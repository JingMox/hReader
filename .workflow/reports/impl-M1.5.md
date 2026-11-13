# impl-M1.5 · `hr_patch_node` 增量 patch + 原子写 + undo（R6 后 · 归档式）

状态：**R6 收口后 `pnpm verify` 全绿（EXIT=0）**——51 test files / `700 passed | 2 todo` / 0 failed，覆盖率四列 **100%**（含 `html/parse.ts`）；`format:check` / `lint` / `typecheck` / `test:coverage` / `depcruise`（0 违规）/ `knip --strict` 六步全 exit 0。

## R6（本轮 · P1-R3-1 升级为 P0：foreign content 里的 `<template>` 裸崩）

**根因（一行）**：`isTemplate` 只判 `nodeName === "template"`，但 parse5 只给 **HTML 命名空间**的 `template` 挂 `content`——`parser/index.js:356-363` 的 `_insertTemplate` 里 `_createElement(token.tagName, NS.HTML, …)` 之后才 `setTemplateContent`，而 foreign content（svg/math）的 `<template>` 走通用 `_createElement(…, NS.SVG, …)`，永远不调 `setTemplateContent` → `parse.ts:121` 读 `element.content.childNodes` 抛裸 `TypeError`，`error.code` 为空，击穿 `HrError` 契约。

**为什么 `nodeName` 判定不够**：`template` 是**跨命名空间共用的名字**，两种构型的结构不同——HTML 的模板把子树放进 `content` 片段，SVG/MathML 的 `<template>` 是普通元素、子树直接挂 `childNodes`。按名字判等于假设"名字 → 结构"，而结构是解析器按**命名空间**分别构造的（`_insertTemplate` 硬编码 `NS.HTML`），名字里根本不带这个信息；`<TEMPLATE>` 还会被 tokenizer 统一小写，连"排除法"都做不到。教训：判结构要看结构，别从名字反推。

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| `isTemplate`（判名字）→ `hasTemplateContent`（判结构） | `html/parse.ts:96`：`const hasTemplateContent = (node: P5Element): node is P5Template => "content" in node;` | 选结构探测而非 `namespaceURI === html.NS.HTML`：① `descendantsOf` 要回答的问题就是"子节点挂在哪"，`content` 在不在**就是**那个答案；② parse5 只在 `_insertTemplate` 一处挂 `content` 且硬编码 `NS.HTML`（`parser/index.js:355-366`，另 `tree-adapters/default.js:57-59` 的 `setTemplateContent` 只赋 `content`、`createElement` 不预置该键），所以结构探测与这条不变量同源；③ 免掉 `import { html }`——本文件多个函数参数就叫 `html`，会引入遮蔽噪声 |
| 调用点改名 | `html/parse.ts:121` | `hasTemplateContent(element) ? element.content.childNodes : element.childNodes`；谓词让 `element` 窄化成 `P5Template`（`Template extends Element` 且带 `content`），**无 `as` / `!` / `ignore`** |
| 语义 | — | SVG/MathML 的 `<template>` 现在按普通元素走 `childNodes`，**子树保留**（此前是崩，不是丢）；`innerEnd` 等其它分支未动 |

### R6 自证（真实命令 + 作用域）

| 命令 | 作用域 | 结果 |
| --- | --- | --- |
| `node /tmp/m15c/r3-crash.mjs` | 6 输入 × `loc` true/false = 12 行 | **12/12 `OK`**，无 `TypeError`（修复前 10/12 抛） |
| `node /tmp/m15c/r3-reach.mjs` | 公开 API：`applyPatch` + 3 片段 | **3/3 ACCEPT**、无 `TypeError`（修复前 `<svg><template>x</template></svg>` 抛） |
| `node /tmp/m15c/r3-fix-verify.mjs` | svg/math/html 模板 4 例往返 + `applyPatch` 片段 + `foreign × special` 50 组合 | 4 例 `treeStable=true` / `textStable=true`；`<svg><template><circle/></template></svg>` 子树保留（`children=["element:circle"]`，序列化 `<circle r="1"></circle>` 二次往返逐字稳定）；`applyPatch` 后 `keepsCircle=true`；交叉 fuzz **50/50 无崩** |
| `node /tmp/m15c/r3-breakout.mjs` | 与裸 parse5 对拍 `<svg><template><p>x</p><circle/></template></svg>` | 树逐节点一致——`<p>` 是 foreign-content breakout 标签，模板按规范本就为空，**不是丢子树**（我的"模板必须非空"启发式误报，已用 parse5 原树证伪） |
| `pnpm exec vitest run --coverage` | 全仓 | 51 files / `700 passed \| 2 todo`；`All files` 与 `parse.ts` 四列 **100 / 100 / 100 / 100** |
| `pnpm verify` | 全仓六步 | **EXIT=0** |
| `pnpm exec tsc --noEmit -p tsconfig.json --pretty false` | 全仓 | 0 error |
| `pnpm exec eslint packages/core/src/html/parse.ts --max-warnings 0` | 单文件 | exit 0 |

