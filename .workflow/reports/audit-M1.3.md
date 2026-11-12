# audit-M1.3 · `hr_outline` 审计（G2）

审计员只读审计，结论来自**实跑**：所有数值用 `registerHooks` 直接加载
`packages/core/src/index.ts` 的真实 ESM 导出（`parseHtml → injectNodeIds → buildOutline`）测得，
探针在 `/tmp/m13/*.mjs`（不进仓库）。仓库仅新增本报告，未 `git add`/`commit`。

## 结论

**G2: FAIL** — P0 × 1，P1 × 3，P2 × 8。

体积与字数两项硬指标都出问题，方向相反：

| 指标 | 卡片要求 | 实测 | 判定 |
| --- | --- | --- | --- |
| 1MB 文档 outline 体积（正常文档） | ≤ 8192 B | **7748 B**（643KB 文档）/ **7653 B**（183KB 文档）/ **7679 B**（800 节×120 汉字） | ✅ |
| 同上，但 `data-hr-id` 为 snake_case / 驼峰 | ≤ 8192 B | **3 278 429 B**（643KB 文档）| ❌ **P0-1**（超 400 倍，且 `nodes: 0`） |
| 字数（AC1 规则） | CJK 1 字 = 1，连续拉丁 1 词 = 1 | `café`(NFC)=**2** vs `café`(NFD)=**1**；`русский`=**7**（应 1） | ❌ **P1-2** |
| 字数统计对象（"article 的全部可见文本"） | 不含不可见文本 | 真实单文件网页 17 → **59**（内联 `<style>` 被计入 42 词） | ❌ **P1-1** |
| 性能 1MB | ≤ 150 ms | **132.4 ms**（1139KB）/ 80.9 ms（591KB） | ✅ |
| 10k 节点 / 4000 深 | 不爆栈 | 51.2 ms / 8.5 ms，无 `RangeError` | ✅ |
| 确定性 | 两次字节相等 | `true`（324 B 文档逐字节相等），且不改 `parsed` | ✅ |

---

## P0-1 诊断数组不受字节预算约束：8KB 硬上限被突破 400 倍，且结构全丢

- `packages/core/src/ops/outline/derive.ts:57-63` 把 `parsed.diagnostics` 全量拼进 `base`，再交给
  `fitBudget`；而 `packages/core/src/ops/outline/budget.ts:129-152` 的 `fitBudget` **只裁节点与批注**
  （`maxPending` + `maxKeep`），`diagnostics` 只是被 `measure()` 计入字节数、**无法被裁剪**。
  于是节点被裁到 0，诊断原样全量输出。
- 触发条件不是"恶意"输入，而是**很常见的 id 形态**：`packages/core/src/html/constants.ts:76`
  `export const HR_ID_PATTERN = /^[a-z0-9-]+$/;` —— `section_1`（snake_case）、`sectionId`（驼峰）
  都不合法，M1.1 每个节点发一条 `invalid_hr_id`（`packages/core/src/html/inject.ts:129`），
  M1.3 侧 `walk.ts:121` 因 `validIdOf(...) === ""` 把这些节点全部丢弃。

```
$ node /tmp/m13/p_p0.mjs           # 2000 节 × 6 段，HTML 643KB，同构文档只换 id 形态
合法 kebab    htmlKB=  643 build=  67ms jsonBytes=    7748 nodes=45 diag={"outline_truncated":1}
snake_case   htmlKB=  643 build= 140ms jsonBytes= 3278429 nodes=0  diag={"invalid_hr_id":16000,"outline_truncated":1}
驼峰          htmlKB=  658 build= 125ms jsonBytes= 3294429 nodes=0  diag={"invalid_hr_id":16000,"outline_truncated":1}
  snake_case 的 outline_truncated 报文: "outline 已截断：按字节预算丢弃节点 1024 个"
```

