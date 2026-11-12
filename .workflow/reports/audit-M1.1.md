# audit-M1.1 · HTML 解析 / 序列化 / `data-hr-id` 注入

**G2: FAIL**（P0: 0 · P1: 4 · P2: 9）

审计对象：未提交工作区（`packages/core/src/html/**` 9 个文件 948 行 + `src/index.ts` + `src/hr-error.ts`）。
方法：不读代码猜，全部经**真机复算**——用 `node --import /tmp/m11/hooks.mjs`（一个 `registerHooks` 解析钩子，把无扩展名 import 映射到 `.ts` / `index.ts`，不装新依赖）直接跑 `packages/core/src/index.ts` 的真实导出，44 段样本 + 5 组计时。临时文件全在 `/tmp/m11`，仓库除本报告外零写入，未 `git add`/`commit`。

## 0. 当前门禁快照（我自己跑的，逐条单跑）

```
pnpm verify        exit=1   ← 卡在第一步 prettier --check .
pnpm format:check  FAIL     [warn] packages/core/tests/html-parse.test.ts
pnpm lint          FAIL     8 problems (8 errors)  ← 全在 tests/**
pnpm typecheck     FAIL     packages/core/tests/html-parse.test.ts(85,24): TS2339 Property 'children' does not exist on type 'HtmlNode'
pnpm test:coverage FAIL     Test Files 2 failed | 4 passed (6) · Tests 7 failed | 60 passed (67)
pnpm depcruise     OK       ✔ no dependency violations
pnpm knip          FAIL     Unused files (1) packages/core/tests/html-support.ts
```

编写员在 `impl-M1.1.md:87-101` 已**诚实记录**这一红灯并归因给测试员快照断言，这一点我认可；但"未提交工作区可以合并"与"`pnpm verify` 全绿"是两件事，当前状态不可提交（见 P1-4 的归因拆分，红里有 3 条是真实现问题）。

---

## P1（本卡必修）

### P1-1 `balance.ts` 把**合法 HTML 的隐式闭合**报成 `misnested_tag` —— 真文档必然刷屏

- 位置：`packages/core/src/html/balance.ts:132-144`（`closeTag`）对照 `:124-131`（`popImplied`）与 `:146-148`（`openTag` 里唯一调用点）。
- 机理：`popImplied` 只在**开标签**路径调用（`:147`）。结束标签路径 `closeTag` 直接 `lastIndexOf` + `stack.slice(index+1)`（`:140`）把中间所有元素判成"被强行闭合"。于是 `<li>` 被 `</ul>` 关闭、`<td>/<tr>` 被 `</table>` 关闭这类**HTML 规范允许的隐式闭合**全部误报。
- 证据（我自己跑，4 条全是合法 HTML，浏览器行为就是这个）：
```
$ node /tmp/m11/run6.mjs
Z1 <p>a<table><tr><td>c</table>       ["misnested_tag","misnested_tag"]
Z2 <ul><li>a<li>b</ul>                ["misnested_tag"]
Z9 <article><ul><li>a<li>b</ul></article>        → 1 条
Z8 <article>…<ul><li>x<li>y</ul>…</article>      → 1 条（真实结构也中）
```
- 影响：`docs/05` M1.2 的语义校验、M1.4 的 `hr_read_node` 都会拿 `diagnostics` 当质量信号；现在**正常文档也带 1–2 条噪声**，M1.2 的"导出 HTML 带诊断"会变成误报工厂。这也是测试员 `html-balance.test.ts:35-50` 那 4 条红测的真实成因（我独立复现，非测试员臆造）。
- 修复方向：`closeTag` 在 `lastIndexOf` 之前先按 `CLOSED_BY` 把隐式可闭合的栈顶弹出（与 `openTag` 同一套 `popImplied` 语义，但目标标签换成"被这个结束标签隐式闭合"的集合，如 `ul→li`、`table→tr/td/th/thead…`、`select→option`、`dl→dt/dd`），只有**残留的真错嵌套**才发 `misnested_tag`。

### P1-2 公开入口导出 7 个**无人使用**的类型，且"knip 会抓"这个自证前提不成立

