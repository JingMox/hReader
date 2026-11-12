# 审计报告 · M1.2 文档模型与不变量校验

- 审计员：常驻审计（只读）；被审：commit 未提交工作区（`M src/index.ts`、`M src/hr-error.ts`、`M src/html/{constants,inject,text}.ts`、`?? src/model/`）。
- 依据：`.workflow/cards/M1.2.md`（v2 修订块为最终裁定）、`docs/02` §3.1/§5、`docs/04` §2/§3/§6。
- **结论：G2: FAIL（P0: 1 / P1: 3 / P2: 7）**

## 复现环境（所有证据都由本条命令产出，非引用他人输出）

```
# /tmp/m11/hooks.mjs 只有 12 行：给 ESM 加 ".ts" / "/index.ts" 后缀解析（等价于 vitest 的 resolve），不改任何行为
node --import /tmp/m11/hooks.mjs probe.mjs     # probe.mjs 内 import "/Users/liu/.../packages/core/src/index.ts"
```
下文"证据"均为该形态下的真实 stdout，已逐条贴出原文。1MB/深度基准在同一台机器、同一次会话内跑完。

---

## P0-1 `packages/core/src/model/constants.ts:19` 注释与 v2 裁定**相反**，指向一个已被取消的诊断码

```ts
/** 标题层级：相邻标题层级差 >1 视为跳级；`h1` 只允许出现在 `<article>` 之外。 */
```

`M1.2.md` v2 修订 #2 的原文是：「**h1 允许且只允许出现一次在 `<article>` 内**（`docs/02` 示例即此形态）；取消原 `heading_level_skip_root` 码，h1 进正文不诊断」。`docs/02:80-83` 的规范示例也是 `<article data-hr-id="root-article">` 内含 `<h1 data-hr-id="title-main">`。这条注释把裁定写反了。

- 证据（实现是对的，注释是错的）：`validateDocument` 对 `<article data-hr-id="r"><h1>t</h1><h2>s</h2></article>` → `[]`（h1 在 article 内不诊断）。
- 危害路径：下一个改 `checkHeading` 的人（M1.4/M1.5）读到"h1 只允许出现在 `<article>` 之外"，会把 `heading_level_skip_root` 重新加回来——这正是本卡 v2 明确取消的码。
- 定价依据：`docs/04` §2「过时注释（改了代码不改注释）**视为 P0**，因为它主动误导」。此处不是笔误级别的措辞，而是把一条**已被裁定的契约**写成了反面。
- 修复方向：删掉"之外"半句，改为「h1 在 `<article>` 内是规范形态，不诊断」。同时 `derive.ts` 无需改动（实现已正确）。

## P1-1 合并诊断不满足"文档顺序"（`packages/core/src/model/validate.ts:244-247`）

```ts
const derived = [...state.ordered, ...duplicateDiagnostics(state), ...articleDiagnostics(state)];
derived.sort((left, right) => left.order - right.order);
return dedupe([...parsed.diagnostics, ...derived.map((entry) => entry.diagnostic)]);
```

M1.1 的诊断被整体**前置**，模型诊断按文档序接在后面。两段各自有序，拼接后不再是文档序。

- 证据（misnested 在文档**末尾**）：
```
validateDocument(injectNodeIds(parseHtml(`<article data-hr-id="r"><p data-hr-id="dup">a</p><p data-hr-id="dup">b</p></article></div>`)))
→ [["misnested_tag","-"],["duplicate_id",">html[0]>body[0]>article[0]>p[0]"],["duplicate_id",">html[0]>body[0]>article[0]>p[1]"]]
```
`</div>` 是最后一个 token，却排在文档最前面的 `p[0]` 之前。
- 契约依据：`M1.2.md` 契约 2「`diagnostics` 顺序 = 文档顺序（稳定，测试会逐条比对）」。
- 结构性事实：M1.1 的 `Diagnostic` 只有 `code/severity/message/path?`，**没有可排序的位置字段**，所以"文档序"在本层无法靠排序复原。这不是实现偷懒，是契约与上游数据不匹配。
- 修复方向（二选一，需协调者裁定）：① 给 `Diagnostic` 加 `order?: number`（M1.1 在遍历时记账，最小改动是 `parse.ts` 的诊断带上字节偏移）；② 把契约降级为"M1.1 诊断（文档序）+ 模型诊断（文档序）两段拼接"，并写进 docs/02，测试按两段比对。
- 现状风险：测试员若按"逐条比对"写用例，这条会以"用例写错"的形式反复返工。

