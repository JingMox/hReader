# impl-M1.2 · 文档模型与不变量校验（实现报告）

- 卡片：`.workflow/cards/M1.2.md`；基线提交 `7ec0110`（M1.1，219 例 / 覆盖率 100%）。
- 分层裁定遵守情况：模型是 `ParsedHtml.root` 的**只读投影**，不缓存、不回写、不持有 parse5 节点、不建第二棵树。

## 1. 交付清单

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/core/src/model/constants.ts` | 24 | `DocumentModel` 类型、`ARTICLE_TAG`、`HEADING_LEVELS` |
| `packages/core/src/model/attrs.ts` | 36 | 单元素判定：`attributeOf` / `isBlockElement` / `validIdOf` / `componentOf` |
| `packages/core/src/model/derive.ts` | 154 | `toDocumentModel`：单趟先序 + 显式栈，收尾时冻结 |
| `packages/core/src/model/validate.ts` | 264 | `validateDocument`：id/标题/article 不变量 + 与 M1.1 诊断合并去重 |
| `packages/core/src/model/index.ts` | 5 | 模块门面 |
| `packages/core/src/html/text.ts` | +3 | 新增 `normalizeWhitespace`（模型复用，**不复制第二份**） |
| `packages/core/src/html/constants.ts` | +11 | `DiagnosticCode` 增 4 个码 + 定级（v2 删 `heading_level_skip_root`）；新增 `ARTICLE_TAG` |
| `packages/core/src/html/inject.ts` | +6 | 新增 `isInjectionTarget`：最外层 `<article>` 自身纳入注入（M1.1 其余语义未动） |
| `packages/core/src/hr-error.ts` | +1 | `HrErrorCode` 增 `invalid_document`（契约 1 明确要求该码） |
| `packages/core/src/index.ts` | +2 | 包入口加 `toDocumentModel` / `validateDocument` / `type DocumentModel` |

## 2. 契约 → 实现映射

| 契约 | 实现 | 证据 |
| --- | --- | --- |
| 1 模型形状 | `derive.ts`：根 = 第一个 `<article>`；`children` 只装 `isBlockElement` 且 id 合法的后代；`text` = 落到该节点的文本片段 join 后一次归一 | §3 三个文档的 JSON |
| 1 顶层 article 唯一 | `enterArticle` 第 2 个 article 立即 `throw HrError("invalid_document")`；遍历结束仍无 root 也抛同码；**根 id 为空/缺失也抛同码**（v2 裁定 6，不造空串 ID） | probe：`<div>a</div>`、双 article、未注入的 `<article>` 三者均抛 `code==="invalid_document"` |
| 1 不可恢复才抛 | 派生只负责结构；可恢复问题（缺 id/非法 id/标题跳级…）全部留给 `validateDocument`，故 `toDocumentModel` 无诊断通道 | §2 下一行 |
| 2 校验 | `validateDocument`：`duplicate_id`（每处一条、路径各自不同）、`missing_article`、`multiple_article`（第 2 个起每处一条）、`heading_level_jump`、`heading_level_skip_root`；`invalid_hr_id` 沿用 M1.1 定义 | §3 诊断行 |
| 2 合并去重 | `dedupe`：键 `code\|path\|message`，保留首次；`derived` 先按文档序 `order` 稳定排序再拼接 | probe `bad-component` 只出 M1.1 的一条 |
| 2 严重度 | 全部走 `DIAGNOSTIC_SEVERITY` 表：`duplicate_id`/`missing_article`/`multiple_article`=error，两个 heading=warning | `constants.ts:DIAGNOSTIC_SEVERITY` |
| 3 不可变 | `freezeDraft` 收尾时 `Object.freeze(children)` + `Object.freeze(node)`，反向先序保证子先冻结 | §4 |
| 4 无未转义 HTML | 模型只存解码后的 `text`/属性值；序列化只在 `serializeHtml` | 三个文档 text 里无 `<`/`&` 残留 |
| 5 归一一致 | `html/text.ts:normalizeWhitespace`（`\s+`→单空格 + trim），注入侧同一语义 | §3 `a\u00a0\u3000 b\n\tc` → `a b c` |
| 6 性能 | 单趟派生（O(n)），路径按需拼接；4000 深 = 栈长度 4000，不递归 | §4 |
| 7 代码形态 | 最大文件 264 行、最长函数 < 40 行、无 `any`/`as`/`!` | `pnpm lint` 绿（complexity/max-depth/max-lines 全在规则内） |

**v2 裁定后的语义**：`<br>` 视为词边界（`separateBlock` 打一个空格，`a<br>b` → `a b`）；无 `data-hr-id` 的块级元素不建节点、其全部可见文本折叠进最近祖先的 `text`（`<article data-hr-id="r"><section>x<p>y</p></section><p>z</p></article>` → `text="x y z"`、`children=[]`），且**不再为此发诊断**；`h1` 在 `<article>` 内合法，`heading_level_skip_root` 码已从 `DiagnosticCode`/定级表删除。

**实现取舍（写下来供审计）**：`text` 不需要内联白名单——遍历时"非块级即透明"，文本自然归到最近的未收尾块级祖先；块级子树进入时给父节点补一个空格（`separateBlock`），否则 `lo<p>in</p>hi` 会粘成 `lohi`。

## 3. 真实文档片段的模型输出（实测）

**A · `docs/02` §3.1 规格示例（节选）**

```json
{"id":"root-article","tag":"article","text":"","children":3}
[{"id":"sec-header","tag":"header","text":"","children":2},
 {"id":"sec-problem","tag":"section","component":"callout-warning","text":"","children":2},
 {"id":"sec-comparison","tag":"section","component":"kpi-bento","text":"","children":0}]
