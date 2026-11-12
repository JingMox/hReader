# M1.4 `hr_read_node` · G2 审计报告

**裁决：G2: FAIL**（P0: 1 / P1: 3 / P2: 8）

- 审计对象：`packages/core/src/ops/readNode/**`（9 文件 666 行）、`html/constants.ts:133-135,159-161`、`hr-error.ts:11`、门面导出。
- 方法：不经测试框架，用 `node --experimental-strip-types` + `registerHooks` 直接跑 `packages/core/src/index.ts` 的真实导出（探针在 `/tmp/m14-*.mjs`，只读仓库）。所有数字都是我自己跑出来的；未改动仓库任何文件（本报告除外），未 `git add`/`commit`。
- 复跑入口：`node /tmp/m14-p.mjs`（选择器/泄漏/截断）、`/tmp/m14-r.mjs`（批注/外壳计数）、`/tmp/m14-t.mjs`（nth-of-type/诊断子集/回读）、`/tmp/m14-y.mjs`（截断现实形态/性能）。

---

## P0-1 子元素整体超限时整块丢弃 → 读 `<article>` 在常见大文档下返回**空内容**

`packages/core/src/ops/readNode/truncate.ts:44`（`openElement` 的第一道门）：

```ts
if (!fits(emitter, serializeNode(node), limit)) { ... truncated = true; return false; }
```

判据是「该节点**整棵子树**能否装下」。装不下就不进入该节点，也不再尝试保留它的前缀——`openLeaf` 里那条"文本取前缀"的分支（`truncate.ts:112-124`）因此对任何"部分可容纳"的元素内部都不可达。

证据（`node /tmp/m14-y.mjs`）：

```
(a) 100KB 单段落、预算 64KB -> bytes=35 节点数=输出已截断：原 120087 字节 / 上限 65536 字节 / 已保留 1 个节点 html="<article data-hr-id=\"a1\"></article>"
    直接读该段落           -> bytes=65535 前缀="<p data-hr-id=\"one\">字字字字…"
    读该段落 mb=40         -> "<p data-hr-id=\"one\">字字字字字</p>"
(a2) section>p(100KB) 预算 64KB -> bytes=35 html="<article data-hr-id=\"a1\"></article>"
```

即：同一个 100KB 段落，**单独读它能拿到 65535 字节**，**读它的父级 `<article>` 却只拿到 35 字节空壳**。这不是边界小概率：任何"第一节正文就超过剩余预算"的真实文档都会命中，调用方拿到 `truncated: true` 却没有内容，只能再发一次 `hr_read_node` 才知道该读谁。

修复方向：元素级判定改为「开标签 + 预留自身闭合标签能否装下」（`emitter.reserved` 已经在做这件事），能装下就进入并按预算继续裁子节点；只有连开标签都装不下时才整块丢弃。这样 `openLeaf` 的前缀分支才真正可达，契约 5「在元素边界截断 + 补齐闭合」才名副其实。

## P1-1 诊断子集过滤按字符串前缀比对，两个生产者的 path 约定不同 → 一半 M1.1 诊断被静默丢弃

`packages/core/src/ops/readNode/diagnostics.ts:17-23` 用 `path === path || path.startsWith(path + ">")` 过滤 `parsed.diagnostics`；但诊断的 `path` 与 `resolve.ts:64` 生成的 `path` 来自两套索引约定（**子节点序号** vs **同名兄弟序号**）。

证据（`node /tmp/m14-t.mjs`、`/tmp/m14-u.mjs`）：

```
[A invalid_component] diag=invalid_component@html[0]>body[1]>article[0]>p[0]
  read [data-hr-id="p1"]    diag=[]
  read article              diag=[]
  read [data-hr-id="a1"]    diag=[]
[B invalid_hr_id]     diag=invalid_hr_id@html[0]>body[0]>article[0]>p[2]
  read article              diag=[invalid_hr_id@html[0]>body[0]>article[0]>p[2]]
```