## P1-2 `validate.ts:17` 注释声称"按需拼接"，实测每个元素都付整条路径成本，深文档 O(n·depth)

```ts
/** 路径按需拼接：正常文档零诊断，不该为每个节点先付一遍整条路径的成本。 */
```
但 `validate.ts:140` 在 `enterElement` 里**无条件**执行 `const pathText = pathToString(current);`，而 `pathToString`（`validate.ts:60-70`）从当前节点一路走到根再 `reverse().join(">")`。

- 证据（同一份深文档，`derive` 与 `validate` 同一进程内分别计时）：
```
d=500   validate=   1.7ms  derive= 0.4ms
d=1000  validate=   6.6ms  derive= 0.5ms
d=2000  validate=  26.9ms  derive= 0.5ms
d=4000  validate=  91.5ms  derive= 0.9ms
```
validate 呈 4× / 4.1× / 3.4× 增长（二次方），derive 平坦。depth=4000 时两者差 **100 倍**，且差异全部来自这个函数。
- 为什么不判 P0：卡片契约 6 的两条硬指标都**实测通过**——1MB 文档 `toDocumentModel + validateDocument` 中位 **111.8ms**（≤200ms）；depth=4000 不溢出（91.5ms）。
- 修复方向：`pathToString` 只在 `record()` 前调用（`record` 已是唯一出口），或把 `PathNode` 换成惰性 `() => string`。改完顺便删掉那条注释，或把它改成真实的复杂度说明（`docs/04` §2 允许"性能/复杂度"类注释）。

## P1-3 诊断 `path` 格式与 M1.1 不一致，且模型侧多一个前导 `>`

- 证据（同一个 `<p>`，两个层各给一次路径）：
```
M1.1 inject（packages/core/src/html/inject.ts:131-132）: "html[0]>body[0]>article[0]>p[0]"
M1.2 validate（validate.ts:60-70，root 的 segment 是 ""）: ">html[0]>body[0]>article[0]>p[0]"
```
前导 `>` 来自 `pathToString` 把根占位节点（`segment: ""`）也 join 进去。
- 为什么是 P1 不是 P2：`path` 是诊断的公共字段，跨层消费者（M1.4 `hr_read_node`、M1.7 诊断面板）按 path 定位；两套格式意味着同一节点的诊断无法按 path 关联，`dedupe` 的 key 也含 path，跨层同码同位置的诊断不会被合并。
- 修复方向：`pathToString` 跳过 `segment === ""` 的根；并在 `html/constants.ts` 的 `Diagnostic` 注释里写明"path 形如 `html[0]>body[0]>...`"，让两层共用一条规则。

## P1-4 交付态 `pnpm verify` 红灯（归属测试员/G3，非实现面，但阻断提交）

```
$ pnpm verify
$ prettier --check .            → 通过
$ eslint . --max-warnings=0 ...
packages/core/tests/html-inject.test.ts
  35:34  error  Arrow function has too many lines (44). Maximum allowed is 40  max-lines-per-function
✖ 1 problem (1 error, 0 warnings)   exit 1
```
未跑到 typecheck/test:coverage/depcruise/knip。

- 归属：`packages/core/tests/**` 在本卡 `Out of scope` 内，是测试员为 article 注入新增的用例。
- 为什么仍然列出：卡片要求自证 `pnpm verify` 状态；红灯在**测试文件**里，实现方无法自行修复，需要协调者直接派给测试员。本次审计的实现结论不因它改变（下面 P0/P1 都是独立的实现面问题）。

---

## P2（7 条，不阻断，登记即可）

