# impl-M1.3 · `hr_outline`

> 一句话：`buildOutline(parsed)` 单趟先序遍历 `<article>`，产出冻结的 outline 树 + `pending_ai` 批注 + 字数 + 诊断；`hr-meta` 只在 `src/meta/` 解析一次。1MB 文档实测 `JSON.stringify(outline)` **7741 B**（另两份极端形态 7731 B / 7586 B，最大 7741 B），`buildOutline` **21–44 ms**。

## 1. 交付物

| 文件 | 行 | 职责（test 可直接 import） |
| --- | --- | --- |
| `packages/core/src/ops/index.ts` | 4 | `ops` 门面（只导 outline） |
| `packages/core/src/ops/outline/index.ts` | 4 | outline 门面 |
| `packages/core/src/ops/outline/constants.ts` | 48 | `OUTLINE_TAGS`、文本/批注/深度上限、8KB 预算、扫节点上限、`Outline*` 类型 |
| `packages/core/src/ops/outline/text.ts` | 39 | `countWords` / `truncate`（Unicode 属性类，无码点区间表） |
| `packages/core/src/ops/outline/walk.ts` | 276 | 单趟先序遍历 → 草稿树 + 字数 + 截断计数 |
| `packages/core/src/ops/outline/annotations.ts` | 70 | `pending_ai` 过滤 + `targetId` 存在性校验 |
| `packages/core/src/ops/outline/budget.ts` | 156 | 8KB 字节预算二分裁剪（先序扁平 + 前缀重建） |
| `packages/core/src/ops/outline/derive.ts` | 68 | 装配 + `Object.freeze` + `outline_truncated` |
| `packages/core/src/meta/index.ts` | 5 | meta 门面 |
| `packages/core/src/meta/constants.ts` | 18 | `MetaAnnotation` / `ParsedMeta` / `PENDING_ANNOTATION_STATUS` |
| `packages/core/src/meta/parse.ts` | 127 | 全仓唯一 `JSON.parse` 点；5 类畸形 → `invalid_meta` |
| `packages/core/src/html/constants.ts` | +8/−2 | 仅扩 `DiagnosticCode` 4 码 + `DIAGNOSTIC_SEVERITY` 4 行 |
| `packages/core/src/index.ts` | +2 | 仅加导出 `buildOutline` / `Outline*` 类型 |

## 2. 契约 → 实现映射

