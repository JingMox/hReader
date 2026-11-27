// Inter-package and layering boundaries (one-way deps, no cycles, no undeclared/dev deps); not runtime behavior.
/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-unresolvable",
      severity: "error",
      comment:
        "imports must resolve to real files; an edge to a missing module silently disables every to.path rule (a false green).",
      from: { path: "^packages/" },
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "core-is-a-foundation",
      severity: "error",
      comment:
        "@hreader/core must not depend on any other @hreader/* package (the dependency direction is one-way).",
      from: { path: "^packages/core/(src|tests)" },
      to: { path: "^packages/(renderer-html|app)/" },
    },
    {
      name: "renderer-html-ignores-hosts",
      severity: "error",
      comment:
        "@hreader/renderer-html is the rendering layer consumed by hosts; it must not depend back on host packages.",
      from: { path: "^packages/renderer-html/(src|tests)" },
      to: { path: "^packages/(app)/" },
    },
    {
      name: "renderer-html-src-stays-pure",
      severity: "error",
      comment:
        "@hreader/renderer-html src is the pure-function layer: it must not touch node: builtins or depend back on the host packages (cli/mcp-server).",
      from: { path: "^packages/renderer-html/src" },
      to: { path: "^(node:|packages/(cli|mcp-server)/)" },
    },
    {
      name: "cli-is-a-thin-adapter",
      severity: "error",
      comment:
        "The CLI is a thin adapter: HTML/CSS/YAML logic lives in core only, so the CLI must not pull in processing libraries.",
      from: { path: "^packages/cli/src" },
      to: { path: "node_modules/(parse5|yaml|cheerio|jsdom|postcss|css-tree|htmlparser2)" },
    },
    {
      name: "cli-parse-and-commands-stay-pure",
      severity: "error",
      comment:
        "args/* and commands/* must not touch process, filesystem, or subprocesses: the process boundary lives only in main.ts / run.ts.",
      from: { path: "^packages/cli/src/(args/|commands/)" },
      to: {
        path: "^(node:)?(process|fs|fs/promises|child_process|os)$",
        dependencyTypes: ["core"],
      },
    },
    {
      name: "src-must-not-import-tests",
      severity: "error",
      comment:
        "production code must not depend back on test code (test helpers would leak into release artifacts).",
      from: { path: "^packages/[^/]+/src" },
      to: { path: "^packages/[^/]+/tests" },
    },
    {
      name: "no-undeclared-external-dep",
      severity: "error",
      comment:
        "source and tests may only reference external dependencies declared in package.json (npm-no-pkg / npm-unknown marks undeclared).",
      from: { path: "^packages/[^/]+/(src|tests)" },
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "app-src-stays-browser-pure",
      severity: "error",
      comment:
        "packages/app/src is served to the browser verbatim: no Node builtins may be " +
        "imported there. src/version.ts is the single audited exception — build-static.mjs " +
        "rewrites its emitted output into a baked literal before it is served.",
      from: { path: "^packages/app/src", pathNot: "^packages/app/src/version\\.ts$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "widgets-use-host-interface",
      severity: "error",
      comment:
        "widgets/** may only depend on the Host interface and pure state; importing the dom.ts implementation directly is forbidden.",
      from: { path: "^packages/app/src/widgets/" },
      to: { path: "^packages/app/src/dom\\.ts$", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-dev-dependency-from-src",
      severity: "error",
      comment:
        "Runtime code must not depend on devDependencies, or the published package crashes on import; type-only edges are not runtime dependencies (`@deepseek-ai/*` is dev-only and imported via `import type`, because a second cordis instance would silently break the Events merge).",
      from: { path: "^packages/[^/]+/src" },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    // Only bounds traversal depth: node_modules is not expanded, but npm edges are still recorded
    // (otherwise the two npm rules above never fire). The git-ignored desktop artifact dirs are
    // listed too so a stray edge into a bundle never expands the whole bundled tree.
    doNotFollow: {
      path: "node_modules|^packages/desktop/src-tauri/(resources/(app|cli)|target)/",
    },
    // Exclude only artifact dirs: repo-root dist|coverage, packages/<pkg>/dist|coverage, and the
    // git-ignored desktop build output under src-tauri/. The exclusion mirrors .gitignore
    // exactly: resources/app/ and resources/cli/ hold copies of app/dist and the bundled
    // cli.mjs whose optional imports like yauzl/proxy-agent would report false
    // no-unresolvable reds, and target/ is the cargo build tree — while a file tracked
    // directly in resources/ (next to the .gitkeep) is real input and stays in the cruise.
    // Cannot write (^|/)(dist|coverage)/: it matches dist at any depth, including inside
    // node_modules — and excluding node_modules would remove npm edges entirely, leaving
    // no-undeclared-external-dep / no-dev-dependency-from-src dead again.
    // Nor ^(packages/[^/]+/)?(dist|coverage)/: nested quantifiers give depcruise's safe-regex a
    // star height of 2 and it refuses to run — hence two anchored branches.
    exclude: {
      path: "^(dist|coverage)/|^packages/[^/]+/(dist|coverage)/|^packages/desktop/src-tauri/(resources/(app|cli)|target)/",
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    // A dependency's `exports` wildcard (e.g. `@modelcontextprotocol/sdk`'s "./*") resolves only
    // with the export fields explicitly enabled; default enhanced-resolve does not read exports and
    // would mark all such edges couldNotResolve (false red).
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
