# 工程与代码规范

本文档描述 hReader 仓库实际执行的代码规范与质量门禁。门禁由工具强制执行（见下表），其余约定靠 code review 把关。

## 一、可读性

代码首先是给人读的契约。判据：一个没参与本功能的工程师，只看函数签名、类型和少量注释，就能正确说出"它做什么、不做什么、失败时怎样"。

1. **签名即文档**：函数名 + 参数名 + 返回类型独立表达语义；需要大段注释才能看懂的签名是设计问题。
2. **显式优于聪明**：不用元编程解决三行直白代码能解决的问题；不把五个动作塞进一个表达式。
3. **控制流扁平**：卫语句提前返回，避免深层 `if/else` 菱形。
4. **无隐式状态**：不读全局单例；环境变量在边界解析后以参数传入；不依赖模块初始化顺序。
5. **一致性**：同一种事只用一种写法（命名、错误处理、异步风格、IO 边界）。
6. **删除优于新增**：单一实现的接口、只被调用一次的封装、`utils.ts` 垃圾桶，默认都是债。

## 二、注释

只写签名表达不了的东西。允许的类别：

| 类别 | 例子 |
| :--- | :--- |
| 契约/不变量 | `// data-hr-id 一旦分配就不可变，patch 依赖它做锚点` |
| 取舍理由 | `// 用 parse5 而非 cheerio：需要保留原始属性顺序以便 diff 最小化` |
| 外部协议/格式 | `// <script id="hr-meta"> 必须是合法 JSON` |
| 反直觉的必需代码 | `// 这里必须深拷贝：上游 patch 会就地改写 children` |
| 性能 | `// O(n) 单遍：二次遍历在大文档下是 2s 级停顿` |
| 安全边界 | `// 仅允许相对路径；绝对路径会逃出工作区` |
| 上游 bug 规避 | `// 见 parse5#1234：无 doctype 时会丢 head` |

禁止：

- 复述代码的注释（`// 遍历 sections`、`// 返回结果`）和注释掉的死代码。
- 过时注释——改了代码就要改注释。
- `@ts-ignore` / `@ts-nocheck`；`@ts-expect-error` 必须带一行理由（lint 强制）。
- 无主 TODO：`TODO(name, issue#): ...` 才可以存在。
- JSDoc 里重复 TS 类型。

另外：文件顶部最多 3 行说明"负责什么 / 不负责什么"；公共导出有非显然契约（幂等、稳定 ID、破坏性默认值）必须写。

## 三、API 形状：裸类型

对外（跨模块/跨包/CLI/插件）参数与返回值用**裸类型**：原始类型、字面量联合、纯数据接口、判别联合。

```ts
function outline(filePath: string): Promise<OutlineNode[]>;

type ParseResult =
  | { ok: true; document: Document }
  | { ok: false; code: "invalid_html" | "no_article"; message: string };
```

禁止：

- 无意义包装类（`class FilePath`）、branded/opaque 类型（`type DocId = string` 这类零成本别名可以）。
- `Option<T>`/`Either`/`Result<T,E>` 包装类——裸判别联合已足够。
- 为两个实现造抽象基类、"预留扩展"的泛型、单实现接口（除非边界需要测试替身替换：fs/http/ws/clock）。
- boolean 控制参数；参数过多时收成 plain-object options。
- `null`/`undefined` 混用同一语义：统一 `undefined` 表示缺失。
- `any`、对象字面量断言、非空断言 `!`（lint 强制）；`as` 断言允许但应当少见。

外部输入（文件、argv、HTTP/WS 消息、MCP 参数、`hr-meta` JSON）在边界处用 zod 或类型守卫校验，向内传裸类型，内部不重复校验。上下文靠参数传递（clock、fs、ws 都注入），不靠隐式全局——这也是测试可控性的来源。

## 四、质量门禁

`pnpm verify` 就是验收命令，与 CI `checks` job 同序：