1. **`validate.ts:45/95/133/145/227/242` `insideArticle` 全链透传但从未被读**。`enterElement` 里 `const inside = insideArticle || node.tag === ARTICLE_TAG;` 之后只被塞回任务，`checkHeading`/`checkId` 都不看它。v2 取消 `heading_level_skip_root` 后它失去了唯一用途 → 死状态。证据：全文件仅 6 处出现，无 `if (insideArticle)` 分支。修复：删字段，`Task.enter` 少一个键。
2. **`packages/core/src/index.ts:8-9` 注释把审计编号写进产品代码**：「入口重复导出只会让"极小导出面"名存实亡（审计 P1-2）」。报告一旦归档/重命名，这行就指向不存在的文件；`docs/04` §2 也不允许这类流程引用。修复：删掉括号，保留结论。
3. **契约 3 的"入参"是否指 `ParsedHtml`，与 M1.5 裁定冲突**。实测 `ParsedHtml` 未冻结、可写：`Object.isFrozen(p)==false`，`p.root.children.push(...)` 成功。若按字面冻结入参，M1.5「Patch 作用在原始树上」立刻不成立。建议在契约里写明"仅模型冻结"。
4. **h1"只允许一次"没有落地**。`<article><h1>a</h1><p>x</p><h1>b</h1></article>` → 零诊断。v2 #2 的这半个条款既没有诊断码也无法校验（`h1→h1` 差值为 0）。需要裁定：删掉该措辞，或给 M1.4 加码。
5. **根 ID 是内容寻址的，改标题一个字就换根 ID**（M1.1 设计，本卡放大了它）。证据：
```
原文       ["hr-a7f2a133","hr-e809c94f",...]
改标题一字 ["hr-06675fff","hr-16cd6bfb",...]   ← 根 article id 变了
只改尾部   ["hr-a7f2a133","hr-e809c94f",...]   ← 根 id 不变
```
根 article 的种子含"子树前 64 字符"，所以 `DocumentModel.id` 会随开篇任意编辑变化。M1.5 按 id 打补丁时需要知道这一点（`docs/02:80` 的 `root-article` 字面量形态则不受影响——已有合法 ID 会被保留，实测 `Z1`）。
6. **解析器纠错补出的空块会拿到 ID 并进模型**。`<article data-hr-id="r"><p data-hr-id="p">a<div>b</div>c</p></article>` → 序列化后多出 `<p data-hr-id="hr-391cfca4"></p>`，模型里出现一个 `text: ""` 的 p 节点。这是 parse5 对游离 `</p>` 的标准纠错（不是实现 bug），但 M1.5 会看到这些空锚点。建议在 `docs/02` 记一句，不要在模型层过滤（过滤会让"每个 id 一个节点"的映射失效）。
7. **`derive.ts` 缺模块头**（文件第 1 行就是 `import`），而同目录 `attrs.ts:1`、`constants.ts:1`、`index.ts:1`、`validate.ts:1` 都有「这层管：…」一行。`docs/04` §2「每个模块文件顶部最多 3 行，说明负责什么/不负责什么」。补一行即可。另：`model/constants.ts:8` 的 `text` 注释写"不含块级后代的文本"，漏了 v2 #3 的"无 ID 块级后代折叠"这一半，建议补全。

---

## 已核对且**未发现问题**（同样都是跑出来的，不是读出来的）

### A. M1.1 回归（R0 改了 `inject.ts` + `constants.ts`，重点）
| 项 | 证据 |
| :-- | :-- |
| 确定性（两次/换 TZ/并行） | `J1 TZ 后一致 true`、`J2 并行一致 true`、`Z3 两次一致 true` |
| 已有合法 ID 原样保留 | `Z1 injected=[]`；`<article data-hr-id="root-article">` → 模型 `root.id="root-article"` |
| 冲突后缀仍可用 | 预占目标 ID 后 → `["hr-b1a8b7c6-2"]`（`Z2`） |
| article 自身进入注入清单 | `Z6 ["hr-7c0186c7",...]` 首位即 article；`H1` 4 个（article+section+2×p） |
| 嵌套 article 只注入最外层 | `H4 注入数=2`（外层 article + 内层 p，内层 article 无 ID） |
| 未闭合容错 | `<article><section><p>a` → 注入 3 个 + `["unclosed_tag","unclosed_tag"]` |
| 往返幂等 | 自造 11 个样本（`<p>` 省略闭合、`<pre>` 白空格、`DATA-HR-ID` 大写、重复属性、自闭合 `<br/>`、`&amp;/&#38;/&nbsp;`、`script/style`、游离 `</div>`）→ **11/11 幂等** |
| 非法 ID 改写 + 诊断 | `data-hr-id="BAD ID"` → `hr-faf0648f` + `invalid_hr_id`，path=`html[0]>body[0]>article[0]>p[0]` |

