# audit-M1.0 · Monorepo 骨架与最严 CI

**G2: FAIL**（3 × P0、4 × P1）

审计对象：`/Users/liu/Documents/Project/hReader` 未提交工作区（快照时间 2026-11-12 18:0x）。
只读审计；除本文件外未写入仓库（实验全部在 `/tmp/audit-m10` 的副本上做）。`packages/*/tests/**` 由测试员（G3）在 16:57 之后创建（mtime 晚于 impl 报告 16:50），不计入编写员越界；本报告只在"配置能否容纳这些测试"这个意义上评判它们。

## 0. 快照（真实树，我自己跑）

```
pnpm install --frozen-lockfile  exit=0  Already up to date（Scope: all 6 workspace projects）
pnpm format:check               exit=0  All matched files use Prettier code style!
pnpm lint                       exit=0
pnpm typecheck                  exit=0
pnpm test:coverage              exit=0  但屏幕上 4 个文件显示 0%（见 P1-3）
pnpm depcruise                  exit=0  ✔ no dependency violations（8 modules, 8 deps）
pnpm knip                       exit=0
pnpm verify                     exit=0
```

**这串绿灯不足以判定通过**，下面每条 P0 都是"绿灯下的事实"。

---

## P0-1 `pnpm typecheck` 完全不检查 `packages/*/tests/**`，测试里的类型错误、非法 `HrErrorCode` 一律放行

- 位置：`package.json:15`（`"typecheck": "tsc -b --pretty false"`）、`tsconfig.json:2-9`（`files: []` + 只引用 5 个包工程）、`packages/core/tsconfig.json:7`（`include: ["src/**/*.ts"]`）。
- 证据 ①：`packages/core/tests/tsconfig.json` 存在，但**不在**任何 references 里 ——
  `npx tsc -b --dry --verbose` 的项目列表只有 `packages/{core,protocol,renderer-html,chrome-extension,app}/tsconfig.json` + 根 `tsconfig.json`，没有 tests 工程。
- 证据 ②（/tmp 副本，`packages/core/tests/evil.test.ts` 里放 3 个错误）：

```
$ npx tsc -b --pretty false
TSC_B_EXIT=0                      ← 门禁绿

$ npx tsc -p packages/core/tests/tsconfig.json --noEmit
packages/core/tests/evil.test.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
packages/core/tests/evil.test.ts(4,26): error TS2367: This comparison appears to be unintentional because the types 'HrError' and 'number' have no overlap.
packages/core/tests/evil.test.ts(4,38): error TS2345: Argument of type '"nope_not_a_code"' is not assignable to parameter of type 'HrErrorCode'.
```

- 为什么是 P0：`packages/core/tests/hr-error.test.ts:6` 的注释写着"`Record<HrErrorCode, true>` 保证联合类型新增成员时此处缺键 → tsc 报错"。**这条保证不存在**——tests 不在 `tsc -b` 图里，ESLint 也从不报告 TS 编译错误。契约 2（TS 最严）与契约 7（typecheck 是门禁）在测试面上是空的，且仓库里放着一句自我认证的假注释。
- 修复方向：把测试工程接进 `tsc -b` 的引用图（tests 工程需 `composite: true`，或改成 `noEmit` 的独立工程由 `typecheck` 脚本逐个 `tsc -p` 调用）；每包一个，别只做 core。

## P0-2 契约允许的跨包依赖（`protocol → core`）一写出来就崩：tsc 报 TS6059/TS6307，运行时 ERR_MODULE_NOT_FOUND

- 位置：`tsconfig.base.json:33-39`（`paths` 把 `@hreader/*` 映射到**兄弟包的 src 源码**）、`packages/protocol/tsconfig.json:4`（`rootDir: "src"`）、5 个包 tsconfig 之间无 `references`、5 个包 `package.json` 无 workspace 依赖声明。
- 证据 ①（/tmp 副本，在 `packages/protocol/src/index.ts` 写 `import { HrError } from "@hreader/core"`，正是契约 4 允许的方向）：

```
$ npx tsc -b --pretty false
packages/protocol/src/index.ts(1,25): error TS6059: File '.../packages/core/src/index.ts' is not under 'rootDir' '.../packages/protocol/src'.
packages/protocol/src/index.ts(1,25): error TS6307: File '.../packages/core/src/index.ts' is not listed within the file list of project '.../packages/protocol/tsconfig.json'.
TSC_B_EXIT=1
```

- 证据 ②（真实树，解析层）：

```
$ node --input-type=module -e 'import("@hreader/core")'   # cwd=packages/app
FAIL ERR_MODULE_NOT_FOUND      ← 无 node_modules 链接，root 也没有 @hreader/* 依赖
```

