# impl-M1.0 · Monorepo 骨架与最严 CI

状态：交付完成（5 项门禁全绿；`test:coverage` 因「仓库内无测试文件」按设计为红，见 §4）。R0.1 补丁已应用（聚合脚本改名 `verify`，见 §6）。

## 1. 交付清单与各自解决的风险

| 文件 | 解决的风险（具体到会出什么事） |
| --- | --- |
| `pnpm-workspace.yaml` | 五个包被识别为同一 workspace；`allowBuilds: esbuild: true` 防止 pnpm 11 默认拦截 esbuild postinstall 导致 vitest 二进制缺失（pnpm 10 的 `onlyBuiltDependencies` 在 11 已改名，写错键会静默不生效） |
| `package.json` | 单一入口提供全部门禁脚本，聚合脚本 `verify` 用 `&&` 串联（任一红即中断）；`packageManager` 钉死 pnpm 11.1.3 避免"我机器上是绿的"；脚本名不与 pnpm 内建命令同名（R0.1，见 §6） |
| `pnpm-lock.yaml` | 依赖可复现；CI 用 `--frozen-lockfile`，lockfile 与 package.json 不一致时直接失败而不是偷偷重解析 |
| `.npmrc` | `engine-strict=true` 让 Node < 22 立刻报错而非运行到一半崩；`save-exact=true` 防止后续加依赖时出现 `^` 漂移 |
| `.gitignore` | 新增 `*.tsbuildinfo`、`.eslintcache`：`tsc -b` 的增量文件与 lint 缓存本来会被误提交，造成"本地绿/CI 红"的假象 |
| `.editorconfig` | 换行/编码在不同编辑器间不一致 → Prettier 与 git diff 反复抖动 |
| `.prettierrc.json` / `.prettierignore` | 格式成为机械判定，代码评审不再讨论空格；忽略 `node_modules`、`dist`、`coverage`、`pnpm-lock.yaml` |
| `tsconfig.base.json` | 打开卡片要求的全部最严开关（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noPropertyAccessFromIndexSignature`、`noImplicitReturns`、`verbatimModuleSyntax`、`isolatedModules`），另加 `noUnusedLocals/Parameters`、`noFallthroughCasesInSwitch`、`allowUnreachableCode:false`；`paths` 让跨包引用在 tsc 侧可解析 |
| `tsconfig.json` | solution-style references：`tsc -b` 一次构建五包，且包间依赖按拓扑顺序检查 |
| `packages/*/tsconfig.json` | 每包 `rootDir: src` + `composite`，越界引用包外文件会直接报错（防止 M2 之后悄悄跨包引源码） |
| `packages/*/package.json` | `private` 防误发布到 npm；`exports` 只暴露 `./src/index.ts`，深路径导入在运行时会解析失败（M1 不打包，解析即源码） |
| `eslint.config.mjs` | flat config + `strictTypeChecked` + `stylisticTypeChecked`；卡片要求的 8 条硬规则全部 error；`no-warning-comments` 把 `eslint-disable/ts-ignore/ts-expect-error` 变成违规（否则门禁可被一行注释绕过）；`no-restricted-imports` 堵 `@hreader/*/src/*` 深导入 |
| `.dependency-cruiser.cjs` | 卡片 §4 五条边界全部 error：无环、core 为地基、protocol 只依赖 core、renderer-html 不依赖宿主、src 不得引 devDependencies/未声明依赖。这些边界一旦破了，M3 拆包时才发现就只能重写 |
| `knip.json` | entry = 各包 `src/index.ts`，`--strict` 下未使用文件/导出/依赖都失败；ignore 仅 `docs/**`、`skills/**`（卡片允许的两项） |
| `vitest.config.ts` | `projects` 分片到五包（vitest 3 的 `workspace` 字段已弃用）；覆盖率 `perFile: true` + 四项 100%，堵住"一个文件测 90% 被其他文件平均掉"和"加个空文件稀释分母" |
| `.github/workflows/ci.yml` | ubuntu-latest × node 22/24，`--frozen-lockfile`，六步串行；无 `continue-on-error`、无 `|| true`，任何一步失败即 job 失败 |
| `packages/core/src/index.ts` | 最小真实构件：`HrError` + `HrErrorCode` 窄联合。后续每张卡都要用（跨包 `instanceof` 判定 + 稳定 `code` 分支），不造 demo 常量 |
| 其余四包 `src/index.ts` | `export {}` 占位，公开入口就位，无未使用导出 |

未引入卡片未要求的工具（无 turbo / nx / biome / changesets）。CI 里没有缓存构建产物，M1 只有 declaration emit，代价可忽略。

## 2. 负向验证（真实输出，临时文件已删除）

**① `any` → lint 红**

```ts
// packages/core/src/bad-a.ts
export const bad = () => {
  const x: any = 1;
  return x;
};
```

```
/Users/liu/Documents/Project/hReader/packages/core/src/bad-a.ts
  2:12  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  3:3   error  Unsafe return of a value of type `any`    @typescript-eslint/no-unsafe-return

✖ 2 problems (2 errors, 0 warnings)
[ELIFECYCLE] Command failed with exit code 1.
=== lint exit: 1 ===
```

**② `as` 断言 → lint 红（并顺带验证 `as const` 的豁免边界）**

```ts
// packages/core/src/bad-b.ts
const raw: unknown = 1;
export const casted = raw as number;
export const tuple = ["a", 1] as const;
```

```
/Users/liu/Documents/Project/hReader/packages/core/src/bad-b.ts
  2:23  error  Do not use any type assertions  @typescript-eslint/consistent-type-assertions

✖ 1 problem (1 error, 0 warnings)
=== lint exit: 1 ===
```

注意：`as const` **没有**被报错（`consistent-type-assertions` 对 `as const` 有内建豁免，`assertionStyle: "never"` 也拿它没办法，且无法通过配置关掉）。这不是我留的口子：`as const` 只把字面量类型收窄、不制造任意类型断言，无法用来说谎；真正的 `as T` 全部拦下。

**③ 44 行函数（含注释/空行计数）→ lint 红**

```
/Users/liu/Documents/Project/hReader/packages/core/src/bad-c.ts
  1:21  error  Arrow function has too many lines (44). Maximum allowed is 40  max-lines-per-function

✖ 1 problem (1 error, 0 warnings)
=== lint exit: 1 ===
```

**④ `core` 依赖 `protocol` → depcruise 红**

```ts
// packages/core/src/bad-d.ts
import "@hreader/protocol";
```

```
  error core-is-a-foundation: packages/core/src/bad-d.ts → packages/protocol/src/index.ts

x 1 dependency violations (1 errors, 0 warnings). 6 modules, 1 dependencies cruised.
=== depcruise exit: 1 ===
```

**⑤ 未被引用的源码文件 → knip 红**

```ts
// packages/core/src/orphan.ts
export const orphaned = 1;
```

```
$ knip --strict
Unused files (1)
packages/core/src/orphan.ts
[ELIFECYCLE] Command failed with exit code 1.
=== knip exit: 1 ===
```

## 3. 主动放弃 / 放宽的严格项

1. **`skipLibCheck`：最终 `false`**（无放宽）。先按卡片允许置 `true`，实测 `false` 下 `tsc -b` 也全绿，故按最严取 `false`。
2. **`*.config.ts` 关闭类型感知规则**（`tseslint.configs.disableTypeChecked`）。原因：`vitest.config.ts` 落在所有 tsconfig 编译图之外（Scope 不允许我新增 `tsconfig.eslint.json` 或把它塞进某个包的 `include`）；改用 `projectService.allowDefaultProject` 会生成一个**无 `strictNullChecks`** 的默认工程，导致 4 条类型感知规则刷出"requires strictNullChecks"伪错误，比关掉更糟。影响面：仅 `*.config.ts`（当前 1 个文件），仍受 Prettier 与语法类规则约束。
3. **Prettier 忽略 `docs/**`、`.workflow/**`**。原因：这两个目录不在编写员写权限内，且上游文档本身未通过 `prettier --check`（实测 8 个不合规文件里有 6 个属于这两个目录）——我不能改，也不该让它永久染红 CI。副作用：`impl-M1.0.md` 本条报告同样不被格式检查。
4. **未开启 `eslint-plugin-import` 的 `no-extraneous-dependencies`**：与 depcruise 的 `npm-no-pkg/npm-unknown/npm-dev` 规则重复，且该规则对 workspace/`paths` 别名易误报。未声明依赖这一风险由 depcruise 覆盖（④ 已实测能拦包间越界，devDependency 违规规则同引擎同理）。
5. **未额外引入** turbo / nx / biome / changesets / husky：卡片未要求，M1 不需要任务图缓存。

## 4. 真实命令输出摘要（本机 node v24.15.0 / pnpm 11.1.3）

```
pnpm install                    exit=0   Already up to date（esbuild postinstall: Done）
pnpm install --frozen-lockfile  exit=0   Already up to date
pnpm format:check               exit=0   All matched files use Prettier code style!
pnpm lint                       exit=0   0 problems（--max-warnings=0 --report-unused-disable-directives）
pnpm typecheck                  exit=0   tsc -b --pretty false，无输出
pnpm depcruise                  exit=0   ✔ no dependency violations found (5 modules, 0 dependencies cruised)
pnpm knip                       exit=0   knip --strict，无输出
pnpm test:coverage              exit=1   No test files found, exiting with code 1
pnpm verify                     exit=1   聚合门禁：前三步绿，停在 test:coverage（见 §6 实测）
```

`test:coverage` 红的原始输出（M1.0 无测试文件，由测试员补齐后转绿）：

```
 RUN  v3.2.4 /Users/liu/Documents/Project/hReader
      Coverage enabled with v8

No test files found, exiting with code 1
...
ERROR: Coverage for lines (0%) does not meet global threshold (100%)
ERROR: Coverage for statements (0%) does not meet global threshold (100%)
```

**⚠️ 发现一个会误导审计的坑（R0.1 已修，根因与证据见 §6）：`pnpm ci` 被 pnpm 内建命令抢名。** pnpm 11 自带 `pnpm ci`（别名 `clean-install`/`ic`/`install-clean`，等价 `pnpm clean && pnpm install --frozen-lockfile`），优先级高于 `package.json` 的同名脚本，因此直接敲 `pnpm ci` **只会重装依赖并 exit 0，一条检查都不跑**。因此本项目已删除根脚本 `"ci"`，聚合门禁改名为 `verify`，入口 `pnpm verify`。`.github/workflows/ci.yml` 里六步仍是逐条显式写的（便于在 UI 上定位失败步骤），不受此影响，不会出现"CI 假绿"。

```
$ pnpm ci --help
Usage: pnpm ci
Aliases: clean-install, ic, install-clean
Runs "pnpm clean" followed by "pnpm install --frozen-lockfile".
```

聚合门禁的调用方式是 **`pnpm verify`**（或等价的 `pnpm run verify`，实测见 §6）。

`git status` 交付后只剩本卡 Scope 内文件（外加协调者的 `.workflow/cards/M1.0.md` 未跟踪），无临时文件残留。

ACP: 28.0k (4%) ctx · 4 blocks · compressible 9.3K · delegate none

## 5. 给测试员的话

**唯一入口（别绕）**

- 测试文件路径固定为 `packages/<pkg>/tests/**/*.test.ts`。`vitest.config.ts` 里每个 project 的 `root` 是 `packages/<pkg>`，`include` 是相对该 `root` 的 `tests/**/*.test.ts` —— 放在仓库根 `tests/`、或包内 `src/*.test.ts` 都不会被收集（后者还会被 lint/knip/覆盖率抓成问题）。
- 跨包只能用包名：`import { HrError } from "@hreader/core"`。深路径（`@hreader/core/src/...`）被 `no-restricted-imports` 拦、`exports` 也只放行 `./src/index.ts`。
- 跑单个包的测试用 `pnpm vitest run --project core`；全量门禁用 `pnpm verify`（或 `pnpm run verify`；**不要**用 `pnpm ci`，那是 pnpm 内建 clean-install，见 §6）。
- 测试里同样禁 `any`/`as`/`@ts-ignore`：`eslint .` 会扫到 `tests/**`（`no-warning-comments` + `ban-ts-comment` 都开着），所以"用 `as` 造违规数据"这类写法本身会先被 lint 打死，请用 `unknown` + 窄化或真实类型。

**M1.0 我认为你会这么写**

1. `packages/core/tests/hr-error.test.ts`：`new HrError("no_article", "msg")` → `instanceof HrError`、`instanceof Error`、`name === "HrError"`、`code` 稳定为字面量、`cause` 透传（`new HrError("locked", "m", { cause })` → `error.cause === cause`）。"跨包 instanceof" 最省事的写法是在 `packages/protocol/tests/` 里 `import { HrError } from "@hreader/core"` 构造并断言（protocol→core 是允许方向，depcruise 不会拦）。
2. 四个占位包：至少 `await import("@hreader/protocol")` 之类把入口拉进覆盖率。**注意风险**：`export {}` 的文件没有任何语句，v8 可能把它报成 `% Stmts 0`（我在空跑时看到 `core/src/index.ts` 是 `0% stmts / 100% branch`）。若 import 后仍红，请先确认是"文件未被加载"还是"零语句文件的统计口径"，再决定是在入口加一条真实导出还是调整 `coverage.include` —— 别用 `/* v8 ignore */` 蒙混，那会触发 `no-warning-comments`。
3. 门禁有效性：本报告 §2 的五条可直接复用为用例，断言点是**退出码非 0**，不要断言整段日志文案（文案随版本漂移）。跑子进程时 cwd 必须是仓库根，否则 `eslint .` 读不到 flat config。
4. 覆盖率不虚高：在 `packages/core/src/` 临时加一个有语句但没测试的文件 → `test:coverage` 必须红（`perFile: true` + 100%），验证完删除。注意 `dist/`、`coverage/` 已被忽略，别把断言写在产物上。

## 6. R0.1 补丁：`ci` → `verify`（P0 修复）

**根因**：pnpm 11 的 CLI 先解析**内建命令**，再回落到 `package.json` 脚本。`pnpm ci` 是内建命令（`Usage: pnpm ci`，别名 `clean-install`/`ic`/`install-clean`，语义 = `pnpm clean && pnpm install --frozen-lockfile`），于是根脚本 `"ci"` 永远不会被执行 —— 敲 `pnpm ci` 只重装依赖、exit 0，形成**假绿**，且不会报任何"脚本被遮蔽"的警告。这类坑的共性是：门禁看起来在跑，实际上什么都没验。

**修法**

1. 根 `package.json` 删除 `"ci"`，聚合脚本改名 `"verify"`；不保留任何与 pnpm 内建命令同名的脚本。
2. `.github/workflows/ci.yml` 保持六条命令逐条显式执行（失败步骤在 Actions UI 上一眼可定位，不会因为一条聚合命令而丢掉"是哪一步红"的信息）；文件内不存在 `pnpm ci` 字样。
3. 命名规则升格为硬约定，已由协调者写入 `docs/03-collaboration-workflow.md`：**门禁命令不得与包管理器内建命令同名**，本仓聚合入口统一 `pnpm verify`。

**证据（本机 pnpm 11.1.3 实测）**

```
$ pnpm ci --help
Usage: pnpm ci
Aliases: clean-install, ic, install-clean
Runs "pnpm clean" followed by "pnpm install --frozen-lockfile".
```

```
$ pnpm run verify
$ pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm depcruise && pnpm knip
Checking formatting...
All matched files use Prettier code style!
No test files found, exiting with code 1          ← 停在 test:coverage（M1.0 无测试文件，预期）
[ELIFECYCLE] Command failed with exit code 1
=== pnpm run verify exit: 1 ===
```

```
$ pnpm verify            ← 不带 run 也解析到脚本，不是内建命令
$ pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm depcruise && pnpm knip
Checking formatting...
All matched files use Prettier code style!
No test files found, exiting with code 1
=== pnpm verify exit: 1 ===
```

两种写法都打印了聚合命令行（说明执行的是脚本，不是内建），且都真实跑到 `test:coverage` 才中断 —— 说明 format:check / lint / typecheck 三步确实被执行；`depcruise` / `knip` 在此链中被 `&&` 挡在后面，单独跑均 exit 0（§4）。

**同名冲突自查**（答辩材料，以后新增脚本前先跑一遍）：

```
$ pnpm help -a | grep -oE '^ {2,7}([a-z][a-z0-9-]*)' | tr -d ' ' | sort -u   # 45 条内建命令
# 与 package.json scripts 求交集 → none
```

当前脚本：`verify, format:check, format, lint, typecheck, test, test:coverage, depcruise, knip`。唯一与 pnpm 词汇重合的是 `test`，但 pnpm 的 `pnpm test` 本身**就是**"跑名为 test 的脚本"的既有快捷方式（实测：`pnpm test` 输出 `RUN v3.2.4` + `No test files found`，确实执行了 vitest），不存在遮蔽，且卡片要求该脚本名保留。

**产物入库自查**：`tsc -b` 以 `emitDeclarationOnly: true` + `composite` 运行，会在 `packages/*/dist/` 写 `.d.ts` 与 `tsconfig.tsbuildinfo`（不是运行时产物，只是类型构建副产物）。`.gitignore` 的基线已含 `dist/`，本卡补了 `*.tsbuildinfo`、`.eslintcache`。实测：

```
$ git check-ignore -v packages/core/dist/index.d.ts packages/core/tsconfig.tsbuildinfo coverage/coverage-summary.json
.gitignore:2:dist/            packages/core/dist/index.d.ts
.gitignore:9:*.tsbuildinfo    packages/core/tsconfig.tsbuildinfo
.gitignore:3:coverage/        coverage/coverage-summary.json

$ git add -n .    # 试加，输出中没有任何 dist/ 文件
$ git status --porcelain -uall   # 33 条，全部为应交付文件（+ 协调者的 docs/03 与卡片）
```

## 7. R1 返工：按审计 P0/P1 与卡片 R1 裁定重做（本轮）

审计判 `G2: FAIL`，核心结论是"门禁绿但实际空转"。以下按 `.workflow/cards/M1.0.md` 的 `## R1 修订（协调者裁定）` 逐条执行，不换方案；同时自查出两个审计未列、同类性质的洞（见 7.3）。

### 7.1 P0 处置

| 项 | 处置 | 证据 |
|---|---|---|
| P0-1 `typecheck` 不检查 tests | 删 `tsc -b`/工程引用，改**单根** `tsconfig.json`（`--noEmit`），`include` 显式枚举 `packages/*/src/**` 与 `packages/*/tests/**` 的 `ts/tsx/mts/cts`（**不能用 `{ts,tsx}` 花括号**，`tsc` 的 include 不支持 brace 展开，实测会把 src 全部漏掉）＋ `vitest.config.ts`；删除 5 个包级 tsconfig 与 `composite`/`references`/`rootDir`/`emitDeclarationOnly` | `pnpm typecheck` 现在直接报 `packages/core/tests/entry-points.test.ts(3,27): error TS2307`（此前该文件不在编译图内，故"绿"）；⑥ 探针也见 7.4 |
| P0-2 tests 不在依赖图 / depcruise 假绿 | `exclude` 只留 `dist|coverage`（原先用 `pathNot` 把 node_modules 排除在**分析**之外，导致 `npm-dev`/`npm-no-pkg` 规则永不触发）；`doNotFollow: {path:"node_modules"}` 只控制遍历深度；扫描 `packages`（src+tests） | ⑤ 探针见 7.4；现行 4 条 `no-unresolvable` 违规即 tests 边被真实分析 |
| P0-3 覆盖率门禁可被空跑绕过 | `perFile: true` 原来写在 `coverage.perFile`（vitest 只认 `coverage.thresholds.perFile`，写在外面被**静默忽略**，等于从来没做 per-file 校验）；已移入 `thresholds` | ④ 探针：`ERROR: Coverage for branches (50%) does not meet global threshold (100%) for packages/core/src/__probe.ts` |

### 7.2 P1 处置

- **P1-1 跨包不可解析**：`packages/protocol/package.json` 加 `"@hreader/core": "workspace:*"`；`tsconfig.base.json` 的 `paths` 与 `vitest.config.ts` 的 `resolve.alias` 都指向**源码** `packages/*/src/index.ts`。⑦ 探针：protocol 里 `import { HrError } from "@hreader/core"` → `tsc` 0 错、`vitest` 1 passed 且 `toBeInstanceOf` 成立（类身份一致，说明走的是同一份源码）。
- **P1-2 ESLint 作用域**：`files` 改 `**/*.{ts,tsx,mts,cts}`；`vitest.config.ts` 进 tsconfig include 后，删掉 `projectService.allowDefaultProject` 与 `*.config.ts` 的 `disableTypeChecked` 豁免——配置文件现在与源码同一工程、同强度。
- **P1-3 vitest projects 分片**：取消 `projects`，单一 `test` 配置（`include: packages/*/tests/**/*.test.ts`）+ 上述 alias。
- **P1-4 空入口空转**：删 `protocol`/`renderer-html`/`chrome-extension`/`app` 的 `src/index.ts` 与 `exports` 字段，四个包 `package.json` 只剩 `name/version/private/type/sideEffects`。`core` 保留真实入口与 `exports`。

### 7.3 本轮自查新发现（与 P0 同类，已修）

1. **`perFile` 位置错**（见 P0-3）：审计没提，但这是"绿得没意义"的第四条。修好后覆盖率立刻能按文件判死。
2. **depcruise 的"假绿"还有第二条通道**：`to.path` 规则只能匹配**已解析**的边。删掉空入口后，`entry-points.test.ts` 的 4 个 import 变成不可解析 → 所有分层规则静默不触发，depcruise 一度显示 `✔ no dependency violations found`。已补 `no-unresolvable`（`from: ^packages/`，`to: { couldNotResolve: true }`）：解析不到就是 error，杜绝"边不存在 → 规则不响"。

### 7.4 负向验证（8 条，全部真实输出；探针文件已删除）

| # | 探针 | 结果 |
|---|---|---|
| ① | 根目录写入未格式化 `format_probe.json` | `[warn] format_probe.json` → `format:check` 红 |
| ② | `packages/core/src/__probe.ts` 里 floating promise | `require-await` + `no-floating-promises` 2 errors → `lint` 红 |
| ③ | `packages/core/tests/__probe.test.ts` 写入 `const wrong: number = "not a number"` | `tsc` exit 2 且报该文件 → **tests 真的在类型检查范围内**（P0-1 关闭） |
| ④ | `__probe.ts` 只覆盖一个分支 + 单测只走真分支 | `ERROR: Coverage for branches (50%) ... for packages/core/src/__probe.ts`，exit 1 → per-file 100% 真的在拦 |
| ⑤ | `core/src` import `protocol/src` | `error core-is-a-foundation: packages/core/src/__probe.ts → packages/protocol/src/index.ts` |
| ⑥ | src 反向 import `../tests/hr-error.test` | `error src-must-not-import-tests: packages/core/src/__probe.ts → packages/core/tests/hr-error.test.ts` |
| ⑦ | protocol → `@hreader/core`（类型 + 运行期解析） | `tsc` 与 `__probe` 相关错误 0 行；`vitest` `Tests 1 passed`，`toBeInstanceOf(HrError)` 通过 |
| ⑧ | 空值/未解析 import | 现行 `no-unresolvable` 4 条违规（见 7.5），证明"解析不到"不再静默 |

### 7.5 `pnpm verify` 现状（诚实记录：红）

```
$ pnpm verify   # format:check && lint && typecheck && test:coverage && depcruise && knip
format:check      exit 0   All matched files use Prettier code style!
lint              exit 1   1 error  packages/core/tests/entry-points.test.ts:23:24  no-unsafe-argument
typecheck         exit 2   4 × TS2307  packages/core/tests/entry-points.test.ts(3,27)(4,39)(6,32)(7,36)
test:coverage     exit 1   FAIL packages/core/tests/entry-points.test.ts（加载即失败）; 其余 25 tests passed
depcruise         exit 4   4 × no-unresolvable  packages/core/tests/entry-points.test.ts → {app,chrome-extension,protocol,renderer-html}/src/index
knip              exit 0
```

**红的原因只有一个文件，且不在我的写入范围**：`packages/core/tests/entry-points.test.ts`。它断言"每个包都有入口并 re-export 公共 API"，而 R1 §3 明确删掉了这 4 个空入口——契约变了，这个测试的前提不成立。四个门禁的 4/1/4 条报错全部由它派生（缺模块 → `error` 类型 → unsafe-argument；缺模块 → no-unresolvable；缺模块 → suite 加载失败）。

### 7.6 需要测试员适配的点（我没动任何 test 文件）

1. **`packages/core/tests/entry-points.test.ts`**：R1 §3 删空了 4 个占位入口，文件前提消失。建议删除，或改为"只断言 `@hreader/core` 入口导出 `HrError`/`HrErrorCode`"（若保留，别从 core 的 tests 里 import 其他包，那会踩 `core-is-a-foundation`——探针⑤ 已实测该边会被判错）。
2. **`packages/core/tests/tsconfig.json`**：单根工程后已无用（且与根 `include` 重复定义同一批文件）。当前不影响 `tsc`/ESLint（实测 `projectService` 仍正常），但它是"两个 tsconfig 定义 tests 工程"的残留，建议删除——我没有删，因为它在 tests 目录里。
3. `hr-error.test.ts` / `gates.test.ts`：**无需改动**，在新配置下 25 tests 全绿；`hr-error.test.ts` 里那条真实的"漏了某个 code"的类型断言现在会真的被 `tsc` 检查到（③ 证明）。

### 7.7 已知限制（写进契约，不假装解决）

- **运行时裸 Node 不承诺**：`paths` 与 vitest alias 都指向 `.ts` 源码，`@hreader/core` 的 `exports` 也指向 `./src/index.ts`。类型检查与测试（vitest 侧）全部可用，但 `node` 直接 `import` 这些包跑不起来。M1 无运行期产物，等出现"必须用 node 跑"的卡再引入构建（`tsc` 产 dist 或 bundler），届时补 `exports.import`。
- **跨包只测类型与解析**：`protocol → core` 仅用探针验证过（源码直连、类身份一致）；未做打包/循环依赖压力验证。
- **`packages/core/package.json` 新增 `devDependencies.eslint`**：`gates.test.ts` 直接 import `eslint` API，按 `no-undeclared-external-dep`（src+tests 都要声明）必须在本包声明；版本锁 `9.39.1`，pnpm 会与根共用同一份。

### 7.8 技术债（P2，登记不修）

| # | 债务 | 触发条件 / 建议 |
|---|---|---|
| 1 | `knip.json` 里 `packages/protocol` 有 `ignoreDependencies: ["@hreader/core"]`：R1 §2 要求声明该依赖，但 M1 没有代码用它，`knip --strict` 会报 unused。只对这一条依赖、只对这一个包豁免 | **M2 protocol 首卡落地后立即删除该豁免**（有代码引用后 knip 自然绿） |
| 2 | `no-warning-comments` 等注释规则只靠 `gates.test.ts` 用 ESLint API 自检，等价于"测试即规则文档" | 规则再增加时，抽出共享的 `RULES_CONTRACT` 常量 |
| 3 | 无 git hooks，`verify` 依赖自觉 | 接入 husky/lint-staged 或 CI |
| 4 | 覆盖率 `reporter: json-summary` 只为给人看，未接入任何看板 | 需要趋势时接 Codecov |
| 5 | 单根 `tsconfig.json` 用显式扩展名枚举（4 种 × 2 目录），新增源类型（如 `.vue`）需手工加 | 出现第 5 种扩展名时改 `include: ["packages"]` 并验证 |

### 7.9 入库状态

`git status --porcelain` 共 22 项，全部是应交付的源码/配置（`dist/`、`coverage/`、探针临时文件均为 0 项，`find` 与 `grep` 双重确认）。但仓库目前只有 2 个 docs 提交，M1.0 产物仍为未跟踪状态——我不擅自 `commit`，入库方式（一次性提交还是按 Pattern 拆分）请协调者裁定。

### 7.10 R2：`P1-A`（`dist/` 排除策略）—— 选方案 A

**改动**：`.dependency-cruiser.cjs` 的 `exclude` 从 `(^|/)(dist|coverage)/` 改为

```js
exclude: { path: "^(dist|coverage)/|^packages/[^/]+/(dist|coverage)/" },
```

即"只排除顶层的产物目录"：仓库根的 `dist|coverage`，以及 `packages/<pkg>/dist|coverage`；`node_modules` 仍只由 `doNotFollow` 控制（不进 `exclude`，否则 npm 边消失，`P0-3` 立刻复活）。

**为什么选 A 不选 B**：B（`verify` 前 `rm -rf packages/*/dist`）是拿"删别人的构建产物"换绿灯——破坏 `tsc` 增量、本地与 CI 行为必须靠约定对齐、而且它把失败时间点推迟到别人机器上；A 只是把"什么算产物"从"任意层级的 dist"收窄成"顶层产物目录"，一行正则、无副作用、`git clean` 不需要参与。

**一个坑（写进注释了）**：最自然的写法 `^(packages/[^/]+/)?(dist|coverage)/` 会被 depcruise **拒跑**——它用 `safe-regex` 做安全检查，`[^/]+` 嵌在可选组里构成 star height 2：

```
ERROR: The pattern '^(packages/[^/]+/)?(dist|coverage)/' will probably run very slowly - cowardly refusing to run.
```

所以改成两条锚定分支（`safe-regex` 通过，匹配语义完全等价：`packages/app/dist/x.js` ✅、根 `dist/x.js` ✅、`packages/app/src/dist/x.ts` ❌不误伤、`node_modules/.pnpm/x/dist/a.js` ❌不误伤）。

**证据（真实现场，探针文件构造后即删；`git status` 已核对无残留）**：

| # | 场景 | 结果 |
|---|---|---|
| ① | 构造 `packages/app/dist/index.js`（内容 `import "@hreader/core"`）后跑 `pnpm depcruise` | `✔ no dependency violations found (7 modules, 10 dependencies cruised)`，**exit=0**（P1-A 的验收点） |
| ①b | 对照组：同一产物 + **旧** regex `(^|/)(dist|coverage)/` | 也是 `✔ no dependency violations ... (6 modules, 6 dependencies)` |
| ② | `packages/core/src/probe.ts` 里 `import "left-pad"` | `error no-unresolvable: packages/core/src/probe.ts → left-pad`（红，无回退） |
| ③ | `packages/core/src/probe.ts` 里 `import "eslint"` | `error no-dev-dependency-from-src: ... → node_modules/.pnpm/eslint@9.39.1_jiti@2.7.0/node_modules/eslint/lib/api.js`（红，无回退） |
| ③b | `packages/app/tests/__probe.ts` 里 `import "prettier"`（root devDep，app 未声明） | `error no-undeclared-external-dep: packages/app/tests/__probe.ts → node_modules/.pnpm/prettier@3.10.0/node_modules/prettier/index.cjs`（红） |
| ④ | `packages/app/src/dist/nested.ts` 里 `import "left-pad"`（非顶层同名目录） | `error no-unresolvable: packages/app/src/dist/nested.ts → left-pad`（收窄**没有**放过非产物目录） |
| ⑤ | 探针清理后 | `✔ no dependency violations found`；`pnpm verify` exit=0（`format:check`/`lint`/`typecheck`/`test:coverage` 31 tests/`depcruise`/`knip` 六步全绿） |

**必须记一笔的发现（`P1-A` 的真实根因与审计写的机理不同）**：①b 证明旧 regex 与同一产物共存时**也是绿的**——`(^|/)(dist|coverage)/` 匹配的是"任意 `/dist/` 片段"，是新写法的**超集**，因此它不可能"漏掉 `packages/app/dist` 而把 depcruise 拖红"，`P1-A` 描述的 `no-orphans/no-unresolvable on packages/app/dist/index.js` 在本机按审计给的配置复现不出来。但旧写法是超集这件事本身才是真问题：它同时把**所有入口文件位于 `<pkg>/dist/` 的 npm 依赖**从分析里删掉了——`no-undeclared-external-dep` / `no-dev-dependency-from-src` 对大多数真实依赖一直是死的（和 `P0-3` 同一类洞）。收窄后的直接证据：

- depcruise 扫描量 `6 modules / 6 dependencies` → **`7 modules / 10 dependencies`**；
- 立刻浮出 3 条 `no-undeclared-external-dep`：`packages/{core,protocol}/tests/*.ts → node_modules/.pnpm/vitest@.../vitest/dist/index.js`（测试直接 import `vitest`，但包里没声明）；
- 处理：`packages/core/package.json`、`packages/protocol/package.json` 各加 `"devDependencies": { "vitest": "3.2.4" }`（与根 `^3.2.4` 同一份，pnpm 不重复安装）。声明后基线恢复 `✔`。

结论：方案 A 仍然是对的，但**理由要比审计给的更硬**——不是为了"别让 dist 拖红"（旧写法本来也没红），而是为了不再用"任意层级 dist"这种超集把 npm 依赖边整片吃掉。若将来真要"本机有产物也不干扰"，A 已经覆盖。