`invalid_component` 明明落在目标子树内（`article[0]>p[0]`），却被丢掉；`invalid_hr_id` 因为在另一套约定下算出 `body[0]` 而侥幸通过。`toDocumentModel` 给出的真实路径是 `html[0]>body[1]>article[0]>p[0]`（`/tmp/m14-v.mjs`），且模型 path 连文本节点也编号（`p[0]>undefined[0]`），而 `resolve` 只遍历元素 —— 两套坐标永远无法对齐。

修复方向：不要用字符串前缀做子树判定。给 `Diagnostic` 携带节点定位（或在 `readNode` 内部把 M1.1 诊断按节点身份归位），退一步也要让 `resolve` 与诊断生产者调用**同一个** path 生成函数。

## P1-2 小预算两难无声处理：≤24B 丢锚点，25–34B 超预算

`truncate.ts:130-145`（开标签必然写入 + 闭合标签预留）与 `:44` 的失败分支在预算小于「开标签 + 闭合标签」时互相矛盾。

证据（`node /tmp/m14-t.mjs`，目标 `<article data-hr-id="a1">`，开 25B + 闭 10B = 35B）：

```
  mb=21  bytes=0   over=false ""
  mb=24  bytes=0   over=false ""
  mb=25  bytes=35  over=true  "<article data-hr-id=\"a1\"></article>"
  mb=34  bytes=35  over=true  "<article data-hr-id=\"a1\"></article>"
  mb=35  bytes=35  over=false "<article data-hr-id=\"a1\"></article>"
```

- `mb ≤ 24`：返回空串 —— 违反契约 5「截断后 `html` 前缀必须保留目标节点的开标签」；
- `25 ≤ mb ≤ 34`：返回 35B > `maxBytes` —— 违反契约 5 的输出上限，调用方按 `maxBytes` 预留的上下文会被撑破（最大超出 34B）。

两种分支都能"自解释"，但由此推出的契约是自相矛盾的；必须选一条并写进卡片与测试。

修复方向：`maxBytes < 开标签字节` 时抛 `HrError("invalid_max_bytes")`（比返回空串更有信息量），或在契约里明确「允许超出至多一个开/闭标签」，并加 `maxBytes ∈ {1,24,25,34,35}` 的边界用例。

## P1-3 `script`/`style`/`template` 作为目标被禁，但作为**父级内容**可整块读出

`packages/core/src/ops/readNode/shell.ts:39-41` 只把 `script#hr-meta` / `style#hr-theme` 当外壳锚点剔除；`isForbiddenTarget`（`:19-20`）拦的是目标本身。

证据（`node /tmp/m14-t.mjs`）：

```
  [data-hr-id="st1"]   HrError(node_not_allowed)     ← style 目标禁读
  [data-hr-id="sc1"]   HrError(node_not_allowed)     ← script 目标禁读
  article(template/style/script 无 shell id) -> "<article data-hr-id=\"a1\"><template data-hr-id=\"t1\"><p data-hr-id=\"tp\">ix</p></template><style data-hr-id=\"st1\">s{}</style><script data-hr-id=\"sc1\">var x=1;</script></article>" []
```

同一份内容，作为目标读被判 `node_not_allowed`，作为父级内容读却原样返回 —— 保护可以一步绕过。卡片 3 的措辞（"`html`/`body`/`head`/`script#hr-meta`/`style#hr-theme` 永远不可读…目标若是 `<script>`/`<style>`/`<template>` → `node_not_allowed`"）把"目标"与"内容"混在一起，实现按字面执行了。

修复方向：`stripShell` 一并剔除 `BLOCKED_CONTENT_TAGS`（`constants.ts` 已有该集合）并计入 `stripped_shell`；若产品上确实允许内联脚本进正文，则卡片要写清"只有目标禁读，内容可透出"，并由测试固定该行为。

---

## P2（不阻塞）

