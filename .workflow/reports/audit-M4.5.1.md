# 审计报告 M4.5.1（G2，审计员 fea68fda）

## Review

**判定：PASS WITH NOTES。** D1 五条实现正确、D2 删净、D3 真正同源、D4 真独立、契约（pages 算法 / 错误码闭集 / exit 3 / 不落盘）均未回归；无 BLOCKER、无 P1，仅有若干 P2/NOTE 级的健壮性与文档一致性提醒。

### 逐条必查结论

1. **D1 五条（`packages/cli/src/pdf/bookmarks.ts`）—— 全部成立**
   - `/Outlines` 缺键 → `0`：`bookmarks.ts:87-89`（`outlinesId === undefined` 直接 `return 0`，与 `--no-outline`/无标题同路）。✓
   - 从 `/First` DFS 同时跟 `/Next` 与 `/First`：`countItemsOf` `bookmarks.ts:52-63`，`count += 1 + countItemsOf(...refOf(d,b"First"))` 后 `currentId = refOf(d,"Next")`。✓
   - `/Count` 存在才核对且取 `Math.abs`：`bookmarks.ts:90-96`，`declared !== undefined && Math.abs(declared) !== walked`。✓
   - 断链/非字典/无 trailer/无 `/Root` → `render_empty` 绝不回退 0：`trailerOf`(`:42-47`)、`dictionaryOf`(`:31-39` 非 `<<` 抛错)、`refOf` 无匹配→`catalogId undefined`→`failOf("trailer 里没有 /Root")`、条目 `dictionaryOf` 缺对象→抛。✓
   - 环检测防自环与互引：共享 `seen: Set<number>`（`:68`、`:72` `if (seen.has(id)) throw`），对 `/First` 递归与 `/Next` 链统一生效，`OUTLINE_SELF_LOOP` 单测钉了自环，互引机制同一路径覆盖。✓

2. **marker 定位脆弱面 —— 对 Chrome 目标安全，但对非本形态输入不安全**
   - `trailerOf` 用 `trailer\s*<<([\s\S]*?)>>` 取**最后一个** trailer（`:42-47`），`/Root` 只在 trailer 文本内用 `refOf` 找，不会命中流内字节或注释；风险面仅在"流里出现字面量 `trailer`"或"对象体里出现字面量 `endobj`"（`OBJECT` 正则 `:14` 全文字面扫描），Chrome 产物流被压缩，实际不命中，写者 §5 已自陈。
   - **不解析 `/Length`、不认流边界是否安全**：安全，**因为不变量是"只读目录/大纲这类普通字典对象，从不读流对象的内容"**。目录对象、`/Outlines` 根、条目字典在 Chrome 产物里都是未压缩普通字典，其 `endobj` 之前不会有裸 `endobj` 字节。真正不安全的只是"某流对象内容里含 `N 0 obj … endobj` 恰好与大纲对象号撞号"这种合谋，概率极低且 Chrome 不产生——因此对目标安全，但不构成通用解析器能力（见 P2-1）。

3. **D2 —— 删净，无假绿**
   - `grep -rn "pdfHeadingsOf\|headingsOf\|HEADING_TAGS\|近似值" packages/cli/src` → 空（实测 exit 1）。仅测试 `pdf-outline-e2e.test.ts` 保留了同名局部 `HEADING_TAGS`（用于打印稿 heading 文本，非 src）。✓
   - `productPdfOf` 收缩为只返 `Uint8Array`（`commands/pdf.ts:78-91`），仍把 `product.html` 交给 render，**语义无丢失**——`bytes`/`pages` 与 html 无关，只有"从 html 数 heading"这条被删除。✓

4. **D3 —— 真同源，键集顺序未变**
   - `humanPdf` 用 `report.outline`，`dataPdf` 也用 `report.outline`，同一 `PdfReport` 对象（`commands/pdf.ts:113-120`），`outline` 均来自 `bookmarkCountOf(bytes)`。✓
   - `dataPdf` 未改动，键序测试仍断言 `["pdf","bytes","pages","outline","out"]`（`pdf-command.test.ts:82-98`）。✓

5. **D4 —— 测试侧与 src 实现层真独立**
   - `tests/helpers/pdf-scan.ts` 独立解码 `/Title`、校验 `/Parent`、`/Dest`→页序；`src/pdf/bookmarks.ts` 只数数、不碰 `/Title`/`/Dest`，未互相 re-export。✓
   - 两处都写了"独立 oracle"理由：`src/pdf/bookmarks.ts:1-5`、`tests/helpers/pdf-scan.ts:1-7`、`tests/pdf-bookmarks.test.ts:1-5`。✓

