// 这层管：全仓静态检查（类型感知规则 + 规模/边界硬约束）；不管格式化（交给 Prettier）。
import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

// 根目录配置文件（vitest.config.ts）已纳入 tsconfig.json 的 include，与源码同一个工程。
const TS_FILE_PATTERNS = ["**/*.{ts,tsx,mts,cts}"];

const BANNED_COMMENT_TERMS = ["eslint-disable", "ts-ignore", "ts-expect-error"];

const sharedRules = {
  "no-console": "error",
  // 违规豁免注释本身就是绕过门禁的后门，一律禁止；确需豁免先找协调者。
  "no-warning-comments": ["error", { terms: BANNED_COMMENT_TERMS, location: "anywhere" }],
  complexity: ["error", 10],
  "max-depth": ["error", 3],
  "max-params": ["error", 4],
  "max-lines": ["error", { max: 300, skipBlankLines: false, skipComments: false }],
  "max-lines-per-function": ["error", { max: 40, skipBlankLines: false, skipComments: false }],
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
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true },
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
    // 卡 M2.2 §0 规则 2：纯层（状态/按键/主题切换/SSE/存储/守卫）**不得**碰浏览器全局。
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
    // 卡 M2.2 §0 规则 3（与 depcruise 的 widgets-use-host-interface 对称）：
    // widget 可以 `import type { Host }`，但**不许**拿适配器实现；eslint 只看得到名字，故按 importNames 收窄。
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
    // 卡 M3.3 AC-2：负例文件里的"期望此处类型报错"指令不是压制错误，而是把"这里必须报错"
    // 写成可执行断言——期望落空时 tsc 报 TS2578。故只对这一个文件放开该指令（禁词表同步去掉），
    // 压制型指令（忽略本行 / 忽略本文件）仍全禁；路径写死单文件，不做 glob，避免蔓延到正例测试。
    files: ["packages/dsh-bundle/tests/types.test-d.ts"],
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": false, "ts-ignore": true, "ts-nocheck": true },
      ],
      "no-warning-comments": [
        "error",
        { terms: ["eslint-disable", "ts-ignore"], location: "anywhere" },
      ],
    },
  },
  {
    // 构建/测试配置必须 default export，白名单只覆盖这些文件。
    files: ["*.config.ts"],
    rules: { "import/no-default-export": "off" },
  },
  {
    // M3.2 AC-1：Pi 只能加载**单文件**扩展，`export default (pi) => void` 是该形态的唯一入口。
    // `max-lines` 同理：本仓 300 行上限是为"一个文件一个职责"设的，而卡面把"零本地 import"
    // 硬约束成"全部职责挤在一个文件"。上限不是旋钮：只因 AC-7 要求 `ERROR_TEXTS` 与 core 码集
    // 逐字相等、core 新增一个 `HrErrorCode` 就必须多一行。2026-11-16 实测 1202 行（M4.1 R2 新增
    // `file_exists`/`llm_failure`）；2026-11-19 实测 1203 行（R1 新增 `content_model_conflict`）
    // ——不留余量，同一理由再来一次就再改一次数字，不改规则。
    // 2026-11-19 R2-F17：新增 duplicate_id（1203→1204）；L-46 记下「行数墙 vs AC-1 单文件扩展」的死锁，
    // 出口是打包后拆分（见 docs/known-defects.md L-46）。
    // `max-params` 的触发点只有一个：AC-6 要求的 `tool.execute(toolCallId, params, signal, onUpdate, ctx)`
    // 是 Pi 定的五参签名，本文件必须照抄，故这条规则在本文件不适用。
    files: ["packages/pi-extension/pi-hreader.ts"],
    rules: {
      "import/no-default-export": "off",
      "max-lines": ["error", { max: 1204 }],
      "max-params": "off",
    },
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