1. **P2-1** `selector.ts:99` 常量 `ATTRIBUTE_NAME = "data-hr-id"` 与 `:3` 的 BNF 都写成小写字面量，实现做的是**大小写不敏感**比对：`[DATA-HR-ID="a1"]` 会被接受（`/tmp/m14-p.mjs` 实测返回 article）。行为符合 HTML 属性语义，但 BNF 与实现不符 —— 要么 BNF 注明 `case-insensitive`，要么严格小写。
2. **P2-2** meta 字段名写错时静默返回空批注：同一文档用 `"annotations"` 得 2 条批注，写成 `"pending_annotations"`（M1.3 输出字段名，很容易混）得 `[]` 且**无任何诊断**（`/tmp/m14-s.mjs`）。消费方无从知道是自己写错了还是真没批注。
3. **P2-3** 错误输入形态抛裸 `TypeError`：把 `injectNodeIds(...)` 的返回值（`{ parsed, injected }`）直接递给 `readNode`，得到 `TypeError: Cannot use 'in' operator to search for 'children' in undefined`（`resolve.ts:62` 的 `childNodesOf`），违反契约 1「只有三种 code 走异常」。类型系统能挡，但这是最容易踩的误用（`readNode(injectNodeIds(parseHtml(x)), …)` 是最自然的写法）。建议 `readNode` 入口校验 `parsed.root` 形状并抛 `HrError`。
4. **P2-4** 交付态不绿（测试侧）：`pnpm lint` exit=1，`packages/core/tests/entry-points.test.ts:27` 箭头函数 55 行 > 40；`pnpm test:coverage` exit=1，486 例全绿但 `readNode/{resolve,selector,truncate}.ts` 覆盖率 91.11–98.6% < 100%。实现侧 `format:check`/`typecheck`/`depcruise`(76 modules)/`knip` 全绿。
5. **P2-5** `truncated_output` 报文「原 N 字节」是**序列化后**字节（120087），源文档只有 ~120036 —— 差值来自注入的 `data-hr-id`，且不含被剔除的外壳。报文加"序列化后"四字即可，否则调用方会以为源文件被改过。
6. **P2-6** `<template>` 内部内容可单独寻址读取（`[data-hr-id="tp"]` → `<p data-hr-id="tp">ix</p>`），与"template 本身不可读"不一致；template 内容是惰性的，风险低，但与 P1-3 同源。
7. **P2-7** `resolve.ts:62` `childNodesOf` 对非元素节点返回 `[]`，把"传错根节点"静默降级为空树而非报错（与 P2-3 同源）。
8. **P2-8** `attrs.ts:13` `identifierOf` 用 `data-hr-id ?? id` 兜底：作者写的页面级 `id` 会自动成为可选锚点，`#a1` 会同时命中 `<article data-hr-id="a1">` 与 `<div id="a1">`（`ambiguous_selector`，取文档序第一个）。可接受，但契约 4 只写了 `data-hr-id`，兜底未入契约。

---

## 已验通过（逐项实测，防"只报不看"）