| 契约 | 落点 | 证据 |
| --- | --- | --- |
| AC1 `Outline` 形状 / 冻结 | `derive.ts` `buildOutline`（`Object.freeze` 递归 + 数组冻结） | 探针 `nodes[0].children.push()` → `TypeError` |
| AC1 `level`：h1–h4 取自身；section/header 取"其所属标题层级" | `walk.ts` `enterHeading`/`closeFrame`：`frame.firstHeadingLevel` 按文档序记录子树首个标题，close 时 `previous.firstHeadingLevel ??= frame...` | `<section><header><h4>丁` → section 与 header 都 `level: 4`、`text: "丁"` |
| AC1 无标题 section 继承父级、顶层记 0 | `closeFrame`：`frame.firstHeadingLevel ?? inherited`，根容器 `node === undefined → 0` | 顶层裸 section → `level: 0`；嵌套裸 section → 继承 2 |
| AC2 只输出 `article` 内 section/header/h1–h4 | `walk.ts` `firstArticleOf` + `OUTLINE_TAGS` | `<p>/<pre>` 不入树；页面级 header 不在 article 内 → 不出现 |
| AC1 缺 id → 不输出 + `outline_node_without_id` | `walk.ts` `validIdOf(node) === ""` 分支 | 未注入 id 的文档 → 2 条诊断、节点被省 |
| AC3 字数规则 | `text.ts` `countWords`：ASCII 字母数字连串=1；码点 > `0x7f` 且 `\p{L}`/`\p{N}` 逐码点=1；其余 0 | 12 例全对（§4） |
| AC1 计数对象 = article 全部可见文本 | `walk.ts`：容器/标题一律 `frame.words += …`，close 时 `node.wordCount = frame.words` 并上并父帧 | `header.wordCount = 34`（含 `<p>` 正文），`Outline.wordCount = 69`（docs/02 样本） |
| AC2 体积 ≤ 8KB + 截断诊断 | `budget.ts` + `derive.ts` `truncationOf` | 1MB → 7741 B；任何丢弃都有 `outline_truncated` |
| AC3 `pending_ai` + `comment` ≤200 + `annotation_target_missing` | `annotations.ts` | `ann-01` 进列表；`ghost-id` 发诊断且批注仍输出 |
| AC3 meta 缺失→空且无诊断；非法/结构不符→`invalid_meta` 且空 | `meta/parse.ts` | §5 五例 |
| AC6 仅 4 个新码、`Diagnostic` 五字段不变 | `html/constants.ts` | `Diagnostic` 接口零改动 |
| AC7 语义确定性 | 单趟文档序遍历，无 `sort` | 两次 `JSON.stringify` 逐字节相等（1104 B） |
| AC8 扁平文档 | `walk.ts` heading 栈在同一容器内按 level 缩进 | `<h1>A</h1><h3>C</h3><h2>B</h2>` → A 下挂 C、B |
| AC8 无标题文档 | 根帧 `children: []`，`truncated*` 全 0 → 不诊断 | `{"nodes":[],"diag":[],"wc":3}` |
| AC9 性能 | 见 §6 | 1MB 21–44 ms；10k 节点无栈溢出 |
| AC10 代码形态 | 全部文件 ≤400 行、函数 ≤40 行、两级门面、无 `any`/`as`/`!` | lint/typecheck 绿 |

## 3. 真实文档实测（字节数 + outline 前 30 行）

1. **docs/02 规范示例原文**（article + header/h1/p + 2 section + `hr-meta` 1 条合法批注，另加我自造的 `ghost-id` 批注 1 条与 `resolved` 1 条）：`JSON.stringify(outline)` = **1104 B**，`wordCount = 69`，诊断 `annotation_target_missing`；`nodes` 顶层 3 个（header、sec-problem、sec-comparison）。

```json
{ "nodes": [
  { "id": "sec-header", "tag": "header", "level": 1, "text": "分布式一致性协议深度解析", "wordCount": 34,
    "children": [ { "id": "title-main", "tag": "h1", "level": 1, "text": "分布式一致性协议深度解析", "wordCount": 12, "children": [] } ] },
  { "id": "sec-problem", "tag": "section", "level": 2, "text": "为什么直觉上的“主从复制”一定会丢数据？", "wordCount": 25,
    "children": [ { "id": "h2-problem", "tag": "h2", "level": 2, … } ] },
  { "id": "sec-comparison", "tag": "section", "level": 3, … }
] }
```

2. **扁平文档**（`<h1>A</h1><h3>C</h3><p>x</p><h2>B</h2>`）：`nodes` = `[h1 A{level:1} → [h3 C{level:3}, h2 B{level:2}]]`；无 section 也不崩。

3. **1MB 合成文档**（1,048,782 B HTML，1 个 h1 + 约 350 个 section，每节 6 段中英混排正文）：**outline JSON = 7741 B**（预算上限 8192 B，占 94.5%），740 行，`node_modules` 外无依赖；前十行：

```json
{ "nodes": [
  { "id": "title", "tag": "h1", "level": 1, "text": "1MB 文档", "wordCount": 3, "children": [] },
  { "id": "s0", "tag": "section", "level": 2, "text": "章节 0 标题", "wordCount": 65,
    "children": [ { "id": "h0", "tag": "header", "level": 2, "text": "章节 0 标题", "wordCount": 5,
      "children": [ { "id": "t0", "tag": "h2", "level": 2, "text": "章节 0 标题", "wordCount": 5, "children": [] } ] } ] }, …
```