### R6 交接（未在 src 单方面收尾的部分）

- **回归用例归 G3 测试员**（本轮未动 `tests/**`，遵守手册 §「G3 独占 tests」）：建议 `<svg><template><circle/></template></svg>`（带子树）与 `<math><template>x</template></math>`（纯文本）各 1 例，断言 (a) 不抛、(b) 模板元素 `children` 非空、(c) `serializeHtml` 两轮逐字稳定。现状 `tests/html-parse.test.ts:139` 只覆盖 HTML `<template>`，**命名空间维度是空的**——这正是审计员绕开我的 4000 例 fuzz 抓到它的原因。覆盖率不需要新例：`in` 不是分支点，`descendantsOf` 两臂既有用例都走到了。
- **fuzz 口径（v3#19，进手册）**：4000 例未含 `<svg>`+`<template>` 交叉，故"元素侧不可达"是弱证据。本轮补的矩阵是 `foreign content (svg/math) × 特殊元素 (template/table/select/foreignObject/mi)` 全交叉，建议固化为测试员语料与手册检查项。
- **同类假设的排查**：`grep -n "\.content\b" packages/core/src` 现在只命中 `parse.ts:121`，即读 parse5 模板结构的点已收敛为一处；`ops/readNode/shell.ts`、`ops/outline/constants.ts` 里的 `"template"` 只用于**剔除/阻断**、不读 `content`，因此不受此 P0 影响。

---

## R5 归档（上一轮 · 覆盖率缺口的最后一处）

| 项 | 改动 | 证据 |
| --- | --- | --- |
| `html/parse.ts` 分支 98.5% < 100% | `spanOfLocation` 里 `location.startTag === undefined` 这个臂对元素**不可达**（parse5 保证元素必有 `startTag`），与"缺位置"合并成单一出口：`parse.ts:52` `if (!location?.startTag) return ZERO_SPAN;`，并把 `spanOfLocation` 改为 `(location: P5Location, startTag: P5StartTag)` 两参形态——`sourceCodeLocation` 实际是 `ElementLocation \| null \| undefined`，且 `exactOptionalPropertyTypes: true` 下 TS 的属性窄化不传递到对象类型（传 `location` 会 TS2379），故显式传窄化后的 `startTag`；`innerEnd` 的 `endTag === undefined` 守卫**保留**（`<br>/<img>` 真实可达） | `pnpm verify` **EXIT=0**；`vitest run --coverage` 51 files / `700 passed \| 2 todo`，`parse.ts` 四列 100%。无 `as`/`!`/`v8 ignore`，未改 `vitest.config` 阈值、未改 `tests/**` |

---

## R4（归档 · v3#17）

**为什么不能整串判（后续维护者最容易再犯的一条）**：`normalizedUrl`（`fragment.ts:26`）会把空白与控制字符一起剥掉，所以把 `;` 换成空格再整串判，等于先把列表**拼回一个 token**（`"safe javascript:alert(1)"` → `"safejavascript:alert(1)"`），首项之外的任何危险值都永远不可能再匹配前缀。列表只能**先切再判**，不能"先净化再判"。

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 逐项判 | `fragment.ts:47-57` | `forbiddenInList` 只按 `;`（SMIL 列表分隔符）切，逐项走同一个单值判定 `forbiddenUrlOf`；不再接受逗号/空白作分隔 |
| 通用属性扫描也逐项 | `fragment.ts:59-69` | `assertAttributesAllowed` 改用 `forbiddenInList`：`href="safe;javascript:…"` 同样被拒（v3#17 #2） |
| `values` 逐项 / `to·from·by` 单值 | `fragment.ts:71-99` | `values` 走列表判定；`to/from/by` 在动画分支保持单值（单值里的分号属相对 URL，v3#17 #1）；`attributeName="onload"` 事件分支不动 |
| 注释保真 | `fragment.ts:71` | "与直接写 `href` 同口径（都按 `;` 逐项判）"现在为真（v3#17 #3） |