| 项 | 结果 |
| --- | --- |
| 选择器窄文法 | 38 个非法输入全 `invalid_selector`（`:not()`/`[href]`/`a,b`/`a *`/`a > *`/`nth-of-type( 2 )`/`(+2)`/`(0x10)`/`(999…9)`/`(-1)`/`(1.5)`/`＃a1`/`p\0`/`p#x`/`#x p`/`[data-hr-id~=]`/`p::before`/`*`/空串…）；1MB 选择器串也 `invalid_selector`，无回溯爆炸 |
| 4 形态正例 | `#s1` / `[data-hr-id="s1"]` / `'s1'` / 无引号 / `h2` / `article > section:nth-of-type(2)` / 无空格变体 全命中 |
| `nth-of-type` 语义 | 按"同名兄弟"计数：`article > section:nth-of-type(2)` 命中 s2（中间夹 `<p>` 不影响），`(3)` 越界 `node_not_found`，嵌套 section 不被误选 |
| `#id` 与 `[data-hr-id]` | 两种情况走同一 `identifierOf`，`#x` 与 `[data-hr-id="x"]` 输出逐字相等；不一致只来自 `id` 兜底（见 P2-8） |
| 泄漏面 | 读 `article`：`<script`/`hr-meta`/`"version"`/`<html>`/`<body>` 全部 0 次命中；meta 嵌在 `section`、`div` 内也被剔除并 `stripped_shell`；`hr-theme` 同样 |
| 5 件套禁读 | `html`/`head`/`body`/`#hr-meta`/`template`/`style`/`script` 目标全 `node_not_allowed` |
| 注释里的标签 | `[data-hr-id="c1"]` → `node_not_found`（注释内容不参与寻址） |
| 截断边界 | 全量 94035B：`maxBytes=94035/94036` → `truncated=false`；`94034` → 93988B `truncated=true`；标签配对（栈验证）恒 BALANCED；`openTag` 恒保留（除 P1-2 的极小预算） |
| 码点安全 | 组合字符 `e+U+0301`、emoji 截断处无半截代理对；`mb=40` 单元素 → `<p data-hr-id="one">字字字字字</p>` |
| 回读 | 截断输出（100/200/1000/65536）`parseHtml` 回读 0 诊断 |
| `maxBytes` 校验 | `0`/`-1`/`1.5`/`16777217` → `invalid_max_bytes`；`1` 合法 |
| 批注 | `resolved` 与 `pending_ai` 两条都返回、按 meta 数组顺序、`targetId` 不符的被排除；`annotations` 字段名（docs/02:103）下工作正常 |
| 外壳计数 | 同一 article 内 meta+theme → `已剔除 2 处页面外壳锚点` |
| 诊断形状 | `Diagnostic` 仍 5 字段；新增码恰 3 个（`html/constants.ts:133-135`）+ 1 个错误码（`hr-error.ts:11`），severity 均为 `warning` |
| 确定性 | 两次调用 `html` 逐字节相等 |
| 性能 | 560KB 文档读 64KB：13.2–15.7ms（≤60）；1MB 全量截断路径 18.5–21.3ms（≤120）；3000 深嵌套 4.5ms；20000 个 `<p>` 24.4ms；**无 O(n²)** |
| 字节计数 | `grep -rn byteLength readNode/` 零命中；用单例 `TextEncoder` 增量累加（`truncate.ts:6-9`），符合卡片 8「不得反复 `Buffer.byteLength`」 |
| 代码形态 | 文件 16–170 行（≤400）、函数 ≤40 行、模块头 ≤3 行、无 `any`/`as`/`!`、注释中零 `卡号/审计编号/报告` 字样（`grep` 实证） |

## 测试员侧待办（不计入本卡 P 级，但 G3 前必须收口）

- `packages/core/tests/entry-points.test.ts:27` 拆函数以过 `max-lines-per-function`；
- `readNode/{resolve,selector,truncate}.ts` 覆盖率补到 100%，其中 `truncate.ts` 的 branches 91.11% 正是 P0-1 的未被覆盖分支，建议先修 P0-1 再补用例，避免为错行为写测试。

## 返工优先级

1. P0-1（空内容）→ 2. P1-2（预算边界，一行判定 + 5 个用例）→ 3. P1-1（path 约定统一）→ 4. P1-3（与卡片措辞一起定）→ 5. P2-3/P2-2（误用与静默）。

G2: FAIL

ACP: 92.9K estimate / 96.0K provider（`acp_status`，16 个折叠块，delegate none）；本卡新增探针 6 个（`/tmp/m14-{p,q,r,s,t,u,v,w,x,y}.mjs`），实现文件合计 666 行。

---

# G2-R · M1.4 返工复审（2026-11-12）

复审范围：上轮 2 个 P0 + 3 个 P1 + 点名的 6 条 P2 + 回归。所有结论均为本轮自跑复算（探针 `/tmp/m14r1/probe{,2,3}.mjs`，`registerHooks` 直接加载 `packages/core/src`，无 mock、无测试复用）。

## 1. 逐条判定

