// This layer: the createFromTemplate worker for the real-subprocess race test — runs the real source (real fs, real locks) and reports only the outcome back to the parent over IPC.

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