**一处刻意的不对称（请审计确认）**：`to='safe;javascript:alert(1)'` 净效果是 **REJECT**——动画分支按 v3#17 #1 单值判，但通用属性扫描是**与属性名无关**的逐项判，第 2 段仍被抓。合法值（`values='0;1;0'`、`values='red;blue'`、`to='#fff'`、`values='https://ok/a;https://ok/b'`、`to='https://ok/a;b'`）全部仍 ACCEPT，所以这里选了"更严但不误杀"的一侧；若要求 `to` 也被豁免，需要给通用扫描加属性名例外（不建议）。

### R4 自证（真实命令 + 作用域）

| 命令 | 作用域 | 结果 |
| --- | --- | --- |
| `node /tmp/m15c/r2g-values.mjs`（审计员脚本） | 10 条 values 漏网探针 | **10/10 REJECT forbidden_content** |
| `pnpm exec jiti /tmp/m15d/r4.mjs` | 5 条裁定漏网 + 5 条合法值 + 通用扫描 2 条 + `to` 单值 2 条 | **14/14 PASS** |
| `pnpm exec jiti /tmp/m15d/r3.mjs`（回归） | v3#16 + 非目标 + P1-6 区间 + v3#12 幂等 | **11/11 PASS**（`values="https://ok/;javascript:…"` 仍 REJECT） |
| `pnpm -s verify` | 全仓六步 | **exit 1，仅第 4 步**：`675 passed / 2 todo / 0 failed`，覆盖率 99.57% 行 / 98.83% 分支 |
| `pnpm -s depcruise … packages` | 全仓依赖图 | exit 0，0 违规 |
| `pnpm -s knip --strict` | 全仓 | exit 0 |
| `pnpm exec prettier --check .` | 全仓 | `All matched files use Prettier code style!` |

### R4 残留（与 R3 同一批 6 处，全部归测试员）

| 位置 | 语义 | 覆盖输入 |
| --- | --- | --- |
| `io/atomic.ts:69-70` | 父目录 `realpath` 跑出 workspace → `path_outside_workspace` | fake fs：`realpath(dir)` 第二次返回 workspace 外路径 |
| `io/atomic.ts:77-78` | rename 目标变成符号链接 → 拒写 | fake fs：`lstat(target)` 返回 `isSymbolicLink: true` |
| `io/lock.ts:113-115` | 陈旧接管 CAS 不符 → 丢弃副本、不写回 | fake fs：`readFile(stealPath)` 返回另一个 nonce |
| `ops/patchNode/fragment.ts:79-80,90-94` | `values` 出现危险项 → `forbidValue`（v3#16 的 URL 分支） | 一次 `<svg><animate attributeName="href" values="safe;javascript:alert(1)">` patch |
| `html/parse.ts:50` | `locations:true` 下隐含骨架元素 → `ZERO_SPAN` | `parseHtml("<p>x</p>", { locations: true })` 断言隐含 `<html>` 的 span 全 0 |

> 本轮顺带把 `fragment.ts` 的行覆盖率从 87.17% 拉到 **94.16%**：`forbiddenInList` 现在被通用属性扫描复用，仓库既有用例就会走到它；剩下未覆盖的只有"动画改 URL 属性"这一段（`forbidValue`），仍需测试员补 1 例。

---

## R3 归档（上一轮原文）

