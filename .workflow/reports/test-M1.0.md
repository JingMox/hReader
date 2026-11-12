# test-M1.0 · 测试员交付报告

卡片：`.workflow/cards/M1.0.md`；实现报告：`.workflow/reports/impl-M1.0.md`；规格：`docs/04-engineering-standards.md` §6。
结论：**`pnpm verify` 六道门禁全绿（EXIT=0）**，实现零缺陷需登记（未写 `src/**`）。R1 返工后的复核见 §6。

## 1. 交付物（全部在写入白名单内）

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `packages/core/tests/hr-error.test.ts` | 15 | `HrError` 契约：instanceof / name / code 全值 / message / cause / 可枚举面 |
| `packages/core/tests/entry-points.test.ts` | 3 | `@hreader/core` 公开面 + 跨 specifier 类身份 + 消费侧 instanceof（R1 从 7 降至 3，见 §6.1） |
| `packages/protocol/tests/core-contract.test.ts` | 3 | 跨包包名导入 `@hreader/core`：类型/解析/类身份/catch 取回 instanceof（R1 新增，P0-2 自证） |
| `packages/core/tests/gates.test.ts` | 10 | 门禁有效性（真实 eslint 配置，内存 lintText）+ ESLint 边界盲区取证 |

`31 passed (31)`，运行 1.4s。无 `any`、无 `as`、无 `@ts-ignore`、无 `eslint-disable`（自测文件同样过全部门禁）。
原 `packages/core/tests/tsconfig.json` 已在 R1 删除：单根 `tsconfig.json` 后它与根 `include` 重复定义同一批文件（impl §7.6.2 建议，属测试目录，归我处理）。

## 2. 真实输出

### 2.1 `pnpm verify`（最终）

```
$ prettier --check .        All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives   （无输出）
$ tsc --noEmit -p tsconfig.json --pretty false   （无输出；R1 起 tests 进编译图）
$ vitest run --coverage
 ✓ packages/protocol/tests/core-contract.test.ts (3 tests) 1ms
 ✓ packages/core/tests/entry-points.test.ts      (3 tests) 1ms
 ✓ packages/core/tests/hr-error.test.ts         (15 tests) 3ms
 ✓ packages/core/tests/gates.test.ts            (10 tests) 1107ms
      Tests  31 passed (31)
$ depcruise --config .dependency-cruiser.cjs packages

✔ no dependency violations found (6 modules, 6 dependencies cruised)
$ knip --strict            （无输出）
VERIFY_EXIT=0
```

> 本节其余输出（门禁表、覆盖率实验、变异体、负路径）取自 R1 之前的那一轮，原始配置下的结论仍然成立；R1 之后的复验数据统一放在 §6。
✔ no dependency violations found (8 modules, 8 dependencies cruised)
$ knip --strict            （无输出）
VERIFY_EXIT=0
```

### 2.2 门禁有效性（不是"跑了 verify 就算"）

`gates.test.ts` 用 `new ESLint({ cwd: <repo> })` 的 `lintText` 在内存里跑**仓库真实 `eslint.config.mjs`**（含 `projectService` + `tsconfigRootDir`）。`filePath` 复用 `packages/core/tests/gates.test.ts` 自身：projectService 拒绝不属于任何 tsconfig 工程的路径（早期用不存在的 `tests/fixtures/probes/probe.ts` 会报 `parserOptions.project` 找不到工程）。磁盘上的本文件保持 lint 干净，探针内容只存在于内存。

| 探针 | 期望 ruleId | 结果 |
| --- | --- | --- |
| `const loose: any = value` | `@typescript-eslint/no-explicit-any` | ✅ |
| `raw as number` | `@typescript-eslint/consistent-type-assertions` | ✅ |
| 49 行函数（`max: 40`） | `max-lines-per-function` | ✅ |
| 11 个 `if`（complexity 12 > 10） | `complexity` | ✅ |
| `// @ts-ignore` | `@typescript-eslint/ban-ts-comment` | ✅ |
| `// eslint-disable-next-line` | `no-warning-comments` | ✅ |
| `import "@hreader/core/src/index"` | `no-restricted-imports` | ✅ |
| `export default 1` | `import/no-default-export` | ✅ |
| 干净文件 `export {}`（对照） | 空数组 | ✅ 说明探针不是"一律报错" |
| `import "@hreader/protocol"`（盲区取证） | **不含** `no-restricted-imports` | ✅ 证明 ESLint 不守包根边界 |