| 上轮项 | 判定 | 我自己跑出的证据 |
| --- | --- | --- |
| **P0-1** 大段落读 `<article>` 得 35B 空壳 | **CLOSED** | 100KB 单段落 + `maxBytes=65536` → `65535` 字节、`truncated=true`、首 70 字符为 `<article data-hr-id="root"><p data-hr-id="p1">段段…`；`section>p(100KB)` → 读 `<article>` 65534B（含 `<section`、含正文）、读 `<section>` 65536B；`maxBytes=200` → 198B、不超预算、开标签保留 + 正文前缀 `<article data-hr-id="root"><p data-hr-id="p1">段段段段` |
| **P1-1** path 双口径 | **CLOSED（行为）**，唯一性未达成（见 P2-R1） | 栅栏：同一文档两个非法 `data-hr-component`，`parseHtml` 诊断 path = `inject` 后诊断 path = `readNode(article)` 诊断 path，三条逐字相等（`html[0]>body[1]>article[0]>section[0]>p[0]` / `…section[1]…`）；`readNode("#p2")` 只保留 `section[1]` 那条（子树前缀过滤有效）。`git diff bf34c87 -- src/html/inject.ts` 显示 ID 种子仍用 `siblingIndex`（`mixHex(tag#siblingIndex, digest)` 未动），`hash.ts`/`text.ts`/`parse.ts` 零 diff → **ID 值与旧版逐字一致**，"只改调用点、不改输出字节"成立 |
| **P1-2** 极小 `maxBytes` 返回空串/超预算 | **CLOSED** | `mb ∈ {1,24,25,34,35,36}` → 全部 `HrError("invalid_max_bytes")`，报文均含最小可行值：`maxBytes 过小：<article> 至少需要 37 字节，收到 N`；`37`→37B、`38`→37B，`bytes ≤ mb` 恒成立，无空串 |
| **P1-3** 内容级外壳未剔除 | **CLOSED** | 子树含 `script`/`style`/`template`/`script#hr-meta`：输出 97 字节仅剩 `<h2>`，`含<script=false 含<style=false 含<template=false 含secret=false 含tp=false`，`stripped_shell` 计数 = 4（每个内容标签记 1，未对子节点重复计）。目标侧 `#sc`/`#t1`/`#t2` 仍 `node_not_allowed`，"目标禁读 + 内容剔除"两层都在 |
| **P2 #14** `#id` 回退原生 `id` | **CLOSED** | `<div id="native">` 与 `<p data-hr-id="native">` 并存 → `#native` 返回 `<p data-hr-id="native">by-data-hr-id</p>`；仅原生 id 的元素 → `#onlyid` 与 `[data-hr-id="onlyid"]` 同为 `node_not_found`（两者等价） |
| **P2 #15** 误用抛 `TypeError` | **CLOSED** | `readNode(injectNodeIds(...))` / `"str"` / `null` / `{root:"x"}` 四种输入全 `HrError("invalid_input")`，报文点名"不是 injectNodeIds 的结果" |
| **P2 #16** meta 字段名写错沉默 | **CLOSED（机制）/ 引入 P1-R1（见 #2）** | `{"pending_annotations":[…]}` → `invalid_meta: hr-meta 含未知字段 "pending_annotations"（只接受 "annotations"）` |
| **P2 #17** 报文缺"序列化后" | **CLOSED** | `输出已截断：原 102060 字节（序列化后）/ 上限 1000 字节 / 已保留 3 个节点` |
| **P2 #18** BNF 未注明大小写 | **CLOSED** | `selector.ts:3` 已注明；行为实测：`[DATA-HR-ID="p1"]`、`P` 均命中（`P#p1` 仍 `invalid_selector`，复合选择器按契约不支持） |
| **回归** | **无漂移，交付态仍不绿** | `pnpm verify`：31 文件 / **506 用例全绿**（上轮 496 → 旧例零漂移），format/lint/typecheck/depcruise/knip 全绿；唯一红是 `test:coverage` —— 见 P1-R2 |

## 2. 新发现（本轮返工引入）

### P1-R1 · `KNOWN_FIELDS` 只认 `annotations`，把文档化 meta 判成非法

`packages/core/src/ops/readNode/annotations.ts:19` `const KNOWN_FIELDS: ReadonlySet<string> = new Set(["annotations"]);`