| 项 | 改动 | 证据 |
| --- | --- | --- |
| **format:check** | 8 个 `src/**` 未过 → `pnpm exec prettier --write "packages/*/src/**/*.ts"`（含本轮新改的 7 个文件），另修 `knip.json` 的格式化 | `prettier --check .` → `All matched files use Prettier code style!` |
| **覆盖率缺口 → 删防御（不是加 ignore）** | ① `io/paths.ts:38-56` 把 `realpathOf`/`statOf` 各自 try/catch 合成一个 `callOf`（catch 只留一处，被 realpath 用例盖住）→ `paths.ts` 100% 行/分支；② `io/atomic.ts:59-71` 的 `assertParentInside` 改 fail-closed：realpath 解析不了直接 `path_outside_workspace`，删掉 `isMissing` 分叉与 `ioFailure` 臂；③ `io/errors.ts` 的 `errorCodeOf`（类型守卫分支永远测不到）→ `codeOf(): unknown`，只与字面量比相等，`isMissing`/`isExists`/`process.ts` 同步；④ `ops/patchNode/apply.ts` 删掉 `assertHtmlText`（非字符串交 `parseHtml` 的 `invalid_html` 契约）、`withoutSelfId` 的三元改 `filter(id => id !== self)`；⑤ `html/parse.ts:54` 的 `location === null \|\| location === undefined` 收成 `location ? … : ZERO_SPAN` | 结果：`paths`/`errors`/`apply` 三维 100%；4 文件 6 处残留 |
| **knip** | `knip.json` 重排：顶层 `entry/project` 保留（否则 `parse5`、`@hreader/core` 会被误报为未用依赖）+ `workspaces["packages/core"].entry` 加 `fixtures/*.mjs`、`tests/**/*.ts`（否则 tests 的 helper 报 unused files）；`io/index.ts` 不再对外转出内部 `OpenFile`/`OpenMode`；`ignoreIssues` 只压 4 个文件的 `exports` —— 它们全是 **测试专用契约**（`TMP_PREFIX`/`removeStaleTmp`/`HISTORY_LIMIT`/`LOCK_RETRY_MS`/`DEFAULT_LOCK_TIMEOUT_MS`/`acquireLock`/`hasAttribute`），`knip --strict` 会把这些当"生产未用" | `knip --strict` exit 0；`hasAttribute` 一度被我按"死代码"删掉，`tests/io/unit-helpers.test.ts` 立刻红 → 已还原（它确实是测试入口） |
| **v3#16（新裁定）** | 发现并修掉一条**真实绕过**：`values="https://ok.example/;javascript:alert(1)"` 原来放行——`forbiddenUrlOf` 对整串做 `startsWith`。新增 `ops/patchNode/fragment.ts:47-57` 的 `forbiddenInList`，按 `[;,\s]+` 切段逐段判（`set/animate` 的 `to/from/by/values` 全走它），`attributeName` 命中 `href/src/xlink:href` 才进 URL 分支 | `/tmp/m15d/r3.mjs` **11/11**：`set href to=javascript:`、`animate src values=…;javascript:`、`set xlink:href from=data:text/html`、`JaVa\tScRiPt:` 混淆全 `forbidden_content`；安全 `href`、`attributeName="fill"` 不误杀 |
| **已知非目标落地** | `docs/02-architecture-and-roadmap.md:335`「已知非目标」段：`<xmp>`/`<plaintext>` raw-text、`style="url(javascript:…)"` 明确不拦并写理由；同段写明 v3#16 的 SVG 动画改 URL 必拦。（注：任务书写的 `docs/03-architecture.md` 不存在，`docs/03` 是协作流程，架构文档是 `docs/02`） | 该段落已就位；r3.mjs 两条"非目标应放行"也断言了 |

### R3 自证（真实命令 + 作用域）

| 命令 | 作用域 | 结果 |
| --- | --- | --- |
| `pnpm -s verify` | 全仓，六步串联 | **exit 1**：第 1–3 步静默通过，第 4 步 `vitest run --coverage` 报 12 条阈值 ERROR；因第 4 步失败，`depcruise`/`knip` **未在 verify 内执行**（故单独跑） |
| `pnpm -s depcruise --config .dependency-cruiser.cjs packages` | 全仓依赖图 | exit 0，134 模块 / 457 依赖 / 0 违规（`io → ops` 边界没被拦） |
| `pnpm -s knip --strict` | 全仓 | exit 0 |
| `pnpm exec jiti /tmp/m15d/r3.mjs` | 11 条 v3#16 + 非目标 + P1-6 区间 + v3#12 幂等 | 11/11 PASS（修绕过前 9/11） |

### R3 未修：`test:coverage` 的 6 处（全部 src 硬化分支，**归测试员**）

