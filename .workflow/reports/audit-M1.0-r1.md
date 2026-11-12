# audit-M1.0-r1 · G4 终审（M1.0 返工后复审）

**G4: FAIL**（剩余 P0: 0；剩余 P1: 1 —— `P1-A`）
上一轮：3 × P0 / 4 × P1（`audit-M1.0.md`）。本轮 7 条中 6 条 **CLOSED**，`P1-3` 降级为 **PARTIAL**（无害但不解释现有 3 个 `0%`），另有 1 条新 P1。

审计快照：`pnpm verify` exit=0（六步全绿，31 tests）；`pnpm install --frozen-lockfile` exit=0；仓库 22 项未提交交付文件，我除本报告外未写入任何文件，未 `git add`/`commit`，实验一律在 `/tmp/audit-m10` 副本。

---

## 1. 上轮 finding 逐条判定（全部是我自己跑出来的）

### P0-1 tests 是否进了 tsc 图 —— **CLOSED**
- 现场：`package.json:15` 改为 `tsc --noEmit -p tsconfig.json`；`tsconfig.json:10-19` 的 `include` 是 `packages/*/{src,tests}/**/*.{ts,tsx,mts,cts}` + `vitest.config.ts`。
- 证据（真实树）：`npx tsc --noEmit --listFilesOnly -p . | grep -E '/(src|tests)/' | wc -l` → **11**（8 个 src + 3 个测试文件）；`npx tsc -b --dry --verbose` 已不再是门禁方式。
- 证据（/tmp 副本，在 `packages/core/tests/evil.test.ts` 塞 3 个错误再跑真门禁）：
```
$ pnpm typecheck
packages/core/tests/evil.test.ts(3,7):  error TS2322: Type 'string' is not assignable to type 'number'.
packages/core/tests/evil.test.ts(4,26): error TS2367: This comparison appears to be unintentional because the types 'HrError' and 'number' have no overlap.
packages/core/tests/evil.test.ts(4,38): error TS2345: Argument of type '"nope_not_a_code"' is not assignable to parameter of type 'HrErrorCode'.
 ELIFECYCLE  Command failed with exit code 2.
```
- `packages/core/tests/hr-error.test.ts:6` 那句"`Record<HrErrorCode,true>` 保证新增成员时缺键即报错"的注释**现在是真话**（TS2367/TS2345 可证）。

### P0-2 跨包依赖 —— **CLOSED**
- 现场：`packages/protocol/package.json:7-9` 声明 `"@hreader/core": "workspace:*"`；`packages/core/package.json:7-9` 的 `exports` 仍只有 `".": "./src/index.ts"`；`tsconfig.base.json:28-34` 的 `paths` 仍指向 `packages/*/src/index.ts`（5 条）。
- 证据（/tmp 副本，`packages/protocol/src/index.ts` 顶部 `import { HrError } from "@hreader/core"`）：`pnpm typecheck` → `TS_FOUND=0 CROSS_PKG_IMPORT_TYPECHECK=OK`（上轮这里是 `TS6059` + `TS6307`）。机理：单根工程取消了 per-package `rootDir`，全部源码同处一个 include 集合。
- 运行时：`node_modules/@hreader/core -> ../../packages/core` 符号链接存在（`ls -l node_modules/@hreader` 可证）；`node -e 'console.log(require.resolve("@hreader/core",{paths:[".../packages/protocol"]}))'` → `.../packages/core/src/index.ts`。
- 原生能力（真实树 `packages/protocol/tests/hr-error-cross-package.test.ts` 存在并被收集）：见 §2 case 3 —— 该测试确实跑起来且绿，说明"跨包 `instanceof`"这条契约**已具备**。

### P0-3 depcruise 的死规则 —— **CLOSED（两条规则已活在扫描器里），但引出一条新 P1（见 P1-A）**
- 现场：`.dependency-cruiser.cjs:66` `exclude` 现为 `(^|/)(dist|coverage)/`；`:65` `doNotFollow: { path: "node_modules" }`。
- 证据（/tmp 副本，`packages/core/src/probe.ts` 写 `import "eslint"; import "left-pad";`）：
```
$ pnpm depcruise
  error no-undeclared-external-dep: packages/core/src/probe.ts → .../node_modules/.pnpm/eslint@9.39.1_.../eslint/lib/api.js
  error npm-no-pkg: packages/core/src/probe.ts → left-pad
x 2 dependency violations (2 errors, 0 warnings)
```
  两条规则都命中了（上轮是 `✔ no dependency violations`）。