`docs/02-architecture-and-roadmap.md:100-104` 的 `hr-meta` **正典形态**是三个顶层字段：

```json
{ "version": "1.0", "style": { "visual": "atelier-editorial", "tone": "feynman-tech" }, "annotations": [ … ] }
```

把它原样交给 `readNode`：

```
diag = ["stripped_shell", "invalid_meta", "invalid_meta"]
msg  = ["已剔除 1 处页面外壳锚点（hr-meta / hr-theme）",
        "hr-meta 含未知字段 \"version\"（只接受 \"annotations\"）",
        "hr-meta 含未知字段 \"style\"（只接受 \"annotations\"）"]
```

即**每一份真实 hReader 文档、每一次 `hr_read_node` 调用都会多出 2 条 warning**；而只写 `{"annotations":[]}` 的（文档未记载的形态）反而零诊断。v2 #16 的意图是抓 `pending_annotations` 这类**拼写接近**的字段，实现却做成了"白名单只有 annotations"。

修复方向（二选一，需协调者定）：① `KNOWN_FIELDS` 收录 `version`/`style`（并考虑后续 `settings` 等），只对白名单外的键报诊断；② 改成"与 `annotations` 编辑距离 ≤ 2 或含 substring `annotation` 才报"，即只抓近似误写。任一方案都要加一条以 `docs/02:100-104` 原样样本为输入的用例（现有 506 例全绿恰恰说明测试也把这个错误行为固化了）。

### P1-R2 · `truncate.ts:122` 的 `false` 臂不可达，`branches 100%` 门永远过不去

```ts
// packages/core/src/ops/readNode/truncate.ts:122
return fits(emitter, serializeNode({ kind: "text", value: prefix }), limit) ? "partial" : "none";
```

不可达证明（同文件 `:63-78` `prefixThatFits` + `:45-53` `fits`）：
- `budget = limit - emitter.used - emitter.reserved`（`:116`）；
- `prefixThatFits(value, budget)` 的二分不变量即 `utf8Length(serialize(prefix)) ≤ budget`（候选串表达式与 `:122` 完全相同）；
- `fits` 的失败条件 `used + size + reserved > limit` ⟺ `size > budget`，故恒为 false。
- 只有 `prefix === ""` 时提前 `return "none"`（`:119`），走不到 `:122` 的第三臂。

实测印证：`pnpm verify` → `ERROR: Coverage for branches (98.27%) does not meet global threshold (100%) for packages/core/src/ops/readNode/truncate.ts`（行号 122），且这是全绿交付的**唯一**红点。也就是说本轮把"覆盖率 100%"门做成了结构性不可满足 —— 测试员无法用用例补齐，只能靠 `/* istanbul ignore */` 或改代码。

修复方向：删掉三元表达式（`prefix` 非空即 `return "partial"`），或把 `budget ≤ 0` 的判定与 `fits` 合并成单一出口让两个臂都可观测。不要用忽略注释掩盖——那会让下一个不可达分支也照此处理。

## 3. 其余（P2，不阻断）