`@hreader/core → @hreader/protocol` 这条**故意不走 lintText**：`no-restricted-imports` 只配了 `@hreader/*/src/*`、`@hreader/*/dist/*` 深层路径，根导入不在 ESLint 职责内。改在仓库内用真实 depcruise 取证（临时文件，已删除）：

```
error core-is-a-foundation: packages/core/src/tmp-boundary.ts → packages/protocol/src/index.ts
x 1 dependency violations (1 errors, 0 warnings)   INREPO_EXIT=1
```

对照组（`/tmp/hrdep` 迷你工程 + 仓库同一份 `.dependency-cruiser.cjs`，`core` 不引 `protocol`）：
`✔ no dependency violations found` `CLEAN_EXIT=0`。选 depcruise 而非 lintText 的理由：该规则的实现依赖**模块解析后**的 `to.path`，ESLint 侧没有对应能力，硬塞一条 `no-restricted-imports` 会与 `@hreader/protocol` 的合法下游依赖冲突。

### 2.3 覆盖率不虚高（两次临时实验，文件已删）

| 实验 | 临时文件 | 结果 |
| --- | --- | --- |
| A 零语句文件 | `packages/core/src/tmp-probe.ts` = `export {};` | `tmp-probe.ts | 0 | 0 | 0 | 0`，但 **A_EXIT=0**（门禁没红） |
| B 有未测分支 | 同上，改为 `if (flag) {...} return 2;` 且无人引用 | `ERROR: Coverage for lines (57.14%) does not meet global threshold (100%)`（branches/functions/statements 同）**B_EXIT=1** |

结论：门禁对**真实代码**有效（B 红），对**零语句文件**空转（A 绿）。这正是 `entry-points.test.ts` 存在的理由——它断言 5 个入口都能被加载、`@hreader/core` 运行期导出面恰为 `["HrError"]`、其余占位包为空，补上覆盖率看不见的那部分。实验后 `git status --untracked-files=all | grep tmp-probe` = 0。

`packages/core/src/index.ts` 的分支两条路径都有断言覆盖：`cause` 传入（`"cause" in error === true`）/ 省略 options / 传 `{}` 无 cause 键。v8 报告 `core/src/index.ts 100/100/100/100`，`total 100/100/100/100`。

### 2.4 负路径：非法 code 被编译器拒绝（无用例内 `@ts-expect-error`，那是被禁的）

`/tmp/hrneg/tsconfig.json`（`paths: {"@hreader/core": [.../packages/core/src/index.ts]}`，strict）分别编译：

```
neg.ts(2,32): error TS2345: Argument of type '"not-a-code"' is not assignable to parameter of type 'HrErrorCode'.
NEG_EXIT=2
control: const ok: string = new HrError("locked", "boom").code;   → POS_EXIT=0
```

用例内另设**类型保鲜闸**：`const CODE_MATRIX: Record<HrErrorCode, true>`。实测（临时文件 `packages/core/tests/tmp-matrix-guard.ts`，已删）：

```
tsc -p packages/core/tests/tsconfig.json  → TESTS_TSC_EXIT=0
删掉 locked 键后 → TS2739: Type '{ invalid_html: true; no_article: true; }' is missing ... 'locked'  GUARD_EXIT=2
```

**R1 状态**：该保证现在**真的生效**——单根 `tsconfig.json` 把 `packages/*/tests/**` 纳入 `pnpm typecheck`，实测删掉 `locked` 键 → `error TS2741: Property 'locked' is missing ... but required in type 'Record<HrErrorCode, true>'`（§6.3 实验 A2）。R1 之前那句“只在显式 typecheck 时成立”已随 P0-1 关闭作废。

## 3. 每个断言"若实现坏掉它会怎么红"

用真实变异体跑真实测试文件取证（`/tmp/hrmut`：`src/index.ts` 换成变异版 + 复制 `hr-error.test.ts` + 软链仓库 `node_modules`；**仓库 `src/**` 全程未改**）：

| 变异 | 红掉的用例 | 计数 |
| --- | --- | --- |
| M1 删 `this.name = "HrError"` | `name` 稳定 + 可枚举面 | 2 failed / 13 passed |
| M2 `super(message)` 丢 cause | cause by identity | 1 failed / 14 passed |
| M3 `this.code = "locked"` 写死 | instanceof 后 code + 6 个 code 逐值 | 7 failed / 8 passed |
| M4 `super("", options)` 吞 message | name（toString）+ throw/catch + 逐字 message | 3 failed / 12 passed |
| 门禁 M5 删 `no-explicit-any` 规则 | `lint gate: any 注释`（`toContain` 失败） | 未执行，等价于 2.2 首轮 `expected [] to include ...` 的失败形态 |

逐条映射（实现改动 → 哪个断言响）：

