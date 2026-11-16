// 这层管：进程壳（解析钩子 + 真实 io + 退出码）；不做解析、不做格式化，逻辑全在 `run.ts`。
// 不读 `HR_DEBUG` 以外的东西：cwd / argv / stdin 只在这里从 `process` 取出后作为参数下传。

import { registerHooks } from "node:module";

import { resolveFallback } from "./resolve-hook.ts";

registerHooks({ resolve: resolveFallback });

const { run } = await import("./run");

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array)) throw new Error("stdin 片段不是字节");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** 两个信号任一来一次就关：第二次不处理，让运行时按默认行为兜底。 */
const stop = new Promise<void>((resolve) => {
  process.once("SIGTERM", () => {
    resolve();
  });
  process.once("SIGINT", () => {
    resolve();
  });
});

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  readStdin,
  debug: process.env["HR_DEBUG"] === "1",
  env: process.env,
  stop,
});

process.exitCode = code;