三点问题叠加：
1. **体积**：3.28 MB / 8192 B = **400 倍**。`docs/02` 把 `hr_outline` 定位为"~150 Tokens 的省 token 入口"，
   3.28 MB 直接击穿调用方（Agent）的上下文预算。AC2 是硬数字，无"极端文档允许超"豁免适用于此。
2. **可用性**：`nodes: 0` —— 文档有 2000 个章节，outline 返回空树。虽然每条诊断都说明了原因，
   但"结构为空 + 3MB 诊断"不是可用的降级。
3. **报文失真**：`outline_truncated` 说"丢弃节点 1024 个"，1024 是 `budget.ts:135` 的
   `OUTLINE_NODE_SCAN_LIMIT` 扫描上限，不是真实丢弃数（本文件真实丢弃 ≈ 4200 节点）；
   且报文**只字未提** 3.28MB 里 99% 来自诊断。

修复方向（都在 Scope 内，不需动 `html/`）：
- `derive.ts` 装配前对 `base` 做**按码聚合**：同 `code` + 同 `message` 前缀的诊断折叠成一条
  （如 `invalid_hr_id` 16000 条 → 1 条「16000 个节点 id 不合规（^[a-z0-9-]+$），首个 s_0」+ 前 3 个样例）。
- 或给诊断数组一个字节上限（如 1024 B），超出时补一条 `outline_truncated` 说明"另有 N 条诊断省略"。
- `budget.ts:153` 的 `droppedNodes` 应基于**真实节点数**而非 `flat.length`（见 P2-3）。

## P1-1 字数把不可见文本计入：内联 `<style>`/`<script>`/`<textarea>` 全算

`packages/core/src/ops/outline/walk.ts:178` 对**任何** text 节点无条件累加：
```ts
if (node.kind === "text") { state.current.words += countWords(node.value); return; }
```
卡片 §3 明确"计数对象 = `article` 的**全部可见文本**"，`docs/05` AC1 亦为字数规则。实测：

```
$ node /tmp/m13/p_wc2.mjs
内联 <style> → wordCount= 59        # <h1>分布式一致性</h1> + <p>Raft 用日志复制保证一致性。</p> + 3 行 CSS
无 style 对照 → wordCount= 17       # 差 42 = CSS 被计入的词数
$ node /tmp/m13/p_e11.mjs
E12b 仅 <script>alpha beta gamma</script> → 3   (期望 0)
article 内 hr-meta → wordCount= 16             (期望 1，JSON 文本被计入)
```
- 触发概率高：单文件网页（"普通浏览器双击可读"是 `docs/02` 的头号规范目标）几乎都带内联 `<style>`，
  一段 2KB CSS 就能让 wordCount 翻倍；`M1.7` 会在 `<style id="hr-theme">` 里塞整份主题 CSS——
  只要该 style 落在 `article` 内（合法），字数立刻失真。
- 修复方向：`walk.ts` 里对 `script`/`style`/`textarea`/`template` 子树跳过字数（但仍需下钻统计其**可见**后代，
  `<template>` 内容是否可见属 M1.4 口径，可与协调者裁定）；`hr-meta` 脚本按 `id === META_SCRIPT_ID` 明确排除。

## P1-2 字数规则与 AC1 不符：非 ASCII 拉丁字母按"逐码点"计，且随 Unicode 归一形式漂移

`packages/core/src/ops/outline/text.ts:23-37` 的 `countWords` 把 ASCII 串按"连续一串 = 1"，
但**非 ASCII 的 `\p{L}`/`\p{N}` 一律逐码点 +1**（`:31-34`）。卡片 §3 的规则是
「连续拉丁/数字串（`[\p{L}\p{N}]` 且非 CJK）每串 = 1」：

```
$ node /tmp/m13/p_e3b.mjs
DIFF café (NFC, U+00E9)      实测=2   期望=1
ok   café (NFD, e+U+0301)    实测=1   期望=1      ← 同一个词，两种编码两个结果
DIFF русский                 实测=7   期望=1
ok   ＢＣ / 日文假名 / CJK 扩展B / emoji / ZWJ 家族 / state-of-the-art   全对
```
- 后果：同一篇文章用 NFC 保存与 NFD 保存，`wordCount` 不同（AC5 的"确定性"针对同字节输入，
  跨编码不在其内，但语料归一形式不由 hReader 控制）；俄语/希腊语/越南语的文档字数被放大 5–7 倍。
