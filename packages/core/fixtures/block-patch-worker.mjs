// This layer: the real-subprocess `patchBlock` race body — runs the true op (real fs, real
// lock) and reports the result over IPC, same barrier contract as `patch-worker.mjs`.

import { loadSrc } from "./load-src.mjs";

const { nodePatchDeps } = await loadSrc("../src/io/index.ts");
const { patchBlock } = await loadSrc("../src/ops/patch-block.ts");
const { listBlocks } = await loadSrc("../src/ops/block-address/index.ts");

const [workspace, file, marker, timeoutMs] = process.argv.slice(2);
if (workspace === undefined || file === undefined || marker === undefined) {
  throw new Error("block-patch-worker needs <workspace> <file> <marker> [timeoutMs]");
}

process.send?.({ ready: true });

process.once("message", async () => {
  try {
    const fs = await import("node:fs/promises");
    const html = await fs.readFile(`${workspace}/${file}`, "utf8");
    const address = listBlocks(html)[0]?.address;
    if (address === undefined) {
      process.send?.({ ok: false, code: "no_block" });
      process.exit(0);
    }
    const result = await patchBlock(
      { workspace, file, address, action: "insertAfter", html: `<p>${marker}</p>` },
      nodePatchDeps,
      { lockTimeoutMs: Number(timeoutMs ?? "0") },
    );
    process.send?.({ ok: true, changed: result.changed, address: result.address });
  } catch (error) {
    process.send?.({
      ok: false,
      code: String(Reflect.get(Object(error), "code") ?? "no_code"),
      message: String(Reflect.get(Object(error), "message") ?? error),
    });
  }
  process.exit(0);
});