1. **P2-R1 · "唯一路径生成函数"未达成**：`packages/core/src/html/path.ts` 已建并被 `inject.ts:16`、`model/validate.ts:13`、`readNode/resolve.ts:5` 使用，但 `packages/core/src/html/parse.ts:88-89` 仍有一份本地 `joinPath`（`parentPath.length === 0 ? segment : …`），`:164` 仍内联 `` `${source.tagName}[${String(index)}]` ``。今天两处口径相同（栅栏测试通过），但"改 `path.ts` 不覆盖 `parse.ts`"的漂移面仍在。`src/html/parse.ts` 在 v2 Scope 之外，故不判编写员违约，登记为待迁移项（建议 M1.5 顺手做，或把 `pathSegment` 反向 import 进 parse.ts）。
2. **P2-R2 · `stripped_shell` 报文与计数不一致**：`readNode/diagnostics.ts:32` 写"已剔除 N 处**页面外壳锚点（hr-meta / hr-theme）**"，但 v2 #13 之后 N 已包含子树内普通 `script`/`style`/`template`（我实测 N=4 时其中 3 个不是锚点）。编写员已在自证里自陈此点并留待裁定；建议改文案（"已剔除 N 处不可读内容（外壳/可执行容器）"）+ 同步改 2 条逐字断言。
3. **P2-R3 · `readNode` 的入参约定被收窄，且未进契约**：v2 #15 让 `readNode(injectNodeIds(x))` 变 `invalid_input`，于是 `#id` 定位只能作用于**已注入**的 `inj.parsed`，而 `readNode` 自身不再注入。这是合理的分层，但契约 1 的签名只写 `parsed: ParsedHtml`，没有写"必须先 `injectNodeIds` 再用 `.parsed`"。建议在契约里加一句，否则 CLI（M1.5）会再次踩到。
4. **P2-R4 · 自证报告把出处写错**：`impl-M1.4.md:165` 称 "`docs/02` §3.1 的 `html[0]>body[0]>…` 示例"，但 `grep -rn "body\[0\]" docs/` 零命中——该示例实际在 `.workflow/cards/M1.2.md:11`（且被标为"契约级、测试逐字比对"）。**裁定**：M1.4 v2 #12 是更晚的裁定（"子节点序号"），故 `html[0]>body[1]>…` 是**修正**不是回归（旧 `body[0]` 是"同名兄弟序号"，与 `parse.ts` 的真实下标不一致，栅栏测试在旧口径下必然失败）；需要做的是给 M1.2 卡片加 errata，而不是改实现。带 `<!DOCTYPE html>` 的文档路径为 `html[1]>body[1]>…`（doctype 占 childIndex 0），实测确认。

## 4. 已验通过（防"只报不看"）

| 项 | 实测 |
| --- | --- |
| 截断可回读 | `maxBytes=3000` → 3000B、`truncated=true`、`parseHtml(输出)` 零诊断（标签配对由序列化器保证） |
| `maxBytes` 校验 | `0`/`-1`/`1.5` → `invalid_max_bytes`；缺省 → 65536；`65537` 合法 |
| 再注入稳定性 | 同输入两次 `injected` 数组相等；已带合法 `data-hr-id` 的文档 `injected=[]`（不重复注入） |
| 裸 `ParsedHtml` | `readNode(parseHtml(x), "article")` 正常返回（未注入时 `#id` → `node_not_found`，符合 P2-R3 的分层） |
| 大小写 | `[DATA-HR-ID="p1"]`、`P` 命中；`P#p1` `invalid_selector`（不支持复合） |
| 禁读面 | `#sc`/`#t1`/`#hr-meta`/`html`/`boty`→`node_not_allowed`；`#tp`（template 内容内的 `<p>`）仍可读（上轮 P2-6，未列入本轮范围） |

## 5. 裁决

**G2-R: FAIL** —— 剩余 **P1: 2**（P1-R1 meta 白名单把文档化形态判非法；P1-R2 不可达分支致 100% 分支门结构性不可满足），P2: 4（R1–R4，均不阻断）。

返工建议顺序：P1-R2（一行删除 + 补一条"注释节点装不下"用例，顺带把 coverage 补绿）→ P1-R1（先由协调者定白名单口径，再改 + 用 `docs/02:100-104` 样本锁死）→ P2-R2（报文与断言同改）→ P2-R1/R3/R4。

ACP: 86.1K estimate / 85.6K provider（`acp_status`，17 个折叠块，delegate none）；本轮探针 3 个（`/tmp/m14r1/probe{,2,3}.mjs`），未新增依赖、未 commit。

---

# G2-R2 · M1.4 收尾终检（2026-11-12）

范围：只验 R1 遗留的 2 个 P1 + 反向变异 + P0-1 不被碰坏。探针 `/tmp/m14r1/probe4.mjs`；变异实验在 `/tmp/m14r1/mut`（rsync 副本），**仓库本体零改动**。

## 1. P1-R1（meta 白名单）→ **CLOSED**

