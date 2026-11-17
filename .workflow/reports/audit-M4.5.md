# M4.5 G2 审计报告（审计员，2026-11-17）

> 由协调者代录：审计员环境无写工具，原文见 subagent artifact。

## 结论

**PASS WITH NOTES**（F1 实现本身无 BLOCKER；卡 §5 强制的 8 条变异全部“能红”。P1 全是**测试网洞**，属 G3 e2e / 补测的责任，不是 F1 代码缺陷）

依据：`git diff --stat` 只动 `packages/cli/**` + `.workflow/state.md`；非目标 1/3/6 全部满足；D1/D3/A1/A7/A10/键集/A5 全部满足。

## BLOCKER

无。

## P1

1. **MV-11「`/Kids` 中间 `/Type /Pages` 节点被当叶子或追加到末尾」现有测试不会红。**
   证据：`packages/cli/tests/helpers/pdf-fixtures.ts` 的 `pagesOf` 只造 `Pages(2) → Page` 一层扁平树（无中间 `/Pages`），`pdf-scan.test.ts` 三份夹具全是扁平页树。`pdf-scan.ts` 的 `pageOrderOf`（`in-place` 递归）实现正确，但**没有任何用例喂过“Pages → Pages → Page”三层页树**，把递归改成“只摊一层/追加到末尾”时无断言失败。→ spec-M4.5 §2「必须原地展开中间节点」的判据缺失。
2. **「按对象号排序而非 `/Kids` 顺序」的变异不会红（spec §2 要求的“反序 `/Kids`”夹具缺失）。**
   证据：`pdf-fixtures.ts` 的 `pagesOf(n)` 生成的 `/Kids` 顺序恒等于对象号升序（3,4,5…）。卡 §5 的 MV「`/Kids` 顺序反转」本身能红（反序收集会让 `pdf-scan.test.ts:12` 的 `[3,4]`→`[4,3]` 失败），但**“`/Kids` 顺序与对象号顺序相反”的夹具没有**，因此“把 kids 按对象号排序”这种更隐蔽的变异全绿。
3. **MV-16「空白正常化退化成 `trim()`」在单元层完全无判据。**
   证据：全仓新增测试无任何 `normalizeWhitespace` 调用（`grep` 无命中）；AC-5 的标题序列 oracle 只有 e2e（`pdf-scan` 只解 `/Title`，不做空白归一），而 `pdf-outline-e2e.test.ts` **尚未在树内**。→ 必须确保 G3 的 AC-5 oracle 真的用 `normalizeWhitespace`（`packages/core/src/html/text.ts:45`），否则该变异存活。

## P2

1. **`decodeHexOf` 把“无 BOM 的 hex 串”也按 UTF-16BE 解**（`packages/cli/tests/helpers/pdf-scan.ts` `decodeHexOf`，`start = bytes[0]===0xFE&&bytes[1]===0xFF ? 2 : 0`，随后恒按双字节读）。spec A11 建议无 BOM 走 PDFDocEncoding/ASCII 直通；此点未进卡 §7 硬裁定，且 Chrome 对 ASCII 用字面串，实际低风险。**注**：`?? 0` 仅用于越界取字节，非语义回退，A10 不受影响。
2. **`pageOrderOf` 对“既非 `/Pages` 又非 `/Page`”的 kid 直接当页码返回**（`pdf-scan.ts` 的 `if (kids === null) return [id]`），未按 spec §2 step3「else: fail 未知子节点」抛错。真实 Chrome 页树只有这两种 kid，无假绿风险；属 helper 宽容度偏高。
3. **命令层互斥用例对 MV-18 偏弱**：`pdf-command-outline.test.ts:130-137` 的 conflict 用例用假 render，若把互斥校验挪到渲染之后（MV-18），该用例仍会绿（假 render 立即返回、throw 前未写盘）。真正拦住 MV-18 的是 `units-run-paths.test.ts` 的 run 级用例（无 Chrome → 会变 `chrome_missing`/exit 3 而红）。命令层想独立兜住，需断言“渲染回调未被调用”（类似 `png-command.test.ts:194` 用 reject 的 render）。
4. **MV-3 若只在 `chrome/session.ts` 塞 `outline ?? true`（字段改可选），无行为测试直接捕获**：只能靠 `chrome-cdp.test.ts:106` 的 `printParamsOf.length === 2`（若改在 `cdp.ts`）或 AC-8 的 perFile 覆盖率（nullish 分支未覆盖）间接兜。交付代码本身 D1 合格（见“正确”）。
5. 夹具 `/Size 99` 与 `startxref 0000` 不是真 xref 一致值（`pdf-fixtures.ts` `trailerOf`）。对扫描器夹具无影响（`pdf-scan` 不读 xref），但过不了 qpdf 之类严格校验；建议注释注明“仅测扫描器、非严格合法 PDF”。
6. `humanPdf` 不打印 `outline`（`packages/cli/src/output.ts` `humanPdf` 未改）——卡未要求，仅报告不一致。
7. 卡 §6「允许改动的文件」清单已过时：点名了不存在的 `chrome/pdf.ts`，实际接缝是 `chrome/cdp.ts:36`；实际还改了 `chrome/session.ts`、`args-png.ts`、`commands/png.ts`、`intent.ts`、`output.ts`、`run.ts`、`tokens.ts`、`usage.ts`。均不在**禁止**清单内。