grand: [["title-main","h1","分布式一致性协议深度解析"],["p-lead","p","从物理时钟的不可靠性出发，推演 Raft 与 Paxos 的本质同构。"]]
diag: []   // v2 起 h1 在 article 内合法
```

**B · KPI + 步骤时间线（内联混排、`&nbsp;`、源码换行）**

```json
[["article","doc-b",""],["  section","sec-kpi","kpi-bento","QPS1200 （p99 3ms） 错误率 0.02%"],
 ["  section","sec-steps","step-timeline",""],["    ol","steps",""],
 ["      li","step-1","采集 日志"],["      li","step-2","归一化 再去重"]]
diag: []
```

**C · 表格 + 嵌套列表 + 跳级标题**

```json
[["article","doc-c",""],["  h2","h2-a","对比"],["  h4","h4-b","细节"],
 ["  table","table-1","RaftPaxos"],["  ul","ul-1",""],
 ["    li","li-1","a"],["      ul","ul-2",""],["        li","li-2","b"]]
diag: ["heading_level_jump"]
```

## 4. 性能与不可变性（实测数字）

- **4000 深**（`<article>` + 4000 层 `<section>`）：`toDocumentModel` 正常返回，模型深度实测 4000，无 `RangeError`。
- **1.31 MB 文档**（`1374799` 字节，9000 个 `section`+`h2`+`p`）：`injectNodeIds + toDocumentModel + validateDocument` 三次 `65.3/53.3/46.7 ms`，中位数 **53.3 ms**（阈值 200 ms）；模型 `children.length = 9000`、深层冻结成立。
- **深层冻结**：`isFrozenDeep(model) === true`（节点与每层 `children` 数组都 `Object.isFrozen`）。
- **写操作无效**：`model.children[0].text = "hacked"` 后值不变；`children.push(...)`、`children[0].children.pop()` 均抛 `TypeError`。
- **两次调用**：`deepEqual(a, b)` 为真，`a !== b`、`a.children !== b.children`、`a.children[0] !== b.children[0]` 全部成立；`structuredClone(a)` 与原模型深等（纯数据，无 getter/类/循环）。
- **§自问**：本卡是否新增了任何可被外部修改的共享状态？**否**——`derive.ts` 的 `DeriveState` 是函数内局部量，`validate.ts` 的 `State` 同样是局部量；模块级只有 `ReadonlySet`/`Readonly<Record>` 常量与 `RegExp` 常量（`\s+`/`[a-z0-9-]` 无 `g` 标志，无 `lastIndex` 状态）。

## 5. `pnpm verify` 现状（如实记录，红都不是实现缺陷）

| 门 | 状态 | 说明 |
| --- | --- | --- |
| `format:check` | ✅ | 全部文件 Prettier 合规 |
| `lint` | ✅ | 0 问题（complexity/max-depth/max-lines/max-params 全过） |
| `typecheck` | ❌ 1 行 | `packages/core/tests/hr-error.test.ts:9`：`Record<HrErrorCode, true>` 缺 `invalid_document`（裁定 5：留测试员补） |
| `depcruise` | ✅ | 38 模块 / 91 依赖，无违规 |
| `knip` | ✅ | 无未用导出/依赖（`INLINE_TAGS` 曾因无引用被 knip 抓到，已删） |
| `test:coverage` | ❌ 13 例（`pnpm verify` 在 `typecheck` 即中止，此行由 `pnpm exec vitest run` 单独实测） | 12 例是 **article 自身注入**带来的断言过期（`injected` 长度 +1、`should not inject the article element itself`、嵌套 article 由 1→2），1 例是 `entry-points.test.ts:26` 的 `REQUIRED_RUNTIME_EXPORTS` 未含 `toDocumentModel`/`validateDocument`。覆盖率因失败未产出，`model/**` 0 例（G3 补齐） |

## 6. 裁定落实（卡片 v2，6 条）

| # | 裁定 | 落点 | 自证 |
| --- | --- | --- | --- |
| 1 | `<article>` 自身也注入 `data-hr-id`，嵌套只注最外层 | `html/inject.ts:isInjectionTarget`（新增）；`html/constants.ts` 新增 `ARTICLE_TAG` | `<article data-hr-id="root-article">` 原样保留且不计入 `injected`（→1 条 = 内部块级）；`<article><article><p>a</p></article></article>` 注入 2 条（外层 article + p），内层不注入 |
| 2 | h1 在 article 内合法，删 `heading_level_skip_root` | `html/constants.ts` 码表与定级表各删一行；`model/validate.ts:checkHeading` 删该分支 | `<article><h1>t</h1><h4>u</h4></article>` → 只出 `heading_level_jump`；h1 单独存在时 `[]` |
| 3 | 无 ID 块级元素不建节点、文本折叠父级、不诊断 | `model/derive.ts`（既有透明逻辑）+ `model/validate.ts` 删除块级缺 ID 诊断 | `<article data-hr-id="r"><section>x<p>y</p></section><p>z</p></article>`（未注入）→ `text="x y z"`、`children=[]`、诊断 `[]` |
| 4 | `<br>` 是词边界 | `model/derive.ts`：`BR_TAG` 分支 `separateBlock(owner)`；常量在 `model/constants.ts` | `<article><p>a<br>b</p></article>` → `"a b"` |
| 5 | `invalid_document` 追认 | 已在 `hr-error.ts`（R0 之前） | `tests/hr-error.test.ts:9` 红留测试员 |
| 6 | 模型根 ID 不得为空串 | `model/derive.ts:enterArticle` 抛 `HrError("invalid_document")` | 未注入的 `<article><p>a</p></article>` → 抛 `invalid_document`（不再产出 `""`） |

**article 注入对 M1.1 既有语义的影响（自测，非测试套）**：

- 确定性：同一输入两次注入，`injected` 与序列化结果逐字节相同 ✅
- 冲突后缀：先占 `hr-6dc6e0c6` 为某 `p` 的 ID，同文档另一个同基 ID 元素得到 **`hr-6dc6e0c6-2`** ✅
- 保留既有 ID：`<article data-hr-id="root-article">` 原样保留、不重复计数 ✅
- 往返：完整文档 `serialize(parse(x)) === x` ✅（未闭合 `<p>` 会补 `</p>`，这是 M1.1 既有解析修复语义，不是本次改动引入）
- 注入范围：`<main><p>x</p></main>` 仍注入 0 条（article 外不注入）✅
- 既有 219 例：**206 通过 / 13 失败**，失败全部是 article 注入导致的断言过期（见 §5），无实现侧回归。

## 6.3 R2 提交前清理

- **P2-R1**：`model/validate.ts` 的两处流程话术（`duplicateDiagnostics` 头部"两臂都可到/段内排序拼接"、`validateDocument` 尾部的排序说明）改为不变量描述：前者一行「重复 ID 逐条报告：先按 id 归组，再对出现 ≥2 次的组按文档序输出每一处的位置」，后者「跨段顺序固定为 M1.1 诊断在前、本模块在后」。
- **P2-R2**：`insideArticle` 死管线整条删除（`Task` 字段、`pushChildren`/`enterElement`/`enterNode` 形参、`validateDocument` 初始化与调用点共 8 处），`validate.ts` 264 → 246 行；`grep -rn "insideArticle" packages/core/src/` 零命中。
- **P2-R3**：`model/derive.ts:1` 补模块头（1 行，与同目录 `constants.ts`/`attrs.ts` 同风格）。
- 验证：`grep -rn "v3\|P0-\|P1-\|审计\|coverage" packages/*/src/` 零命中；`pnpm verify` EXIT=0，300 例全绿，四维覆盖率 100%（`src/model/**` 每文件 100/100/100/100）。输出未变：诊断文案/path/顺序/错误类型均未触碰（纯删参 + 注释改写）。

## 7. 给测试员的话（5 条，最该打哪里）

1. 先修三处存量断言再谈新卡：`hr-error.test.ts:9` 补 `invalid_document: true`；`entry-points.test.ts:16` 的 `REQUIRED_RUNTIME_EXPORTS` 加 `toDocumentModel`/`validateDocument`；**12 例 article 注入相关断言整体 +1**（`injected` 长度、`should not inject the article element itself` 应当反过来断言"必须注入"、嵌套 article 由 1→2）。
2. `text` 边界是本卡最容易错的地方：`<p>a <span>b</span></p>`→`a b`；`<section>lo<p>in</p>hi</section>`→`lo hi` + 子节点 `in`；`<p>a<br>b</p>`→`ab`（当前取舍）；全角空格/NBSP/换行/制表都归一成单空格。
3. `duplicate_id` 必须**每处一条**且路径各不相同（3 处 → 3 条），`multiple_article` 从第 2 个起每处一条，`missing_article` 无 `path`。
4. 冻结要打到底：`Object.isFrozen` 检查到叶节点 + 每层 `children` 数组；再打"写无效/`push` 抛 TypeError"；再加两次调用 `deepEqual` 且 `!==`。
5. 性能与深度的下限已实测（4000 深 OK、1 MB `toDocumentModel+validateDocument` 中位数 49.8 ms），测试阈值别贴着实测定（建议 4000 深用"不抛 RangeError"、1MB 用 200 ms 上限）。

## 7. R1 返工（卡片 v3 #10–#14 + P0/P1/P2）

| 编号 | 位置 | 改前 | 改后 |
| --- | --- | --- | --- |
| P0-1 | `src/model/constants.ts:19` | `/** 标题层级：相邻标题层级差 >1 视为跳级；h1 只允许出现在 <article> 之外。 */` | `/** h1 在 <article> 内是规范形态，不诊断；跳级判定只看相邻标题的层级数字差 >1。 */`（实现零改动） |
| P1-3 | `src/model/validate.ts:63-67`（`pathToString`） | 根占位段 `""` 也进数组 → `">html[0]>body[0]>article[0]>p[0]"` | 跳过空段 → `"html[0]>body[0]>article[0]>p[0]"`，与 `inject.ts:133` 的 `[...state.path, seg].join(">")` 逐字同构 |
| P1-2 | `src/model/validate.ts:16-21`（`PathNode` 注释） | `/** 路径按需拼接：正常文档零诊断，不该为每个节点先付一遍整条路径的成本。 */`（与实现不符：`enterElement` 对每个元素都拼一次） | 真实说明：本模块 `O(n·depth)`；实测 430KB/6000 块 4.3ms、4000 深 97.2ms（阈值 200ms），故不改惰性路径 |
| P1-1 | 契约 v3 #10 | 代码里 `state.ordered` + 收尾 `sort` 容易被读成"全局排序" | 改名 `state.ownDiagnostics`，注释写明"只对本模块诊断做段内稳定排序；跨段顺序 = M1.1 段 + 模型段"；不加 `order` 字段、不改 `Diagnostic` 五字段 |
| P2 | `src/index.ts:9` | `// …名存实亡（审计 P1-2）。` | `// …名存实亡。`（保留结论，删审计编号） |