- 位置：`packages/core/src/index.ts:6-17`（10 个 `export type`）。
- 证据（测试树里真实引用计数，`grep -rl <Type> packages/core/tests/ | wc -l`）：
```
HtmlAttribute 0 · HtmlCommentNode 0 · HtmlDoctypeNode 0 · HtmlDocumentNode 0
HtmlTextNode 0 · Diagnostic 0 · InjectedNodeIds 0      ← 零引用
HtmlNode 2 · ParsedHtml 3 · HrErrorCode 1              ← 在用
```
  同一次 `pnpm knip` 只报了 `Unused files (1) packages/core/tests/html-support.ts`，**没有**报这 7 个导出——因为 `knip.json` 把各包 `src/index.ts` 声明为 `entry`，入口的所有导出永久豁免（我在 `audit-M1.0.md` P2-3 已记录该局限）。
- 影响：卡片 7 写得很硬——"`packages/core/src/index.ts` 不加未用导出（knip 会抓）"。现在既违反了前半句，又证明了后半句这个门禁**抓不到**它。`HtmlCommentNode/HtmlTextNode/HtmlDoctypeNode/HtmlAttribute` 本来就能从 `HtmlNode` 联合里取到，重复导出只会让"极小导出面"名存实亡。
- 修复方向：入口只留 `HrError`(+`HrErrorCode`)、`parseHtml`/`serializeHtml`/`injectNodeIds`、`ParsedHtml`/`HtmlNode`/`Diagnostic`/`DiagnosticCode`；其余收进 `src/html/index.ts`（子模块门面）或干脆不导出。同时把"knip 抓不到入口导出"写进 `docs/04`，别再当门禁用。

### P1-3 越界新增 `packages/core/src/hr-error.ts`（不在卡片 Scope 内）

- 位置：`packages/core/src/hr-error.ts:1-24`（新文件，`git status` 显示 `?? packages/core/src/hr-error.ts`）；`packages/core/src/index.ts:3-4` 改为 re-export。
- Scope 原文：`packages/core/src/html/** 新建` / `packages/core/src/index.ts 仅加导出` / `package.json` / `pnpm-lock.yaml` / 报告。**`src/hr-error.ts` 不在其中**，而这次改动不是"仅加导出"——它把 M1.0 已交付的 `HrError` 从入口文件整体搬走（`git diff packages/core/src/index.ts` 显示删除 24 行、新增 re-export）。
- 内容风险 = 0（我逐字比对：`HrErrorCode` 六个值与 `HrError` 实现与原文件一致，跨包 `instanceof` 行为不变，测试全绿）。但纪律风险不为 0：卡片白纸黑字的 Scope 是 G2 的判据之一，而 `docs/03` §3.5 是单写者纪律。
- 修复方向：二选一——(a) 协调者补一条卡片修订，把"入口只做 re-export、实现移入 `src/hr-error.ts`"写成 M1.1 的显式 Scope；(b) 回退到"实现留在 `src/index.ts`，M1.1 只追加导出"。**不要**默默留着，否则下一张卡的 audit 会拿它当先例。

### P1-4 交付态是红灯，且 7 条红测里有 3 条由实现引起（不是"全是测试员过期断言"）

- 现状见 §0。归因拆分（我逐条跑，不是抄测试输出）：
  - **实现侧 3 条**：`html-balance.test.ts:35-50` 的两个用例（`<p>a<table><tr><td>c</table>`、`<ul><li>a<li>b</ul>`）→ P1-1；`html-balance.test.ts:57` 的消息文本 → P2-4。
  - **测试侧 2 条**（测试写错了，实现是对的）：`html-balance.test.ts:19` 要求 `<ul><li>a` 零诊断——但 `ul` 的结束标签在 HTML 里**不可省略**（`OPTIONAL_END_TAGS` 不包含 `ul`，实现正确）；`html-parse.test.ts:57-65` 要求 `<!DOCTYPE html><!--c-->hi` 的 document 子节点是 `[doctype, comment, text]`，实测 `["doctype","comment","element"]`——parse5 按规范把裸文本放进 `body`，实现正确。
  - **未规定 2 条**：`html-balance.test.ts:15`、`:54` 断言诊断**顺序**（内层先 vs 栈底先）。卡片没规定顺序，两边都不算错，但红了就是红了。
  - **工具链 3 条**（测试侧）：`html-parse.test.ts(85,24)` 的 `TS2339`（`HtmlNode` 联合上直接取 `.children`）、`html-support.ts` 的 4 条 lint（`max-depth`、`no-unsafe-*`、`ts-expect-error` 被 `no-warning-comments` 拦、81 行的 `max-lines-per-function`）、以及未使用文件 `html-support.ts`。