## 必查清单结论（证据行）

| # | 结论 | 证据 |
|---|---|---|
| 1 D1 显式传/无默认值 | 通过 | `packages/cli/src/chrome/cdp.ts:36` `printParamsOf(pageSize, outline)` 第二参**必填**；`:48` `generateDocumentOutline: outline`；全仓仅此一处赋值，无 `?? true`/`Boolean()`；命令层唯一决定点 `commands/pdf.ts:105-110` |
| 2 D3 单测可见 | 通过（非 e2e） | `packages/cli/tests/chrome-cdp.test.ts:110-146` 解析 `responder.sent` 里的 `Page.printToPDF` 报文，断言 `params.generateDocumentOutline === true/false`（报文级，非仅入参对象）；`:96-106` 另钉 `printParamsOf` 直取、`false` 时键存在、`length===2` |
| 3 A1/A14 数元素 | 通过 | `commands/pdf.ts:59-70` `headingsOf` 递归 `parseHtml(product.html).root` 的 `element.tag ∈ h1..h6`，非正则、非 `buildOutline`；`pdf-command-outline.test.ts:142-159` 钉 h7/h1x/注释/转义文本不算、6 层嵌套全算（A14） |
| 4 非目标 3 renderer-html 零改动 | 通过 | `watchdog_diff --stat` 22 文件全在 `packages/cli/**`+.workflow，**无 `packages/renderer-html/**`**；`OUTLINE_DEPTH_LIMIT` 未动 |
| 5 非目标 1 无新依赖/无自写 PDF 增量 | 通过 | diff 无 `package.json`/`pnpm-lock.yaml`；`pdf-scan.ts` 只读，仅测试用 |
| 6 错误码零新增 | 通过 | diff 无 `packages/core/src/hr-error.ts`；只用既有 `invalid_input`（`exit-codes.ts:20` → `EXIT_FAILURE=1`） |
| 7 A7 png 对称 | 通过 | `commands/png.ts:93-96` 单条 `if (input.outlineFlag !== undefined) throw invalid_input`，两旗标同一路径（`args-png.ts:40` `OUTLINE_FLAGS.find` 取首个命中）；`png-command.test.ts:194` `it.each(["--outline","--no-outline"])` 双向覆盖 + `existsSync(out)===false`（先于任何落盘/渲染） |
| 8 A10 pdf-scan 无回退死分支 | 通过 | `pdf-scan.ts` `pageRefOf` 缺 `/Dest`/首元素非 ref 均 `throw`；`itemsOf` dest 页不在 `/Kids` 直接 `throw`；`titleOf` 缺 `/Title` `throw`；无 `?? 0` 语义回退、无 `catch` 吞错 |
| 9 夹具只 tests + 字节可走通 | 通过（附 P2-5） | `grep pdf-scan/pdfScanOf` 在 `packages/cli/src` 无命中；手工推演：`trailer /Root 1 0 R`→obj1 Catalog（`withOutlinesOf` 挂 `/Outlines 10 0 R`）→`/Pages 2 0 R`→`/Kids [3 0 R …]`→obj3+ `Page`；SINGLE(10→11)、NESTED(10→11→{12→14,13}，`/Parent`/`/Next` 自洽) 均可走通 |
| 10 类型/注释 | 通过 | 返回均为 `CdpParams`(`Readonly<Record<string,unknown>>`) 或显式 `PdfScan`/`PdfOutlineNode`；`HtmlNode=ReturnType<typeof parseHtml>["root"]` 为派生类型非含糊；无“复述型”注释（如注释均解释取舍，非“把 outline 设成 true”） |
| 11 键集顺序/数值 | 通过 | `output.ts` `dataPdf` 输出 `pdf,bytes,pages,outline,out` 顺序；`pdf-command.test.ts:81-94` `keysOf` 顺序钉死；`pdf-command-outline.test.ts:63` 无 heading `toStrictEqual(0)`（数字非 `"0"`/`null`） |
| 12 A5 `--no-outline --force` | 通过 | `pdf-command-outline.test.ts:112-121` 覆盖已存在文件、重写成功、`outline===0` |
| 13 usage/help 一致性 | 通过 | `usage.ts:37` synopsis 加 `[--no-outline]`；`:101-104` 正文明写 `--outline`「默认开；h1–h6 成树」与 `--no-outline`「与 --outline 不可同传」，与实现/AC 一致 |
| 14 变异存活 | 见下 | 卡 §5 强制 8 条**全红**；spec 扩展 MV 的存活项见 P1 |