### B. 单棵树裁定（契约：模型是投影）
- `toDocumentModel` 无模块级状态；两次调用 `JSON.stringify` 深等、`m1 !== m2`、子数组不共享（`m1.children[0] !== m2.children[0]`）。
- 模型对象只有 `id/tag/text/children` 四个键，`Object.getPrototypeOf === Object.prototype`，**不含 parse5 的 `kind/children` 结构**。
- 入参未被改写：`S1 ParsedHtml 前后一致 true`。
- `structuredClone(M)` 成功且 `JSON` 深等。

### C. 冻结（契约 3）
- 递归遍历每个节点与每层 `children` 数组 → `{"ok":true,"bad":[]}`（深到底，含子节点）。
- `M.text = "hacked"` / `M.children.push({})` / `M.children[0].text = "x"` → **三处均抛 `TypeError`**（ESM 严格模式）。
- 1MB 上 `toDocumentModel` 含 freeze：`[12.2, 7.8, 7.8]ms`（开销可忽略）。

### D. `text` 语义（契约 1 + v2 #4）
| 样本 | 结果 |
| :-- | :-- |
| `<p>a<span>b</span></p><p>c</p>` | p1=`ab`、p2=`c`（内联按契约"拼接"，无空格） |
| `<p>a<br>b</p>` | `a b`（v2 #4 词边界 ✓） |
| `x\u00a0\u00a0y\u3000z\n\tt` | `x y z t`（NBSP/全角/换行/制表全部归一 ✓） |
| `<div><p>x</p><p>y</p></div>`（真·无 ID 块） | 折叠为 `x y`，不产生子节点（v2 #3 ✓） |
| `<p>head<table><tr><td>cell</td></tr></table>tail</p>` | `p.text="head tail"`，table 是 `p.children[0]`，cell 在 table 里 → **无重复计入** |
| `<div>a<section data-hr-id="s">b</section>c</div>` | article=`a c`、section=`b` → 位置正确、无重复 |
| `&lt;b&gt; &amp; &#38; &#x26;` | `<b> & & &`（已解码，契约 4 ✓） |

### E. 诊断（契约 2）
- `duplicate_id` 报**全部**位置：3 处 → 3 条，`p[0]/p[1]/p[2]`；`article` 与子节点撞 ID 也报 2 条。
- 顺序稳定：同文档两次调用数组**逐字节一致**（`U1 true`）。
- `heading_level_jump`：`h1→h2→h3` 不报、`h1→h3` 报、`h6→h2` 不报、首个即 `h3` 不报、两个相邻 section 各起 h2 不报、`h2` 后表格内 `h4` 报（跨容器仍算跳级）。
- 严重度：`duplicate_id/missing_article/multiple_article`=error、`heading_level_jump`=warning，与契约 2 一致。
- `missing_article`（0 个）落数组末尾（`order: Infinity`），无其它诊断时只有 1 条。

### F. 错误契约
| 输入 | 结果 |
| :-- | :-- |
| 0 个 article | `HrError code=invalid_document` |
| 2 个 article / 嵌套 article | 同上（消息指向"多个"） |
| 未注入（`<article>` 无 id） | `HrError code=invalid_document`，**不产出空串 ID** |
| 1 个 article 正常 | 正常返回，`validateDocument` 同输入给 `[]` |

### G. 性能（自己测）
| 指标 | 实测 | 门槛 |
| :-- | :-- | :-- |
| 1MB · `toDocumentModel+validateDocument` | **111.8ms**（137.1/111.8/97.3） | ≤200ms ✓ |
| 1MB · 干净文档诊断数 | **0** | 无噪音 ✓ |
| depth 4000 | 不溢出，91.5ms | 不溢出 ✓ |
| 20000 个 `<p>`（≈10 万节点） | validate 12.1ms / derive 5.4ms | 无 O(n²) ✓ |