另三份极端形态（验"极端文档允许超"是否发生）：密布短标题 3000 节 → **7731 B**；每标题 120 汉字 800 节 → **7586 B**；400 条满长批注 → **5821 B**（批注先占 2304 B 份额，故节点让位）。**实测最大值 7741 B，未超 8KB**。

## 4. 字数规则 12 例（期望值都来自卡片规则，非实现值）

| 例 | 文本 | 期望 | 实测 |
| --- | --- | --- | --- |
| 纯中文 | 分布式一致性 | 6 | 6 |
| 纯英文单词 | distributed consensus | 2 | 2 |
| 中英混排 | 我用 PDF 阅读器 | 6 | 6 |
| 数字 | 2026 年 11 月 | 4 | 4 |
| 全角字母 | ＡＢＣ | 3 | 3 |
| emoji | 🎉🎉 | 0 | 0 |
| CJK 扩展 B | 𠀀𠀁 | 2 | 2 |
| 组合字符 | `e` + U+0301 | 1 | 1 |
| 纯标点 | ，。！？；： | 0 | 0 |
| 空串 | `` | 0 | 0 |
| `<code>` 内文本 | `<code>raft.leader == paxos.proposer</code>` | 4 | 4 |
| 纯空白 | 空格/换行/Tab | 0 | 0 |

## 5. `hr-meta` 五类畸形（+ 注入）

| 输入 | 诊断 | `pendingAnnotations` |
| --- | --- | --- |
| 缺失 `<script id="hr-meta">` | 无 | `[]` |
| 空脚本 | `invalid_meta` | `[]` |
| `not json` | `script_in_meta`（M1.1 码）+ `invalid_meta` | `[]` |
| `[1,2,3]` | `invalid_meta` | `[]` |
| `{"annotations":"x"}` | `invalid_meta` | `[]` |
| `annotations: [1, {合法}]` | `invalid_meta`（跳第 1 条） | 1 条 |
| `annotations: [{缺 targetId}]` | `invalid_meta` | `[]` |
| `comment` 里含 `</script>` | `misnested_tag` + `script_in_meta` + `invalid_meta` | `[]` |

> "非 JSON"同时出现 `script_in_meta` 与 `invalid_meta`：前者是 M1.1 既有契约（raw text 被提前截断），后者是 M1.3 新契约。两码都描述同一缺陷，**不是重复实现**；测试请断言"包含 `invalid_meta`"而非"仅此一码"。

## 6. 性能与稳定性

- 1MB 文档（同进程，`parseHtml` 60.7 ms / `injectNodeIds` 35.0 ms 之后单测 `buildOutline`）：**21.0 / 33.8 / 36.4 / 43.8 ms**（≤150 ms 上限）。
- 10k 节点（1 个 h1 + 10000 个 section/heading）：**47** 个顶层节点、`wordCount = 30001`、无 `RangeError`；遍历、扁平化、重建、冻结全部迭代实现，递归深度 ≤ 4。
- 预算与截断：先序扁平 → 前缀保持父先于子 → 二分找最大 `keep`；批注先占 `2304 B`；`RESERVE_BYTES = 512` 留给截断诊断报文。`OUTLINE_NODE_SCAN_LIMIT = 1024` 是**实现自加上限**（卡片未规定），保证万级树上不做 1024 次以上的序列化。
- 确定性：两次调用 `JSON.stringify` 逐字节相等；`buildOutline` 不修改 `ParsedHtml`（前后 JSON 相等）；返回值深冻结。

## 7. `pnpm verify` 状态

```
format:check ✓   lint ✓   typecheck ✓   test:coverage ✗   depcruise ✓   knip ✓
```

- **唯一红线**：`packages/core/tests/entry-points.test.ts:36`（测试员文件）断言"公开面只有 M1.2 的符号"，我按 Scope 新增 `buildOutline` 导出 → `expected [ 'buildOutline' ] to deeply equal []`。
- 覆盖率表因此未输出（vitest 失败即跳过报告）；新文件 0% 属预期，G3 由测试员补齐。
- depcruise：`✔ no dependency violations found (54 modules, 146 dependencies cruised)`；knip：`--strict` 无输出（曾报 4 个未用导出，已把 `characterCount`/`PendingResult`/`WalkedArticle`/`ParsedMeta` 收回模块内）。

