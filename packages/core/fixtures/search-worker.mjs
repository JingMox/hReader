// Real child-process worker for search concurrency tests: runs the real `searchLibrary`
// (real fs, real lock) and reports the outcome to the parent over IPC.

import { loadSrc } from "./load-src.mjs";

const { nodePatchDeps } = await loadSrc("../src/io/index.ts");
const { searchLibrary } = await loadSrc("../src/search/query.ts");

const [workspace, query] = process.argv.slice(2);
if (workspace === undefined || query === undefined) {
  throw new Error("search-worker 需要 <workspace> <query>");
}

const report = (payload) => {
  process.send?.(payload);
};

try {
  const result = await searchLibrary({ workspace, query }, nodePatchDeps);
  report({
    ok: true,
    paths: result.results.map((hit) => hit.path),
    total: result.total,
    diagnostics: result.diagnostics,
  });
} catch (error) {
  report({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    code: typeof error === "object" && error !== null ? error.code : undefined,
  });
}