- 写作者在 `text.ts:9-13` 的文档注释里**诚实**写清了实现（"非 ASCII 的字母/数字逐码点计 1"），
  这与卡片规则不一致，属规则偏差而非注释说谎——按"注释不得自我认证"这条值得肯定，但规则要按卡片改。
- 修复方向：把"拉丁串"的判定改成 `inRun` 也覆盖非 CJK 的 `\p{L}`/`\p{N}`（CJK 仍逐字），
  即 `[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]` 逐码点、其余 `\p{L}\p{N}` 归入 run。

## P1-3 `script_in_meta` 与 `invalid_meta` 对同一缺陷双报（同一输入两条同义诊断）

`packages/core/src/html/parse.ts:192-205` 的 `metaScriptDiagnostics` 以"JSON 不可解析"为
`script_in_meta` 判据（注释自陈"JSON 可解析性就是是否被截断的判据"），而
`packages/core/src/meta/parse.ts:118-124` 对同一条件发 `invalid_meta`：

```
$ node /tmp/m13/p_meta.mjs
not json        diag={"script_in_meta":1,"invalid_meta":1} pending=0
</script> 注入   diag={"misnested_tag":1,"script_in_meta":1,"invalid_meta":1} pending=0
```
- 一条输入、一个缺陷、两条诊断，两条 message 几乎同义（"内容不是完整 JSON，多半被 `</script>` 提前截断"
  vs "hr-meta 不是合法 JSON"）。卡片 §6 只授权 M1.3 新增 4 个码，`script_in_meta` 是 M1.1 遗留；
  **实现者的 `请求裁定 #2` 说对了问题，但把它留给"后续"**，而这条在 G2 就该收口。
- 修复方向（Scope 内一行）：`derive.ts` 拼 `base` 时，若本次 `meta.diagnostics` 含 `invalid_meta`，
  过滤掉同源的 `script_in_meta`（它只在 meta 文本不可解析时产生，二者恒同现）；彻底做法是删
  `parse.ts:192-205`（需授权改 `src/html/**`，建议与裁定 #2 一并处理，M1.4 前做掉）。

---

## P2（8 条，均不阻塞）

1. **多 article 时取"最后一个"** — `walk.ts:217-247` 的 `firstArticleOf` 把子节点**正序 push** 进 LIFO 栈
   （`for (const child of current.children) stack.push(child)`），`drainStack` 是 `pop`，
   于是 DFS 顺序被反转。实测 `<article data-hr-id="first">` + `<article data-hr-id="second">`
   → `nodes = ["a2"]`（**第二个**），而 `model/validate.ts:197` 的 `state.articles.slice(1)`
   以**第一个**为规范。两层对"哪个是正文"的判断相反。改法：push 时反向遍历（与 `walk.ts:96-108`
   `pushChildren` 已有的写法一致）。
2. **嵌套无标题 section 的 `level` 依赖父级标题的文档序位置** — `walk.ts:200-207`：
   `closeFrame` 结算子帧时读 `previous.node.level`，而父节点的 `level` 要等**它自己的** `exit` 任务
   （或它内部第一个标题）才写。实测：
   ```
   <section s1><section s2><p>正文</p></section><h2 late>迟到的标题</h2></section>
     → s1.level=2, s2.level=0
   <section s1><h2 late>迟到的标题</h2><section s2><p>正文</p></section></section>
     → s2.level=2
   ```
   卡片 §1 "无标题 section 继承父级 level" 在前一种序下不成立（得 0）。修法：两级结算，
   或先把每层"首个标题 level"预扫一遍再建树。