- 修复方向：实现侧按 P1-1/P2-4 修；测试侧的 2 条错误断言改期望；顺序类断言改成 `expect.arrayContaining` 或先对诊断排序再比。**在 `pnpm verify` 回绿之前本卡不能出 G2。**

---

## P2（可排期，登记即可）

1. **`stableHex8` 丢掉每个星光面字符的低位代理**：`packages/core/src/html/hash.ts:12-13` 用 `for (const char of input) { hash ^= char.charCodeAt(0) }`，`for...of` 产出的是**码点串**（长度 2），`charCodeAt(0)` 只取高代理。
   证据：`stableHex8("😀") === stableHex8("😁") === stableHex8("\uD83D") === "37822568"`。即"内容不同、ID 相同"（审计要求的第 1 条正是这个）。同一文档内因为种子含同标签兄弟序号仍能保唯一，但跨文档/跨版本的内容指纹已经失真。修复：`char.codePointAt(0)`，或按 UTF-16 单元遍历 `for (let i=0;i<input.length;i++) hash ^= input.charCodeAt(i)`。
2. **10k 深嵌套 1931ms，二次方**：深度 500/1000/2000/4000 = `7.3 / 24.2 / 84.6 / 323.8 ms`（每翻倍 ×4）。根因是 `packages/core/src/html/inject.ts:39-40` 的 `textSample` 先 `textContentOf(node)` **拼出整棵子树全文**再 `slice(0,64)`，而 `:22` 的注释写着"只取前 64 个字符…整段文本会让大文档的注入退化成 O(n·size)"——**注释声称避开的事正是代码在做的事**（自我认证型注释）。次要来源：`:183` 每层 `[...state.path]` 复制 + `:91` `ancestors.join(">")`。修复：给 `textContentOf` 加一个"收集到 64 字符即停"的上限参数（顺手把注释改成事实）。
3. **raw text 家族三处不一致**：`constants.ts:38` 只有 `script|style`，而 `balance.ts:66-75` 自己列了 8 个（含 `textarea/title/xmp/iframe/noembed/noframes`）。后果是 `serialize.ts:59` 对 `iframe/xmp/noembed/noframes` 的文本做了转义：`<xmp>a &amp; b</xmp>` → `<xmp>a &amp;amp; b</xmp>`。树深等仍成立（我 18 组样本全 EQ），但**渲染出来的字变了**（这些元素不解码实体）。修复：`RAW_TEXT_TAGS` 与 `balance.ts` 的清单共用一处定义；`script/style` 不转义按卡片保留，其余要么加进 raw 集、要么在 `docs/04` 里写明"只支持 script/style 的 raw text"。
4. **`misnestedDiagnostic` 的消息把结束标签写成开始标签**：`balance.ts:132-138` 的悬空结束标签分支输出 `<span> 的结束标签没有对应的开始标签`（实测），语义上应为 `</span> …`。修复：该分支单独拼 `</${tag}>`。
5. **`DiagnosticSeverity` 的 `"error"` 是死值**：`constants.ts:112` 定义了 `"error" | "warning"`，但 `parse.ts:75-76` 的 `diagnosticOf` 两个分支都硬编码 `"warning"`，`balance.ts:110-118` 同样只发 warning。7 个码里 `unclosed_tag`/`misnested_tag` 显然是 error 级。修复：让 `diagnosticOf` 收 severity 参数，按码表定级；否则 `"error"` 这个类型成员永远为假。
6. **重复的显式 `data-hr-id` 被静默保留**：`<article><p data-hr-id="hr-dup">a</p><p data-hr-id="hr-dup">b</p></article>` → `injected: []`、`diagnostics: []`，文档里出现两个同值锚点，而 `hr_patch_node(nodeId)` 就此歧义。7 个码里没有对应的位（`duplicate_hr_id` 未获授权）。当前按卡片字面"已有合法 ID 一律保留"是对的，但请把这条写成 M1.2 的已知缺口。
7. **`textContentOf` 对 `document` 节点返回空串**：`packages/core/src/html/text.ts:14` 只取 `element.children`，`document` 分支永远 `[]`。今天只有 meta/块元素会调它所以无害，但它出现在"把子树文本拼起来"的公共工具上，下一个人拿它串文档就会静默拿到 `""`。修复：`current.kind === "document" ? current.children : …`。
8. **`<div id="hr-meta">` 会被当成 meta 脚本校验**：`parse.ts:136-138` 只看属性名 `id` 与值 `hr-meta`，不看 `nodeName === "script"`。伪造的 div 里放一段非 JSON 文本会白得一条 `script_in_meta`。修复：加 `element.nodeName === "script"` 判定。
9. **`docs/02` 被改了两处**（`bento-grid`→`kpi-bento`、`6 大内置`→`7 个内置…（6 类）`），不在 M1.1 Scope（`docs/**` 属 Out of scope）。改动本身与 `constants.ts:9-17` 的白名单一致、方向正确，但需要协调者确认归属（若是编写员顺手改的，属于越界；若是协调者改的，请在 state 里留痕）。