- 为什么是 P0：契约 8 要求 `HrError`「`instanceof` 可判断」并且要跨包用它；当前配置下**跨包引用既不能编译也不能解析**，这张卡的唯一真实构件在跨包场景里无法被使用。更糟的是 impl 报告 `impl-M1.0.md:170` 明确指导测试员"在 `packages/protocol/tests/` 里 `import { HrError } from "@hreader/core"`"——照做会撞上 P0-2 + P1-2。impl 报告 §1 声称 `tsconfig.json` 提供"包间依赖按拓扑顺序检查"，该声明不成立。
- 修复方向：让跨包解析走**声明产物**（`exports` 加 `types` 指向 `dist/index.d.ts`，各包 `references` 指向被依赖包，`paths` 随之指向 `dist`）并在 `packages/*/package.json` 声明 `"@hreader/core": "workspace:*"`；若 M1 决定不支持跨包引用，则必须删掉 impl 报告里对测试员的相反指引，并把它写成已知限制。

## P0-3 depcruise 的两条依赖规则**永不触发**（`exclude` 含 `node_modules` 把 npm 边整条删掉）

- 位置：`.dependency-cruiser.cjs:50`（`exclude: { path: "(^|/)(node_modules|dist|coverage)/" }`）、`:37-38`（`to: { dependencyTypes: ["npm-no-pkg","npm-unknown"] }`）、`:44-45`（`to: { dependencyTypes: ["npm-dev"] }`）。
- 证据（/tmp 副本，`packages/core/src/` 里写违规 import）：

```
$ cat packages/core/src/probe.ts
import "eslint";        ← devDependency（且未在本包 package.json 声明）
import "left-pad";      ← 未声明、也不存在的包
export const a = 1;

$ npx depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (10 modules, 3 dependencies cruised)   exit=0

$ # JSON 里 probe.ts 的依赖只有一条，且类型是 unknown
left-pad | resolved: left-pad | types: ["unknown"]        ← 没有任何规则匹配 "unknown"
（"eslint" 这条边在图上根本不存在）
```

- 根因复算（同一副本，**只**把 `exclude` 里的 `node_modules` 去掉，其余不动）：

```
exclude: { path: "(^|/)(dist|coverage)/" }

$ npx depcruise --config .dependency-cruiser.cjs packages
  error no-undeclared-external-dep: packages/core/src/probe.ts → .../node_modules/.pnpm/eslint@9.39.1_.../eslint/lib/api.js
x 1 dependency violations (1 errors, 0 warnings)
```

- 为什么是 P0：契约 4 的六条里有两条（"src 不得 import devDependencies"、"不得 import 未声明的外部依赖"）实际是死规则，而它们拦的正是"本地能跑、干净 clone 就炸"的依赖。impl 报告 §1 把这两条记为已交付、§2 只用 ④（core→protocol）做负向验证，从未验证它们 —— 与契约"负向验证必须有证据"的目标背离。
- 修复方向：`exclude` 只保留 `dist|coverage`（保留 `doNotFollow: node_modules` 控制遍历深度）；同时复核 `npm-dev` 在"devDependencies 全在根"的布局下能否触发（`eslint` 被判成 `npm-no-pkg` 而非 `npm-dev`）——若不能，就明说该条由 `npm-no-pkg` 覆盖或改为按包声明 devDeps。

---

## P1-1 `.tsx` / `.mts` / `.cts` 完全不被 lint（静默零检查）

- 位置：`eslint.config.mjs:34`（`files: ["**/*.ts"]`），`:87`、`:93` 只补了 `mjs`/`cjs`。
- 证据（/tmp 副本）：

```
$ npx eslint packages/core/src/tsx-probe.tsx packages/core/src/mts-probe.mts
mts-probe.mts  errors: 1 [ 'File ignored because no matching configuration was supplied.' ]
tsx-probe.tsx  errors: 1 [ 'File ignored because no matching configuration was supplied.' ]
（文件内容是 `export const bad: any = 1;`；`eslint .` 时连这条提示都没有）
```

- 影响：renderer-html / chrome-extension / app 迟早出现 `.tsx`，那时 `no-explicit-any`、`as`、`max-lines-per-function` 全线失效且无人察觉。
- 修复方向：`files: ["**/*.{ts,tsx,mts,cts}"]`（必要时只给 `.tsx` 开 JSX parser 选项）。

## P1-2 只有 `packages/core` 有 tests 工程，在其余 4 包放测试会让 `pnpm lint` 直接解析失败

