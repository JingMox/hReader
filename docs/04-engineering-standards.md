# hReader 工程与代码标准 (Engineering Standards)

> [!IMPORTANT]
> 本文档是 hReader 的**质量红线**。编写员按此实现，审计员按此判卷，测试员按此设计测试。任何"这次先这样"的例外都必须在卡片里登记理由，并由用户批准。

---

## 一、第一性目标：可读性

代码首先是**给人读的契约**，其次才是给机器执行的指令。判据很简单：

> 一个没参与本卡的工程师，能否在不运行、不问人的情况下，只看函数签名 + 类型 + 少量注释，就正确说出"它做什么、不做什么、失败时怎样"？

达不到就是 P1。具体落实为：

1. **签名即文档**：函数名 + 参数名 + 返回类型要能独立表达语义。需要大段注释才能看懂签名的，是设计问题。
2. **显式优于聪明**：不用元编程解决能用 3 行直白代码解决的问题；不写"一行流"把 5 个动作塞进一个表达式。
3. **控制流扁平**：卫语句提前返回，嵌套 ≤ 3 层，禁止 `if/else` 深层菱形。
4. **无隐式状态**：不读全局单例、不读环境变量（在边界解析后以参数传入）、不依赖模块初始化顺序。
5. **一致性**：同一种事只用一种写法。命名、错误处理、异步风格、IO 边界全项目统一。
6. **删除优于新增**：能删的抽象就删。单一实现的接口、只被调用一次的封装、`utils.ts` 垃圾桶，默认都是债。

---

## 二、注释规约（硬性）

**只写签名表达不了的东西。** 允许的注释只有以下几类：

| 类别 | 例子 |
| :--- | :--- |
| 契约/不变量 | `// data-hr-id 一旦分配就不可变，patch 依赖它做锚点` |
| 为什么这样做（取舍） | `// 用 parse5 而非 cheerio：需要保留原始属性顺序以便 diff 最小化` |
| 外部协议/格式 | `// <script id="hr-meta"> 必须是合法 JSON，浏览器端直接 JSON.parse` |
| 反直觉的必需代码 | `// 这里必须深拷贝：上游 patch 会就地改写 children` |
| 性能/复杂度 | `// O(n) 单遍：大文档下二次遍历会触发 2s 级停顿` |
| 安全边界 | `// 仅允许相对路径；绝对路径会逃出工作区` |
| 上游 bug 规避 | `// 见 parse5#1234：无 doctype 时会丢 head，先补 doctype` |

禁止：
- 复述代码：`// 遍历 sections`、`// 返回结果`、`// 参数 path 是路径`。
- 逐行翻译式注释、装饰性分隔线长注释块。
- 注释掉的死代码（用 git 历史）。
- 过时注释（改了代码不改注释视为 P0，因为它主动误导）。
- `@ts-ignore`（只允许 `@ts-expect-error` 且必须带一行理由）。
- 无主 TODO：`TODO(name, issue#): ...` 才可以存在。
- JSDoc 里重复 TS 类型：`@param {string} path` 这类垃圾。

其他要求：
- 每个模块文件顶部最多 3 行，说明"负责什么 / 不负责什么"。
- 公共导出若有非显然契约（幂等、线程/并发安全、稳定 ID、单位、破坏性默认值），**必须**写；显然的不要写。
- 复杂正则、复杂条件表达式必须抽成具名函数或用一行注释说明输入假设。

---

## 三、裸类型 API 规约（硬性）

对外（跨模块/跨包/CLI/插件）的参数与返回值使用**裸类型**：能直接用语言原生类型表达，就不要造壳。

### 3.1 允许

```ts
// 原始类型、字面量联合
function setTheme(id: string, mode: "light" | "dark" | "auto"): void;

// 纯数据接口（只有字段，没有行为）
interface OutlineNode {
  id: string;
  level: 1 | 2 | 3 | 4;
  text: string;
  wordCount: number;
  children: readonly OutlineNode[];
}
function outline(filePath: string): Promise<OutlineNode[]>;

// 只读数组 / 普通数组 / Map（确有键语义时）
function patchNode(filePath: string, nodeId: string, action: "replace" | "insert_after" | "insert_before" | "append" | "delete", html: string): Promise<{ changed: boolean; newIds: readonly string[] }>;

// 失败用裸判别联合，或抛具名错误类
type ParseResult =
  | { ok: true; document: Document }
  | { ok: false; code: "invalid_html" | "no_article"; message: string };
```