| 步骤 | 命令 | 内容 |
| :--- | :--- | :--- |
| 格式 | `pnpm format:check` | Prettier，不在 CI 里自动修 |
| Lint | `pnpm lint` | ESLint 9 flat config，`strictTypeChecked` + `stylisticTypeChecked`，`--max-warnings=0` |
| Shell | `pnpm lint:sh` | shellcheck（`-x -S warning`）；本地未安装则提示跳过，CI 必跑 |
| 类型 | `pnpm typecheck` | `tsc --noEmit`，strict 全开（见 tsconfig.base.json） |
| 构建 | `pnpm build` | 各包 scripts/build.mjs（esbuild 单文件产物） |
| 测试 | `pnpm test:coverage` | Vitest + v8 覆盖率 |
| 主题 | `pnpm theme:check` | `scripts/check-theme-contrast.mjs`：WCAG 2.1 对比度实测（正文/次要文字 ≥ 4.5:1）、`@media print`、`prefers-reduced-motion`、外壳选择器泄漏 |
| 依赖边界 | `pnpm depcruise` | 见第五节 |
| 死代码 | `pnpm knip` | 未使用导出/依赖/文件即失败 |

桌面壳另有一道独立门禁 `pnpm desktop:check`（rustfmt + clippy `-D warnings` + cargo test）。

`pnpm test:e2e`（真 Chrome 的打印稿分页 + 外来文档沙箱对抗）不在 `verify` 里——本机没装 Chrome 时两个脚本打印 SKIPPED 退 0；CI 的 `checks` job 在 `test:coverage` 后真跑（ubuntu-latest 自带 Chrome，显式给 `CHROME_BIN`）。

关键 lint 约定：

- 跨包只能走 `@hreader/<name>` 的公开入口，深层导入（`/src/*`、`/dist/*`）报错。
- `eslint-disable` 允许但必须有界且带说明；裸的全局关闭禁止。
- 不设行数、参数个数、圈复杂度硬上限——规模问题在 review 里讨论，不写成数字门槛。

覆盖率策略：全局四维阈值（lines/branches/functions/statements）取当前实测值作为棘轮，只允许持平或上升。新文件不要求单独满覆盖，但总量不得回退。

## 五、依赖方向与封装

```text
packages/core            依赖底座，不依赖任何其他 @hreader 包
packages/renderer-html   → core
packages/cli             → core, renderer-html
packages/mcp-server      → core
packages/pi-extension    → core
packages/dsh-bundle      → core（构建期 esbuild 打进 dist，运行时不算跨包依赖）
packages/app             独立前端（构建产物给桌面壳/浏览器用）
packages/desktop         → app 的构建产物（Tauri 外壳，零业务逻辑）
```

dependency-cruiser 编码的规则：无环；core 不依赖任何 adapter/宿主包；`src/` 不得 import `tests/`；运行时代码不得依赖 devDependencies（`import type` 除外）；`cli/src/args` 与 `cli/src/commands` 不碰 fs/child_process。

封装判据：

1. 模块只有一个变化理由。
2. 公开面最小——knip 会抓未使用导出。
3. 不泄露内部 AST/实现类型；要导出就先定义纯数据接口。
4. 抽象必须被至少两处使用，或隔离真实外部系统。

## 六、测试纪律

- AAA 结构，一个测试一个行为，命名 `should <behavior> when <condition>`。
- 断言具体值与错误 `code`；不断言内部调用顺序/私有字段。
- 禁止 `test.only`、注释掉的测试、无种子随机、直读 `Date.now()`、真实网络、`setTimeout` 轮询。
- 外部依赖（fs/http/ws/clock）注入可控替身；临时目录 `mkdtemp` + `finally` 清理。
- 交付物测试对**构建产物**跑真子进程（`mcp-server` 的 `dist/main.js`、`cli` 的 `dist/cli.mjs`），不是只测 src。

## 七、提交

- [Conventional Commits](https://www.conventionalcommits.org/)：`type(scope): summary`，type ∈ `feat`/`fix`/`refactor`/`test`/`docs`/`chore`/`perf`/`build`。
- 变更影响公开 API 或文档结构时，同步更新 `README.md` / `docs/`。