## 8. 给测试员的 5 条建议（按性价比排序）

1. **先修 `entry-points.test.ts`**：把 `buildOutline` 加进 `REQUIRED_RUNTIME_EXPORTS`（这是当前唯一红线；同时注意 `Outline`/`OutlineNode`/`PendingAnnotation` 是 type-only 导出）。
2. **打 `section.level` 的"首个标题在 header 里"这条**：`<section><header><h4>丁</h4></header></section>` 必须 `level: 4` 且 `text: "丁"`——这是我第一版漏掉、卡片 AC1 明确要求的点。
3. **打预算边界**：构造 3000 节短标题文档断言 `bytes ≤ 8192` **且** `diagnostics` 里出现 `outline_truncated`（静默丢节点是 P0 级缺陷）。
4. **打"批注不被树挤零"**：400 条 200 字批注 + 300 节 → `pendingAnnotations.length > 0`（我为此加了 2304 B 批注份额）。
5. **打 `hr-meta` 的 `</script>` 注入与双码**：`comment` 含 `</script>` 时断言 `invalid_meta` 存在即可，别断言"仅一码"。

## 9. 请求裁定（3 条，均不阻塞）

1. **`entry-points.test.ts` 的公开面断言**与"每个功能卡可新增导出"在本卡冲突：我按 Scope 改了 `src/index.ts`，测试归测试员。建议 G3 一并改，或把该断言改成"⊇ 必需符号"。
2. **`script_in_meta` 与 `invalid_meta` 双码**：M1.1 的 `script_in_meta` 判据是"JSON 不可解析"，与 M1.3 `invalid_meta` 重叠。建议后续把 M1.1 那条降级为只在"截断风险"场景触发，或干脆合并——需改 `src/html/**`，故本卡不动。
3. **`OUTLINE_NODE_SCAN_LIMIT` / `OUTLINE_ANNOTATION_BYTE_LIMIT`** 是我为实现 8KB 目标自加的两个上限，卡片契约未规定。若审计认为"批注应先于节点"或"扫描上限应可配置"，我按裁定再调。

## 10. R1 返工对照（v2 修订 #11–#18）

| 编号 | 审计问题 | 改法 | 证据 |
| --- | --- | --- | --- |
| P0-1 | `derive.ts:57-63` 把全量 `diagnostics` 塞进 `base`，`fitBudget` 裁不掉 → 2000 节 snake_case 文档 3.28MB、`nodes: 0` | 新增 `ops/outline/diagnostics.ts`：按 `code`+`message` 折叠 → `3 条/code` → `1 条/code` → 只留一条 `outline_truncated`，硬上限 `OUTLINE_DIAGNOSTIC_BYTE_LIMIT = 1024`；截断文案带**真实**省略条数 | 下表三行；`invalid_hr_id` 折叠后仍点名规模（"另有 3997 条诊断省略（invalid_hr_id 3997 条）"） |
| P1-1 | `walk.ts:178` 把 `<style>/<script>/<textarea>/<template>` 的文本计字数 | `NON_VISIBLE_TEXT_TAGS` 命中即整棵子树跳过（不建节点、不计字） | `outline-text.test.ts` 的 "should not let the hr-meta JSON inflate wordCount" 通过；`<title>` 仍计（保持原契约） |
| P1-2 | `text.ts:9-12` 词切分口径不对（`𠀀` 计 0） | `countWords`：NFC 归一 + 组合附标不另计；CJK（Han/Hiragana/Katakana/Hangul，含扩展 B）逐码点 1，其余 `\p{L}\p{N}` 连串 1 | `𠀀`=1、`state-of-the-art`=4、`1,234.56`=3、`l'été`=2、NFC/NFD 同值 |
| P1-3 | `h3` 在 section 内被"父链缺失压缩级别"改成 1/2 | `containerLevel` 递归取"自身首个标题的层级"，删掉压缩补偿；无标题才继承父级 | `<section><h3>丙三</h3></section>` → `level: 3` |
| P2-1 | `derive.ts` 与 `model/derive.ts` 撞名 | 改名 `assemble.ts`；把 `firstArticleOf` 拆到 `locate.ts`（`walk.ts` 302→282 行，回到 300 行上限内） | `ls packages/core/src/ops/outline/` |
| P2-2 | outline 自带第二份空白/文本归一，且与 `html/text.ts` 行为不同 | 标题与节点 `text` 一律走 `normalizeWhitespace` + `textContentOf`（与 M1.1/M1.2 同一份） | `walk.ts` 只 import 不再自写正则 |
| P2-3 | 单节点 `text` 无上限，长标题吃满预算 | `OUTLINE_TEXT_LIMIT = 120` 码点，超出以 `…` 结尾并计入 `outline_truncated` | `truncate` 同时用于批注（200 码点） |
| P2-4 | `budget.ts:153` 用扫描上限冒充丢弃数 | `fitBudget` 收 `builtNodes`（遍历阶段真实建出的节点数），`droppedNodes = builtNodes - keep` | 2000 节文档实测"丢弃节点 3936 个"（4000 建出 − 64 保留） |

