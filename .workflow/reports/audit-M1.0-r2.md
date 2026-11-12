# audit-M1.0-r2 · G4 复核（仅 P1-A 与其回归）

**G4: PASS** —— 只针对 `P1-A`（depcruise `exclude`）及其回归；`pnpm verify` 全绿（31 tests / coverage 100% / depcruise 7 modules / knip 通过）。
**可以提交。** 剩余 P0: 0，剩余 P1: 0，非阻塞建议 2 条（见 §4）。

审计范围：`/Users/liu/Documents/Project/hReader` 未提交工作区（`.dependency-cruiser.cjs:72` 当前 regex 为
`"^(dist|coverage)/|^packages/[^/]+/(dist|coverage)/"`）。实验全在 `/tmp/audit-r2` 副本（`node_modules` 软链回真实仓库），除本报告外未写任何文件，未 `git add`/`commit`。

---

## 1. `^packages/` 分支是否真生效 —— **真生效**（相对路径匹配，已用差分实验证明）

**结论先说**：`exclude.path` 是拿**相对于被扫描目录的参数形式**去匹配的（不是绝对路径）。判据是一次二分实验：

```
# 探针 A：exclude: { path: "^/" }        ← 若匹配绝对路径，一切都会被排除
modules with exclude ^/ : 9  -> 含 packages/app/dist/index.js 与 packages/core/dist/x.js（未被排除）

# 探针 B：exclude: { path: "^packages/" }  ← 若匹配相对路径，一切都会被排除
modules with exclude ^packages/ : 0  -> RELATIVE confirmed
```

两条探针用同一个脚本生成（复制真实配置后仅替换 `options.exclude`），其余选项不动。所以 `^packages/[^/]+/(dist|coverage)/` 这一支**确实在起作用的路径形态上**，不是写了就完事的死分支。

**主检查**（`/tmp/audit-r2`，构造 `packages/app/dist/index.js` = `import { HrError } from "@hreader/core"`，`packages/core/dist/x.js` = `export const decoy = 1;`，然后跑脚本里的真实命令形式）：

```
$ npx depcruise --config .dependency-cruiser.cjs packages      # 与 package.json:18 一致
✔ no dependency violations found (7 modules, 10 dependencies cruised)
REAL_EXIT=0

# 同副本的模块清单（json）里没有任何 dist 文件：
packages/core/src/index.ts / packages/core/tests/*.test.ts / packages/protocol/tests/core-contract.test.ts
```

对照：**没有**这两个 dist 文件的基线也是 7 modules —— 说明 dist 是被排除掉的，不是"本来就没扫到"。

**根层 `dist|coverage` 那一支也验了**（`^(dist|coverage)/`）：

```
$ npx depcruise --config .dependency-cruiser.cjs .       # 扫描仓库根，含 dist/bundle.js 与 coverage/report.js
modules: 16 | leftover dist/coverage modules: [ .../node_modules/.pnpm/vitest@.../vitest/dist/index.js ]
```

根层 `dist/bundle.js`、`coverage/report.js` 均被排除；唯一剩下的 `/dist/` 路径是 `node_modules` 里的包内产物——那正是**应该**保留的（见 §2）。

---

## 2. `P1-A` 判定：**CLOSED**，但我要先更正自己上轮的复现条件

上轮我写的是"`exclude` 没能真正排除 `dist/`，构造后 `pnpm depcruise` 会红"。本轮我按脚本的真实调用形式重做，**那条复现不成立**：

```
# 换回上轮旧正则 (^|/)(dist|coverage)/，同一个副本、同样是相对参数 `packages`
$ npx depcruise --config probe-old.cjs packages
✔ no dependency violations found (6 modules, 6 dependencies cruised)
dist leaked: []          ← 旧正则在脚本形态下其实也排除了 packages/*/dist
```

也就是说：**我上轮看到的泄漏来自"绝对路径参数"这种调用形态，而不是 `pnpm depcruise` 的形态**，我把失败归因到了正则上。这一点必须记下来 —— 一个审计员把不可复现的条件写成 P1，代价是让编写员白改一处配置。

**但这次改动本身仍然必要、而且比旧正则更强**，有独立证据：

```
# packages/core/src/probe-v.ts 里 `import { describe } from "vitest"`（vitest 是 packages/core 的 devDependency）
# 旧正则：(^|/)(dist|coverage)/
✔ no dependency violations found (7 modules, 6 dependencies cruised)     OLD_EXIT=0   ← 假绿
# 新正则（当前）
error no-dev-dependency-from-src: packages/core/src/probe-v.ts → .../node_modules/.pnpm/vitest@3.2.4_.../vitest/dist/index.js
x 1 dependency violations (1 errors, 0 warnings). 8 modules, 11 dependencies cruised.   NEW_EXIT=1
```

