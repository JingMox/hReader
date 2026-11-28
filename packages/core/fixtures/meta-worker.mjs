// Real child-process worker for doc-meta concurrency tests: runs the real `setDocMeta`
// (real fs, real table lock) and only reports results to the parent over IPC.

import { loadSrc } from "./load-src.mjs";

const { nodePatchDeps } = await loadSrc("../src/io/index.ts");
const { setDocMeta } = await loadSrc("../src/ops/doc-meta-ops.ts");

const [workspace, file, tagPrefix, count, timeoutMs] = process.argv.slice(2);
if (workspace === undefined || file === undefined || tagPrefix === undefined) {
  throw new Error("meta-worker 需要 <workspace> <file> <tagPrefix> [count] [timeoutMs]");
}

const options = { lockTimeoutMs: Number(timeoutMs ?? "0") };
const total = Number(count ?? "1");

process.send?.({ ready: true });

process.once("message", async () => {
  try {
    for (let index = 0; index < total; index += 1) {
      await setDocMeta(
        { workspace, file, patch: { addTags: [`${tagPrefix}-${String(index)}`] }, by: "user" },
        nodePatchDeps,
        options,
      );
    }
    process.send?.({ ok: true });
  } catch (error) {
    process.send?.({
      ok: false,
      code: String(Reflect.get(Object(error), "code") ?? "no_code"),
      message: String(Reflect.get(Object(error), "message") ?? error),
    });
  }
  process.exit(0);
});