3. **`outline_truncated` 的丢弃计数失真** — `budget.ts:153` `droppedNodes: flat.length - keep`，
   而 `flat` 被 `:135` 的 `OUTLINE_NODE_SCAN_LIMIT`（`constants.ts:24` = 1024）截断：
   2000 节文档真实丢弃 ≈ 4200 节点，报文写"丢弃节点 1024 个"。修法：`walk` 返回真实节点总数。
4. **`idsOf` 无条件全量遍历** — `annotations.ts:49` 在**没有任何批注**时仍先 `idsOf(root)` 扫全文
   （`annotations.ts:21-45`）。20k `<p>` 无 meta 文档 `buildOutline` 中位 8.1 ms，其中大半是这趟白扫。
   修法：先筛出 `pending_ai` 再决定是否建 id 集。
5. **批注只保住 3/400 条** — `constants.ts:21` `OUTLINE_ANNOTATION_BYTE_LIMIT = 2304`。
   实测 400 条 × 200 字批注 + 300 节 → `bytes=5869, pending=3, nodes=23`。
   卡片 AC3 写的是"`status === "pending_ai"` **全部**进 `pendingAnnotations`"，与 AC2 的体积上限冲突；
   当前实现把冲突解在"批注"一侧，而 `docs/02` 把批注列为 `hr_outline` 的头号交付物（"以及**所有未处理**的
   `pending_ai` 批注"）。建议抬高份额或改成"节点让位优先"，并由协调者把这条写进契约。
6. **两个 `hr-meta` 时取最后一个** — `meta/parse.ts:46-71` 的 `findMetaScript` 同 1 的遍历反转问题。
   实测两个 meta → `pending = ["second"]`（后者）。规范里该形态非法，但与 M1.1 的"首个 meta"口径不一致。
7. **`version` 不校验** — `docs/02` 的 `hr-meta` 结构首位是 `"version": "1.0"`，`meta/parse.ts` 完全忽略；
   `{"version":"2.0"}` 无诊断。M1.5 写回、M1.6/M1.7 读 style 时要靠版本号分流，建议本卡先补一条
   `invalid_meta`（未授权新码，可复用）。
8. **outline 不含 M1.2 模型诊断** — `derive.ts:57` 只 `spread` 了 `parsed.diagnostics`（M1.1 层）。
   文档有重复 `data-hr-id`、多个 article、无 article 时，outline 的诊断**全部为空**：
   ```
   重复 id 文档 → outline diag= {}        # model/validate.ts 会报 duplicate_id
   两 article   → outline diag= {}        # 会报 multiple_article
   ```
   `hr_outline` 若被 Agent 单点调用（`docs/02` 的工具表就是单点），这些缺陷对它不可见。
   卡片 §1 "复用 M1.1/M1.2 码空间" 未明确是否跑校验 —— 请协调者裁定：
   (a) 只复用码空间（现状，P2 记录）；(b) 在 outline 内跑 `validateDocument` 并合并诊断（推荐，成本 ~1 行 + 一次遍历）。

## 关于两条"请求裁定"的审计意见

- **#1 测试员的导出表红线**：**实现合规，测试过期**。卡片 Scope 明写 `src/index.ts` "仅加导出"，
  `git diff packages/core/src/index.ts` 是 `+2` 行（`buildOutline` + 3 个 type-only）。
  `entry-points.test.ts:36` 的"公开面等于固定清单"断言与"每卡可加导出"天然对立，
  应改成"⊇ 必需符号"（G3 事项）。
- **#2 `script_in_meta` / `invalid_meta`**：见 P1-3，判为**必须收敛**（重复诊断），
  但收口方式可先在 `ops` 侧过滤，`html/` 侧的删除留给 M1.4 一并授权。
- **#3 `OUTLINE_NODE_SCAN_LIMIT` / `OUTLINE_ANNOTATION_BYTE_LIMIT`**：自加上限本身可接受
  （预算是产品要求），但两处副作用要修：扫描上限导致丢弃计数失真（P2-3）、批注份额导致 AC3 的"全部"落空（P2-5）。

## 已检查且**未**发现问题（免得被当成没看）