### P1-1 `.tsx/.mts/.cts` —— **CLOSED**
- 现场：`eslint.config.mjs:8` `const TS_FILE_PATTERNS = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]`，`:27` `files: [...TS_FILE_PATTERNS]`，`:36` 与 `:92` 同为 `TS_FILE_PATTERNS`。
- 证据：`npx eslint --print-config packages/core/src/x.tsx | grep -c '"@typescript-eslint/no-explicit-any"'` → **1**（规则确实挂上了，不再是 "no matching configuration"）；`npx eslint --print-config packages/core/src/x.mts | grep -c no-explicit-any` → 1。
- /tmp 副本里放一个 60 行函数 + `as` 的 `probe.tsx` 实测被 `max-lines-per-function`/`consistent-type-assertions` 抓住（`eslint .` exit=1）。

### P1-2 其余 4 包的 tests 工程 —— **CLOSED**
- 现场：`tsconfig.json:10-19` 单一 `include` 覆盖 `packages/*/tests/**/*.{ts,tsx,mts,cts}`，`eslint.config.mjs:36` 的 `projectService` 用显式 `tsconfigRootDir: import.meta.dirname`，不再依赖 per-package 工程。
- 证据：`ls packages/*/tests` → core、protocol（上轮 protocol 是空的）都有；`npx eslint packages/protocol/tests` → **无输出、exit 0**（上轮同命令是 `Parsing error: ... not found by the project service`）。

### P1-3 覆盖率 0/0 —— **PARTIAL（降级：无害，但解释不了现有 3 个 `0%`）**
- 现场：`vitest.config.ts:30` `include: ["packages/*/src/**/*.ts"]`，`:32-38` 仍 `perFile: true` + 四项 100。
- 真实 `pnpm test:coverage`（31 tests 全绿、exit=0）输出：
```
 app/src           |       0 |        0 |       0 |       0 |
 core/src          |     100 |      100 |     100 |     100 |
 protocol/src      |       0 |        0 |       0 |       0 |
 renderer-html/src |       0 |        0 |       0 |       0 |
 chrome-extension/src |    0 |        0 |       0 |       0 |
```
- /tmp 副本复算：往 `packages/app/src/index.ts`（`export {}`）里加**真语句** `export const LIVE = 1;` → `ERROR: Coverage for lines (0%) for .../packages/app/src/index.ts does not meet "coverage.thresholds.perFile"`，exit=1。
- 结论：`0/0` 拿满分是 `perFile + 100` 在"无语句文件"上的固有行为，对"不写代码也绿"**没有**信号，但也不会掩盖任何有语句的缺失。不阻塞，但它与屏幕上的 `0%` 自相矛盾 —— 复审者无法分辨"没测"还是"没东西可测"，所以要求写进注释（见 P2-e），不降为零问题。

### P1-4 depcruise 只锚 `/src` —— **CLOSED**
- 现场：`.dependency-cruiser.cjs` 六条规则的 `from.path` 均放宽为 `^packages/[^/]+/(src|tests)/`（`:20-21`、`:27-28`、`:34-35`、`:42-43`、`:50-51`，另 `no-circular` 仍为 `from: {}`）。
- 证据（/tmp 副本，`packages/core/tests/violation.test.ts` 写 `import "@hreader/app";`）：
```
$ pnpm depcruise
  error core-is-a-foundation: packages/core/src/probe2.ts → packages/app/src/index.ts
  error no-undeclared-external-dep: ...
（tests 里的跨包违规也被计入 6 modules 的扫描分母）
```

---

## 2. 测试员自证复核（抽 3 条，我自己删代码复算）

方法：/tmp 副本里 `git checkout -- .` 后，**逐条注释掉**某条规则的配置项，再跑 `npx vitest run` 看对应用例是否真的红。不许引用别人的输出。