### 3.2 禁止

- **无意义包装类**：`class FilePath { constructor(public value: string) {} }`、`class NodeId`、`class Html`。
- **Branded / opaque 类型**：`string & { __brand: "path" }`、`Opaque<...>`。类型别名 `type DocId = string` 可以（零成本文档），带 brand 不行。
- **容器/单子**：`Option<T>`、`Either<L,R>`、`Result<T,E>` 包装类；自己实现的 `Task`/`IO`。裸判别联合已足够。
- **为 2 个实现造抽象基类**，或"预留扩展"的泛型参数（`<T extends unknown = never>`）。
- **单实现接口**：除非该边界必须能被测试替身替换（真实外部系统：fs、http、ws、clock），否则不要接口。
- **boolean 控制参数**：`render(html, true)` → 改字面量联合或独立函数。
- **参数超过 4 个**却不收成 options 对象；options 对象本身必须是小写 plain object interface，不许 class。
- **返回 `null | undefined` 混用**同一语义；统一 `undefined` 表示缺失，`null` 只用于 JSON 空值场景。
- **`any`、`as`（除 `as const`）、非空断言 `!`、`@ts-expect-error` 滥用**：CI 会拦，审计发现即 P1。

### 3.3 边界与校验

- 外部输入（文件、CLI argv、HTTP/WS 消息、MCP 参数、`<script id="hr-meta">` JSON）在**边界处**用 schema 校验（推荐 `zod` 或手写类型守卫），校验后向内传递裸类型，内部不再重复校验。
- 上下文的传递靠**参数**，不靠隐式全局。Daemon 的依赖（clock、fs、ws server）通过参数注入，便于测试。

---

## 四、最严 CI 档位（唯一标准）

`pnpm verify` **就是**验收命令。任何一项红 → 该卡不许进 G4。

### 4.1 工具链

| 类别 | 工具 | 要求 |
| :--- | :--- | :--- |
| 包管理 | `pnpm`（workspace） | `packageManager` 字段锁死版本；`engines.node >= 22`；`--frozen-lockfile` |
| 语言 | TypeScript（`strict` 全开，见 4.2） | 禁止 `skipLibCheck: false` 之外的宽松项 |
| Lint | ESLint 9 flat config + `typescript-eslint` | `strictTypeChecked` + `stylisticTypeChecked` + 自定义禁令，`--max-warnings=0` |
| 格式 | Prettier | `--check`，不允许在 CI 里自动修 |
| 测试 | Vitest + `@vitest/coverage-v8` | 覆盖率阈值见 4.4；`--reporter=verbose` 保留失败详情 |
| 变异 | Stryker（vitest runner） | `packages/core` ≥ 75%，其他包 ≥ 65% |
| 死代码 | `knip` | 未使用导出/依赖/文件一律失败 |
| 依赖边界 | `dependency-cruiser` | 见 §5 的分层规则，违规即失败 |
| 包发布健康 | `publint` + `@arethetypeswrong/cli` | 每个可发布包必须过 |
| 前端体积 | `size-limit` | 阅读器首屏 JS ≤ 150KB gzip |
| 依赖版本一致性 | `syncpack` | workspace 内版本冲突即失败 |
| 提交规范 | `commitlint`（conventional commits） | 见 §7 |