- **体积**：正常文档三形态 7653 / 7679 / 7748 B，均 ≤ 8192 且**必有** `outline_truncated`（恰好 1 条，
  不随节点数重复）；深嵌套 12 层 → 457 B；`outline_truncated` 由 `derive.ts:26-45` 单点产生，不会每节点一条。
- **字数**（`p_e3b.mjs` 21 例）：纯中文/纯英文/中英混排/数字/全角字母/emoji/ZWJ 家族 emoji/CJK 扩展 B/
  NFD 组合字符/日文假名/连字符 `state-of-the-art`(=4)/纯标点/`a自b`(=3)/NBSP/全角空格 全部符合规则；
  `<code>`/`<pre>` 计入（=5，符合 §3）；`aria-label`/`alt` **不**计入（=1，正确）。
- **ID 校验口径**：`annotations.ts:48-51` 用的是 `data-hr-id`（`idsOf` 取 `HR_ID_ATTRIBUTE`），
  不是 HTML 原生 `id`；`targetId="ghost"` → `annotation_target_missing` 且批注仍输出。
- **批注截断按码点**：250 个中文 / 250 个 emoji → 均 201 码点、`…` 结尾、**无孤立代理**。
- **meta 畸形 5 类**：缺失 → 0 诊断 + `[]`（合法形态）；空 → `invalid_meta`；非对象数组 → `invalid_meta`；
  `annotations` 非数组 → `invalid_meta`；元素缺字段 → 逐条 `invalid_meta` + 跳过、其余正常。
  `__proto__` 不污染（`({}).polluted === undefined`）；5.1MB meta（2 万条批注）不崩、123 ms。
- **`<script>` 里的 `</script>`**：`misnested_tag` + 双码 + `pending=[]`，不抛异常。
- **确定性**：两次 `JSON.stringify` 逐字节相等（`true`）；`buildOutline` 不改入参（前后 `JSON.stringify(parsed)` 相等）；
  返回深冻结（`Object.isFrozen` 对 `Outline`/`nodes`/子 `children` 均 true）；`ops/**` 与 `meta/**` 内无
  `Math.random`/`Date`/`sort`（单趟文档序遍历，`grep -rn "sort\|Math.random\|Date.now"` 零命中）。
- **代码形态**：`eslint packages/core/src/ops packages/core/src/meta` → rc=0（真的跑了，不是看报告）；
  11 个新文件 4–276 行（`walk.ts` 276 ≤ 400）；模块头均为 1 行；无 `any`/`as`/`!`（`grep` 零命中）；
  两级门面成立（`index.ts` → `ops/index.ts` → `ops/outline/index.ts`，各 4 行，只转发）。
  `budget.ts`（156 行，字节预算）与 `derive.ts`（68 行，装配 + 冻结 + 截断诊断）职责确不重叠，
  `text.ts` 复用 `html/text.ts` 的 `normalizeWhitespace`/`textContentOf`，**没有**复制归一逻辑。
  `Diagnostic` 五字段未变（`git diff html/constants.ts` 只加 4 个码 + 4 行 severity）。
- **`level` 推导**：section 内只有 h3 → `level=3`；`section>header>h4` → 三者 `level=4`、`text="丁"`
  （AC1 明确要求的点，实现正确）；article 外的页面级 `header` 不出现；`level: 0` 只出现在顶层无标题容器，
  无 `sort` 故不引发下游排序问题；扁平 `h1/h3/h2` → `h1` 下挂 `h3`、`h2`（AC8 正确）；无标题只有 `p` → `nodes: []` 且不诊断。
- **性能**：1MB（1139KB）132.4 ms ≤ 150；10k 节点 51.2 ms；4000 深 8.5 ms；规模 591KB→1139KB→2295KB→4607KB
  对应 80.9→132.4→265.9→551.1 ms，**线性**，无 O(n²)。