## 变异存活表（对照 spec §4 MV-1…MV-21，针对**当前树内测试**）

- **会红（已覆盖）**：MV-1 (`chrome-cdp.test.ts:96`)、MV-2 (`:97`)、MV-3-@cdp (`:106` length)、MV-4 (`args-pdf.test.ts:68`)、MV-5 (`pdf-command-outline.test.ts:57`)、MV-6 (`:57` 2≠4)、MV-7 (`png-command.test.ts:194`+run 级)、MV-8 反转 (`pdf-scan.test.ts:12`)、MV-9 (`args-pdf.test.ts:62`)、MV-10 (`pdf-scan.test.ts` FEFF 中文)、MV-12 (`NESTED` 兄弟靠 `/Next`)、MV-13 (中文/全角解码)、MV-14 (`pdfHeadingsOf` 只算 h1→3 变 1)、MV-15 (6 层嵌套→buildOutline 丢 h5/h6)、MV-17 (`args-pdf.test.ts:75`)、MV-18 (run 级 `units-run-paths.test.ts`)、MV-19 (`toBe(true)` 严格)、MV-20 (`pdf-command-outline.test.ts:63` 键存在)、MV-21 (`args-pdf/args-png` okOf 先红 `未知参数`)。
- **不会红（存活，= P1）**：**MV-11**（无三层 `/Pages` 夹具）；**“按对象号排序而非 `/Kids` 顺序”**（无 `/Kids` 反序夹具）；**MV-16**（单元层无 `normalizeWhitespace`/AC-5 oracle，待 G3 e2e）。
- **间接/依赖覆盖（P2）**：MV-3 若只在 `session.ts` 加 `?? true`（靠覆盖率/`length` 兜，无行为测试）；MV-18 命令层用例偏弱（靠 run 级兜）。

## 必须返工的当场证据

- **无 P0。** 以下为“G3 / 补测必须落地”的返工输入（当前树内缺，非 F1 代码错）：
  - 缺嵌套 `/Pages` 中间节点夹具 → `packages/cli/tests/helpers/pdf-fixtures.ts` 需增一份 `Pages→Pages→Page` 手写字节并在 `pdf-scan.test.ts` 断言“原地展开顺序”。复现 MV-11：把 `pdf-scan.ts` `pageOrderOf` 改成“只摊一层”，现有用例全绿。
  - 缺“`/Kids` 顺序 ≠ 对象号顺序”片段 → 同上文件增一份反序字节，断言页序跟 `/Kids`。复现：把 kids 排序改成按对象号，现有用例全绿。
  - AC-5 空白归一（MV-16）与 AC-1/2/4/6 产物结构全部依赖尚不存在的 `pdf-outline-e2e.test.ts` → G3 必须交付，且 oracle 必须用 `normalizeWhitespace`（`packages/core/src/html/text.ts:45`）、不做 NFC/NFKC。
- **须由协调者在审计后跑（本环境无法执行 shell）**：`pnpm verify`（AC-8，连跑两遍，核 257→ 文件数、2857→ 用例数只增不减、四维 perFile 100%），以及 G3 的真 Chrome e2e（AC-1/2/5/6/7）。F1 的单元层绿不等价于产物契约绿。