6. **测试自证 / 无退化假绿**
   - 14 例每条都对应 `bookmarks.ts` 的具体分支，变异清单全部能变红（见下节）。
   - `chrome-helpers.ts` 的 `pdfOf` 改结构自洽（`tests/chrome-helpers.ts:18-33`）后，**没有**把既有用例从"真证据"退化为自造假绿：唯一被改弱的是 `pdf-command.test.ts:106-113` 人读行从"`statSync(out).size` bytes"改成硬编码字符串，但**同一文件** `pdf-command.test.ts:95-101` 仍用 `statSync(out).size`/`readFileSync(out)` 断言 bytes 与 base64 一致性，字节证据未丢。✓

7. **契约回归 —— 未回归**
   - `pages` 算法未动（`PDF_PAGE` 正则 `commands/pdf.ts:50`、`pdfPagesOf:53-54` 与旧完全一致）。✓
   - 错误码闭集未扩：新错误全用既有 `render_empty`（`hr-error.ts:45` 已在闭集，`exit-codes.ts:49` → `EXIT_IO`=exit 3）。✓
   - exit 3 与不落盘仍在：`assertPdfOf` → `bookmarkCountOf`（`commands/pdf.ts:100-105`）均在 `writeOutOf`（`:106-111`）之前，抛错即不写；`pdf-command-outline.test.ts` 的"不落盘"用例钉住。✓

8. **可读性/风格 —— 良好，一处可加固**
   - 注释基本只解释"签名看不出来的东西"（如 `refOf` 为何只认引用、`/Count` 为何取绝对值、`seen` 存在理由），**未见逐行复述代码**的注释。
   - 参数/返回值无裸类型：`bookmarkCountOf(bytes: Uint8Array): number`、`countItemsOf(context: ItemsContext, firstId: number | undefined): number` 等均已标注。✓
   - 模块边界"规整漂亮"到可能诱人误用——但 `bookmarks.ts` 头部注释**没有**像 `pdf-scan.ts` 那样明写"不是通用 PDF 解析器 / 只认 Chrome 经典 xref+trailer 形态"（见 P2-1）。

9. **已知四洞判读**
   - `/Dest` 间接（`/A` 动作、命名目的地、`/Parent` 回边）：**不影响 `bookmarkCountOf`**——它根本不读 `/Dest`，只数 `/First`/`/Next`。该洞只影响测试侧 `pdf-scan.ts` 的页序还原，而 Chrome 写直接 `/Dest`。→ 可接受。
   - `/Names` 式大纲：Catalog 无 `/Outlines` 键 → 归入"没开大纲"返回 `0`。**代码符合 D1.2 契约**（无键=0），但**与写者 §5 自述"不会静默 0"矛盾**（见 NOTE-1）。
   - 早期 trailer 才权威 / 最新 trailer 经 `/Prev` 继承 `/Root`：Chrome 单次产物无增量更新，"最后一个 trailer"即权威，安全；但通用增量 PDF 若最新 trailer 省 `/Root` 只带 `/Prev`，会抛 `trailer 里没有 /Root`（见 NOTE-2）。
   - 对象体含字面量 `endobj` 的流对象：被当非字典 → `render_empty` 而非误读，符合"宁可抛错不回退 0"取向。→ 可接受。

---

### 分档清单（现象 → 文件:行号 → 定档理由 → 建议）

**P2-1** 模块边界易被误当通用 PDF 解析器。
`packages/cli/src/pdf/bookmarks.ts:1-5` 头部注释只写"从 PDF 产物字节数大纲；只读纯函数"，缺 `pdf-scan.ts:8` 那句"不是通用 PDF 解析器 / 只认 Chrome 经典 xref+trailer 形态"的显式免责。它确实不处理 ObjStm、xref 流、`/Names` 大纲、非零 generation、`/Prev` 链。→ 建议：头部补一行"只认 Chrome 产物的经典 xref+trailer 形态，不是通用 PDF 解析器"。

**P2-2** `refOf` 硬性要求 `0 R`（generation 必须为 0）。
`bookmarks.ts:26-29` 正则 `\s+(\d+)\s+0\s+R`；合法增量 PDF 复用对象时可能出现 `/Root 68 2 R`，会被判成"没有 `/Root`"而 `render_empty`。Chrome 单产物 gen 恒 0，当前不受影响。→ 建议：注释显式声明"只支持 generation 0"，或正则放宽为 `(\d+)\s+(\d+)\s+R` 后取首数。

**NOTE-1** 写者 §5 自述"`/Names` 式大纲遇到会报错、不会静默 0"与实现不符：无 `/Outlines` 键即返回 0（`bookmarks.ts:87-89`）。代码本身合规，是可核查文档不一致。→ 建议：把 §5 改为"`/Names` 式大纲会按无 `/Outlines` 键返回 0"。

