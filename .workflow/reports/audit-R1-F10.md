审查已完成。没有写工具，因此完整报告放在下方；请将以下内容保存到 `.workflow/reports/audit-R1-F10.md`。

---

# audit-R1-F10 · F7/F9/F10 三段 diff 结构审计

审计范围：`packages/core/src/ops/patchNode/content.ts`（F7）、`packages/core/src/ops/patchNode/fragment.ts`（F9）、`packages/core/src/html/constants.ts` + `html/inject.ts` + `html/seed.ts` + `html/slots.ts` + `html/text.ts` + `ops/patchNode/apply.ts`（F10）。只读、无 shell；所有结论基于源码判据（"如果…则…"）。解析器实测行为以 `packages/core/src/html/parse.ts:3` 用 **parse5**（真 HTML5 规范解析器，含插入模式与 foster parenting）为前提。

## 判决：**CHANGES-NEEDED**（P1 × 3，P2 × 6，无 P0）

---

## 1. 三个集合是否真的分离（M4.1 是否复发）

全仓调用点清单：

| 调用点 | 用的集合 | 语义 | 判定 |
|---|---|---|---|
| `packages/core/src/html/constants.ts:25` `BLOCK_TAGS` | — | 内容模型投影 | 定义处 |
| `packages/core/src/html/constants.ts:52` `ADDRESSABLE_TAGS` | `= BLOCK_TAGS ∪ {h5,h6,div,aside,nav,main,article,dl,dt,dd,figcaption,caption,thead,tbody,tfoot,tr,td,th}` | 有无 id | 定义处 |
| `packages/core/src/html/constants.ts:79` `PATCHABLE_TAGS` | `= ADDRESSABLE_TAGS`（同一引用） | 能否当 patch 目标 | 定义处（当前零例外） |
| `packages/core/src/html/inject.ts:38-39` `isInjectionTarget` | `ADDRESSABLE_TAGS` | 分配 id | ✅ 正确 |
| `packages/core/src/ops/patchNode/attrs.ts:39` `isBlockLevel` | `PATCHABLE_TAGS` | patch 目标判定，唯一调用点 `ops/patchNode/apply.ts:89` | ✅ 正确 |
| `packages/core/src/model/attrs.ts:22-24` `isBlockElement` | `BLOCK_TAGS` ∪ (div + `data-hr-component`) | 派生文档模型 | ✅ 语义对（且 `BLOCK_TAGS ⊆ ADDRESSABLE_TAGS`、`div ∈ ADDRESSABLE_TAGS` ⇒ 不变量"每个模型节点都有 id"仍成立） |
| `packages/core/src/style/extract/paragraphs.ts:12` | `BLOCK_TAGS` 注释口径 | 段落抽取 | ✅ 一致 |

结论：**没有第二处把"寻址/目标"语义塞进 `BLOCK_TAGS` 的地方**，M4.1 的三语义复用没有复发。唯一残留是 P2-1（`model/attrs.ts:21` 的注释仍在宣称两处"同一判据"，而这已不成立）。

## 2. `injectSeedOf` 会不会造重复 id —— **不可能**（给证明）

判据链：

1. 片段入树前 id 全被剥掉（`ops/patchNode/fragment.ts:239` `stripHrIds`），所以 `inject.ts:127-129` 那个"已合法 id 直接返回、不登记 `used`"的早退分支在 patch 路径上不可达。
2. 保留集 = 整篇文档现存 id（`apply.ts:230` `collectHrIds(parsed.root)`），`replace` 只额外摘掉**整个被删区间**的 id（`apply.ts:150-157` `withoutReplacedIds`）——被摘掉的那些元素确实随旧字节一起消失。
3. 每次发号都登记：`inject.ts:131-134` `const id = uniqueId(...); context.used.add(id)`。
4. 种子 = 标签 + 同标签兄弟序号 + 文本前缀 + 祖先摘要（`inject.ts:117` `seedOf`），而 `slots.ts:23-25` 的同标签序号在同一父下唯一 ⇒ 同一棵树内两个节点不可能同种子；即使同种子，`uniqueId`（`inject.ts:68-76`）会产出 `-2` 后缀。
5. `replace` 复算种子只喂**片段根**（`apply.ts:169-175` `injectFragment` 把片段元素自身当 root，`rootSeed` = `injectSeedOf(root, located.target)` 的 `(parentDigest, siblingIndex)`），与 `seed.ts:34-37` `childDigestOf` 逐字同口径 ⇒ 复算出的 id = 旧 id，且旧 id 已从保留集摘除 ⇒ 不自撞。