### H. 代码形态（契约 7）
- 文件行数 36/27/166/5/247（≤400 ✓）；函数均 ≤40 行（`toDocumentModel` 18 行、`enterElement` 25 行）；复杂度无嵌套爆点。
- `grep -nE "\bas\b|\bany\b|!\\." src/model/*.ts` → **零命中**（连 `as const` 都没有）。
- 导出面：包门面只加 `toDocumentModel/validateDocument/DocumentModel`（`index.ts:6-7`），内部辅助（`attrs`/`constants`）未外泄；`model/index.ts` 三行门面 ✓ 两级制。

---

## 建议返工顺序
1. **P0-1**（一行改注释，5 秒）＋ **P1-4**（协调者转测试员，一行拆函数）。
2. **P1-3**（`pathToString` 跳根 + 统一格式，10 行内）→ 顺带解掉"跨层 path 无法关联"。
3. **P1-2**（惰性 path）→ 顺手删掉那条假注释。
4. **P1-1**（顺序）需协调者裁定契约形态，再改代码；在此之前先别让测试员按"逐条比对"写用例。
5. P2 收尾（1/2/7 是注释与死字段，半小时内可全清）。

## G2: FAIL
（P0-1 与 P1-1/P1-2/P1-3 均需在提交前处理；P1-4 归 G3）

ACP: 82.1K→61.8K · 11 blocks · delegate none

---

# R1 复审（G2-R · 只验上轮 6 项 + 回归）

复现环境：临时工作目录 `/tmp/m12r1`（不进仓库），用 `registerHooks` 直接以 ESM 加载
`packages/core/src/index.ts`，故所有数值均来自**真实导出**而非源码阅读。变异实验（见 §R1-7）
在一份带 `node_modules` 软链的源码副本上做，仓库文件未被改动。

## 逐条判定

| # | 上轮结论 | 本轮判定 | 关键证据 |
|---|---|---|---|
| 1 | P0-1 `constants.ts:19` 注释与 v2 #2 相反 | **CLOSED** | 见 §R1-1 |
| 2 | P1-3 `path` 多前导 `>`，与 M1.1 不同构 | **CLOSED** | 见 §R1-2 |
| 3 | P1-2 `validate.ts:17` 注释称"按需拼接"与实现不符 | **CLOSED** | 见 §R1-3 |
| 4 | P1-1 合并诊断不满足"文档顺序" | **CLOSED**（按 v3 #10 降级口径） | 见 §R1-4 |
| 5 | P2-2 `src/index.ts` 写了"审计 P1-2" | **CLOSED**（但同类残留 1 处，见 P2-R1） | 见 §R1-5 |
| 6 | 重复 ID 只报一处的风险（新形状 `Map<string, Occurrence[]>`） | **CLOSED** | 见 §R1-6 |

### R1-1 P0-1 CLOSED
`packages/core/src/model/constants.ts:19` 现为：「h1 在 `<article>` 内是规范形态，不诊断；跳级判定只看相邻标题的层级数字差 >1。」
- 全文断根：`grep -rn "skip_root\|只允许.*h1\|h1.*只允许\|heading_level_skip" packages/core/src/` → 无输出。
- 码表断根：`packages/core/src/html/constants.ts:136-148` 的 `DIAGNOSTIC_SEVERITY` 11 个键中含 `heading_level_jump: "warning"`，无 `heading_level_skip_root`。
- 行为复核：`<article data-hr-id="root"><h1>t</h1><h2>s</h2></article>` → `[]`；`h2→h4` → 1 条 `heading_level_jump`；`h3→h4→h1` → `[]`（向后不跳级，正确）。