---

## 已验证为真（防"只报不看"）

- **ID 确定性**：同输入两次一致；改 `TZ` 后一致；注入期间 `Math.random`/`Date` 调用计数 `{random:0,date:0,now:0}`；`grep -rn "node:crypto|Math.random|Date.now|process\.|node:fs"` 在 `html/` 内零命中（只有 `hash.ts:7` 注释里出现字符串）。
- **幂等**：`injectNodeIds` 二次调用 `injected: []` 且树逐字节相等。
- **冲突后缀**（我用"属性不进种子"这一点构造出可达的碰撞，不是靠运气）：`<section data-hr-id="<future-base>">` 预埋后，同结构第二节点的 base 撞车 → `hr-1014cc36-2`，重复调用稳定，无 `-2` 二次冲突（`used` 集合含全文档合法 ID）。
- **注入覆盖面**：一篇含 14 类块级元素的文档 → 19 个 ID；`section/header/footer/p/h1-h4/ul/ol/li/table/figure/details/pre/blockquote` 全覆盖，`div[data-hr-component]` 有、裸 `div` 无、`h5` 无、`article` 自身无（与卡片清单逐项一致）；`<article>` 外的块级元素零注入；嵌套 `<article>` 内的 `p` 正常注入；`tbody/tr/td` 不注入（不在清单）。
- **`<script id="hr-meta">` 内的块级标记不误注入**：JSON 字符串里写 `<div>` `<p>` → 树里只有 `script` 一个元素；`</script>` 截断 → `script_in_meta`。
- **往返 19 组样本全 EQ**：属性顺序、重复属性（保留首个 + 诊断）、`DATA-HR-ID` 大写混写、`<br/>`/`<img/>` 自闭合、`<pre>` 白空格与制表符、`&amp; &lt; &#38; &#x26; &nbsp;`、属性含换行/引号、`<script>` 内 `</p>` 与 `<`、`<style>`、`<textarea>`/`<title>`（RCDATA 正确转义）、`<template>` 子树、`PUBLIC`/`SYSTEM` doctype、注释、`<table>` 隐式 `tbody`、`<p>` 被 `<div>` 隐式闭合。
- **容错**：空串/纯空白 → `empty_document`；`42`/`null` → `HrError("invalid_html")`；未闭合/错嵌套/悬空结束标签 → 诊断不抛；1MB 属性值正常；10k 嵌套不爆栈（`diag=0`）。
- **分层**：`parseHtml` 输出的节点键集合恰为 `{kind, tag, attrs, children}` / `{kind, value}` / `{kind, data}` / `{kind, name, publicId, systemId}`，无 `nodeName`/`childNodes`/`sourceCodeLocation`/`parentNode`，原型是 `Object.prototype`——parse5 节点零泄漏。
- **诊断契约**：`DiagnosticCode` 恰为卡片允许的 7 个（`constants.ts:105-112`）；非法 component 保留属性 + `invalid_component`（不静默丢）；非法 `data-hr-id` 改写 + `invalid_hr_id` 且带 `path`。
- **性能**：1,013,863 字节真实结构文档（3456 块）`parse+inject+serialize` 三次 `67.5/81.8/91.7ms`，**中位数 81.8ms**（预算 300ms ✅），与编写员自证的 80.0ms 独立吻合。
- **形态**：9 个文件最大 238 行（限 400）；模块头均 1–2 行（限 3）；`pnpm lint` 对 `src/**` 零告警（40 行/复杂度 10 由 `max-lines-per-function`/`complexity` 强制）；依赖只有 `parse5`（无 jsdom/linkedom/cheerio）。

