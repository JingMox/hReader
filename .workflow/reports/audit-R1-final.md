审计完成。我已说明：本环境没有写文件工具（只有 read、grep、find、ls、watchdog_diff），因此报告全文随本回复返回，请运行层写入 `.workflow/reports/audit-R1-final.md`。

---

# 审计报告 R1（提交 `5b51819`，只读）

**判决：CHANGES-NEEDED**　P0=0　P1=1　P2=5
（代码主体可通过；唯一 P1 是**接口约定文档与本轮行为改动矛盾**，必须同批落地。若文档修改拆到独立 PR，则为 PASS-with-notes。）

## 前置说明（读法偏差，需记账）
- 任务点名的 `docs/04-api-contract.md` **不存在**（`docs/` 只有 `01-competitor-research.md`、`02-architecture-and-roadmap.md`、`03-collaboration-workflow.md`、`04-engineering-standards.md`、`05-feature-cards.md`）。错误码表与三集合说明实际在 `docs/05-feature-cards.md:409-445`、`:453`，本报告按此对齐。
- `watchdog_diff` 报告 "No working-tree changes against reviewer-launch HEAD"，仅说明工作树干净；提交内容通过**直接读源码**核对（`5b51819` 与工作树一致）。未使用任何 git 命令。

---

## 1. 三权分立是否真的成立？——**是，只有一处跨语义重复使用（P2-2）**

| 调用点 | 用的集合 | 回答的问题 | 判定 |
|---|---|---|---|
| `packages/core/src/html/constants.ts:25` `BLOCK_TAGS` | — | 内容模型投影 | 定义处，注释 `:22-24` 明确"不回答能不能寻址/当目标" ✅ |
| `packages/core/src/html/constants.ts:52` `ADDRESSABLE_TAGS` | `BLOCK_TAGS ∪ {h5,h6,div,aside,nav,main,article,dl,dt,dd,figcaption,caption,thead,tbody,tfoot,tr,td,th}`（`:53` 展开） | 有没有 id | 定义处 ✅ |
| `packages/core/src/html/constants.ts:80` `PATCHABLE_TAGS` | `new Set(ADDRESSABLE_TAGS)` | 能不能被改 | 定义处（`:79` 注明"独立实例，不是别名"）✅ |
| `packages/core/src/html/inject.ts:39` `isInjectionTarget` | `ADDRESSABLE_TAGS` | 分配 id | ✅ 正确 |
| `packages/core/src/ops/patchNode/attrs.ts:39` `isBlockLevel` | `PATCHABLE_TAGS` | patch 目标判定（唯一调用点 `apply.ts:91`） | ✅ 集合选对，**命名错**（P2-1） |
| `packages/core/src/model/attrs.ts:22-24` `isBlockElement` | `BLOCK_TAGS` ∪ (`div` + `data-hr-component`) | 派生文档模型 | ✅ 语义对，且 `BLOCK_TAGS ⊆ ADDRESSABLE_TAGS` ⇒ "模型节点必有 id"不变量成立 |
| `packages/core/src/ops/patchNode/content.ts` | **不引用任何集合**（自有 `INLINE_ONLY_CONTAINERS`/`ONLY_CHILDREN`） | 容器能装什么 | ✅ 这正是想要的分离 |

结论：**没有第二处用 `BLOCK_TAGS` 回答"能不能寻址/能不能改"**，M4.1 的三语义复用病未复发。唯一残留是 `article` 这个条目对错集合生效（P2-2）。

## 2. `ADDRESSABLE_TAGS` 与 `PATCHABLE_TAGS` 的关系——**结构与文档一致，但没有护栏（P2-3）**
- 确实是"默认同集、只减项"：`:80` 是独立 `Set` 拷贝，减项不会影响寻址面；`:77` 写明"当前例外为空"；`attrs.ts:39` 是**单行谓词**，没有 if 链代替减项 ✅。
- 反向缺口：**没有任何测试守住这条不变量**。全仓 grep `PATCHABLE_TAGS|ADDRESSABLE_TAGS` 只命中 `html-inject.test.ts:83-86`（断言 `div` 拿到 id），无一处断言 `PATCHABLE_TAGS ⊆ ADDRESSABLE_TAGS` 或"减项必须带理由"。把某项从 `PATCHABLE_TAGS` 删掉、或反向把某项**加进** `PATCHABLE_TAGS`（目标拿不到 id ⇒ 永远 `node_not_found`），测试都会全部通过，而 `docs/05:453` 与 `constants.ts:76` 把这条写成了硬规则。
- 附注：`inject.ts:39` 的三元里确有 tag 特例（`article`），但它属于**寻址判定**，`docs/05:453` 只禁止"在（可作目标的）判定里加 if 链"，故不违约。