### R1-2 P1-3 CLOSED（path 逐字同构）
同一元素在两层的 `path` 字符串比对（inject 侧取 `invalid_hr_id`、validate 侧取 `heading_level_jump`，同一节点）：
```
[E1 2层] inject=["html[0]>body[0]>article[0]>h4[0]"]           validate=同上  equal=true
[E1 3层] …>section[0]>div[0]>h4[0]                              equal=true
[E1 5层] …>section[0]>div[0]>ul[0]>li[0]>h4[0]                  equal=true
[E1 同名p] inject=['…>article[0]>p[0]','…>article[0]>p[1]']      validate 同值
[E5 文本/注释夹层] inject p[0] p[1] h4[0]；h4 path 与 validate 相同
[E14 未注入 vs 已注入] 'html[0]>body[0]>article[0]>section[0]>p[0]' === inject 同值
```
`validate.ts:68` 的跳根占位（`segment === ""`）是这轮的关键一行；`html[0]` 之前的 `>` 已不存在，两层逐字相等。

### R1-3 P1-2 CLOSED（注释已诚实，代码未被改坏）
`packages/core/src/model/validate.ts:17-21` 现为 `O(n·depth)` 说明 + 实测数字。自己复测（各 5–7 次取中位，`toDocumentModel` 与 `validateDocument` 分开计时）：
```
[E13 wide 6000 块] bytes=530748  validate=7.80ms   derive=4.96ms
[E13 wide 9000 块] bytes=797748  validate=10.75ms  derive=7.36ms
[E13 deep 4000]    bytes=122976  validate=95.46ms  derive=0.23ms
```
- 注释里的 `4000 深 97.2ms` 与本机 `95.46ms` 差 2%，可信。
- 注释里的 `430KB/6000 块 4.3ms` 与本机 `530KB/6000 块 7.80ms` 不同（字节数不同、机器不同），量级一致，**不判失实**；关键是"O(n·depth) 上限 + 仍在门禁内"这个断言被复算证实（1MB 级 `validate+derive` 共 18.1ms ≪ 200ms）。
- 代码仍是 eager 路径（`validate.ts:147` 对每个元素调 `pathToString`），与注释描述的"每个元素都拼一次"一致；未被改成惰性路径，也没有因此引入 bug（§R1-7 回归全绿佐证）。

### R1-4 P1-1 CLOSED（按 v3 #10 的两段拼接口径）
- 两段拼接真实形态（M1.1 诊断在文档后位、模型诊断在前位时仍不跨段排序）：
```
[E10] misnested_tag(无 path) , misnested_tag , duplicate_id@…article[0]>p[0] , duplicate_id@…p[1]
      code 序列 = misnested_tag,misnested_tag,duplicate_id,duplicate_id
```
- 无 `order` 泄漏到公开类型：`Object.keys(diag)` 恒为 `code+severity+message+path`；`JSON.stringify(diagnostics)` 中 `"order"` 出现 0 次；`html/constants.ts:150-156` 的 `Diagnostic` 仍为 5 字段。
- **dedupe 误合并风险（本轮重点，未发现）**：8 份文档逐条检查 `code|path|message` 三元组重复与 `code|path` 撞车：
```
[E15 #0..#7] 重复三元组均为 []；唯一的"同 code+path 双条"是
             misnested_tag|| 两条（不同文案）—— 这是 M1.1 balance 不产 path 的既有形态，
             dedupe 因 message 不同而**正确地没有合并**，语义上是两条独立问题。
```
  → `dedupe`（`validate.ts:227-238`）用 `code|path|message` 作键，在"拼接策略"下不会把两条独立诊断吞成一条；同时也不会双重上报（`invalid_hr_id` 实测 1 条，未出现 inject+validate 各报一次）。
- 遗留说明（不计入 finding）：M1.1 段里 `balance` 产生的诊断没有 `path`，所以"跨层关联"在 M1.1 侧仍做不到；这已在 v3 #10 裁定接受，非本轮引入。

### R1-5 P2-2 CLOSED
`grep -rn "审计\|P0-\|P1-\|P2-\|finding\|reports/" packages/*/src/` → 无输出（rc=0 但零匹配）。
`src/index.ts:8-9` 现为结论式注释（"入口重复导出只会让极小导出面名存实亡"），不含流程编号。