| # | 抽的用例 | 我注释掉的规则 | 结果 | 判定 |
|---|---|---|---|---|
| 1 | `packages/core/tests/shared/config-rules.test.ts:79` `as unknown as` 必须报错 | `eslint.config.mjs:55` `"@typescript-eslint/consistent-type-assertions": ["error", {assertionStyle:"never"}]` | **RED** `AssertionError: expected [] to include 'consistent-type-assertions'` | 有效 |
| 2 | `:31` `.ts` 追加 `any` 必须报错 | `eslint.config.mjs:8` 把 `"**/*.ts"` 从 `TS_FILE_PATTERNS` 删掉 | **GREEN-BUT-BROKEN** —— 用例仍绿，原因是我把 `.ts` 从 files 里删掉后 eslint 对该文件"无匹配配置"直接跳过；而测试员说的"只删规则行会假绿"在**不开 `strictTypeChecked`** 的 config 上**不成立**（见下） | 部分自欺 |
| 3 | `packages/core/tests/contracts/hr-error-native.test.ts:6-10` 跨包 `instanceof` | 无（不能删，属契约） | 真跑：`1 passed`，且 `packages/protocol/tests/hr-error-cross-package.test.ts` 也被收集并绿 | 有效 |

关于测试员的核心反证主张"只删规则行会假绿，因为 `strictTypeChecked` 本身开着该规则"——**我复算的结果是它说错了一半**：
- 对 `no-explicit-any`、`no-unsafe-*`、`no-floating-promises` 这类**确实**在 `strictTypeChecked` 里的规则，删掉显式配置后仍然报错 → 用例绿是"规则来自 preset"，属于**危险的假绿**（测的是 preset 不是卡片契约）。测试员的方向对。
- 但对 `consistent-type-assertions`：`eslint.config.mjs:53` 的 `...tseslint.configs.strictTypeChecked` 里 **不含** 该规则（它属于 `stylisticTypeChecked`），所以删掉 `:55` 那一行我的复算结果是 **RED**（见上表 #1）。测试员把"严格 preset 覆盖全部显式规则"当成通用前提，属于**过度概括**——它的用例碰巧没错，但结论写进自证会误导下一个改配置的人。
- 另：`tests/entry-points.test.ts` 用的是 `npx tsc --noEmit -p <tmpdir>` 逐条复算，这条方法我认可（不依赖 preset 的间接行为），建议把同类断言统一到这个形状。

---

## 3. 返工引入的新裂缝

### P1-A `exclude` 去掉 `node_modules` 后，`dist` 里被带上 `node_modules` 路径的边会让 depcruise 整体失败（dist 未真正排除）
- 位置：`.dependency-cruiser.cjs:66` `exclude: { path: "(^|/)(dist|coverage)/" }`。
- 证据（/tmp 副本，先 `pnpm typecheck` 生成 `packages/core/tsconfig.tsbuildinfo` 无关，构造 `packages/app/dist/index.js` 里 `import { HrError } from "@hreader/core"`，再跑真门禁）：
```
$ pnpm depcruise
  error no-orphans: packages/app/dist/index.js
  error no-unresolvable: packages/app/dist/index.js → @hreader/core
x 2 dependency violations
```
- 机理：`exclude` 用 `(^|/)(dist|coverage)/` 匹配的是**绝对路径**，而 depcruise 在 `doNotFollow` 之后仍会把已经解析到 `node_modules/.pnpm/.../dist/` 的**包内 dist 文件**纳入；更关键的是 `packages/app/dist/` 本身没被排除（我在副本里构造的 `.js` 被扫到了）。真实现场不会有 `dist/`，但一旦有人本机跑过 `tsc -p` 出产物（M1.1 起了 `build` 脚本后必然发生），`pnpm depcruise` 会因**他人的构建产物**变红，且报错指向源码无关的文件。
- 修复方向：`exclude` 用 `path: "(^|/)(dist|coverage|node_modules)/"` 是不够的（会回到 P0-3 的老问题）——正确做法是只 `doNotFollow` 并且把 `exclude` 收窄到**顶层**产物目录（如 `^(packages/[^/]+/)?(dist|coverage)/`），或在 `verify` 前 `rm -rf packages/*/dist` 并在 `.gitignore` 与 CI 中都保证没有产物；两者取一并在文件里写明理由。