**NOTE-2** "最新 trailer 权威"成立的前提是"最新 trailer 自带 `/Root`"。增量 PDF 最新 trailer 仅靠 `/Prev` 继承 `/Root` 时会误抛。属目标外，但值得在 `trailerOf` 注释点明假设。

**NOTE-3** D1.5 列举的"`/Kids`/`/Pages` 混淆"未被显式识别：`bookmarks.ts` 对任何 `<<…>>` 体都照 `/First`/`/Next` 读；若条目指向页树节点，只有 `/Count` 存在时靠交叉核对间接抛错，无 `/Count` 时会静默多计。→ 建议：可在 `dictionaryOf` 里对条目拒绝含 `/Type /Pages` 的体，或至少注释说明靠 `/Count` 兜底。

**NOTE-4** e2e `expectCountOf` 的 `/Count` 兜底写法有脆弱性：`packages/cli/tests/pdf-outline-e2e.test.ts:126` `expect(Math.abs(scan.outlineCount ?? 0)).toBe(walked)`——若 Chrome 哪版本省了根 `/Count`，会以 `0 === walked` 失败，报错理由误导。建议先 `expect(scan.outlineCount).toBeDefined()` 再比。

---

### 变异清单实测（§5 八条）

| # | 变异 | 能否红 | 为什么 |
|---|------|--------|--------|
| 1 | `/Count` 恒当答案（不实走） | **能红** | `OUTLINE_COUNT_LIE`（`/Count 3` 实走 2）期望 `render_empty`；直接返回 3 不抛 → `pdf-bookmarks.test.ts:86-91` 红 |
| 2 | 实走不跟 `/Next` | **能红** | `OUTLINE_TWO_SIBLINGS`/`NESTED` 走走得 1，触 `/Count` 交叉核对抛错；`countOf(...).toBe(2)` 因抛错失败（`pdf-bookmarks.test.ts:60-62`） |
| 3 | 不跟 `/First`（只数第一层） | **能红** | `NESTED` 只数顶层得 1，`/Count 4` 不符抛错；`toBe(4)`（`:55-57`）红 |
| 4 | 交叉核对删掉 | **能红** | 无核对时 `OUTLINE_COUNT_LIE` 返回 2 而非抛 `render_empty`（`:86-91`）红 |
| 5 | 断链改成返回 0 | **能红** | `OUTLINE_BROKEN_FIRST`/`OUTLINE_NOT_A_DICTIONARY` 期望 `render_empty`，返回 0 则 `expectParseFailureOf` 抛"预期抛 HrError"红（`:94-107`） |
| 6 | `/Outlines` 键判断写成"总有" | **能红** | 无键时不判 undefined 会 `objects.get(undefined)`→抛或误读；"Catalog 没有 `/Outlines` 键时是 0" `:45-47` 红 |
| 7 | 人读行 `M` 恒 0 | **能红** | `pdf-command-outline.test.ts:203-211` 期望 `2 条书签`；恒 0 则红 |
| 8 | `/Info` 的 `/Title` 被算进去 | **能红** | `bytesWithInfoOf` 用例期望 `1`，数 `/Title` 得 2（条目 1 + Info 1）→ `:79-81` 红 |

结论：**8 条全部可红**，无一条被夹具自洽性掩盖。

---

### 我认为最可能在未来咬人的一处

**`bookmarkCountOf` 的 `/Count` 强一致交叉核对（`bookmarks.ts:90-96`）会把"产物元数据轻微不等"升级为整条 `hr pdf` 硬失败（exit 3、不落盘），而它对真实 Chrome 只在可跳过的 e2e 里被验证。**

理由：单测里所有 `/Count` 都是手写、与实走**刻意相等**，真正验证"Chrome 对**嵌套**大纲写出的根 `/Count` 是否恰等于形走总数"的只有 `pdf-outline-e2e.test.ts`，而它在无 Chrome 环境下 `skipIf` 静默跳过（`pdf-outline-e2e.test.ts:154`）。一旦 Chrome 某版本对嵌套/折叠大纲的根 `/Count` 口径变化（少 1、只计顶层展开项等），`bookmarkCountOf` 会在正常文档上抛 `render_empty`，用户侧表现为"整份 PDF 生成失败"，而 CI 若未装 Chrome 则全程绿——正是"最难查的假绿"的另一面。卡面明确要求"不许静默取其中一个"，所以这是按契约实现，但残余风险最高：建议在 `render_empty` 文案里对 `/Count` 不符额外提示"可能是渲染器版本差异"，并确保 CI 有真 Chrome 跑那条 e2e，别让它长期 skip。

---

**Merge verdict: OK with notes.**