- **字数自洽**：顶层节点 `wordCount` 之和 = `Outline.wordCount`；父节点 `wordCount` ⊇ 子节点之和。
- **Scope**：`git status` 新增面只有 `src/ops/**`、`src/meta/**`、`html/constants.ts`(+8/−2)、`src/index.ts`(+2)，
  与卡片 Scope 一致，**无越界**。

## G2: FAIL

P0-1（诊断不受预算约束 → 400 倍破限 + 结构全丢）必须先修；P1-1（不可见文本计入字数）、
P1-2（字数规则与 AC1 不一致）、P1-3（双码重复诊断）必须在提交前收敛。
P2 八条与三条裁定建议可在本卡或 M1.4 一并处理。

ACP: 103.9K / 14% · 13 blocks · delegate none（写报告时 `acp_status`）

---

# R1 复审（G2-R · 只验上轮 P0-1 / P1-1..P1-3 + 3 条 P2 + 回归）

复现环境：`/tmp/m13r1`（源码副本 + `node_modules` 软链，`registerHooks` 加载 `.ts`），
所有数值来自真实导出。**管线一律为真实管线**：`buildOutline(injectNodeIds(parseHtml(x)).parsed)`。

> 方法更正（诚实记录）：本轮初次探针把 `parseHtml(x)` 直接喂给 `buildOutline`，得到
> `nodes=0` 与成对的 `outline_node_without_id`。这不是实现缺陷——`data-hr-id` 由
> `injectNodeIds` 赋予，`parseHtml` 只解析。改走真实管线后所有指标正常；这条踩坑本身
> 作为 P2-D 登记（`ParsedHtml` 类型无法区分"已注入/未注入"）。

## 逐条判定

| # | 上轮结论 | 本轮判定 |
|---|---|---|
| 1 | P0-1 三行复现超 8KB / 静默截断 | **CLOSED** |
| 2 | P1-1 `style`/`script`/`textarea`/`template` 计入字数 | **CLOSED** |
| 3 | P1-2 字数口径（CJK-B、连字符、数字、NFC） | **CLOSED** |
| 4 | P1-3 `level` 被"父链补偿"压缩 | **CLOSED** |
| 5 | P1-3 之二 `script_in_meta` + `invalid_meta` 双报 | **CLOSED**（按 v2 #15） |
| 6 | P2 `derive.ts` 同名 | **CLOSED** |
| 7 | P2 归一逻辑复制 | **PARTIAL**（outline 侧已复用；html 层仍有一份内联副本） |
| 8 | P2 单节点 `text` 上限 | **CLOSED**（见 P2-C 的口径脚注） |

## R1-1 P0-1 CLOSED（三行复现 + 最坏形态 + 1MB + 深嵌套）

```
2000 节（真实管线 inject→build）：
  kebab  jsonBytes=6731  nodes=62  trunc=1  dropped=3938  kept+dropped=4000/4000  diagBytes=100
  snake  jsonBytes=7353  nodes=59  trunc=1  dropped=3941  kept+dropped=4000/4000  diagBytes=753
  camel  jsonBytes=7368  nodes=59  trunc=1  dropped=3941  kept+dropped=4000/4000  diagBytes=768
```
- 三行全部 **≤8192 B**、`nodes > 0`、`outline_truncated` **恰 1 条**。
- `snake`/`camel` 的 id 不符合 `HR_ID_PATTERN`（`/^[a-z0-9-]+$/`，`packages/core/src/html/constants.ts:76`），
  由注入层改写为 `hr-<hex8>` 并报 `invalid_hr_id`（被限流到 3 条），所以字节数比 kebab 高 ~600 B
  ——这正是"诊断也吃预算"的可见后果，`diagBytes` 仍 ≤1024。
- **丢弃数是真实值**：三行都满足 `kept + dropped = 4000`（排序前真实建出的 `section + h2` 总数），
  不是拿 `OUTLINE_NODE_SCAN_LIMIT`（1024）冒充。
