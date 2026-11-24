// 这层管：全仓静态检查（类型感知规则 + 模块边界）；不管格式化（交给 Prettier）。
import js from "@eslint/js";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

// 根目录配置文件（vitest.config.ts）已纳入 tsconfig.json 的 include，与源码同一个工程。
const TS_FILE_PATTERNS = ["**/*.{ts,tsx,mts,cts}"];

const sharedRules = {
  "no-console": "error",
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      ".stryker-tmp/**",
      "release-artifacts/**",
      "packages/desktop/src-tauri/target/**",
      "packages/desktop/src-tauri/resources/**",
      "packages/cli/styles/**",
      "packages/mcp-server/styles/**",
      "skills/hreader/scripts/cli.mjs",
      "skills/hreader/scripts/styles/**",
      "pnpm-lock.yaml",
    ],
  },
  {
    // 豁免注释的规则与主流项目一致：可以 eslint-disable，但必须有界（禁裸的全局关闭）、
    // 有主（禁无说明豁免）、不重复不聚合。
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "@eslint-community/eslint-comments/disable-enable-pair": [
        "error",
        { allowWholeFile: true },
      ],
      "@eslint-community/eslint-comments/no-aggregating-enable": "error",
      "@eslint-community/eslint-comments/no-duplicate-disable": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/no-unused-enable": "error",
      "@eslint-community/eslint-comments/require-description": "error",
    },
  },
  {
    files: TS_FILE_PATTERNS,
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      // TS 自己检查未定义变量与未使用变量，核心规则会误报类型专用导入。
      "no-undef": "off",
      "no-unused-vars": "off",

      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      // typescript-eslint 语义上的默认形态：允许 `as` 断言，禁止对象字面量断言
      // （字面量已经是最具体的类型，断言只会写错不会写对）。
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
        },
      ],

      "import/no-default-export": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@hreader/*/src/*", "@hreader/*/dist/*"],
              message: "跨包只能走 @hreader/<name> 的公开入口，禁止深层导入。",
            },
          ],
        },
      ],
    },
  },
  {
    // 纯层（状态/按键/主题切换/SSE/存储/守卫）不得碰浏览器全局。
    // depcruise 管"模块依赖"，这条管"名字解析"——两条一起才算把分层规则写进配置。
    files: ["packages/app/src/{keys,state,style-switch,sse,store,guard}.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "document", message: "纯层不得碰 DOM：全局只允许出现在 main.ts / dom.ts。" },
        { name: "window", message: "纯层不得碰 DOM：全局只允许出现在 main.ts / dom.ts。" },
        { name: "fetch", message: "纯层不得发请求：IO 由 boot/main 经注入的 deps 提供。" },
        { name: "EventSource", message: "纯层不得建连接：SSE 走注入的 SourceLike。" },
        { name: "localStorage", message: "纯层不得持久化：状态集中在 state.ts，不做浏览器存储。" },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../dom.ts",
              importNames: ["createDomHost"],
              message: "纯层只认 Host 类型，不得进 DOM 适配器。",
            },
            {
              name: "./dom.ts",
              importNames: ["createDomHost"],
              message: "纯层只认 Host 类型，不得进 DOM 适配器。",
            },
          ],
          patterns: [
            {
              group: ["@hreader/*/src/*", "@hreader/*/dist/*"],
              message: "跨包只能走 @hreader/<name> 的公开入口，禁止深层导入。",
            },
          ],
        },
      ],
    },
  },
  {
    // widget 可以 `import type { Host }`，但不许拿适配器实现；
    // eslint 只看得到名字，故按 importNames 收窄。
    files: ["packages/app/src/widgets/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../dom.ts",
              importNames: ["createDomHost"],
              message: "widget 只依赖 Host 接口，不得进适配器实现。",
            },
            {
              name: "./dom.ts",
              importNames: ["createDomHost"],
              message: "widget 只依赖 Host 接口，不得进适配器实现。",
            },
          ],
          patterns: [
            {
              group: ["@hreader/*/src/*", "@hreader/*/dist/*"],
              message: "跨包只能走 @hreader/<name> 的公开入口，禁止深层导入。",
            },
          ],
        },
      ],
    },
  },
  {
    // 构建/测试配置必须 default export，白名单只覆盖这些文件。
    files: ["*.config.ts"],
    rules: { "import/no-default-export": "off" },
  },
  {
    // Pi 只能加载单文件扩展，`export default (pi) => void` 是该形态的唯一入口。
    files: ["packages/pi-extension/pi-hreader.ts"],
    rules: { "import/no-default-export": "off" },
  },
  {
    files: ["packages/desktop/webview/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "script", globals: globals.browser },
    rules: { ...sharedRules },
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "module", globals: globals.node },
    rules: { ...sharedRules, "no-undef": "off" },
  },
  {
    files: ["**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { ...sharedRules },
  },
);
