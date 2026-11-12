// 这层管：包间与分层边界（单向依赖、无环、不引未声明/开发依赖）；不管运行时行为。
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
      to: { path: "^packages/(protocol|renderer-html|chrome-extension|app)/" },
    },
    {
      name: "protocol-depends-on-core-only",
      severity: "error",
      comment: "@hreader/protocol 只允许依赖 @hreader/core。",
      from: { path: "^packages/protocol/(src|tests)" },
      to: { path: "^packages/(renderer-html|chrome-extension|app)/" },
    },
    {
      name: "renderer-html-ignores-hosts",
      severity: "error",
      comment: "@hreader/renderer-html 是被宿主消费的渲染层，不得反向依赖宿主包。",
      from: { path: "^packages/renderer-html/(src|tests)" },
      to: { path: "^packages/(chrome-extension|app)/" },
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
      name: "no-dev-dependency-from-src",
      severity: "error",
      comment: "运行时代码不得依赖 devDependencies，否则发布后必然崩。",
      from: { path: "^packages/[^/]+/src" },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    // 只控制遍历深度：node_modules 不展开，但 npm 边仍会被记录（否则上面两条 npm 规则永不触发）。
    doNotFollow: { path: "node_modules" },
    // 只排除顶层的产物目录：仓库根的 dist|coverage，以及 packages/<pkg>/dist|coverage。
    // 不能写成 (^|/)(dist|coverage)/：它匹配任意层级的 dist，连 node_modules 里的也算；
    // 而把 node_modules 塞进 exclude 会让 npm 边彻底消失，
    // no-undeclared-external-dep / no-dev-dependency-from-src 重新变成死规则（见 impl-M1.0.md P0-3）。
    // 也不用 ^(packages/[^/]+/)?(dist|coverage)/：嵌套量词会让 depcruise 的 safe-regex 拒跑（star height 2），
    // 因此拆成两条锚定分支。
    exclude: { path: "^(dist|coverage)/|^packages/[^/]+/(dist|coverage)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