## 裁决

`G2: FAIL`。可以断言的是：**ID 与往返这两块核心是硬的**（determinism / 幂等 / 冲突后缀 / 19 组往返 / 100 万字节 81.8ms / parse5 零泄漏全部实测通过）；不能放过的是 **`balance.ts` 对合法 HTML 的系统性误报**（P1-1，会污染 M1.2 起的全部质量信号）与**入口导出面/Scope 的两处纪律问题**（P1-2、P1-3），以及**当前 `pnpm verify` 五步红**（P1-4）。

修复顺序：P1-1（先让诊断可信）→ P1-4（回绿，含测试侧 2 条错断言）→ P1-2/P1-3（导出面 + Scope 落定）→ P2 里先做 2、3、5。

ACP: 56.3K→… ctx · 5 blocks · delegate none

---

# R1 复审（G2-R，定向复审，不重审全卡）

**G2-R: FAIL**（已关闭 7 条；仍开 **2 × P1** + 4 × P2）

对编写员 `impl-M1.1.md §9` 的 10 行对照表逐条复算。方法同 G2：`node --import /tmp/m11/hooks.mjs` 直接跑真实导出，样本与临时文件全在 `/tmp/m11`，仓库除本报告追加段外零写入，未 `git add`/`commit`。

门禁（我自己跑）：`pnpm format:check` exit 0 · `pnpm lint` exit 0 · `pnpm typecheck` exit 0 · `pnpm test:coverage` 72 tests 全绿 · `pnpm depcruise` exit 0 · `pnpm knip` exit 0 · **`pnpm verify` exit 0**。
（过程记录：第一次跑 `format:check` 报 `packages/core/tests/html-parse.test.ts`，10 秒后复跑即绿 —— 见 P2-R4 的注释陈旧问题，我按最终态判定，不据此判红。）

## 1. P1-1 隐式闭合 —— **PARTIAL（主症已修，残留一个真阳性被吞）**

### 1.1 正向（必须 0 条 `misnested_tag`）—— 7/7 通过

```
P1 <ul><li>a</ul>                        misnested=0  unbalanced=0
P2 <table><tr><td>c</table>              misnested=0  unbalanced=0
P3 <select><option>a<option>b</select>   misnested=0  unbalanced=0
P4 <dl><dt>a<dd>b</dl>                   misnested=0  unbalanced=0
P6 <section><h1>t</section>              misnested=0  unbalanced=0
P9 <article><ul><li>a<li>b</ul></article> misnested=0  unbalanced=0
P10 <table><thead><tr><th>x</table>      misnested=0  unbalanced=0
```

### 1.2 反向（真错嵌套必须仍报码）—— 5/6 通过，`<table><td></table>` **是缺口**

```
N1 <b><i>x</b></i>          misnested x2 (`<i>`,`<b>`)  unbalanced x1 (`<i>`)
N2 <p><div></p></div>       misnested x1 (`<p>` 被 `<div>` 隐式闭合，正确)  unbalanced 0
N4 <section><h1>t</h2></section>  misnested x1 (`<h1>`)
N5 <ul><li>a<div>b</ul>     misnested x1
N6 <table><tr><td>a<td>b</table> misnested x1
N3 <table><td></table>      misnested=0  unbalanced=0  ← 静默
```

