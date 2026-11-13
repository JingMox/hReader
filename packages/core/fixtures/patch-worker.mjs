// 这层管：真实子进程的并发 patch 试验体——跑真 `patchFile`（真 fs、真锁），只把结果经 IPC 回给父进程。

import { loadSrc } from "./load-src.mjs";

const { nodePatchDeps, patchFile } = await loadSrc("../src/io/index.ts");

const [workspace, file, html, timeoutMs] = process.argv.slice(2);
if (workspace === undefined || file === undefined || html === undefined) {
  throw new Error("patch-worker 需要 <workspace> <file> <html> [timeoutMs]");
}

process.send?.({ ready: true });

process.once("message", async () => {
  try {
    const result = await patchFile(
      { workspace, file, request: { targetId: "box", action: "append", html } },
      nodePatchDeps,
      { lockTimeoutMs: Number(timeoutMs ?? "0") },
    );
    process.send?.({ ok: true, changed: result.changed, newIds: result.newIds });
  } catch (error) {
    process.send?.({
      ok: false,
      code: String(Reflect.get(Object(error), "code") ?? "no_code"),
      message: String(Reflect.get(Object(error), "message") ?? error),
    });
  }
  process.exit(0);
});