```
最坏形态（2000 节 + 600 深嵌 + 长标题）：jsonBytes=6736  nodes=33
  msg="命中结构/文本上限 601 处，按字节预算丢弃节点 1169 个"
CJK 重型（2000 节 × 120 汉字标题）：bytes=6728  chars=3108  nodes=8   （byteLength 才是判据）
1MB 文档：htmlBytes=860100  buildMs=49.4  outlineBytes=6626  nodes=49  dropped=1751  trunc=1
1200 层深嵌套：ms=5.9  nodes=7  msg="命中结构/文本上限 2393 处"（不爆栈，深度上限 4 生效）
诊断天然巨多（3000 条悬空批注）：diagBytes=557（中文 id/comment 版 602）  trunc=1
  msg="按字节预算丢弃批注 2960 条，另有 2997 条诊断省略（annotation_target_missing 2997 条）"
```
- 诊断段 6 组样本实测字节：100 / 449 / 557 / 602 / 753 / 768 —— **全部 ≤1024**；
  `fitDiagnostics` 三级收敛（3/code → 1/code → 只留截断报告，`diagnostics.ts:106-120`）是真实存在的降级路径。
- 总预算算术自洽：`OUTLINE_BYTE_LIMIT 8192 - OUTLINE_RESERVE_BYTES 1536 = 6656`（节点+批注），
  加诊断 1024 → 上界 7680 < 8192，与实测最大值 7368 吻合（`packages/core/src/ops/outline/constants.ts:26-38`）。

## R1-2 P1-1 CLOSED（标签计入）

```
style=1  script=1  textarea=1  template=1   ← 基线 1（h2 标题）即净 0，不计
noscript=3  code=3  pre=3                   ← 净 +2，计入
```
（基线核对：同文档去掉这些片段时 `wordCount=1`。）

## R1-3 P1-2 CLOSED（字数逐项对表）

```
𠀀(U+20000)=1   state-of-the-art=4   1,234.56=3    l'été NFC=2 / NFD=2
Ａ(全角)=1       αβγδε=1              привет=1      あいう=3   한글=2
👨‍👩‍👧‍👦=0（非 L/N）    e+́(U+0301)=1
```
全部与卡片 #13 一致；NFC/NFD 同值说明 `normalize("NFC")` 生效（`packages/core/src/ops/outline/text.ts:15`）。
扩展 B 现在计 1 —— 上轮 `\p{Script=Han}` 漏 U+20000 的问题已闭。

## R1-4 P1-3 之一 CLOSED（`level`）

```
<section data-hr-id="sec"><h3>…</h3></section>              → section:3  h3:3
<section><section><h3>…</h3></section></section>            → section:3 section:3 h3:3
<h1>…</h1><h4>…</h4>                                        → h1:1  h4:4
```
`h3` 不再被压成 2，“父链缺失压缩级别”的补偿逻辑已移除。

## R1-5 P1-3 之二 CLOSED（双报，无第三条同义）

`<script id="hr-meta">{"title":"x </script> y","annotations":[]}</script>` 输出三条：
```
misnested_tag     <script> 的结束标签没有对应的开始标签
script_in_meta    <script id="hr-meta"> 内容不是完整 JSON，多半被正文里的 </script> 提前截断
invalid_meta      hr-meta 不是合法 JSON
```
- 两条被允许的诊断**各自说清不同层**：`script_in_meta` 是 HTML 层（"被 `</script>` 截断"），
  `invalid_meta` 是 JSON 层（"不是合法 JSON"）。
- 第三条 `misnested_tag` 来自 html/balance，描述的是**结构性事实**（悬空结束标签），
  与两条 JSON 诊断不同义，不算"同义第三条"。
- 唯一可改进处：一次输入同一病因产出 3 条报文，读者需自己归因；建议在卡片 #15 说明里点明"第三条来自结构层属预期"（不阻塞）。

## R1-6 P2 三点

- **`assemble.ts` 改名 CLEAN**：`grep -rn "derive" packages/core/src/ops/ packages/core/src/index.ts` → 无输出；
  模块头 `assemble.ts:1`「这层管：把 walk/meta/预算的结果装配成冻结的 `Outline`」写清了职责。