- `instanceof HrError` → 类不再是 `Error` 子类 / 入口被复制成两份类（M1 之外的 `entry-points` 双 specifier 用例专门守这点）失败。
- `name === "HrError"` → M1 红；`toString()` 顺带守住 `name` 与 `message` 的拼接。
- `code` 透传 → M3 红（每值一条 + 独立性一条）。
- `message` 保留 → M4 红；列表含 `""`、中文、emoji、含 `<script>`、换行，任何 trim/转义/截断都会红。
- `cause` 透传 → M2 红（身份比较 `toBe`，不是深比较）。
- 可枚举面 → 新增任何 `this.x = ...`、或 `cause` 变可枚举、或 `message` 被改成可枚举，`Object.keys(...).sort()` 与 `propertyIsEnumerable` 三元组立刻红。
- 公开面 → 多导出一个运行期符号（如顺手导出 `HrErrorCode` 的运行时表）→ `["HrError"]` 精确相等失败；占位包被塞进任何东西 → 空数组断言失败。

## 4. 仍存裂缝（登记，不自行扩权修）

1. **[R1 仍在] 覆盖率门禁对零语句文件空转**（§2.3 实验 A；R1 复测见 §6.6 实验 I，`__r1_empty.ts` 显示 `0 | 0 | 0 | 0` 但 `I_EXIT=0`）。`perFile` 修好也只管“有语句但没跑全”，管不了 0/0。
2. **[R1 已关闭] 测试不在类型检查图里**（`audit-M1.0.md` P0-1）：单根 tsconfig 后 tests 进主编译图，§6.3 A1/A2 自证红。此处保留一条自责：初稿注释曾写成无条件保证，已改为可验证陈述。
3. **正式变异门禁未落地**：仓库无 stryker 依赖且 `package.json` 冻结。本轮以 4 个手搓变异体在 `/tmp` 取证（4/4 被杀死）；常驻 mutation gate 需批准加 devDependency。
4. **[R1 部分关闭] `@hreader/*` 运行期不可解析**：在仓库里（tsconfig paths + vitest alias 指向源码）typecheck 与 vitest 都通（§6.4）；但**裸 Node 仍 ERR_MODULE_NOT_FOUND**（§6.4 实测），是 impl §7.7 已声明的限制，不是缺陷。仍有坑：`core` 的 tests 不能包名导入其他包（会被 `core-is-a-foundation` 判错，impl 探针⑤）。
5. **[R1 已关闭] 测试工程的 lint 上下文单点**：改为单根工程后无需每包 tsconfig；残留的 `packages/core/tests/tsconfig.json` 已删，lint/typecheck 均无需它。
6. **[R1 已关闭] depcruise 规则原只锚定 `/src`**：R1 后规则改成 `(src|tests)`，protocol 的 `tests/` 边已被真实分析（§6.4）。
7. `gates.test.ts` 的探针只依赖**语法层**结论；未来若加类型感知探针（如 `no-unsafe-assignment`），因为 lintText 的类型信息来自磁盘那份文件，必须改为真实文件工程。
8. `eslint-disable` 探针断言的是 `no-warning-comments`；`--report-unused-disable-directives` 的实际拦截由 `pnpm verify` 覆盖，未单独断言（verify 必跑，可接受）。

## 5. 实现缺陷

**本轮测试未发现 `HrError` 行为缺陷**：32 个用例（29 条 `expect`，`it.each` 展开后约 41 条断言）对 4 个变异体 4/4 击杀，公开面/包边界/错误契约均符合卡片。

门禁层面的事实（非实现 bug，已交叉引用 `audit-M1.0.md`）：tests 不进 `tsc -b`（P0-1）、`@hreader/*` 运行期不可解析（P0-2）、depcruise 两条 npm 规则死路（P0-3）、零语句文件覆盖率空转（P1-3）、`tests/**` 不受 depcruise 约束（P1-4）。这些需要改根配置/`package.json`，超出测试员白名单，**未自行修**。

未对 `src/**`、根配置、`eslint.config.mjs`、`tsconfig*`、`package.json`、卡片做任何改动（`git status` 仅新增 `packages/core/tests/**` 与本报告）。

ACP: Estimate: 41.1k (5%) | Provider-reported: 47.5k (6%)

## R1 复核（返工后复验）

前提：编写员按审计完成 R1（单根 tsconfig 纳入 tests、跨包走源码、depcruise 修死规则、删 4 个空包入口）。本节所有结论均为**我自己造的证据**（`/tmp/hrr1` 副本 + 仓库内新用例），未采信 impl/audit 报告的自述。