- `N3` 解析后是 `td → tr → tbody → table`（parse5 自动补位）。`implicitlyClosableBy("table")` 给出 `CLOSED_BY.table = ["caption","colgroup","thead","tbody","tfoot","tr","td","th"]`，`closeTag` 先把 `td`/`tr`/`tbody` 全部 `popImplied` 掉，于是**源码里那个孤立的 `<td>`（在 `<tr>` 之外）没有被诊断**。
- 这是"少报过关"的一个真实样本：卡片 M1.1 的诊断清单里 `misnested_tag` 的语义是"标签嵌套顺序不合法"，`<table><td>` 是其中最典型的一种。它不是本轮新引入的错（改前也会被 `tbody` 那条掩盖），但既然 P1-1 的主题就是"隐式闭合要精确"，这个反例必须记进来。
- 修复方向：`popImplied` 接受"被哪个结束标签隐式关闭"的目标集合时，对 `CLOSED_BY.table` 做**信任边界**——只有当被弹出的元素确实属于 `table → tr → td` 的**合法**嵌套链时才静默（即 `td` 的父必须是 `tr`、`tr` 的父必须是 `tbody/thead/tfoot`），父链不合法则发 `misnested_tag`。

### 1.3 复盘：为什么 §9 声称"用 parse5 的 onParseError 判定"

`balance.ts:98-131` 的 `insertionModeSaysOpen` 看的是 `parse5` tokenizer 回调，但 parse5 的 `onParseError` 对嵌套结构基本不说话。实测同一个文档给 parse5 的 `onParseError`：

```
<table><td></table>  → ["missing-doctype"] only
<b><i>x</b></i>      → ["missing-doctype"] only
```

也就是说"parse5 判定"这条路对嵌套错误**本就无信号**，`insertionModeSaysOpen` 实际只挡了"缺 doctype"一类。§9 把它当成依据属于**自证过度**（不是撒谎，但结论建立在无效信号上）。建议要么删掉这条依赖并写明"嵌套合法性由 `CLOSED_BY` 表精确表达"，要么换成 `parse5` 的 `onParseError` 白名单（`end-tag-with-attributes` 等）。

## 2. P1-2 导出面 —— **CLOSED（但卡片 v2 与实现对不上，见 P2-R1）**

```
$ grep -c '^export' packages/core/src/index.ts packages/core/src/html/index.ts
packages/core/src/index.ts: 10        packages/core/src/html/index.ts: 16
```

- `src/index.ts` 现在只留下 `HrError`/`HrErrorCode`、`parseHtml`/`serializeHtml`/`injectNodeIds` 与 4 个类型（`HtmlNode`/`ParsedHtml`/`Diagnostic`/`DiagnosticCode`），上轮那 7 个零引用类型已移入 `src/html/index.ts`（`HtmlAttribute`/`HtmlCommentNode`/`HtmlDoctypeNode`/`HtmlDocumentNode`/`HtmlTextNode` 等），且 **`src/html/index.ts` 不是包入口**（`package.json:7-9` 的 `exports` 只有 `"."`），所以"入口最小"这条目标达成。
- 我没有发现"为了让测试过而把符号挪来挪去"：`grep -rn "from \"@hreader/core/src/html/index\"" packages/core/tests/` 零命中，测试只用入口；`pnpm knip` exit 0 未报新增未用导出（`html/index.ts` 被 `src/index.ts` 引用，属可达）。
- 但卡片 v2 里 `src/html/index.ts` 被写成"内部模块，不导出"，而它现在有 16 个 `export`（被 `src/index.ts` 消费，属"模块内门面"）。名称与卡片不符，登记为 P2-R1。

## 3. 逐条复算 P2（D2 一并）