| 位置 | 语义 | 能覆盖它的输入 |
| --- | --- | --- |
| `io/atomic.ts:69-70` | 写 tmp 前/rename 前复核 `realpath(dirname)`，父目录真实路径跑出 workspace → `path_outside_workspace`（P0-1 核心） | fake fs：`realpath(dir)` 第二次返回 workspace 外的路径（如 `/etc`）→ 断言 `path_outside_workspace` 且外部文件未变 |
| `io/atomic.ts:77-78` | rename 目标在最后一步变成符号链接 → 拒写（P0-1） | fake fs：`lstat(target)` 在写入前返回 `isSymbolicLink: true` |
| `io/lock.ts:113-115` | 陈旧接管时 `rename → 读回` 的 CAS 不符（锁已被别人换新）→ 丢弃搬走的副本、不写回 | fake fs：`readFile(stealPath)` 返回**另一个 nonce** 的 payload → 断言没有写回 `path`、返回 false 后重试 |
| `ops/patchNode/fragment.ts:52-57` | `forbiddenInList` 本体：列表取值逐段判 | 一次 `<svg><set attributeName="href" to="javascript:alert(1)">` patch（同时盖 85-93 的首段） |
| `ops/patchNode/fragment.ts:85-93` | SVG 动画改 `href/src/xlink:href` → `forbidden_content`（v3#16） | 上述 + `values="https://ok.example/;javascript:alert(1)"`（盖列表分支） |
| `html/parse.ts:50` | `locations:true` 时隐含骨架元素无源码位置 → `ZERO_SPAN` | `parseHtml("<p>x</p>", { locations: true })` 后断言隐含 `<html>` 的 `span` 全 0 |

> `fragment.ts` 的函数覆盖 93.33% 也是同一因：`forbiddenInList` 没被仓库用例调到（我的 `/tmp` 脚本调到了，但覆盖率只认 `tests/**`）。

---

## R2 归档（上一轮原文）



| finding | 改动（文件:行） | 证据 |
| --- | --- | --- |
| **P1-7 OPEN**：`collectSvgScope` 谓词恒假，`assertAnimationAllowed` 从未被调用 | `fragment.ts:53-65`：删掉 `collectSvgScope`（恒假谓词 + 死函数），只对 `<svg>` **子树**跑 `assertSvgAnimations`；**根因**是解析器保留属性名源码大小写（`attributeName` 是驼峰），`attributeValue(attrs,"attributename")` 永远取不到 → `attrs.ts:16-32` 新增 `attributeValueLoose`/`hasAttributeLoose` 做大小写不敏感查找，`meta http-equiv/charset` 同步改用它 | `/tmp/m15c/o-svg-set.mjs`：两条都 `REJECT forbidden_content`；`/tmp/m15d/r2.mjs` 另加 `ONLOAD`、嵌套 svg、非事件属性不误杀、`meta HTTP-EQUIV` 大小写共 6 条 |
| **v3#12 幂等** | `apply.ts:96-108,133-146`：新增 `contentKey(nodes)` = 剥 `data-hr-id` 后序列化；`sameContent` 比较“片段 vs 目标（root 则比 `<article>` 的子节点）”的规范形式，相等则 `spliceFor` 返回 `undefined` → `applyPatch` 原串返回 `{changed:false,newIds:[]}`；`changed` 改为“走到拼接分支即为 true”（等值分支已提前返回，无恒真/恒假臂） | `patch-actions.test.ts` 的 `replace 内容相同即幂等`、`root 目标幂等`、`patch-file.test.ts` 的 `changed:false 不写盘` 三红转绿；r2.mjs 5 条（含“空白差异算不同”“实体拼写等价算相同”“内容真变→新 ID”） |
| **v3#13 空片段** | `fragment.ts:112-116`：`typeof html === "string" && html.trim().length === 0` → `invalid_fragment`，报文含“根元素”；非字符串仍交 `parseHtml` 的 M1.1 契约（`invalid_html`） | r2.mjs：`""` / 仅空白 / 仅注释（后者走“恰好一个根元素”）全 `invalid_fragment`；`42` → `invalid_html` |
| **v3#14 undo 不可读** | 复验为**绿，无需改实现**：契约校验先于 fs；`lstat` 的 EACCES 经 `failureOf`/`ioFailure` 已是 `io_failure`，只有“存在但不是普通文件”才 `not_a_file`。本轮唯一可能影响它的改动是 #15 的锁严格读（`release` 不再抛） | `undo-bytes.test.ts` 全绿（含“atomic restore 失败 → io_failure、快照与文件不动、锁已释放”） |
| **v3#15 锁文件读失败** | `lock.ts:44-62`：`readFile` 的 ENOENT 才算“锁没了”，EACCES/EISDIR → `ioFailure("读取锁文件")`（带 cause），不再当“不存在”去抢；`lock.ts:121-131` 的 `releaseLock` 读失败则**保留锁**且不许抛 | `lock.test.ts` 全绿；r2.mjs 用注入的 EACCES 断言 `io_failure` |
| `atomic.test.ts` 父目录离开 workspace | **是实现缺口**：`atomic.ts:51-66` 的 `assertParentInside` 之前让 `realpath` 的 ENOENT 漏成 `io_failure`。现改为“父目录已无法解析 = 无法证明落点仍在 workspace 内” → `path_outside_workspace`；其余故障仍 `io_failure`（`readdir` EACCES 那条不变） | `atomic.test.ts` 9/9 绿 |

