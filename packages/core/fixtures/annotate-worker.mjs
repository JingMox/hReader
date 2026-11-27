// 这层管：真实子进程的并发侧车批注试验体——跑真 `addSidecarAnnotation`/`migrateMetaAnnotations`
// （真 fs、真锁），只把结果经 IPC 回给父进程。

import { loadSrc } from "./load-src.mjs";

const { nodePatchDeps } = await loadSrc("../src/io/index.ts");
const { addSidecarAnnotation, migrateMetaAnnotations } = await loadSrc("../src/ops/sidecar-ops.ts");

const [workspace, file, mode, notePrefix, count, timeoutMs] = process.argv.slice(2);
if (workspace === undefined || file === undefined || mode === undefined) {
  throw new Error(
    "annotate-worker 需要 <workspace> <file> <add|migrate> [notePrefix] [count] [timeoutMs]",
  );
}

const options = { lockTimeoutMs: Number(timeoutMs ?? "0") };
const total = Number(count ?? "1");

const report = (payload) => {
  process.send?.(payload);
};

const addLoop = async () => {
  const ids = [];
  for (let index = 0; index < total; index += 1) {
    const result = await addSidecarAnnotation(
      {
        workspace,
        file,
        selector: "body > article:nth-of-type(1) > p:nth-of-type(1)",
        anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
        note: `${notePrefix ?? "note"}-${String(index)}`,
      },
      nodePatchDeps,
      options,
    );
    ids.push(result.annotation.id);
  }
  report({ ok: true, ids });
};

const migrateOnce = async () => {
  const result = await migrateMetaAnnotations({ workspace, file }, nodePatchDeps, options);
  report({ ok: true, migrated: result.migrated, skipped: result.skipped, changed: result.changed });
};

process.send?.({ ready: true });

process.once("message", async () => {
  try {
    if (mode === "add") await addLoop();
    else if (mode === "migrate") await migrateOnce();
    else report({ ok: false, code: "bad_mode", message: `未知 mode：${mode}` });
  } catch (error) {
    report({
      ok: false,
      code: String(Reflect.get(Object(error), "code") ?? "no_code"),
      message: String(Reflect.get(Object(error), "message") ?? error),
    });
  }
  process.exit(0);
});
