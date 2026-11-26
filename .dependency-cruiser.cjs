// Inter-package and layering boundaries (one-way deps, no cycles, no undeclared/dev deps); not runtime behavior.
/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-unresolvable",
      severity: "error",
      comment:
        "import 必须能解析到真实文件；指向不存在模块的边会让所有 to.path 规则静默失效（虚假绿灯）。",
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
      comment: "@hreader/core 不得依赖任何其他 @hreader/* 包（依赖方向单向）。",
      from: { path: "^packages/core/(src|tests)" },
      to: { path: "^packages/(renderer-html|app)/" },
    },
    {
      name: "renderer-html-ignores-hosts",
      severity: "error",
      comment: "@hreader/renderer-html 是被宿主消费的渲染层，不得反向依赖宿主包。",
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
        "args/* 与 commands/* 不得碰进程、文件系统或子进程：进程边界只允许在 main.ts / run.ts。",
      from: { path: "^packages/cli/src/(args/|commands/)" },
      to: {
        path: "^(node:)?(process|fs|fs/promises|child_process|os)$",
        dependencyTypes: ["core"],
      },
    },
    {
      name: "src-must-not-import-tests",
      severity: "error",
      comment: "生产代码不得反向依赖测试代码（测试辅助函数会因此漏进发布产物）。",
      from: { path: "^packages/[^/]+/src" },
      to: { path: "^packages/[^/]+/tests" },
    },
    {
      name: "no-undeclared-external-dep",
      severity: "error",
      comment:
        "源码与测试只能引用 package.json 里声明过的外部依赖（npm-no-pkg / npm-unknown 表示未声明）。",
      from: { path: "^packages/[^/]+/(src|tests)" },
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
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
    // (otherwise the two npm rules above never fire).
    doNotFollow: { path: "node_modules" },
    // Exclude only top-level artifact dirs: repo-root dist|coverage and packages/<pkg>/dist|coverage.
    // Cannot write (^|/)(dist|coverage)/: it matches dist at any depth, including inside
    // node_modules — and excluding node_modules would remove npm edges entirely, leaving
    // no-undeclared-external-dep / no-dev-dependency-from-src dead again.
    // Nor ^(packages/[^/]+/)?(dist|coverage)/: nested quantifiers give depcruise's safe-regex a
    // star height of 2 and it refuses to run — hence two anchored branches.
    exclude: { path: "^(dist|coverage)/|^packages/[^/]+/(dist|coverage)/" },
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