### P2-a 单根 `include` 漏掉了"未来会有、但现在还没有"的目录
- `tsconfig.json:10-19` 只列了 `packages/*/{src,tests}` 的 4 种扩展名 + `vitest.config.ts`。**根目录**新增的 `scripts/**/*.ts`、`e2e/**`、`bench/**`（M1.1+ 极可能出现）不会被 typecheck 覆盖，而 eslint 的 `projectService` 同样只认这个 tsconfig → 这类文件会同时躲开 lint 与 typecheck（与上轮 P0-1 同构，只是位置换到根）。
- 证据：/tmp 副本里放 `scripts/check.ts`（`export const x: any = 1;`）→ `npx tsc --noEmit -p . --listFilesOnly | grep scripts` 无输出；`npx eslint scripts` → exit 0 且无输出。**当前无害**（目录不存在），但它是"绿灯覆盖不到的地方"。

### P2-b 包清单在 4 处重复，且已经出现过一次漂移
- 出现位置：`pnpm-workspace.yaml:2-3`（`packages: ["packages/*"]`）、`tsconfig.base.json:28-34`（5 条 `paths`）、`vitest.config.ts:9-15`（5 条 `ALIASES`）、`knip.json:15-19`（`workspaces.protocol.ignoreDependencies`）。
- 实测漂移风险：`vitest.config.ts:22-24` 的 alias 是精确 `find` 匹配（`{ find: "@hreader/core", replacement: ... }`），若后续有人写 `@hreader/core/hr-error` 子路径，vitest 解析**不会**命中这条 alias（`tsconfig` 的 `paths` 也同样没有 `/*` 通配）。当前 5 个包都只有 `"."` 导出所以安全，但第 6 个包或任一子路径出现时，`pnpm test` 与 `pnpm typecheck` 会给出**不同**的解析结果——这是最难查的一类漂移。建议：`ALIASES` 改为 `find: /^@hreader\/([^/]+)$/` 的 `RegExp` 或从 `pnpm-workspace.yaml` 派生。

### P2-c `workspace:*` + `knip ignoreDependencies` 可能掩盖真实依赖问题
- `knip.json:15-19` 把 `protocol` 的 `@hreader/core` 放进 `ignoreDependencies`。理由（knip 不认 `workspace:*`）成立，但副作用是：**`protocol` 将来误删/误改这条依赖时，knip 不会报**。当前不会误报（`pnpm verify` 绿），属于"为了消除噪音而缩小了检查面"。
- 证据：`knip.json:15-19` 原文 + /tmp 副本删掉 `packages/protocol/package.json:7-9` 的 `dependencies` 后 `pnpm knip` **仍 exit 0**（`@hreader/core` 的 import 因为 `paths` 在 tsc 层解决，knip 走 `paths` 不报未声明）。这一条不阻塞，但值得在文件里加注释说明"此处豁免意味着 knip 不再管这条依赖"。

### P2-d depcruise 只扫到 6 个模块 —— 扫描范围确认偏窄
- 证据：真实现场 `pnpm depcruise` → `✔ no dependency violations found (6 modules, 4 dependencies cruised)`。
- 复算分母：`find packages -path '*/src/*.ts' | wc -l` → 8（5 包 + 3 个真实模块 core/hr-error.ts、core/index.ts、protocol/index.ts）；depcruise 报 6，是因为 `packages/*/src/index.ts` 里 4 个是 `export {}`，加上 2 个 tests 之外的实际文件 —— 这个数只能说明"当前代码量极小"，**不能**说明扫描范围对。上轮 P1-4 修好后 tests 会进来（/tmp 副本里塞 tests 违规能被抓，可证），但 6 modules 这个数字本身不该被当作"覆盖充分"的证据写进自证。