- 位置：`eslint.config.mjs:43`（`projectService.allowDefaultProject: ["*.config.ts"]`）、`eslint.config.mjs:27`（`CONFIG_TS_FILES`）。
- 证据（/tmp 副本，测试写在 `packages/protocol/tests/cross-package.test.ts`，即 impl 报告 `:170` 指定的位置）：

```
$ npx eslint packages/protocol/tests
  0:0  error  Parsing error: .../packages/protocol/tests/cross-package.test.ts was not found by the project service.
             allowDefaultProject is set to ["*.config.ts"], which does not match 'packages/protocol/tests/cross-package.test.ts'
✖ 1 problem (1 error, 0 warnings)
```

- 影响：测试义务 1（跨包 `instanceof`）最自然的落点会直接把 CI 打红，而且报错信息与"测试内容有问题"毫无关系，测试员会误判。
- 修复方向：每包一个 tests 工程（同时解决 P0-1），或把 `allowDefaultProject` 扩到 `packages/*/tests/**/*.ts` 并给默认工程补 `strict`。

## P1-3 `perFile + 100%` 对"无语句文件"给 100 分，且显示与判定互相矛盾

- 位置：`vitest.config.ts:17`（`include: ["packages/*/src/**/*.ts"]`）、`:19`（`perFile: true`）、`:20-25`（四项 100）。
- 证据 ①（真实树 `pnpm test:coverage` exit=0，但屏幕上是这样）：

```
 app/src            |       0 |        0 |       0 |       0 |
 ...-extension/src  |       0 |        0 |       0 |       0 |
 core/src           |     100 |      100 |     100 |     100 |
 protocol/src       |       0 |        0 |       0 |       0 |
 renderer-html/src  |       0 |        0 |       0 |       0 |
```

  同上一次运行的 `coverage-summary.json` 却写着 `packages/app/src/index.ts | lines 100 (0/0)`、`funcs 100 (1/1)`。
- 证据 ②（/tmp 副本，新增一个**只有类型**、无人 import 的 `packages/core/src/types-only.ts`）：
  `npx vitest run --coverage` → exit=0，表格里它显示 `0%`，`coverage-summary.json` 里是 `pct:100, 0/0`。而同一位置放一个**有语句**的 `real.ts` 才会红（`ERROR: Coverage for lines (88.88%) ...` exit=1）。
- 影响：契约 6 的"100% 覆盖"在占位包与纯类型模块上是零信号；更实际的风险是审阅者看到 CI 绿 + 屏幕 4 个 `0%`，无法判断到底是"没测"还是"没东西可测"。impl 报告 §1 声称 perFile 堵住了"加个空文件稀释分母"——稀释确实堵住了，但反向（空文件白拿 100%）没堵。
- 修复方向：把占位/纯类型文件从 `coverage.include` 显式排除并记录"为何无测试价值"，或加一条"每个被 include 的文件至少 1 条可执行语句"的自检；两者都要能解释现有 4 个 `0%`。

## P1-4 depcruise 六条规则全部锚定 `/src`，`tests/**` 完全不受边界约束

- 位置：`.dependency-cruiser.cjs:15-16, 22-23, 29-30, 37-38, 44-45`（`from.path` 均为 `^packages/.../src`）。
- 证据（/tmp 副本，在 `packages/core/tests/violation.test.ts` 里写 `import "@hreader/app";`）：

```
✔ no dependency violations found (7 modules, 2 dependencies cruised)   exit=0
```

- 影响：测试正是最容易"顺手 import 一个错方向"的地方；而且跨包 `instanceof` 测试（P0-2 的验证点）就在这个盲区里，写错了也没人拦。`no-circular` 例外（`from: {}`）是覆盖 tests 的。
- 修复方向：把 5 条规则的 `from.path` 放宽为 `^packages/[^/]+/(src|tests)`，或按 `dependencyTypes: ["local"]` 之外再加一组 tests 专用规则。

---

## P2（可排期，登记即可）