### R2 自证（真实命令 + 作用域）

| 命令 | 作用域 | 结果 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit -p tsconfig.json` | 全仓 | **0 error**（src 与 tests 均干净） |
| `pnpm exec eslint packages/core/src --max-warnings 0` | src | exit 0 |
| `pnpm -s vitest run packages/core/tests/io` | tests/io | **151 passed / 16 files** |
| `pnpm -s vitest run packages/core` | 全 core | **663 passed, 2 todo** |
| `pnpm exec jiti /tmp/m15d/r2.mjs` | 16 条 R2 断言 | **16/16 PASS** |
| `pnpm exec jiti /tmp/m15c/o-svg-set.mjs` | 审计员 P1-7 复现 | 两条 `REJECT forbidden_content` |
| `pnpm exec jiti /tmp/m15c/h-final.mjs` | 审计员回归脚本 | P1-3 / P1-7 / P1-9 段全绿；**“undo chain”段在第二次按 `p1` patch 时 `node_not_found`**（脚本未按 v3#4 更新：内容变更后 ID 换新，续打须用 `newIds[0]`） |

### R2 未修 + 为什么

- `h-final.mjs` 里 3 条 `MISS`（`svg set href`、`style javascript: url`、`xmp raw`）不在 v2#9 名单内，且都不是可执行面：`<xmp>` 内容按 raw text 处理、`style` 的 `url(javascript:)` 不执行 JS、`set href` 只改链接属性。加进名单会误杀合法正文，留待裁定。
- 死代码自查：删掉 `collectSvgScope`（唯一恒假谓词）与其 scope 集合；`noUnusedLocals` + eslint 均 0。`attributeValue` 保留精确匹配（`data-hr-id`/`data-hr-component`），宽松版只给拒绝名单用。
- 审计 P2 未动（本轮只按 P0/P1/v3 收口）。

---

## R1 归档（以下为上一轮原文）

## 0. 自证（真实命令 + 作用域，P0-2）

| 命令 | 作用域 | 结果 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit -p tsconfig.json` | 全仓（src + tests） | **src 0 error**；tests 36 error（见 §4，均为测试员按 R0 签名在写的 `tests/io/**`，test-scope 进行中） |
| `pnpm exec eslint packages/core/src --max-warnings 0` | 仅 src | exit 0，0 warning |
| `pnpm exec jiti /tmp/m15b/repro.mjs` | 17 组断言（P0-1 两种攻击 + P1-1…P1-9 + E2E） | **17/17 PASS** |

`pnpm verify` **未跑**：knip 的 unused file/export 要等 `tests/io/**` 落地；`tests/` 的 36 条类型错误是测试员在写的同一批文件，不由本卡修。

## 1. 逐 finding → 改动 → 证据