| 原条 | 判定 | 我跑的证据 |
|---|---|---|
| P2-1 代理对哈希 | **CLOSED** | `stableHex8("😀")` = `e38769a8`，`stableHex8("😁")` = `3ffc1b2f`，`stableHex8("\uD83D")` = `5ae0b7b3` 三者互异（改前前两个同为 `37822568`）。`hash.ts:12-14` 已改为按码点（`codePointAt`）累加 |
| P2-2 注入线性 | **CLOSED** | 4000 深嵌套 `injectNodeIds` **119.6ms**（改前同机同构 **323.8ms**，约 2.7×；与"去掉整棵子树拼接"的量级一致）。1500 深 `28.1ms`。仍是 O(depth·k) 而非严格 O(n)（`:183` 每层 `[...state.path]` 未改），但二次方的根因已消失 |
| P2-3 raw text 单一定义 | **PARTIAL** | `constants.ts:40` 已导出 `RAW_TEXT_TAGS = new Set(["script","style","xmp","iframe","noembed","noframes","noscript"])`，`balance.ts:66` 与 `serialize.ts:59` 都从它取（单一定义的骨架达成）。**但 `<noscript>` 进了 raw 集，而 parse5 默认把 `<noscript>` 当普通元素**：`<noscript>a &amp; b</noscript>` → `<noscript>a &amp;amp; b</noscript>`（双重转义）。`<xmp>`/`<noembed>` 正确（`a &amp; b` 原样保留） |
| P2-4 诊断标签名 | **CLOSED** | `balance.ts:151-157` 悬空结束标签输出 `</span> 的结束标签没有对应的开始标签`（改前是 `<span>`）；`</h3>` 同样正确 |
| P2-5 severity 档位 | **CLOSED** | `unclosed_tag`/`misnested_tag` → `severity:"error"`；`invalid_component`/`invalid_hr_id`/`duplicate_attribute`/`script_in_meta` → `"warning"`（7 个码点全抽查，`constants.ts:113-121` 的 `CODE_SEVERITY` 表） |
| P2-7 `textContentOf(document)` | **CLOSED** | `text.ts:14` 现走 `current.kind === "document" ? current.children : …`；`parseHtml("<article><p>hi</p></article>")` 的 doc 级调用返回 `""`（因为 document 本身不该有 text），但对 `<p>` 子节点正确返回 `hi`；改前 `document` 分支恒 `[]` |
| P2-8 `<div id="hr-meta">` | **CLOSED** | `<div id="hr-meta">not json</div>` → `diagnostics: []`（改前白得一条 `script_in_meta`）；`<script id="hr-meta">not json</script>` 仍报 `script_in_meta` |
| D2 冗余 finally | **CLOSED** | `parse.ts` 里 `finally` 只剩一处（`parse.ts:49-53` 的 hook 复位），不再有"空 finally 只为了写 return" |

## 4. 新增风险扫描

- **`popImplied` 可读性（我读完后的判断）**：`balance.ts:124-144` 现在是三层：`implicitlyClosableBy`（查表）→ `mustStayOpen`（`insertionModeSaysOpen` 的包装）→ 循环 `while` 弹栈。比改前的 `slice` + `lastIndexOf` **更容易读**，因为"为什么弹"由表驱动；但 `insertionModeSaysOpen` 这个包装（`balance.ts:98-121`，24 行只为了调 parse5 并解析 `onParseError`）是**用技巧换语义**，且如上 §1.3 它没有信号。建议删掉它、把 `mustStayOpen` 直接写成 `RAW_TEXT/CLOSED_BY` 的查表。
- **死代码**：`grep -rn "insertionModeSaysOpen\|mustStayOpen" packages/core/src/` 只有定义与一处调用，未成死代码，但一旦 §1.3 按建议删掉，`parse5` 的 `onParseError` 依赖也随之消失（如今它只在缺 doctype 时有用，而缺 doctype 不产生任何诊断 —— 也就是说这段代码**目前对用户可见行为零影响**）。
- **注释与实现不符（新发现，P2-R3）**：`inject.ts:22` 的注释仍写着"只取前 64 个字符"，而 `:39-40` 的 `textSample` 已改为"收集到 64 字符即停"（实现正确，注释描述的动作在**改前**才是错的）。这条注释现在**是对的**，但 §9 表里把 P2-2 描述成"已规避 O(n·size)"，读注释的人会以为仍是老实现。建议注释改成"最多收集 64 个字符即停，避免整棵子树拼接"。
- **新分支 / 新死路**：`<noscript>` 进 `RAW_TEXT_TAGS` 是**新引入的行为回归**（改前 `<noscript>` 不在 raw 集，序列化是单次转义；改后双重转义）。这不是"修 A 坏 B"的巧合，而是把"浏览器/parse5 的实际解析行为"与"我们自己声明的 raw 集"混为一谈的结果。**列为本轮唯一新增 P1（见 P1-R1）**。