1. `eslint.config.mjs:71`：`no-restricted-imports` 只匹配 `@hreader/*/src/*`，需要尾段。`import "@hreader/core/src"` 实测既过 lint（无输出）也过 depcruise（`no violations`）——加一条 `@hreader/*/src` 独立 pattern。
2. `eslint.config.mjs:25-33`：`ignores` 未含 `**/*.d.ts`。实测现场曾在 16:53 出现 `packages/core/src/index.d.ts`（emit 落在 src 里），随后 `eslint .` 直接报 `Parsing error: ... was not found by the project service`——错误信息与真实问题无关，且该文件不被 `.gitignore` 覆盖（只忽略 `dist/`）。建议 `ignores` 加 `**/*.d.ts` 或把 `*.d.ts` 纳入 ignore 并在 `.gitignore` 补 `packages/*/src/**/*.d.ts`。
3. `knip.json:3`：`entry` = 各包 `src/index.ts`，因此**入口文件的所有导出永久豁免**死代码检测（实测在 entry 里加 `export const unusedFromEntry = 42;` 不报；在非 entry 的 `inner.ts` 里加 `neverUsed` 会报）。这是卡片规定的形状，但请把它写成显式约定，免得后人以为 knip 在管公开 API。
4. `.github/workflows/ci.yml:1-28`：无 `permissions:`（默认 GITHUB_TOKEN 过宽）、无 `concurrency`（同 PR 重复跑）；CI 逐条跑六步而**从不跑** `pnpm verify`，聚合脚本改坏了没人拦。
5. 卡片文本（`.workflow/cards/M1.0.md` 契约 7 / 目标）仍写 `pnpm ci`，与 R0.1 后的 `pnpm verify` 不一致。改卡是协调者的写权限，不是我。
6. `package.json:15` 的 `tsc -b` 依赖 `*.tsbuildinfo` 增量；本地 tsbuildinfo 存在时它是近空转（我验证 P0-1 时正好受益于此）。CI 是干净 clone 无此问题，但建议 CI 用 `tsc -b --force`，或在脚本里 `--clean` 后再 build。

---

## 已检查但未发现问题（可复算）

- `pnpm install --frozen-lockfile` exit=0，`pnpm-lock.yaml` 与 `package.json` 一致（`Scope: all 6 workspace projects`，`Already up to date`）。
- CI 无 `|| true` / `continue-on-error` / `--if-present` / `--passWithNoTests`；`--frozen-lockfile` 在 `ci.yml:22`；六步顺序与契约 7 一致；矩阵 `node: [22, 24]` + `ubuntu-latest` + `fail-fast: false`。
- `eslint-disable` 后门确实被堵：block / next-line / line 三种写法实测全部报 `no-warning-comments`（3/3）。
- `consistent-type-assertions(never)` 拦 `as` 与 `as unknown as`（实测）。`as const` 豁免是规则内建、无法配置关闭，只能收窄字面量、无法说谎——符合 impl 报告 §2② 的描述。
- `max-lines-per-function` **不能**用嵌套闭包拆分绕过：外层 78 行仍报 `Arrow function has too many lines (78). Maximum allowed is 40`（实测）。
- knip `--strict` 真会红：未使用文件、非入口文件的未使用导出都能抓到（实测），impl 报告负向验证 ⑤ 可复现。
- 包边界四条（`core-is-a-foundation` / `protocol-depends-on-core-only` / `renderer-html-ignores-hosts` / `no-circular`）工作正常，能精确指出违规边。
- 契约 1：5 个包 `private` / `type: module` / `sideEffects: false` / 包名 `@hreader/<dir>` / `exports → ./src/index.ts` 全部符合；四个占位包只有 `export {}`，无多余导出。
- 契约 8：`HrError` 无 `demo`/`hello`/占位常量；`packages/core/src/index.ts:1-2` 是层说明 + 契约，`:12-15` 的 JSDoc 说明"怎么用/怎么判"，属 §2 允许的契约注释，不是复述代码。
- `allowBuilds: esbuild: true` 生效：`pnpm ignored-builds` → `None`，esbuild 二进制已落地（10 MB）。
- **无越界**：编写员未写 `tests/**`；`docs/03-collaboration-workflow.md`（+1 行）与 `.workflow/state.md` 的改动出自协调者，内容与 R0.1 说明一致。
- R0.1 的 `pnpm ci` 判断正确且已被我复核：`pnpm ci --help` → `Usage: pnpm ci / Aliases: clean-install, ic, install-clean`，确实会遮蔽同名脚本；改名 `verify` 是正确处置。

## 结论

`G2: FAIL` —— 绿的是命令，不是门禁。P0-1 让整类测试类型错误隐身（且仓库里有一句依赖它的假注释），P0-2 让契约允可的跨包依赖既不能编译也不能解析，P0-3 让契约 4 的两条依赖规则成为死规则。这三条都是"用具体输入复算出来"的，不是读代码猜的。

建议返工顺序：P0-2（决定跨包解析方案，影响 P0-1/P1-2 的做法）→ P0-1/P1-2（tests 工程统一接线）→ P0-3（depcruise `exclude`）→ P1-1/P1-3/P1-4。

ACP: 62.6k (8%) ctx · 2 blocks · compressible 47.2K · delegate none
