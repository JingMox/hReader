// 这层管：进程壳（解析钩子 + 真实 io + 退出码）；不做解析、不做格式化，逻辑全在 `run.ts`。
// 不读 `HR_DEBUG` 以外的东西：cwd / argv / stdin 只在这里从 `process` 取出后作为参数下传。

import { registerHooks } from "node:module";

// core 的内部相对导入不带扩展名（`./hr-error`、`./ops`）：vitest 会推断，Node ESM 不推断。
// 补 `.ts` 与 `/index.ts` 后，CLI 与测试解析到同一份源码，不引入构建步骤或第三方加载器。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
  },
});

const { run } = await import("./run");

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array)) throw new Error("stdin 片段不是字节");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

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
});

process.exitCode = code;
