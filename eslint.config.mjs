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
    // 构建/测试配置必须 default export，白名单只覆盖这些文件。
    files: ["*.config.ts"],
    rules: { "import/no-default-export": "off" },
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