### 6.1 改了什么（只动 tests）

1. `packages/core/tests/entry-points.test.ts` 重写（7 → 3 用例）：R1 §3 删掉了 `protocol`/`renderer-html`/`chrome-extension`/`app` 的 `src/index.ts`，原来那 4 个 import 指向不存在的模块，整个文件的前提消失。现在只守 `@hreader/core`：公开面恰为 `["HrError"]`、双 specifier 类身份、消费侧可窄化。
2. 新增 `packages/protocol/tests/core-contract.test.ts`（3 用例）：**用裸包名** `import { HrError } from "@hreader/core"`，同时覆盖 typecheck、vitest 解析、`instanceof`、`catch` 取回、重复 import 的类身份（P0-2 自证载体）。
3. 删除 `packages/core/tests/tsconfig.json`（单根工程后与根 `include` 重复定义同一批文件；在 tests 目录内，归我处理）。

### 6.2 lint 错根因（不是 `it.each` 的锅，是"入口被删"）

`/tmp/hrr1` 复现：`import * as missingEntry from "../../app/src/index"` + `Object.keys(missingEntry)` →

```
7:24  error  Unsafe argument of type error typed assigned to a parameter of type `{}`  @typescript-eslint/no-unsafe-argument
packages/core/tests/__r1_rootcause.test.ts(3,31): error TS2307: Cannot find module '../../app/src/index' or its corresponding type declarations.
```

链条：R1 删空入口 → `TS2307` → 模块命名空间退化为 `error`/`any` → 传入 `Object.keys` 的 `{}` 参数即 `no-unsafe-argument`（原报错行 23:24 正是 `it.each` 回调里的 `Object.keys(entry)`）。对照实验：行类型显式标注、模块可解析的同一写法 lint 干净（`K_LINT_EXIT=0`）；只改 `it.each` 表结构也能消错，但那只是掩盖。R1 让 tests 进类型感知 lint 后，这条从"隐形"变"报错"，属门禁变严。

### 6.3 P0-1 自证（tests 真的进类型检查了）

`/tmp/hrr1` 副本，基线 `BASE_EXIT=0`：

| 实验 | 探针 | 真实输出 |
| --- | --- | --- |
| A1 | `packages/core/tests/__r1_probe.test.ts` 写 `const probe: number = "not a number"` | `error TS2322: Type 'string' is not assignable to type 'number'.` `A_EXIT=2` |
| A2 | 删 `hr-error.test.ts` 中 `CODE_MATRIX` 的 `locked` 键 | `error TS2741: Property 'locked' is missing ... but required in type 'Record<HrErrorCode, true>'.` `B_EXIT=2` |
| B | `packages/core/src/__r1_probe.mts` 写类型错误 | `error TS2322 ... __r1_probe.mts(1,14)` `B_EXIT=2`（`**/*.mts` 确实在 include） |
| C | 新建 `scripts/x.ts`（不在 include） | `tsc` 绿 `C_TSC_EXIT=0`，但 lint 硬红：`Parsing error: /private/tmp/hrr1/scripts/x.ts was not found by the project service` `C_LINT_EXIT=1` |

结论：A2 同时证明我在 `hr-error.test.ts` 里那句注释**现在是真的**（`CODE_MATRIX` 缺键由 `pnpm typecheck` 拦截，不再是自我认证）。

### 6.4 P0-2 自证（跨包只走包名）

- 仓库内：`packages/protocol/tests/core-contract.test.ts` 用 `@hreader/core` → `tsc` 0 错；`vitest` 3 passed；`instanceof`、`catch` 取回的 `unknown` 窄化、`await import("@hreader/core")` 与静态导入**同一个类**（说明走的是同一份源码，没有重复模块实例）。
- 漂移实验（/tmp）：删 `vitest.config.ts` 的 `@hreader/core` alias → `Cannot find package '@hreader/core'`（`D_EXIT=1`）；删 `tsconfig.base.json` 的 paths → `TS2307` + `TS18046`（`E_EXIT=2`）。两条链都被真实使用。
- 边界（impl §7.7 已声明，是限制不是缺陷）：`node -e 'import("@hreader/core")'` → `NODE_FAIL: ERR_MODULE_NOT_FOUND`。

### 6.5 P0-3 自证（depcruise 的 npm 规则不再架空）

`/tmp/hrr1` 里把探针 import 逐条塞进 `packages/core/src/__r1_probe.ts`：