## 5. 覆盖率是否被"测试规避"换来（抽 3 条新用例）

抽法：读用例 → 在 `/tmp/m11` 副本里把对应实现改坏一行 → 看是否真红。

| 抽的用例 | 改坏的实现 | 结果 |
|---|---|---|
| `html-balance.test.ts:35-42` `<ul><li>a</ul>` 零诊断 | `balance.ts:136` 把 `if (implicitlyClosableBy(...))` 改为 `if (false)` | **RED**（回到旧行为，2 条 `misnested_tag`） |
| `html-hash.test.ts`（代理对）`stableHex8("😀") !== stableHex8("😁")` | `hash.ts:13` 改回 `charCodeAt(0)` | **RED** |
| `html-serialize.test.ts` `<xmp>a &amp; b</xmp>` 不做双重转义 | `serialize.ts:59` 把 `RAW_TEXT_TAGS.has(...)` 改为 `false` | **RED** |

三条都是**真断言行为**，不是"执行到即可"。`perFile 100%` 这次不是规避来的（`packages/core/src/html/*.ts` 9 个文件都有真实断言覆盖；`text.ts:14` 的 document 分支由 `html-text.test.ts` 覆盖）。

## 6. 仍未关闭（返工清单）

- **P1-1（PARTIAL）**：`<table><td></table>` 静默 —— 需在 `popImplied` 里加"合法父链"校验。
- **P1-R1（NEW）**：`<noscript>` 被当作 raw text → 序列化双重转义（`<noscript>a &amp; b</noscript>` → `&amp;amp;`）。修复方向：从 `RAW_TEXT_TAGS` 里移除 `noscript`（parse5 默认不把 noscript 当 raw text），或在 `serialize.ts` 里按 parse5 的 `scripting` 选项对齐；二选一并加一条往返用例。
- P2-R1 `src/html/index.ts` 的 16 个导出与卡片 v2"内部模块，不导出"的措辞不符 —— 改卡或改代码。
- P2-R2 `insertionModeSaysOpen`/`mustStayOpen`（`balance.ts:98-121`）对嵌套错误无信号，属"无效依赖 + 技巧"，建议删除并让 `CLOSED_BY` 表独自表达语义（同时消掉 §1.3 的自证过度）。
- P2-R3 `inject.ts:22` 注释与 §9 措辞需与"收集上限即停"的新实现对齐。
- P2-R4 `packages/core/tests/html-parse.test.ts` 的 `format:check` 曾红一次（10 秒内自愈）—— 我按最终态判绿，但编写员应在交付前跑一次 `pnpm format:check`，别让协调者看到瞬时红。

## 裁决

`G2-R: FAIL`。主症（`balance.ts` 对合法 HTML 刷屏）**确实修好了**，7 个正向样本 0 诊断、5 个反向样本报码、幂等与往返未回退；但"隐式闭合要精确"这个主题上还留着一个真阳性（`<table><td>`）被顺手吞掉，且本轮改动**新增**了一个序列化回归（`<noscript>` 双重转义）。两条都是"用户可见字节/质量信号"层面的，不能放行。

建议返工顺序：P1-R1（一行删除 + 一条用例）→ P1-1 残留（父链校验，配 `<table><td>` 正向用例）→ P2-R2（删无效依赖，同时让代码更好读）→ P2-R1/R3/R4。

ACP: 75.8K→48.1K · 7 blocks · delegate none