| finding | 改动（文件:行） | 证据（`/tmp/m15b/repro.mjs`） |
| --- | --- | --- |
| **P0-1 TOCTOU**（能写到 workspace 外） | `io/atomic.ts:87-101`：`writeTmp` 用 `open(tmp, "wx-nofollow")`（:71）；写 tmp 前 (:91)、rename 前 (:94) 各 `assertParentInside` 复核 `realpath(dirname)`；rename 前 `assertTargetNotLink` (:58/:95) 拒符号链接目标；`io/paths.ts` 新增 `isInsideOrSelf`（放行"父目录就是 workspace"） | 两条确定性攻击（在 deps 上注入时序）：①rename 目标被换成符号链接 → `path_outside_workspace`，`outside/victim.html` 仍为 `VICTIM`，tmp 清空；②父目录中途换外链 → 复核失败，victim 与原文件均逐字节不变，落在外部的 tmp 被删 |
| **P1-6 字节保真**（全篇 serialize 会重写 CRLF/引号/实体） | `html/parse.ts:36,50,164,254-262`：`parseHtml(html, { locations })`（默认关，M1.1 行为不变），元素带 `span{start,end,innerStart,innerEnd}`；`ops/patchNode/apply.ts:96-129,135-147`：**按源码区间拼接**，`rangeFor` 决定 from/to（元素整段 / 零宽插入点 / root 用 inner），被替换子树内部才重新序列化；`ops/patchNode/tree.ts` 整棵重建方案已删除 | CRLF + 单引号 + `&nbsp;` + 4 空格缩进的文档 patch 一个 `<p>`：前后缀逐字节相等，**实际改写区间 = `[120,168)` / 229 字节**，中段 `"<p class=\"note\" data-hr-id=\"hr-a4c310ea\">a\u00a0b</p>"`；delete/append 同样只动目标区间 |
| **P1-3 root 保护** | `apply.ts:83-94`：`targetId === "root"` 只认最外层 `<article>`；按**身份**判 `isRoot`（`:92`），delete/insert_before/insert_after → `invalid_input`（`:119-125`） | root 的 delete/insert_* 抛 `invalid_input`；root 的 replace/append 后 `<article data-k='v'>` 开标签（含属性、单引号）逐字节不变 |
| **P1-4 片段剥 ID 重注入** | `ops/patchNode/ids.ts`（`stripHrIds` + `collectHrIds`）、`fragment.ts:113-117`、`apply.ts:117-128`：片段一律剥 `data-hr-id`，再用整篇文档 ID 当 `reserved` 重注入；`newIds` 只含重注入结果 | 片段抄目标自己的 ID / 抄别人的 ID / 自带新 ID 三种都变成一次性新 ID，全文无重复；`reserved` 生效（R1 修掉 `walkElements` 之前"停在 document 根"的遍历 bug，见 §3） |
| **P1-5 BOM 只加一次** | `io/bytes.ts`：`decodeUtf8` 用 `ignoreBOM: true` **保留** BOM 字符，写回靠源码区间带走，不再额外拼 BOM | 带 BOM 的文件 patch 后首 3 字节仍是 `EF BB BF`，第 4-6 字节不是 BOM；`result.bytes` 与实际字节数一致 |
| **P1-8 `changed` = 字节相等** | `apply.ts:145-146`：`changed = 拼接结果 !== 原串`；`apply.ts:107-115`：replace 时把**被换掉的 ID** 从保留集摘掉，重复 patch 才能推出同一个 ID | 同一请求连打两次：第二次 `changed:false`、`newIds: []`、`historyPath: null`，文件字节不变、历史仍只有 1 份 |
| **P1-9 undo 哈希前缀** | `io/history.ts:18-30,63-73`：快照名 `<sha256-16>-<ts>-<seq>.html`；`io/undo.ts:24-31`：`sha256.startsWith(name.hash)` 不符则 `io_failure` 且**不消费**快照 | 篡改快照后 undo → `io_failure`，坏快照仍在盘上，目标文件字节不变；命名（含哈希前缀）另有一条断言 |
| **P1-1 锁单次写 + 原子接管** | `io/lock.ts:70-97`：`open(wx)` 后**一次**写全量 payload（不再 open→读→写）；接管改为 `rename` 成 `.steal-<nonce>` 后比对 payload `nonce`（CAS），不符就放回；`:139` 先 `mkdir` locks 目录 | 死 pid 陈旧锁被接管且最终释放（locks 目录空）；活 pid + 新鲜 `at` → `locked`，别人的锁字节不变 |
| **P1-2 tmp 带 pid、只清死者** | `io/atomic.ts:19-46`：名字 `.hr-tmp.<pid>.<nonce>.<basename>`，回收只认"名字可解析出 pid 且（pid 已死或 mtime 超 5min）" | 死 pid 的 tmp 被删；**活 pid** 与**名字不可解析**的 tmp 都保留 |
| **P1-7 拒绝名单** | `ops/patchNode/constants.ts:31-43` + `fragment.ts:22-66`：`script/style/iframe/object/embed/link`、`meta http-equiv|charset`、`on*`、`javascript:`/`data:text/html`（先剥空白与控制字符再小写）、SVG `animate|set` 的 `attributeName=on*` | 六类样例全部 `forbidden_content`；两个根元素 → `invalid_fragment` |