| import | 命中 |
| --- | --- |
| `eslint`（core 的 devDependency） | `no-dev-dependency-from-src` ✅ |
| `prettier` / `typescript` / `dependency-cruiser`（根 devDep、core 未声明） | `no-undeclared-external-dep` ✅ |
| `left-pad`（未安装） | `no-unresolvable` ✅ |
| `vitest`（core 未声明！） | **0 报错** ❌ → P1-A |

### 6.6 新裂缝（本次复核实测，未修）

- **P1-A `exclude` 的 dist 盲区**：`exclude: { path: "(^|/)(dist|coverage)/" }` 会吞掉**任何**解析落在 `dist/` 的边（不只是本仓库 build 产物），于是 `import "vitest"` 这种未声明依赖在 `no-undeclared-external-dep` 下静默通过；换成 `import "vitest/node"`（解析到 `node_modules/vitest/node.d.ts`）立刻被抓。把 exclude 收窄为 `^(coverage/|packages/[^/]+/(dist|coverage)/)` 后瞬间冒出 4 条真实违规（`packages/*/tests/*.test.ts → vitest/dist/index.js`）——**说明修这条得先给带 tests 的包声明 `vitest` devDependency**，否则一修就红。属根配置 + `package.json`，不在我白名单。
- **P1-B 零语句文件仍白送 100%**（实验 I，`I_EXIT=0`）：`packages/core/src/__r1_empty.ts` = `export {}` 显示 `0 | 0 | 0 | 0` 却整轮通过；`perFile: true` 只治"有语句没跑全"（实验 H：`ERROR: Coverage for lines (66.66%) ... for packages/core/src/__r1_cov.ts`，`H_EXIT=1`），治不了 0/0。
- **P1-C 包清单三处重复**：`tsconfig.base.json` 的 `paths`、`vitest.config.ts` 的 `ALIASES`、`.dependency-cruiser.cjs` 规则里的包路径。漂移只在"有测试用到该包名"时才被抓（D/E 证明），新增包漏改一处可能全绿。建议从各包 `package.json#name` 派生。
- **P2-D knip 不认 tsconfig paths**：删掉 `knip.json` 的 `workspaces.packages/protocol.ignoreDependencies` 后 `knip --strict` 报 `Unused dependencies (1) @hreader/core packages/protocol/package.json:8:6`（`F_EXIT=1`），尽管 protocol 的测试真的 import 它。所以该豁免**现在仍必要**，impl §7.8.1 的"有代码引用即可删"此刻不成立（需 workspace 链接或 knip 指向源码）。
- **P2-E typecheck 只覆盖 include 白名单**：新目录（如 `scripts/`）靠 lint 的 projectService 报错兜底，没有第二道（实验 C）。可接受，但"typecheck 绿"≠"全仓 .ts 都被检查"。

### 6.7 门禁用例在新配置下仍然有效（重跑 + 反证）

- 重跑：`gates.test.ts` 10/10 通过（新配置：tests 进类型感知 lint、单根工程、无 per-package tsconfig）。
- 反证：把 `"@typescript-eslint/no-explicit-any": "error"` 改成 `"off"` → `Tests 1 failed | 9 passed`，`AssertionError: expected [ Array(1) ] to include '@typescript-eslint/no-explicit-any'`。
- **踩坑记录（重要）**：一开始只删那一行，10/10 仍绿——因为 `tseslint.configs.strictTypeChecked` 本身也开启该规则。删规则 ≠ 关规则；探针必须显式 `off`，否则会得出"gates 无效"的假结论。

### 6.8 最终 `pnpm verify` 与覆盖率

```
$ prettier --check .        All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives   （无输出）
$ tsc --noEmit -p tsconfig.json --pretty false                   （无输出）
$ vitest run --coverage
 ✓ packages/protocol/tests/core-contract.test.ts (3 tests)
 ✓ packages/core/tests/entry-points.test.ts      (3 tests)
 ✓ packages/core/tests/hr-error.test.ts         (15 tests)
 ✓ packages/core/tests/gates.test.ts            (10 tests)
      Tests  31 passed (31)
$ depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (6 modules, 6 dependencies cruised)
$ knip --strict            （无输出）
VERIFY_EXIT=0
```

覆盖率：`packages/core/src/index.ts` 100/100/100/100，`All files` 100。用例总数 31（R1 前 32：少的 1 个来自被删除的 4 个空入口断言）。

入库面：`git status` 中测试侧仅 `packages/core/tests/**`、`packages/protocol/tests/**`、本报告，外加**删除**的 `packages/core/tests/tsconfig.json`；未触碰 `src/**`、根配置、`eslint.config.mjs`、`tsconfig*`、`package.json`、卡片与 impl 报告。

ACP: Estimate: 59.5k (8%) | Provider-reported: 76.3k (10%)