### 4.2 `tsconfig.json` 必开项

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noPropertyAccessFromIndexSignature": true,
  "noFallthroughCasesInSwitch": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "useUnknownInCatchVariables": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true,
  "forceConsistentCasingInFileNames": true,
  "allowUnreachableCode": false,
  "allowUnusedLabels": false,
  "noImplicitReturns": true,
  "target": "ES2023",
  "moduleResolution": "bundler"
}
```

### 4.3 ESLint 必开规则族（节选，全部为 error）

- `typescript-eslint`：`strictTypeChecked`、`stylisticTypeChecked`、`no-floating-promises`、`no-misused-promises`、`switch-exhaustiveness-check`、`consistent-type-imports`、`prefer-readonly`。
- 自定义禁令（`no-restricted-syntax` / `no-restricted-imports`）：
  - `TSAnyKeyword`、`TSAsExpression`（`as const` 除外）、`TSNonNullExpression`、`TSEnumDeclaration`（用字面量联合）。
  - 跨包深层导入：`@hreader/core/dist/**`、`@hreader/core/src/**`。
  - `src/internal/**` 被包外导入。
  - `console.*`（`packages/cli` 的 `output/` 模块例外）。
  - `process.env` 直接读取（边界模块例外）。
- 复杂度与规模：`complexity: 10`、`max-depth: 3`、`max-lines-per-function: 40`、`max-params: 4`、`max-lines: 300`（`skipBlankLines`/`skipComments` 均 false）。
- 命名：`@typescript-eslint/naming-convention`（typeLike PascalCase、变量 camelCase、常量 UPPER_SNAKE 仅真常量）。

### 4.4 覆盖率与变异

```text
全局:        lines 90 / branches 90 / functions 90 / statements 90
packages/core/src:  lines 95 / branches 92 / functions 95 / statements 95
perFile: true（core）；false（UI，但单文件 < 60% 需在报告中解释）
变异: core ≥ 75%，其他 ≥ 65%（低于则列出存活变异体并解释为何不可杀）
```

覆盖率不是目标，是下限。**测试有效性**由变异测试与审计员共同判定。

### 4.5 脚本契约

```jsonc
{
  "scripts": {
    "ci": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm deps && pnpm test:coverage && pnpm mutation && pnpm build && pnpm publint && pnpm knip && pnpm size",
    "ci:fast": "pnpm lint && pnpm typecheck && pnpm test",
    "format:check": "prettier --check .",
    "lint": "eslint . --max-warnings=0 --report-unused-disable-directives",
    "typecheck": "tsc -b --pretty false",
    "deps": "depcruise --config .dependency-cruiser.cjs packages",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "mutation": "stryker run",
    "build": "pnpm -r build",
    "publint": "pnpm -r --if-present exec publint && pnpm -r --if-present exec attw --pack",
    "knip": "knip --strict",
    "size": "size-limit"
  }
}
```

规矩：**禁止**在本地用 `--no-verify`、跳过 lint、放宽 tsconfig、`eslint-disable` 交差。`eslint-disable` 必须带理由 + 作用范围 ≤ 1 行 + 审计员复核。

---

## 五、架构、模块分工与封装

### 5.1 依赖方向（单向，禁止回流）

```text
packages/core            ← 依赖底座，不依赖任何其他 hreader 包
packages/cli             → core
packages/mcp-server      → core
packages/pi-extension    → core
packages/dsh-bundle      → core
packages/reader-ui       → core 的公开类型/协议，不 import 其实现
packages/desktop         → reader-ui 的构建产物（Tauri 外壳，零业务逻辑）
```

`dependency-cruiser` 必须编码以下规则：无环、包间只走公开入口、`core` 不得 import 任何 adapter 包、UI 不得 import Node 内置模块。

### 5.2 `packages/core` 内部分层

```text
core/src/
├── html/       解析、序列化、data-hr-id 注入（parse5 封装；纯函数）
├── model/      文档模型与不变量（节点、树、校验）
├── ops/        outline / read_node / patch_node / diff（纯逻辑，无 IO）
├── style/      style.yaml 解析、主题注入、tone prompt 编译、禁用词 lint
├── io/         文件读写、原子写、备份/undo 存储（唯一允许碰 fs 的地方）
├── daemon/     HTTP + WebSocket 服务、file watcher、事件编解码
└── index.ts    公开 API（极小导出面）
```

规则：
- `ops/`、`model/`、`html/` 不得 import `io/`、`daemon/`、`node:fs`、`node:http`。
- 所有时间、随机 ID、文件系统访问通过参数注入（`clock`、`idGen`、`fsLike`），测试可完全控制。
- 原子写：先写 `*.tmp` → `fsync` → `rename`，失败不破坏原文件；`undo` 保留上 N 个版本到 `.hreader/history/`。
- 公开 API 只有 `src/index.ts`；`internal/` 用 ESLint `no-restricted-imports` 封锁。

### 5.3 封装判据（审计员必查）

1. 模块只有一个变化理由（SRP）；出现"因为 A 和 B"就是 P1。
2. 公开面最小：没有"以防万一"的导出。`knip` 会抓未使用导出。
3. 不泄露实现细节：不导出内部 AST 类型（若要导出，先定义纯数据接口）。
4. 不存在的抽象不要建；抽象必须被至少两处使用或隔离真实外部系统。
5. 每个包有 `README.md` 说明：职责、公开 API 一览、不负责什么。
6. UI 组件：展示与状态分离；无业务逻辑；所有交互有键盘路径与 ARIA 语义。

---

## 六、测试纪律

### 6.1 编写规则

- 结构 AAA（arrange / act / assert），一个测试一个行为。
- 命名：`should <observable behavior> when <condition>`。
- 断言具体值，不断言"存在"；断言错误 `code` 与关键文案，不只断言抛错。
- 禁止：`test.only`、被注释的测试、条件分支里 skip、随机无种子、`Date.now()` 直读、真实网络、`setTimeout` 轮询等待（用事件/可注入时钟）、对被测单元本体的 mock。
- 每个外部依赖（fs、http、ws）在测试里必须可控；临时目录用 `mkdtemp` 且 finally 清理。
- 黄金文件（HTML/JSON 输出）放 `tests/fixtures/`，人工简短可读；单文件 > 120 行需说明理由。
- 测试代码同样受 ESLint/TS 最严格约束（不允许 `any` 图省事）。

### 6.2 测试有效性审计（审计员必查的反模式）

| 反模式 | 判据 |
| :--- | :--- |
| 同义反复 | 断言与实现同一表达式（`expect(f(x)).toBe(f(x))`） |
| 过度 mock | mock 掉了被测逻辑依赖的**行为**，只剩调用计数 |
| 只测快乐路径 | 无错误/边界/空输入用例 |
| 快照倾倒 | 巨大快照无人能读，改了就更新，等于没测 |
| 无意义覆盖 | 覆盖率高但分支/错误码未被断言 |
| 耦合实现 | 断言内部调用顺序/私有字段，重构即红 |
| 假并发 | 用 `await` 串行模拟"并发" |
| 环境依赖 | 依赖本机路径、时区、locale、已有文件 |

### 6.3 对抗验证（"有没有办法引起 bug"）

测试员对每个功能至少尝试以下攻击面，并在报告中逐条给出结果（成功/失败/不适用 + 证据）：

1. 输入边界：空串、1 字节、超大（≥ 10MB）、超长单行、null 字节、BOM、CRLF、emoji/代理对、RTL 文本、混合编码。
2. 结构边界：最深嵌套、非法 HTML（未闭合/交叉标签/重复 id）、`<script>` 内嵌 `</script>`、属性含引号。
3. 选择器/ID：不存在的 nodeId、重复 id、选择器注入、`data-hr-id` 被用户手工改坏。
4. 路径：`../` 穿越、符号链接、只读目录、不存在的父目录、非 ASCII 文件名、大小写敏感差异。
5. 并发/时序：同一文件并行 patch、watcher 抖动（保存 10 次）、WS 断连重连、patch 与外部编辑竞争。
6. 幂等/重入：同一 patch 执行两次、undo 两次、resolve 已 resolved 的批注。
7. 崩溃恢复：写入中途 kill、留下 `.tmp`、`hr-meta` JSON 非法、history 目录缺失。
8. 安全：注入 `<img onerror>`、`javascript:` 链接、`<style>` 逃逸、原型污染 `__proto__`、ReDoS 正则。
9. 性能：1MB 文档 outline/patch 耗时与内存，退化是否线性。
10. 可访问性（前端）：Tab 可达、焦点可见、屏幕阅读器标签、对比度。

---

## 七、提交与记录

- Commit：`type(scope): imperative summary`，type ∈ feat/fix/refactor/test/docs/chore/perf/build。一卡一 commit（返工可追加，但必须 `fix(...)` 并引用卡片 id）。
- 每张卡必须更新 `.workflow/reports/*.md` 与 `.workflow/state.md`；文档与代码同一次交付。
- 变更若影响公开 API 或 HTML 规范：必须同步更新 `docs/` 对应章节，否则 P1。

---

## 八、完成定义 (Definition of Done)

一张卡只有全部满足才算 `accepted`：

- [ ] 卡片 `AC` 逐条有证据（代码 + 测试 + 真实运行输出）。
- [ ] `pnpm verify` 全绿（含变异、依赖边界、knip、publint、size）。
- [ ] 覆盖率达标，变异分数达标，存活变异体已解释。
- [ ] 审计：无 P0/P1；P2 已登记。
- [ ] 测试报告含对抗实验结论（"有没有办法引起 bug"有明确答案）。
- [ ] 注释符合 §2；公共 API 全裸类型；无新增 `any`/`as`/`!`。
- [ ] 架构：依赖方向正确、无越界导入、文件/函数规模达标。
- [ ] 文档同步（README / docs / 卡片契约）。
- [ ] 无死代码、无 TODO（除登记项）、无调试输出。
- [ ] 协调者已复跑一次 `pnpm verify`（只读验证，不修代码）。