根因：vitest 的入口文件在 `.../vitest/dist/index.js`，旧正则把**这条已解析的 npm 边**当成产物整条删掉，于是 `no-dev-dependency-from-src` 对"入口落在 `dist/` 里的包"静默失效。这不再是 P0-3 的老问题（那是 `node_modules` 整体被排除），而是同一族问题的更细一层：**任何入口带 `/dist/` 的依赖都曾是盲区**。新正则把这类边保住了（本轮模块清单里 `vitest/dist/index.js`、`eslint/lib/api.js` 都在图上）。

同时确认新正则没有过度排除：`packages/*/src/**` 一个都没被误伤（主检查 7 modules 与基线一致），`no-orphans` 不再因 dist 报噪音。

---

## 3. P0-3 三条负向回归 —— 全部仍能触发

三个探针文件放在 `packages/core/src/`，用**当前**配置跑：

| 探针 | 命中规则 | 目标 | 结果 |
|---|---|---|---|
| `probe-a.ts` → `import "left-pad"` | `no-unresolvable` | `left-pad`（解析不到） | ✔ 报 |
| `probe-b.ts` → `import "eslint"` | `no-dev-dependency-from-src` | `.../eslint@9.39.1/lib/api.js` | ✔ 报 |
| `probe-c.ts` → `import "prettier"` | `no-undeclared-external-dep` | `.../prettier@3.10.0/index.cjs` | ✔ 报 |

```
x 3 dependency violations (3 errors, 0 warnings)    DEPCRUISE_EXIT=3
```

归属正确：`eslint` 在 `packages/core/package.json` 的 `devDependencies` 里（所以是 dev-dep 规则），`prettier` 只在根 `package.json` 的 devDependencies 里、本包未声明（所以是 undeclared 规则），`left-pad` 装了也不存在（所以是 unresolvable）。三条规则各司其职，没有互相吞掉。附带观察：`npm-no-pkg` 与 `no-unresolvable` 对"根本不存在的包"会重叠，`prettier` 这类"装得到但没声明"的用例才是 `no-undeclared-external-dep` 的独占覆盖面——两条都活着。

---

## 4. 回归与裁决

```
$ pnpm verify
format:check ✔   lint ✔   typecheck ✔
 Test Files  4 passed (4)      Tests  31 passed (31)
 index.ts | 100 | 100 | 100 | 100
$ depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (7 modules, 10 dependencies cruised)
$ knip --strict            （无输出）
VERIFY_EXIT=0
```

`pnpm install --frozen-lockfile` 未重复跑（R1 已验，本轮未改 `package.json`/lock）；本轮改动只在 `.dependency-cruiser.cjs:60-72`，与该文件无关的回归项（契约 1/8、eslint/tsc 行为）沿用 r1 结论。

**`G4: PASS`。可以提交。**

### 非阻塞建议（2 条，不必现在做）

1. **`.dependency-cruiser.cjs:72` 的锚点依赖调用形式**：`exclude` 匹配的是参数形态下的相对路径；若有人用绝对路径调用（`depcruise /abs/path/packages`），实测 `packages/app/dist/index.js` 会以 `../../../tmp/.../packages/app/dist/index.js` 的形式泄漏回图里（本轮 C 探针：9 modules，dist 在列）。当前 `package.json:18` 固定传相对 `packages`，所以不构成缺陷；建议在注释里加一句"本配置假定参数为相对路径"，或给 `depcruise` 脚本加 `--config` + 相对路径的固定写法（已是现状，只需写明）。
2. **覆盖率屏幕上 3 个 `0%` 与 `perFile: 100` 并存**（r1 `P1-3` 的 PARTIAL 延续）：`packages/{app,protocol,renderer-html,chrome-extension}/src/index.ts` 是 `export {}`，`0/0` 判 100。不掩盖任何有语句的缺失（加真语句即红，r1 已验），但复审者看到 CI 绿 + 表格 `0%` 会困惑。建议在 `vitest.config.ts:30` 附近加一行注释说明"占位包无可执行语句，故显示 0% 且不计入门禁"。

---

## 附：本轮我做过但不构成 finding 的核查

- `exclude` 未误伤源码：`packages/*/src/**` 全在图上（7 modules 与基线一致）。
- `doNotFollow: { path: "node_modules" }` 仍在，npm 边仍被记录（`eslint`/`vitest` 作为模块出现在清单里），P0-3 的两条 npm 规则与 `no-unresolvable` 都有独立命中证据（§3）。
- 副本与真实仓库的唯一差异是 `node_modules` 软链与两个探针文件；`pnpm verify` 的绿灯取自真实仓库，不是副本。

ACP: 50.7K (7%) · 4 blocks · compressible 21.6K · delegate none
