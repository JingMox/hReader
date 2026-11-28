// Mutation-test scope, execution, and anti-regression thresholds; neither the tested code nor the
// unit tests themselves. Reports and the incremental cache land in .reports-tmp/ (gitignored);
// partial runs use `pnpm test:mutation --mutate "<glob>"`.
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
const config = {
  // Mutation scope: security-critical and data-integrity-critical modules. Three app files are supplementary.
  // The security/data-integrity-critical modules named by the task (a directory-level glob inflates to 11k mutants — infeasible).
  mutate: [
    // html: sanitize (incl. CSS escape decoding, hasExecutableContent), serialize
    "packages/core/src/html/sanitize.ts",
    "packages/core/src/html/serialize.ts",
    // model: classify, load
    "packages/core/src/model/classify.ts",
    "packages/core/src/model/load.ts",
    // ops: patch-node, undo/history, import, normalize
    "packages/core/src/ops/patch-node/**/*.ts",
    "packages/core/src/ops/import.ts",
    "packages/core/src/ops/normalize-file.ts",
    "packages/core/src/ops/revert-op.ts",
    "packages/core/src/io/undo.ts",
    "packages/core/src/io/history.ts",
    // annotations: sidecar store (corruption handling, dangerous keys, limits, relocation)
    "packages/core/src/annotations/sidecar-model.ts",
    "packages/core/src/annotations/relocate.ts",
    "packages/core/src/io/annotation-store.ts",
    "packages/core/src/ops/sidecar-ops.ts",
    // style: apply, css safety checks, replaceTheme-related
    "packages/core/src/style/apply.ts",
    "packages/core/src/style/apply-file.ts",
    "packages/core/src/style/css.ts",
    "packages/core/src/style/theme.ts",
    // io: paths, trust, lock, atomic write, digest
    "packages/core/src/io/paths.ts",
    "packages/core/src/io/trust.ts",
    "packages/core/src/io/lock.ts",
    "packages/core/src/io/atomic.ts",
    "packages/core/src/io/digest.ts",
    // server: auth, routes, handlers write gates, http-io body parsing, CSP generation,
    // annotate token book + injection, /f/ asset scope (reserved-name precedence)
    "packages/core/src/server/annotate.ts",
    "packages/core/src/server/doc-assets.ts",
    "packages/core/src/server/auth.ts",
    "packages/core/src/server/routes.ts",
    "packages/core/src/server/handlers.ts",
    "packages/core/src/server/http-io.ts",
    "packages/core/src/server/body.ts",
    "packages/core/src/server/static.ts",
    // sidecar HTTP surface: strict-body gates + relocation wiring are security-relevant
    "packages/core/src/server/sidecar-replies.ts",
    "packages/core/src/server/write-replies.ts",
    "packages/core/src/server/runtime.ts",
    "packages/core/src/annotations/anchor.ts",
    "packages/core/src/annotations/body-text.ts",
    // search: tokenizer/CJK fuzzy gate, incremental index, snippet offsets, query bounds, HTTP reply
    "packages/core/src/search/tokenize.ts",
    "packages/core/src/search/extract.ts",
    "packages/core/src/search/index-store.ts",
    "packages/core/src/search/snippet.ts",
    "packages/core/src/search/query.ts",
    "packages/core/src/server/search-reply.ts",
    // cli: term(), argument parsing, and the export-side permission gate
    "packages/cli/src/output.ts",
    "packages/cli/src/args/**/*.ts",
    "packages/cli/src/commands/export-foreign.ts",
    // cli: the fail-closed link-annotation sanitizer every hr pdf artifact passes through
    "packages/cli/src/pdf/links.ts",
    // app widgets
    "packages/app/src/widgets/present.ts",
    "packages/app/src/widgets/foreign.ts",
    "packages/app/src/escape-attr.ts",
    // annotator bundle (untrusted-frame script): capture, engine, protocol, text model
    "packages/app/src/annotator/caps.ts",
    "packages/app/src/annotator/index.ts",
    "packages/app/src/annotator/proto.ts",
    "packages/app/src/annotator/run.ts",
    "packages/app/src/annotator/text-model.ts",
    // reader side: strict inbound validation + the annotate controller's message intake
    "packages/app/src/annotate-proto.ts",
    "packages/app/src/widgets/annotate.ts",
    // D55 foreign-annotation panel: textContent-only rendering + write-action dispatch
    "packages/app/src/widgets/ann-panel.ts",
    // D61 library-search panel: highlight-offset clamping + textContent-only marks
    "packages/app/src/widgets/search.ts",
  ],
  testRunner: "vitest",
  // pnpm's .pnpm realpath layout hides the runner from the default "@stryker-mutator/*" glob, so declare it explicitly.
  plugins: ["@stryker-mutator/vitest-runner"],
  // pool matches vitest's default (forks): tests exercise process.chdir for cwd independence, which the threads pool does not support.
  vitest: { configFile: "vitest.config.ts", pool: "forks" },
  // perTest: run only the tests covering each mutant; running the whole suite per mutant is infeasible.
  coverageAnalysis: "perTest",
  // The default sandbox copies the whole worktree; node_modules goes by symlink (symlinkNodeModules default true, required under pnpm layout).
  symlinkNodeModules: true,
  // Sandbox copies lose executable bits, and pnpm treats symlinked node_modules as foreign and
  // auto-installs; buildCommand runs once per sandbox before the initial test run — details in
  // scripts/stryker-prep.mjs.
  buildCommand: "node scripts/stryker-prep.mjs",
  incremental: true,
  incrementalFile: ".reports-tmp/stryker-incremental.json",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: ".reports-tmp/mutation/index.html" },
  jsonReporter: { fileName: ".reports-tmp/mutation/mutation.json" },
  // 16GB host running other workloads in parallel: at most 2 mutation-test processes.
  concurrency: 3,
  // CLI cases have an internal 10s hard timeout; 15s is enough budget without letting a hung mutant drag on.
  timeoutMS: 15000,
  timeoutFactor: 1.5,
  // break 85: anything under the full mutation score turns red at once. Security-critical modules (sanitize/css/paths/auth/handlers write gates/term) measure ≥96.
  thresholds: { high: 90, low: 75, break: 85 },
};

export default config;
