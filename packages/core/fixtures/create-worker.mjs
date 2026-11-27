// 这层管：真实子进程的并发 createFromTemplate 试验体——跑真源码（真 fs、真锁），只把结果经 IPC 回给父进程。

import { loadSrc } from "./load-src.mjs";

const { nodePatchDeps } = await loadSrc("../src/io/index.ts");
const { createFromTemplate } = await loadSrc("../src/templates/index.ts");

const [workspace, home, id, file] = process.argv.slice(2);
if (workspace === undefined || home === undefined || id === undefined || file === undefined) {
  throw new Error("create-worker 需要 <workspace> <home> <id> <file>");
}

process.send?.({ ready: true });

process.once("message", async () => {
  try {
    const result = await createFromTemplate(
      { id, target: file },
      { workspace },
      { ...nodePatchDeps, home },
    );
    process.send?.({ ok: true, path: result.path });
  } catch (error) {
    process.send?.({
      ok: false,
      code: String(Reflect.get(Object(error), "code") ?? "no_code"),
      message: String(Reflect.get(Object(error), "message") ?? error),
    });
  }
  process.exit(0);
});