兜底还在：重复 id 是 `duplicate_id`、severity `error`（`html/constants.ts:179` `:205`，`model/validate.ts:145-170`）。**未发现反例**。

## 3. `<tr>` 片段按祖先链解析

- 祖先链**没有**变成"绕过校验的通行证"：`fragment.ts:232` 解析后仍跑 `assertNoForbiddenContent(parsed.root)`（`:187-193`，覆盖标签/属性/SVG 动画），而目标侧的五类内容模型判定由调用方无条件执行（`apply.ts:218-219`），与祖先链无关。✅
- "同一片段在不同目标下语义不同"这一点**已被边界判定接住**：`<tr>` 片段 append 到 `<td>` 目标 → `content.ts:188-196` ③（`td ∉ TABLE_STRUCTURE_PARENTS`）拒绝；`<td>` 片段 append 到 `<div>` → 同样拒绝。✅
- 但"容器子节点投影"是个过滤器（见 P1-2）。

---

## 3'. 内容模型覆盖度（第 4 点确认）

- `td` 装 `div`：**合法**，`content.ts` 未对 `td/th` 设 `ONLY_CHILDREN`，与 HTML5 flow content 一致；parse5 在 in-cell 模式下不会移走块级元素。✅
- `tr`(`:95`)、`thead/tbody/tfoot`(`:96-98`)、`dl`(`:99`)、`select`(`:94`) 的 `ONLY_CHILDREN` 都写进数据表。✅
- `h5/h6/div/dt` 进了 `INLINE_ONLY_CONTAINERS`（`content.ts:69-82`），`p/pre/h1-h6/legend` 同表。✅
- **缺口**：`div/aside/nav/main/article/figcaption/caption/h5/h6` 这些新可寻址容器**没有内容模型条目**，靠"不写 = 放行"。对它们是对的（内部只有表格结构标签会改树，已由 ③ 兜住）；但 `table` 这个最需要白名单的容器也没有条目 ⇒ 见 P1-1。

---

## Findings

### P1-1 `FORBIDDEN_CHILDREN.table` 写反了方向：放行真正会改树的子节点，拒绝真正安全的
位置：`packages/core/src/ops/patchNode/content.ts:117`（`table: new Set(["tr","td","th","thead","tbody","tfoot","caption","colgroup","col"])`），`assertFragmentFits` 判定顺序 `content.ts:221-229`。

判据：`table ∉ ONLY_CHILDREN`（`content.ts:93-100`）、`table ∉ INLINE_ONLY_CONTAINERS`、`table ∉ RAW_TEXT_CONTAINERS`，所以 `<table>` 容器只被第 ④ 类拦——而 ④ 里列的是**恰好不会重排的那 9 个标签**。于是：
- **如果** `assertFragmentFits(tableEl, {tag:"p"})` 不抛错，**则** `hr patch --target <table 的 id> --action append --html '<p>x</p>'` 会把 `<p>` 写进 `<table>` 源码；parse5 在 in-table 模式对 `p/div/ul/li/form/h1…` 启用 foster parenting，重解析后 `<p>` 变成 `<table>` 的**兄弟**⇒ 写出去的字节与解析回来的树不一致，正是本模块自述要拒绝的那一类。
- 反向误杀：`<table>` + `<caption>` / `<colgroup>` / `<thead>` / `<tbody>` / `<tfoot>` 不重排，却被 ④ 拒。（`<table><tr>` 被拒是对的，因为 parse5 会造隐式 `<tbody>`。）

最小修法：给 `ONLY_CHILDREN` 加一条 `table: new Set(["caption","colgroup","tr","td","th","thead","tbody","tfoot"])`（tr/td/th 留着让 ③ 用自己的专项报文拒绝），并把 `FORBIDDEN_CHILDREN.table`（`:117`）整条删掉。这样默认拒绝，`p/div/ul/form` 立刻落到 ②，`caption/colgroup/thead/tbody/tfoot` 恢复可 append。
证据缺口：`packages/core/tests/io/patch-content-model.test.ts:136-145` 只覆盖 `table+tr`、`table+td`，`table+p`/`table+div` 无任何测试（不是有意放行，是漏了）。