- **归一只有一份（outline 侧）**：`packages/core/src/ops/outline/walk.ts:11` 直接
  `import { normalizeWhitespace, textContentOf } from "../../html/text"`；
  `ops/outline/text.ts` 只剩 `countWords`/`truncate`，无归一实现 → 卡片 #16 达成。
  **残留**：`packages/core/src/html/inject.ts:45` 仍内联 `replace(/\s+/gu, " ").trim()`，
  与 `packages/core/src/html/text.ts:45` 的 `normalizeWhitespace` 是同实现的两份（P2-A）。
- **单节点 `text` 上限生效**：200 字符标题 → `text` 121 码点（120 + `…`），`wordCount` 仍按全文计 40；
  200 个 `😀` → 121 码点且**无孤立代理对**（`truncate` 用 `Array.from`，`text.ts:40-42`）。
  批注 `comment` 同口径：200 字符 + `…` = 201 码点（卡片 #5 明写"— 200 字符（`…` 结尾）"，一致）。

## R1-7 回归（自己跑）

```
$ pnpm verify            → EXIT=0
  Test Files  27 passed (27)     Tests  393 passed (393)
  coverage: src/html、src/meta、src/model、src/ops/outline 每个文件 100 | 100 | 100 | 100
  depcruise: ✔ no dependency violations found (63 modules, 174 dependencies cruised)
  knip --strict: 通过
```
未发现"为了压诊断把正常文档压坏"：空文档 / 纯注释 / 只有 `<p>` 三种合法形态 → `nodes: []` 且**零诊断**
（卡片 #8），`<section><h2>alpha beta</h2></section>` 的 `wordCount` 为 2/2/2（父子**无重复计入**）。

## 本轮新增 P2（4 条，均不阻塞）

1. **P2-A 测试用字符数而非字节数**：`packages/core/tests/outline-budget-regression.test.ts:53,58`、
   `packages/core/tests/outline-meta.test.ts:279`、`packages/core/tests/outline-perf.test.ts:61`、
   `packages/core/tests/outline-pressure.test.ts:57` 都写 `JSON.stringify(x).length`。
   `length` 是 UTF-16 码元数，中文/emoji 文档下恒小于 UTF-8 字节数，所以断言**弱于实现**
   （实现用 `TextEncoder`，`packages/core/src/ops/outline/budget.ts:42`、`diagnostics.ts:23-24`）。
   我实测 CJK 重型：bytes 6728 / chars 3108 —— 若实现改用字符计，测试也照样绿。
   修复方向：断言改 `new TextEncoder().encode(JSON.stringify(x)).length`（或抽一个 `bytesOf` 测试工具）。
2. **P2-B `html` 层归一仍有两份**：`packages/core/src/html/inject.ts:45` 与
   `packages/core/src/html/text.ts:45`。建议 `inject.ts` 改调 `normalizeWhitespace`。
3. **P2-C `ParsedHtml` 不区分"已注入/未注入"**：`buildOutline(parseHtml(x))` 会静默返回空树 +
   成对 `outline_node_without_id`（报文诚实，但调用方很容易以为是文档问题）。M1.8 组装 CLI 时是真实风险。
   修复方向：让 `injectNodeIds` 返回 branded `InjectedHtml`，或 `ops/index.ts` 文档里写明"必须先注入"。
4. **P2-D `text` 上限的口径脚注**：卡片 #18 字面写"`text` ≤ 120 字符"，实现是"正文 ≤120，含 `…` 共 121"。
   与 #5 的 `comment` 口径一致，属卡面措辞需要补一句（若按字面读，是 1 字符的契约差，需协调者裁定）。

## 未关闭项

- P1：**0**
- P2：4 条（上面 P2-A..P2-D）

## G2-R: PASS
（P0-1 与三条 P1 全部 CLOSED；P2 归一项目前只剩 html 层内部副本，不影响 outline 行为。M1.3 可提交。）

ACP: 约 60K / 8% · 15 blocks · delegate none