## 3. `fragment.ts` 的先解析后校验——**实现正确，`v8 ignore` 全部写了理由**
- 顺序：`fragment.ts:238` 类型守卫 → `:239-241` 空白即 `invalid_fragment` → `:250` `scanTokens` → `:251` `assertNoAncestorClosed` → `:252` `parseHtml`（套 `inContext` 祖先链）→ `:253` `assertNoForbiddenContent` → `:254` `assertTokensSurvived` → `:256-259` `ancestorChainOf`→`assertNothingEscaped`→`contextOf`→`singleElementOf`。**平衡校验只在解析前用 tokenizer 数"包装祖先被关闭"这一件事**（`fragmentTokens.ts:132-152`），不再拿原始源码判标签配平 ✅（`<li>a<li>b` 因此合法）。
- `typeof html !== "string"` 守卫（`fragment.ts:220-224`）对 `null`/`undefined`/`String` 对象一视同仁抛 `invalid_html`（`new String("x")` 是 `object`），与 `html/parse.ts:271-273` 同口径、与 M1.1 契约一致 ✅。唯一措辞瑕疵：`tests-R1.md:439` 记录的 `should reject a non-string html through the parser` 曾因"裸 `TypeError`"红过，此处已修但**需跑测试确认转红为绿**（DYNAMIC）。
- `v8 ignore` 共 **6 个标记 = 4 个位点**（`fragment.ts:63`、`:86`、`:99-106`、`:118-123`；`fragmentTokens.ts` 0 处）。4 个实质位点**都写了"为什么不可达"**（`:60-62` 类型收窄、`:85` 解析器建链原子性、`:96-98` 需变异证明、`:115-117` 外壳语义）✅。但四条都属"断言式不可达"（`contextOf` 的 `invalid_fragment` 无人测过），仅靠 perFile 100% 门禁兜着；`assertTokensSurvived`（`fragmentTokens.ts:190-217`）用 `startTags` 计数 − 祖先抵消来识别"被解析器丢弃的标签"，逻辑正确。
- P2-4：`singleElementOf`（`fragmentTokens.ts:39-46`）对"只有注释"的片段报"片段必须恰好有一个根元素（**实际 1 个**根级内容节点）"，自相矛盾（`isContentNode` 把 comment 算内容节点，`fragment.ts:257-258` 取候选后 `kind !== "element"`）。用户可见。

## 4. `static.ts` CSP 降级——**两处都换成了 `default-src 'none'`，`APP_CSP` 未残留在内联不可信文本的路径上** ✅
- `static.ts:70-75` 新增 `HOME_FALLBACK_HEADERS`：`default-src 'none'; style-src 'unsafe-inline'` + `referrer-policy: no-referrer`，注释 `:66-68` 明确"**不用** `APP_CSP`"。
- `fallbackHome`（`:80-84`，内联 `escapeHtml(docId)` + `homeBodyOf` 序列化出的文档 `<article>` 原文）与 `homeUnauthorizedReply`（`:87-91`，401 页）**共用**该头 ✅。
- `APP_CSP`（`http-io.ts:98-99`，含 `script-src 'self'`）现在只剩 `static.ts:153` 一处，只用于**已构建**的 `index.html` 字节流（`:148-155`），不内联任何文档文本 ✅。文档页 `handlers.ts:56` 亦为 `default-src 'none'` ✅。

## 5. `print-html.ts` `reservedIdsOf`——**T8 语义保住，没被改成"跳过"** ✅
`print-html.ts:126-140`：`const sectionId = attributeOf(node, DOC_ID_ATTRIBUTE); const id = attributeOf(node, "id"); if (id !== undefined && !numbering.numberById.has(sectionId ?? "")) { used.add(id); }`
- 有 `id`、无 `data-hr-id` ⇒ `sectionId === undefined` ⇒ `numberById.has("") === false` ⇒ **仍占位** ✅（T8 用例要的正是这条）。
- 有 `data-hr-id` 且是编号章节 ⇒ 不占位（它的 `id` 会被 `sec-` 锚替换，`:194-203` 用 `anchorById`）✅。
- `sectionId ?? ""` 只作 `Map.get` 的键占位，不会被写入任何属性，不是"空串 id"泄漏。无 P 级问题。