### P1-2 祖先链路径把"上下文容器的子节点"当唯一边界：逃出容器的内容被静默丢弃
位置：`packages/core/src/ops/patchNode/fragment.ts:236-239`
```
: contextOf(parsed.root, ancestors).children.filter(isContentNode);
```
判据：`contextOf` 取的是**第一个** `<table>` 的指定后代的 `children`（`fragment.ts:63-81` + `:83-93` `throughShells`），其余节点既不计数、也不报错；`singleElementOf`（`fragment.ts:210-218`）只看这堆候选是不是恰好一个。
反例（可执行）：`--target <tbody 的 id> --action append --html '<tr><td>a</td></tr></table><p>evil</p>'`。`inContext` 拼成 `<table><tbody>` + 片段 + `</tbody></table>`；片段的 `</table>` 关掉了包装器，`<p>evil</p>` 落在 `body` 下 ⇒ 候选仍是 1 个 `tr` ⇒ **接受，`<p>evil</p>` 静默消失**。同类：片段里再开一张 `<table>` 时，`throughShells` 取到第一张表，第二张表的整棵子树消失。
这确实是"祖先链当捷径"的软形态：不是跳过校验，而是**用祖先链决定哪部分内容算数，剩下的当没看见**。

最小修法（二选一，都不需要恢复源码级配对校验）：
- (a) 通用：用 parse5 的 `Tokenizer` 走一遍原始片段计时 start-tag 数，要求"解析后元素数 − 包装祖先数 == start-tag token 数"，不等即 `invalid_fragment`（这条同时把下面 P1-3 一起堵住，且不受可选结束标签影响：`<li>a<li>b` 是 2:2）；
- (b) 窄口径：只对祖先链标签做 token 级深度检查——挂在深度 0 上出现 `</table>`/`</tbody>`/`</select>` 之类即拒绝。

### P1-3 "只丢内容才报结构错误"存在**静默丢内容**的构造（解析后无法自证）
位置：`fragment.ts:220-240`（`parseFragment` 全流程只把 `parsed` 当数据源，从不看 `parsed.diagnostics`）。

判据：parse5 对"忽略该 token"类错误只产 `tokenizer` 级诊断，`parse.ts:70-80` 的映射表里没有对应码；丢弃发生在建树时、不留痕迹，因此解析后的"根数=1"是唯一闸门。三个实测形态：
- `<select><div>x</div></select>` 作片段 → select 模式下 `div` 起始标签被忽略 ⇒ 片段变成 `<select>x</select>`，**元素丢失**，接受；
- `<template><tr><td>x</td></tr></template>` 作片段 → in-body 对 `tr/td` "忽略该 token" ⇒ 空的 `<template></template>`，**全部内容丢失**，接受（append 到任意 div）；
- `<td><tr>…</tr></td>` 作片段（`td` 可作目标，`target` 为 `tr`）→ `tr` 被忽略 ⇒ 空 `td`。

这三条都写进文档后字节是稳定的，所以不是"文档损坏"，但用户输入被无声吃掉。最小修法：P1-2 的 (a) 方案同时覆盖；若不想引入 tokenizer，至少把这三种构造写进 `patch-content-model.test.ts` 当**已知行为**钉住，并在 `packages/core/src/ops/patchNode/fragment.ts` 顶部注明"解析器丢弃的内容不报错"。

---

### P2-1 `model/attrs.ts:21` 注释仍在宣称"与 M1.1 注入范围同一判据"（已不成立）
`packages/core/src/model/attrs.ts:22-24` 现在是 `BLOCK_TAGS ∪ (div + data-hr-component)`，而注入面是 `ADDRESSABLE_TAGS`（`html/inject.ts:39`）。二者已不相等（`td/tr/aside/dl/…` 有 id 但不是模型节点）。
判据：如果后续有人按这条注释"对齐"两处，要么 `div` 重新失去 id（批注无处挂，BUG-13 复发），要么阅读器文档模型被 `td/aside/dl` 污染。修法：改注释为"模型面是寻址面的子集"，并在 `model` 侧加一条断言性测试 `isBlockElement(node) ⇒ 该 node 必有合法 data-hr-id`。

### P2-2 `CONTEXT_ANCESTORS` 里 `caption/colgroup/col` 是死路径
`fragment.ts:25-29` 为它们做了祖先链包装，但 `content.ts:117` 拒收它们作为 `<table>` 的子节点，而 `<table>` 是唯一合法父（`content.ts:143-149`）⇒ 任何 action 都到不了。随 P1-1 一起修就自动复活。

### P2-3 片段的解析诊断被算出后丢掉
`fragment.ts:231` 的 `parsed.diagnostics` 从未上浮（`apply.ts:169-175` 只取 `newIds/rootId/text`）。`duplicate_attribute`（`parse.ts:79`）这类"属性被吞"的情况于是完全不可见。要么上浮，要么在注释里写明"片段诊断一律丢弃"。

### P2-4 过严两处（不塌，但会把用户逼到 replace 整块）
`content.ts:99` `dl: {dt,dd}` 拒绝 `<dl><div>`（HTML5 允许 div 分组）；`content.ts:69-82` 把 `dt` 列进 `INLINE_ONLY_CONTAINERS`（规范里 `dt` 装 flow）。而 `content.ts:67` 的注释刚说过 `dt` "自 R1-F10 起可作目标"。二者不冲突但是同一个坑的两面：能作目标却只能装行内内容。