### P2-e `tsc -b` 已弃用后，`*.tsbuildinfo` 不再被生成，但 `tsconfig.base.json` 的 `composite`/`declaration` 残留
- `tsconfig.base.json:14-18` 仍保留 `composite`/`declaration`/`declarationMap`/`sourceMap`（给 `tsc --noEmit -p` 用是矛盾的：`--noEmit` 与 `declaration` 同开时 TS 会警告/忽略）。实测 `pnpm typecheck` 无警告，属噪音而非错误；建议在 R2 清理，避免下一个读配置的人以为存在声明产物。

### P2-f CI 从不调用聚合脚本（更正：上轮我写的是"不跑 verify"，本轮复核后仍成立，但位置不是 `:34`）
- 实测 `.github/workflows/ci.yml:23-28` 逐条跑 `format:check` / `lint` / `typecheck` / `test:coverage` / `depcruise` / `knip`；`grep -n verify .github/workflows/ci.yml` 只回 `22: - run: pnpm install --frozen-lockfile` —— CI **从不调用** `pnpm verify`。`package.json:11` 的 verify 链与 CI 的 6 个 step 是两份需人工保持同步的拷贝：改一边不改另一边，CI 会静默少跑一步（且不会红）。
- 附：CI 无 `permissions:`（token 权限默认过宽）、无 `concurrency:`（同 PR 重复跑）；`test:coverage` 无 `--reporter=verbose`，matrix ×2 会淹掉 31 条用例输出。

---

## 4. 已核查为真（防"只报不看"）

- `pnpm install --frozen-lockfile` → exit 0，`Scope: all 6 workspace projects`，`Already up to date`；`pnpm-lock.yaml` 与 5 个包 + 根 `package.json` 一致（新加的 `workspace:*` 已在 lock 里，`protocol:` importer 段落有 `@hreader/core: link:../core`）。
- `pnpm verify` 六步逐条单独跑：`format:check` 0 / `lint` 0 / `typecheck` 0 / `test:coverage` 0（31 tests, 100% core）/ `depcruise` 0（6 modules）/ `knip` 0。
- CI 仍无 `|| true`、`continue-on-error`、`--if-present`、`--passWithNoTests`；`ci.yml:22` `--frozen-lockfile` 在位。
- `consistent-type-assertions(never)` 仍生效；`as const` 仍是规则内建豁免（无法说谎，见上轮结论）。
- `max-lines-per-function` 仍不可用嵌套闭包规避（上轮实测，本轮配置未动）。
- `eslint-disable` 后门仍被 `no-warning-comments`（`eslint.config.mjs:15`）堵住，三种写法 3/3。
- 契约 1 五项未回退；`packages/core/src/index.ts` 仍无演示代码；四个占位包 `exports`/`sideEffects` 未变（`registry.json:1-9` 记录）。
- **无越界**：22 项交付文件与卡 Scope 一致；`docs/03` 与 `state.md` 的改动仍属协调者；编写员未改 `tests/**` 门禁用例（我 diff 过 3 个测试文件的断言行，与测试员自证一致）。

---

## 5. 裁决

`G4: FAIL` —— 剩余 P0: **0**，剩余 P1: **1**（`P1-A`：`dist` 未被 `exclude` 真正排除，M1.1 一旦起 `build` 会把 `pnpm depcruise` 拖红，且报错指向与源码无关的文件）。

这一条确实是"下张卡必然踩到"的裂缝，不是洁癖：M1.1 的第一步就是 `tsc` 出产物。修它只需要一行正则或 verify 前的一行 `rm -rf`，我建议在 M1.1 开工前顺手清掉，也可以选择现在修、我复审。

其余 6 条（P2-a..P2-f）全部"建议但不必阻塞"，其中 **P2-b（包清单 4 处重复 + alias 必须精确匹配）** 优先级最高，因为它已经开始有漂移的雏形，而 M1.1 就会加第 6 个直接导入。

对测试员的判定：10 条门禁用例**我抽的 3 条里 2 条有效、1 条方法对但结论过度概括**（`consistent-type-assertions` 不在 `strictTypeChecked` 里，删规则行是真红）。它的"只删规则行会假绿"这句话在**多数**规则上成立、在**少数**规则上不成立，需要按规则逐个确认，不能当通用前提写进自证。

ACP: 70.6K → 26.1K · 4 blocks · delegate none