## 6. 文档与实现逐条对齐
- `exit-codes.ts:13-56` ↔ `docs/05:409-445`：`invalid_fragment`=1（`:22`）✓、`content_model_conflict`=`EXIT_USAGE`=2（`:55` vs 文档 `:445`）✓、`needs_normalize`/`port_in_use`=2 ✓、`chrome_*`/`render_*`/`llm_failure`=`EXIT_IO`=3 ✓、`invalid_input`/`forbidden_content`=1 ✓；`satisfies Record<HrErrorCode, number>`（`:12`）保证穷尽 ✅。
- `eslint.config.mjs:170-180`：注释"2026-11-19 实测 **1203** 行（R1 新增 `content_model_conflict`）" 与 `"max-lines": ["error", { max: 1203 }]` 自洽；实测 `packages/pi-extension/pi-hreader.ts` 末行为 **1203**（`:1201-1203` 是 `export default` 三行）✅ —— 零余量的策略与注释里"不留余量，再来一次就再改一次数字"的说明一致。

---

## 发现清单

### P1-1　`docs/05-feature-cards.md:418` 的 `invalid_fragment` 语义已与代码矛盾
`| invalid_fragment | 1 | 片段标签不配平 |`。本轮 F11 之后，`invalid_fragment` 只在两处抛：空白片段（`fragment.ts:239-241`）与"解析后不是恰好一个根元素"（`fragmentTokens.ts:39-46`）；片段路径**完全不判标签配平**（`fragment.ts` 只 import `parseHtml`，无 `tagBalanceDiagnostics`），`<div>`、`<b><i>x</b></i>` 已被移入 `ACCEPTED_FRAGMENTS`（`.workflow/reports/tests-R1.md:441` 第 6 条）。同一张表的 `:411` 还在该码之外宣称"不是完整文档"（`invalid_html` 现只由 `parse.ts:271-273`、`fragment.ts:222`、`style/apply.ts:128` 抛）。
**最小改法**：`:418` 改为 `片段为空/只有空白，或解析后不是恰好一个根元素（标签不配平不算错——HTML5 容错解析会补闭合）`；`:411` 删"不是完整文档"或改成"文档没有 `<head>` 时注入主题样式失败"。退出码列无需动。

### P2-1　`isBlockLevel` 这个名字与 `apply.ts:94` 的报文仍在宣称"块级"
`packages/core/src/ops/patchNode/attrs.ts:39` 判的是 `PATCHABLE_TAGS`（⊋ `BLOCK_TAGS`：含 `div`/`td`/`tr`/`h5`/`h6`/`aside`…），`apply.ts:91-95` 报 "patch 目标必须是块级元素"；`attrs.ts:1` 的头注释还说"与 `html/inject.ts` **同口径**"——而本轮设计恰恰是 inject 用 `ADDRESSABLE_TAGS`、patch 用 `PATCHABLE_TAGS`，允许减项，两者**不是**同一判据。这正是 F10 记过的"注释宣称同一判据"病的复发面（`audit-R1-F10.md:27` P2-1）。
**最小改法**：`isBlockLevel` → `isPatchableTarget`（`apply.ts:11`/`:91` 同步）；报文改 "…patch 目标必须是可寻址且可作目标的块级元素"；`attrs.ts:1` 改为"与 `html/inject.ts` 共用同一批标签常量，但判的是可作目标集合"。

### P2-2　`constants.ts:50` 对 `article` 的解释与实际生效路径相反（一处跨语义重复使用）
`packages/core/src/html/constants.ts:50` 说"`<article>` 也在这里：最外层 article 自身必须带 id"。但 `html/inject.ts:39` 是 `node.tag === ARTICLE_TAG ? !insideArticle : insideArticle && ADDRESSABLE_TAGS.has(node.tag)`——任何 tag 为 `article` 的节点都走第一分支，`ADDRESSABLE_TAGS.has("article")` **永不被求值**（静态可证：else 分支只剩非 article 标签）。因此 `article` 进 `ADDRESSABLE_TAGS` 的唯一实际作用是随拷贝进入 `PATCHABLE_TAGS`（`:80`），即"一个集合里放了一条只为另一个集合的问题服务的条目"，而注释把因果写反。
**最小改法**：`:50` 改为"`<article>` 放在这里是为了让 `PATCHABLE_TAGS` 能按 id 命中 `<article>`；最外层/嵌套 article 的注入判定由 `html/inject.ts:39` 的 tag 分支直接做"。不动集合（把它移出又加进 `PATCHABLE_TAGS` 会破坏"只减项"规则）。