**P1-3 自测（改后实测字符串，与 `injectNodeIds` 同源同构）**

| 样本 | `validateDocument` 输出 path |
| --- | --- |
| 双 `<article>` | `html[0]>body[0]>article[0]>article[0]` |
| 同 id 两处（article 内两个 section） | `html[0]>body[0]>article[0]>section[0]` / `…>section[1]` |
| `h1`+`h3` 跳级 | `html[0]>body[0]>article[0]>h3[0]` |
| 未注入 + 非法 id | `html[0]>body[0]>article[0]`（与 `inject.ts:133` 同串） |

**D2（协调者裁定"不是缺陷"）**：`normalizeWhitespace` 的 `\s+` 连 NBSP/U+3000 一起归一，未收窄，按裁定保留。

## 8. `pnpm verify` 真实状态

**现状（覆盖率补刀后）：EXIT=0，300 例全绿，`All files 100 | 100 | 100 | 100`。**

| 门 | 状态 |
| --- | --- |
| `format:check` / `lint` / `typecheck` / `test:coverage` / `depcruise` / `knip` | ✅ 全绿 |

**R1 收尾（覆盖率补刀）**：`model/validate.ts:175` 的 `?? 0` 假臂逻辑不可达（每个 occurrence 两行前刚被计入 counts）→ 判定为实现形状问题而非测试缺口，把 `duplicateDiagnostics` 重构为"按 id 归组 + 只遍历 `length ≥ 2` 的组"（两臂皆可达；无 `??` / `!` / `as`），输出文案与 path 逐字不变，组内按 `order` 排序。

**历史（补刀前的红灯，仅供回溯）**：`model-validate.test.ts` 5 例按旧格式断言带前导 `>` 的 path（测试员已按 v3 #11 翻牌）；`html-r1-regression.test.ts` 1 例覆盖率插桩下耗时比 16.35 > 16（单跑通过，测试员已放宽为按中位数）。

ACP: 44.7K 估算 / 59.2K provider（`acp_status`，22 个折叠块，delegate none）。R2 变更面：`model/validate.ts`（-18 行 + 2 处注释）、`model/derive.ts`（+模块头）、本报告；tests 零改动。
