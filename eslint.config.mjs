// Repo-wide static checks (type-aware rules + module boundaries); formatting belongs to Prettier.
import js from "@eslint/js";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import importPlugin from "eslint-plugin-import";
import globals from "globals";
import tseslint from "typescript-eslint";

// The root config file (vitest.config.ts) is in tsconfig.json's include, same project as the sources.
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
    // Exemption-comment rules follow mainstream projects: eslint-disable is allowed but must be
    // bounded (no bare global disable), owned (no unexplained exemption), and never duplicated or
    // aggregated.
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "@eslint-community/eslint-comments/disable-enable-pair": ["error", { allowWholeFile: true }],
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
      // TS itself checks undefined and unused variables; the core rule false-positives on
      // type-only imports.
      "no-undef": "off",
      "no-unused-vars": "off",

      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      // typescript-eslint's semantic default shape: `as` assertions allowed, object-literal
      // assertions banned (a literal is already the most specific type — an assertion can only be
      // wrong, never righter).
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
    // The pure layer (state/keys/theme switching/SSE/storage/guards) must not touch browser
    // globals. depcruise governs "module dependencies"; this one governs "name resolution" —
    // together they put the layering rule into config.
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
    // A widget may `import type { Host }` but must not take the adapter implementation; eslint
    // only sees names, so narrow by importNames.
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
    // Build/test configs must default-export; the whitelist covers only these files.
    files: ["**/*.config.ts"],
    rules: { "import/no-default-export": "off" },
  },
  {
    // Pi only loads single-file extensions; `export default (pi) => void` is the only entry for that shape.
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