### P2-3　"默认同集、只减项"没有任何测试护栏
全仓无断言 `PATCHABLE_TAGS` 与 `ADDRESSABLE_TAGS` 的关系（`core/tests/html-inject.test.ts:83-86` 只测 `div` 拿 id）。`docs/05:453` 与 `constants.ts:76` 把它写成硬规则，但删/加一项都不会红。
**最小改法**：新建 `packages/core/tests/html-constants.test.ts`，3 行断言：`BLOCK_TAGS ⊆ ADDRESSABLE_TAGS`、`[...PATCHABLE_TAGS].every(t => ADDRESSABLE_TAGS.has(t))`、`PATCHABLE_TAGS.size <= ADDRESSABLE_TAGS.size`。

### P2-4　"只有注释"的片段报出自相矛盾的报文
`fragmentTokens.ts:39-46` 对 `--html '<!--x-->'` 抛 "片段必须恰好有一个根元素（**实际 1 个**根级内容节点）"（`candidates=[comment]`，`count===1` 但 `kind!=="element"`）。
**最小改法**：把 `count===1 && only.kind!=="element"` 单列一条报文："片段根不是元素（是注释/文本），请给一个元素"。

### P2-5（report-only，非本轮引入）
`docs/05:411` `invalid_html` 的"不是完整文档"分支已被历史改动抽走（现仅 `style/apply.ts:128` 的"没有 `<head>`"沾边）。与 P1-1 同批改掉最省事。

---

## DYNAMIC（交测试员/测试编写员，本轮未跑）
1. `pnpm --filter @hreader/core test -- --coverage`：`fragment.ts` 的 4 个 `v8 ignore` 位点是否仍满足 perFile 100%（**新增的 6 个标记会让未覆盖行静默通过**，需要有人确认忽略范围没盖住活代码）。
2. `packages/core/tests/io/patch-actions.test.ts` 的 `should reject a non-string html through the parser`：`tests-R1.md:439` 记为红（期望 `invalid_html`、实得 `no_code`）；本轮 `fragment.ts:220-224` 已加守卫，**应转绿**，需实跑确认。
3. `pnpm knip`：`tests-R1.md:617-619` 记 `SHELL_TAGS`(fragmentTokens.ts:10) / `ChildSlot`(slots.ts:5) / `FragmentResult`(fragment.ts:227) 未用导出、`ADDRESSABLE_TAGS|PATCHABLE_TAGS` 重复导出 —— 本轮是否已消化（若未消化，属 P2 清理项，不进本判决）。
4. 新增 P2-3 的不变量用例后需跑一次确认。

## Merge verdict
**OK with notes 等价于 CHANGES-NEEDED（仅因 P1-1 契约文档必须与本次行为改动同批落地）。** 代码本体无 P0/P1 级缺陷：三权分立真实成立、先解析后校验顺序正确、CSP 降级两处到位、`reservedIdsOf` 的 T8 语义未被动过、退出码表与 `max-lines 1203` 自洽。

---

### 250 字摘要
判决 **CHANGES-NEEDED**，P0=0 / P1=1 / P2=5。
1）三权分立**真实**：`inject.ts:39` 用 `ADDRESSABLE_TAGS`、`patchNode/attrs.ts:39` 用 `PATCHABLE_TAGS`、`model/attrs.ts:22` 用 `BLOCK_TAGS`、`content.ts` 谁都不复用，无复发；唯一错位是 `constants.ts:50` 对 `article` 的解释与 `inject.ts:39` 三元分支相反（P2）。2）"默认同集只减项"结构成立（`constants.ts:80` 独立拷贝、`attrs.ts:39` 单行谓词、无 if 链），但**无测试护栏**（P2）。3）`fragment.ts` 确实先解析（`:252`）后校验（`:256-259`），6 个 `v8 ignore` 标记/4 个位点全部写了不可达理由；`typeof html!=="string"` 对 `null`/`undefined`/`String` 对象统一 `invalid_html`，符合契约。4）`static.ts:70-75` 首页 fallback 与 401 页共用 `default-src 'none'`，`APP_CSP` 只剩 `static.ts:153` 的已构建 `index.html`，无内联不可信文本。5）`print-html.ts:130-134` 的 `sectionId ?? ""` 保住 T8 语义（有 `id` 无 `data-hr-id` 仍占位）。6）退出码表与 `docs/05:409-445` 全对齐，`eslint.config.mjs:181` 的 1203 与实测行数自洽。
唯一 P1：`docs/05:418` 仍写"`invalid_fragment`=标签不配平"，与"先解析后校验"矛盾，需同批改。