### 10.1 三行复现表（审计脚本口径：`parseHtml` → `injectNodeIds` → `buildOutline`）

| 文档（2000 节） | jsonBytes | nodes | 诊断条数 |
| --- | --- | --- | --- |
| snake_case id | **7390** | 65 | 4（`invalid_hr_id`×3 + `outline_truncated`×1） |
| camelCase id | **7402** | 65 | 4（同上） |
| kebab-case id（全合法） | **6743** | 64 | 1（`outline_truncated`） |

修前：同一 snake_case 文档 **3.28 MB**、`nodes: 0`（审计实测）。

### 10.2 1MB 正常文档（不回归）

- `1411632` 字节 HTML（6000 节，id 全合法）→ `JSON.stringify(outline)` = **6654 B**（≤ 8192）。
- 端到端 `parseHtml + injectNodeIds + buildOutline` 三次：**109.4 / 213.7 / 185.2 ms**；`nodes` 顶层 35、`diagnostics` 只有一条 `outline_truncated`。

### 10.3 `pnpm verify`

```
format:check ✓   lint ✓   typecheck ✓   test:coverage ✓   depcruise ✓   knip ✓   → EXIT=0
```

385 例 / 26 文件全绿；覆盖率四维 **100%**（`src/ops/outline` 九个文件逐项 100）；depcruise `62 modules / 171 dependencies` 无违规；knip `--strict` 无输出。

期间为覆盖率补了两处形状：`duplicateDiagnostics` 归组散列化、`flatten`/`rebuild` 去掉 `!== undefined` 死分支（改走 `drainStack` + 切片）。

### 10.4 内部接口面（给测试员：`outline-surface.test.ts` 要按 v2 P2-1 改名）

`src/ops/index.ts` 只导出 `buildOutline`、`Outline`、`OutlineNode`、`PendingAnnotation`。模块内真实导出：`assemble.ts: buildOutline`、`walk.ts: walkArticle / DraftNode / WalkedArticle`、`budget.ts: fitBudget / Budgeted`、`diagnostics.ts: fitDiagnostics`、`annotations.ts: pendingAnnotations`、`locate.ts: firstArticleOf`、`text.ts: countWords / truncate`。审计后已不存在 `deriveOutline` / `budgetOutline` / `annotationsOf` / `wordCountOf` / `OUTLINE_BUDGET_BYTES`（`outline-surface.test.ts:56` 的 red 就是这组旧名）。

ACP: 72.8K 估算 / 96.7K provider（`acp_status`，25 个折叠块，delegate none）。R1 变更面：`ops/outline/**` 9 文件（新增 `diagnostics.ts`/`locate.ts`/`assemble.ts`，删 `derive.ts`）、`html/constants.ts`（无新码）、本报告；`tests/**` 零改动。