### P2-5 `append`/`insert_*`/root `replace` 的 id 与位置脱钩
`apply.ts:206-208`（非 replace 一律 `seed: undefined` ⇒ `inject.ts:236` 的 `ROOT_SEED`）⇒ 插入节点的 id 只由"标签+文本前缀"决定；root replace 走 `apply.ts:170-172` 的旧口径（保留旧子 id）。不产生重复（`uniqueId` 兜住），但同一内容插两处会得到 `hr-X` / `hr-X-2`，且 `insert_before` 后既有同标签兄弟的 id 不再等于"重算 normalize 会得到的值"。不影响锚点存活（normalize 是纯增量迁移），建议在 `docs` 里写明这层不对称。

### P2-6 `textSamplesOf`：**没有**把 O(n²) 换成另一处 O(n²)
`packages/core/src/html/text.ts:59-76` 是后序一次遍历 + `sampleFromChildren` 按 `limit` 早停 ⇒ 时间 O(n·limit)，与旧 `textSampleOf` 的 O(n²)（深嵌套每个祖先都要下沉到底）相比是真修。内存 O(n·limit)（`Map<HtmlNode,string>`，每串 ≤ `TEXT_SAMPLE_LENGTH`），40k 节点 × 64B ≈ 2.5MB，可接受。唯一可选优化：只对 `isInjectionTarget` 为真的节点留样本（但那会把"前缀=先序前 64 字符"的口径拆成两份，不建议）。

---

## Correct（已核过、不是问题的部分）

- `injectSeedOf` 与注入器共用 `childSlots`（`slots.ts:14-16`）+ 同一先序（`seed.ts:53-63` vs `inject.ts:200-204`），`replace` 复算种子与 normalize 同口径；`document` 节点不推进 digest 的两处实现也一致（`inject.ts:213-217` vs `seed.ts:30-33`）。
- `replace` 摘 id 的范围与拼接范围一致：`withoutReplacedIds`（`apply.ts:150-157`）对应 `spanOrZero(located.target)` 的整元素区间（`apply.ts:203`），未改动兄弟/子树的 id 不在摘除集内 ⇒ "未改动行/单元格 id 保持"在结构上成立。
- `sameContent` 短路（`apply.ts:221`）避免了"同内容再 patch 一次就换 id"。
- `isBlockElement`（模型）⊆ `isInjectionTarget`（id）：`BLOCK_TAGS ⊆ ADDRESSABLE_TAGS`、`div ∈ ADDRESSABLE_TAGS`，所以不存在"模型节点没有 id"的洞。
- `validate` 不校验"id 是否落在模型节点上"（`model/validate.ts:99-112` 只查格式与重复），因此注入面放宽**没有**制造假诊断。

## 需要监督者跑的验证（我无权跑命令）

```
pnpm -C packages/core exec vitest run packages/core/tests/io/patch-content-model.test.ts
pnpm -C packages/core exec vitest run packages/core/tests/io
pnpm -C packages/core exec vitest run packages/core/tests/html
```
建议新增回归断言（写完 P1-1/P1-2 的修复后）：
1. `assertFragmentFits(table, p)` 抛 `content_model_conflict`；`assertFragmentFits(table, caption|colgroup|thead|tbody|tfoot)` 不抛。
2. `parseFragment('<tr><td>a</td></tr></table><p>evil</p>')` 抛 `invalid_fragment`（或明确断言 p 的文本不出现）。
3. `parseFragment('<template><tr><td>x</td></tr></template>')` 要么抛错，要么在测试里钉住"内容被丢弃"的现状。
4. `applyPatch` 端到端：`--target <table>` + `<p>` 必须拒绝。

---

## 150 字摘要

F9 的"先容错解析、再判结构"方向对，`injectSeedOf` 与注入器共用 `childSlots` 与同一先序，"重复 id 不可能"可证（片段 id 全剥 + 保留集 + `uniqueId` 登记）。三集合已真分离，M4.1 未复发，只剩 `model/attrs.ts:21` 注释过期。三处 P1：`content.ts:117` 的 `table` 黑名单写反（放行会被 foster-parent 的 `p/div`，误杀 `caption/thead`）；`fragment.ts:236` 只取上下文容器的子节点，逃出包装器的内容静默丢弃；解析器丢弃 token 时（`select+div`、`template+tr`、`td+tr`）无任何报告。**判决：CHANGES-NEEDED**（3×P1，6×P2，无 P0）。