## 2. 端到端

`/tmp/m15b/repro.mjs` 的 E2E：五动作链式推进（replace → insert_before → insert_after → append → delete）均 `changed:true` 且 CRLF/article 属性原样；**undo 两次逐字节回到上两次写盘前**；连打 12 次后历史收敛到 `HISTORY_LIMIT=10` 份。

## 3. R1 期间发现并修掉的两个自身 bug（测试员请照着补用例）

1. `walkElements` 之前写成 `if (node.kind !== "element") continue;` → 遍历停在 `document` 根，**一个元素都访问不到**，导致拒绝名单与 `reserved` 全部静默失效。现集中于 `ops/patchNode/walk.ts:10-22`，须有一条"根在 document 下"的片段用例（`:16-18` 已注释）。
2. `resolveTarget` 的 workspace 是 `realpath` 结果，而 macOS 上 `/var → /private/var`：文件直接放在 workspace 根时 `realpath(dirname) == workspace`，严格 `isInside` 会误判逃逸。已加 `isInsideOrSelf`。

## 4. 未修 / 需要别人接的部分

- **超出卡片名义范围但必须改的三处 `html/**`**（审计 P1-6/P1-4 直接要求，均为增量、默认关）：`parse.ts` 新增 `locations` 选项（默认关，M1.1 行为不变）、`constants.ts` 新增 `SourceSpan` 与可选 `span`、`inject.ts` 新增 `{ reserved, insideArticle }` 选项（默认行为未动）；另 `hr-error.ts` 仍是上轮追认的 6 个码，本轮**没有**加码。
- **tests/ 36 条类型错误**（`tests/io/{harness,lock,undo,node-fs,fragment-gate,v2-rulings}.test.ts`、`entry-points.test.ts`）：测试员按 R0 签名写的，R1 的签名迁移清单——
  `ExclusiveFile → OpenFile`；`open(path)` → `open(path, "wx" | "wx-nofollow")`；`FileStat` 增 `isSymbolicLink()/mtimeMs`；
  `writeAtomic(fsApi, path, data)` → `writeAtomic({ path, workspace, data }, deps)`；`removeStaleTmp(fsApi, dir)` → `(deps, dir)`；
  `LOCK_STALE_MS` 已删除（改用 mtime + `STALE_UNPARSABLE_MS/STALE_LIVE_MS`）；`ResolvedTarget` 增 `workspace/lockPath`；
  `historyDirOf(target)`；`listSnapshots/pruneSnapshots(deps, dir)`；`writeSnapshot({ dir, workspace, data }, deps)`；`Snapshot` 增 `hash`；
  `parseFragment` 返回 `HtmlNode`；`ops/patchNode/tree.ts` 已删除（无 `rewrite/withChildren`），新增 `walk.ts`、`ids.ts`。
- **残留 TOCTOU 窗口（如实记录）**：`node:fs` 没有 `openat`/`dirfd`，`realpath(dirname)` 复核与真正的 `open` 之间仍有极小窗口；本轮把"能改外部**目标文件**"堵死（双复核 + `wx-nofollow` + 拒符号链接 rename 目标），但极端窗口内仍可能在外部**新建** tmp/快照（随后被清）。彻底解法要 `O_NOFOLLOW|O_DIRECTORY` 或 `fs.opendir` 句柄级写，属于后续卡。
- **实体口径**：被替换子树内部按 M1.1 序列化口径重写（`&nbsp;` → `U+00A0`、属性顺序按注入结果）；区间外不受影响。若要求片段内也保持实体原样，需要 serializer 支持"保留原文"，不在本卡。
- 未跑 `depcruise`（G1 只要求 tsc/eslint/脚本）；`ops/patchNode/**` 里 `grep -n "node:fs\|node:path\|process\."` 为空，`process.pid/process.kill` 只出现在 `io/{lock,atomic,process}.ts`。

ACP: R1 完成 P0-1、P1-1…P1-9 全部返工；`tsc`(src 0 error / tests 36 test-scope)、`eslint src` 0 warning、`/tmp/m15b/repro.mjs` 17/17；P1-6 的 diff 实测落在目标 `<p>` 的 `[120,168)` 字节区间。