`packages/core/src/ops/readNode/annotations.ts:19` 现为 `new Set(["version", "style", "annotations"])`。实测（同一 harness，`readNode(article)`）：

| 输入（`hr-meta`） | `invalid_meta` | 证据 |
| --- | --- | --- |
| `docs/02:100-104` 原文（`version`+`style`+`annotations`） | **0** | 全部诊断 `["stripped_shell"]` |
| `{"pending_annotations":[]}` | **1** | `hr-meta 含未知字段 "pending_annotations"（只接受 "version" / "style" / "annotations"）` |
| `{"annotations":[],"foo":1}` | **1** | 报 `"foo"` —— 说明没有把校验做松 |
| `{"annotation":[]}`（单数误写） | **1** | 报 `"annotation"` |
| `{"version":"1.0","style":{}}` 单独 | 0 | 只报真未知字段 |
| `{}` | 0 | 不误报 |

报文按 v3 #21 列出了全部三个白名单键；且 `docs/02` 样本下的批注投影路径未受影响。

## 2. P1-R2（不可达分支）→ **CLOSED**

- `truncate.ts` 的三元死臂已**删除**，改为 `prefixThatFits` 直接返回 `{ text, bytes }`，非空即 `emitter.chunks.push / used += bytes` 后 `return "partial"`（不再重算 `fits`，等于把不可达判定整段拿掉，而不是加忽略）。
- 全仓 `grep -rn "istanbul ignore|c8 ignore|eslint-disable|@ts-ignore" packages/core/src/` → **零命中**（确认不是掩盖）。
- 我自己跑 `pnpm verify`：**EXIT=0**，`Test Files 32 passed`、`Tests 511 passed`、`All files 100 | 100 | 100 | 100`，`readNode/truncate.ts` 四维 100（上轮 98.27 的红点消失）。
- `"partial"` 路径有专门用例：`packages/core/tests/read-node-truncate.test.ts:275`（`describe("truncate · a non-empty prefix is still a partial read (v3 #20)")`，注释写明正是为锁住删臂后暴露的路径）。

## 3. 反向变异（手册 §10.2）→ **测试确实绑住行为**

在 `/tmp/m14r1/mut` 副本把 `KNOWN_FIELDS` 改回 `new Set(["annotations"])`（`diff` 仅此行差异），`npx vitest run`：

```
Test Files  1 failed | 31 passed (32)
     Tests  3 failed | 508 passed (511)
  × meta · the canonical payload from docs/02 > should treat version / style / annotations as known fields
  × meta · the canonical payload from docs/02 > should accept version alone and style alone
  × meta · the canonical payload from docs/02 > should flag exactly one invalid_meta when a fourth field shows up
```

即改坏一行 → **3 条红**，且全部落在新增的 `read-node-meta.test.ts` 正典样本上（不是别的用例偶然兜住）。仓库本体未变异（`packages/core/src/ops/readNode/annotations.ts:19` 复核仍为三键）。

## 4. P0-1 未被碰坏

100KB 单段落读 `<article>`（`maxBytes=65536`）→ **65535 字节**、`truncated=true`、正文在位（`<p data-hr-id="p1">段段…`）；`maxBytes=200` → 198B、开标签保留。

## 5. 裁决

**G2-R2: PASS** —— 剩余 **P1: 0**；P2: 2（`P2-R1` `src/html/parse.ts:88-89,164` 仍有一份本地 `joinPath`/内联拼段，`path.ts` 未成为唯一实现，属 Scope 外待迁移；`P2-R4` `impl-M1.4.md` 把示例出处写成 `docs/02` 而非 `cards/M1.2.md:11`）。R1 的 `P2-R2`（`stripped_shell` 文案）与 `P2-R3`（契约补入参前置条件，v3 #23）已确认修复。

**可以提交**（本条只覆盖 R1 两个 P1 与其回归；全卡历史结论见上文各段）。

ACP: 99.0K estimate / 101.6K provider（`acp_status`，17 个折叠块，delegate none）；本轮探针 1 个 + `/tmp` 副本变异 1 次，未新增依赖、未 commit。