### R1-6 新形状（`duplicateDiagnostics` → `Map<string, Occurrence[]>`）CLOSED
```
[E2 3 处分布在不同父下] count=3
   error | html[0]>body[0]>article[0]>p[0]              | data-hr-id="dup" 重复出现（共 3 处）
   error | html[0]>body[0]>article[0]>div[0]>p[0]       | 同上
   error | html[0]>body[0]>article[0]>section[0]>p[0]   | 同上
```
- 3 处全报、文案带总数"共 3 处"、顺序 = 文档序（`result.sort` 生效：三个分支的文档序被正确还原）。
- 2 处（同父相邻 `/…>p[0]`、`/…>p[1]`）、跨 article（`article[0]>p[0]` + `article[1]`）、含 article 自身共享 id 三种形态亦复核通过，`severity` 均为 `error`。
- 段内顺序与文档序一致：`[E6 B]` 真实文档输出 `heading_level_jump@…h4[0] , duplicate_id@…p[0] , duplicate_id@…div[0]`。

### R1-7 回归（自己跑，不引用测试员）
```
$ pnpm verify   → EXIT=0
  Test Files  20 passed (20)      Tests  300 passed (300)
  coverage: src / src/html / src/model 全部 100 | 100 | 100 | 100
  depcruise: ✔ no dependency violations found (43 modules, 108 dependencies cruised)
  knip --strict: 通过
```
真实文档抽查（不只看计数）：
- 文档 A（h1+section+ul+blockquote，规范形态）→ **0 条诊断**；模型根 `root-article`，`children` 4。
- 文档 B（h1 后直接 h4、`dup` 在 p 与 div 各一次）→ 3 条：`heading_level_jump`(h4) + 2 条 `duplicate_id`，顺序为文档序，无多余告警。
→ 无"fix 完但语义变了"的迹象。M1.1 的 219 例仍在 300 例内全绿。

## R1-8 测试有效性反向验证（覆盖率 100% 是否被规避换来）
在源码副本上做 3 处变异，复跑 `packages/core/tests/model-validate.test.ts`（基线 17 passed）：
```
M1 duplicateDiagnostics 只发首处（group → group.slice(0,1)）→ 4 failed
   含 "should report every occurrence of a repeated id, with its own path"
M2 跳级判据 > 1 改成 > 0                                → 1 failed
   含 "should stay quiet for h2 followed by h3 and for repeated h2"
M3 pathToString 加前导 ">"                              → 6 failed
   含 "should give one element byte-identical paths in both layers"
复原后 → 17 passed
```
→ 三条新增用例都**真的断言行为**（码/路径/文案/严重度），不是"执行到即过"；覆盖率 100% 不是测试规避换来的。

## 新增 P2（2 条，不阻断提交）

1. **P2-R1 `packages/core/src/model/validate.ts:168-172` 注释里仍带流程编号与覆盖率备注**：
   「两臂都可到：单次出现的 id 走 `groups` 直取、早就有的 id 走 `push`」「跨段顺序仍是 v3 #10 的…」。
   `v3 #10` 是卡片修订号、`两臂都可到` 是覆盖率备注，两者都属于"产品代码引用内部流程"（与上轮 P2-2 同类，规则见 `docs/04` §2）。
   修复方向：改为一句行为描述（"同 id 先归组，只为 ≥2 的组逐条发诊断，组内按文档序"），删掉修订号与"两臂"表述。

2. **P2-R2 `packages/core/src/model/validate.ts:49,95,102,140,152,160,162,165` 的 `insideArticle` 是死管线**：
   v2 #2 取消 `heading_level_skip_root` 之后，没有任何分支读取它——只被 `:152` 用来算 `inside`，再原样塞进 `Task`（`:102`）。
   `eslint`/`knip` 都不会报（参数被"使用"了），但它让 `enterElement`/`enterNode`/`pushChildren` 各多一个参数，是本轮改动留下可读性税。
   修复方向：删 `Task.insideArticle`、`inside` 局部量与三个函数的该参数（约 8 行）。

登记（非本轮范围，不计数）：`packages/core/src/model/derive.ts:1` 无模块头注释（同目录 `constants.ts:1`/`validate.ts:1`/`index.ts:1` 都有），契约 7 的"模块头 ≤3 行"应对齐；M1.3 顺手补即可。

## G2-R: PASS
（上轮 6 项全部 CLOSED；本轮新增仅 2 条 P2，无 P0/P1。M1.2 可提交。）

ACP: 75.2K / 10% · 12 blocks · delegate none
