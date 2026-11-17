# M4.5 G3 测试报告：真机 + 敌意输入 + 变异（2026-11-17）

> 测试对象：M4.5 工作树（`--outline` / `--no-outline` / `--json.outline` / `pdf-scan.ts`）
> 环境：macOS 15.7，Node 24.15，Google Chrome 157.0.8103.79（真机，非 mock）
> 结论：**AC-1…AC-8 全通过**；变异 21 条全部“能红”（19 条套件内红，1 条由真机顺序检查红，1 条等价变异）；发现 1 处 P2 口径风险（`display:none` 标题）与 2 处 P3 建议，均不构成 F1 返工。

## 1. 真机基线矩阵（`--json` + 结构扫描双侧）

扫描器：`packages/cli/tests/helpers/pdf-scan.ts`（经 `/tmp/m45/scan.mjs` 调用，只读）。

| 文档 | pages | report.outline | 扫描 items | `/Outlines` 键 | 根 `/Type /Outlines` | 标题序列 |
| --- | --- | --- | --- | --- | --- | --- |
| multi（4 章 7 标题，含中文/全角/`&<>"`） | 4 | 7 | 7 | 有 | 有 | `1 Chapter One` / `1.1 Section One` / `1.2 连续 空白` / `1.2.1 （ＡＢＣ） &<>" tail` / `1.2.1.1 Deep Four` / `2 Chapter Two` / `2.1 Section Two` |
| single（单章） | 3 | 2 | 2 | 有 | 有 | `1 Only Chapter` / `1.1 Only Section` |
| deep（h1–h6 六层） | 3 | 6 | 6 | 有 | 有 | 六条嵌套 depth 0…5，h5/h6 未被截断（A2 的“h5/h6 未实测”已补上真机证据） |
| none（无 heading） | 4 | 0 | 0 | **无** | **无** | — |

AC-5 补充真机：`A &amp; B &lt;C&gt; "D" 中文 ＡＢＣ`、`Café naïve — Ünïcode` 在产物 `/Title` 中还原为
`1 A & B <C> "D" 中文 ＡＢＣ`、`1.1 Café naïve — Ünïcode`（全角 ＡＢＣ 原样，未 NFC/NFKC；前缀编号符合 A13）。

## 2. AC 逐条判定

| AC | 判定 | 证据 |
| --- | --- | --- |
| AC-1 | ✅ | multi：exit 0、`/Type /Outlines` 存在、`--json` 五键精确 `{pdf,bytes,pages,outline,out}`、`outline=7` |
| AC-2 | ✅ | `--no-outline`：exit 0、扫描 `outContainsOutlinesKey=false`、`outline=0` |
| AC-3 | ✅ | pdf 同传 `--outline --no-outline`：exit 1、不落盘、stderr `--outline 与 --no-outline 不能同时使用`；`HREADER_CHROME=/nonexistent` 下同样 exit 1（互斥先于启动浏览器）；`hr png --outline`、`--no-outline`、两者同传均 exit 1 且不落盘（A7 无正向 exit 2 裂缝） |
| AC-4 | ✅ | none.pdf：exit 0、无 `/Outlines`、`outline=0`（数字、键存在、非报错） |
| AC-5 | ✅ | 上表标题序列逐条 == 打印稿 textContent（空白归一后）；转义/全角/中文/重音真机还原 |
| AC-6 | ✅ | ① multi/single/deep/count300 四份文档 items == report.outline == heading 数（7/2/6/300）；② `--page-size` 与扫描页序一致，300 条目的 page 序列 5…34 单调不减（35 页）；③ 两次渲染 `pdf-scan` 的 items/页序完全相等 |
| AC-7 | ✅ | 全部真机跑完后 `find $TMPDIR -maxdepth 2 -name 'hr-chrome*'` 为空；`pgrep -fl 'Google Chrome for Testing|--headless=new'` 为空 |
| AC-8 | ✅ | `pnpm verify` EXIT=0：259 test files / 2892 tests 全绿，depcruise 560 模块 0 违规，knip 干净，四维 perFile 100% |

确定性边界（D5）：两次渲染 PDF 字节不同，但仅差 2 字节（`/CreationDate` 秒级时间戳）；大纲条目数/标题序列/页序完全一致。

## 3. 敌意输入矩阵（真机）

| 用例 | 输入 | 结果 |
| --- | --- | --- |
| 互斥 | `--outline --no-outline` | exit 1，不落盘（即使 `HREADER_CHROME` 指向不存在路径也 exit 1，说明互斥先于 Chrome 启动） |
| 旗标错位 | `hr png … --outline` / `--no-outline` / 两者 | 均 exit 1，不落盘 |
| 旗标语法 | `--outline=false` | exit 2 `未知参数：--outline=false` |
| 旗标语法 | `--outline true` | exit 2 `pdf 只接受 1 个位置参数，多出 1 个` |
| 参数越界 | `--page-size a3` | exit 1 `--page-size 只能是 a4 \| letter \| a5：a3` |
| 参数越界 | `--timeout 0` / `601` / `1.5` | exit 2 `--timeout 必须是 1..600 的整数` |
| 路径越界 | `--out /tmp/…`（workspace 外） | exit 3 `--out 只能写到 workspace 内`，不落盘 |
| 子命令错位 | `hr export … --outline` | exit 2 `--outline`（未知参数） |
| 300 标题（h1–h6 循环） | 300 heading | exit 0，35 页，`outline=300`，items=300，depth 0–5，page 单调，无空标题 |
| 刁钻标题 | 空白标题、重复标题、`<em>`、`<br>`、`display:none`、emoji/RTL/tab、空 `<span>` | exit 0；见 §4 P2 |
| 100 KB 单标题 | 100 000 × `X` | exit 0，122 页，`outline=1`，`/Title` 被 Chrome 截到 1035 字符；见 §4 P3 |
| 只有标题的文档 | 单 h1 无正文 | exit 0，3 页，`outline=1`（不报 empty_document） |

## 4. 观察项（需协调者裁定是否登记，不阻塞本卡）

- **P2（口径风险）**：`display:none` 的 heading 仍被 `pdfHeadingsOf` 计数（`packages/cli/src/commands/pdf.ts:51` 只数元素），但 Chrome 生成 PDF 大纲时跳过它 → 同一份文档 report `outline=8`、产物实际 7 条（刁钻文档实测，缺的是隐藏的 `3.3`）。常规打印稿不含隐藏 heading，因此 AC-6 在验收文档上成立；若要把“报告值 == 实际书签数”推广到敌意输入，需要写明限制（隐藏 heading 不计入实际大纲），或在 `pdfHeadingsOf` 里排除不可见节点——后者是行为变更，非本卡范围。
- **P3（Chrome 上限）**：超长标题（100 KB）在产物 `/Title` 中被 Chrome 截为 1035 字符；`outline` 计数仍为 1，不崩。建议文档记录“PDF 书签标题最长 ~1 KB”。
- **P3（死默认值）**：`packages/cli/src/chrome/session.ts:257` `outline: input.outline` 的类型是必填 `boolean`（`RenderPdfInput.outline`），D1 的“协议层无默认值”成立；MV-3 把这里改成 `?? true` 后套件不红——说明该 `?? true` 在 TS 下不可达，属等价变异，不是测试漏洞。若要防运行时 JS 调用方漏传，可在 `chrome-session` 增一条 runtime-undefined 用例（可选）。

## 5. 变异测试（21 条，逐条“能红”）

方法：`/tmp/m45-mut`（工作树副本，`node_modules` 软链原仓），逐条改源码 → 跑目标用例 → 还原；结果落 `/tmp/m45/mutation-results.json`。仓库本体零改动。

| 编号 | 变异 | 判定 | 红灯用例摘要 |
| --- | --- | --- | --- |
| MV-1 | `packages/cli/src/chrome/cdp.ts:48` `generateDocumentOutline: outline` → `false` | 红 | `printParamsOf` 三纸张 + D3 两用例，共 5 条 |
| MV-2 | 同上 → `true` | 红 | D3 “false 时请求里是 false（不是缺键）”等 2 条 |
| MV-3 | `packages/cli/src/chrome/session.ts:257` → `input.outline ?? true` | 等价 | 套件 15/15 绿（类型必填，见 §4 P3） |
| MV-4 | `packages/cli/src/args-pdf.ts:55` 恒 `true` | 红 | `--no-outline 关掉大纲` |
| MV-5 | `commands/pdf.ts:112` `outline` 恒 `0` | 红 | `outline = 打印稿 heading 数` |
| MV-6 | 同上 → `pdfPagesOf(bytes)` | 红 | 4 条（含无 heading/`--no-outline`） |
| MV-7 | `packages/cli/src/args-png.ts:40` 不识别大纲旗标 | 红 | png `--outline` 被静默接受 |
| MV-8 | `tests/helpers/pdf-scan.ts` `/Kids` 顺序反转 | 红 | 单条目页序 + 三层嵌套 + `/Dest` 共 4 条 |
| MV-9 | `args-pdf.ts:55` 反向读 `--outline` | 红 | 2 条旗标矩阵 |
| MV-10 | `pdf-scan.ts` 跳过 BOM | 红 | 三层嵌套 + 兄弟 `/Next` + UTF-16BE 共 3 条 |
| MV-11 | `pdf-scan.ts` 叶子判断反向 | 红 | 7 条 |
| MV-12 | `pdf-scan.ts` 不跟 `/Next` | 红 | 三层嵌套 2 条 |
| MV-13 | `pdf-scan.ts` UTF-16 大小端互换 | 红 | 3 条 |
| MV-14 | `commands/pdf.ts:51` `HEADING_TAGS` 仅 h1 | 红 | 3 条 |
| MV-15 | 同上仅 h1–h4 | 红 | 3 条（A2 的 h5/h6 有单测兜底） |
| MV-16 | `outline` 在 `--no-outline` 时仍报 heading 数 | 红 | 2 条 |
| MV-17 | `commands/pdf.ts:117` 互斥分支失效 | 红 | `旗标互斥` |
| MV-18 | 互斥检查挪到渲染之后 | 套件绿，**真机顺序检查红** | `HREADER_CHROME=/nonexistent` 下原版 exit 1，变异版 exit 3（先渲染后报错）；说明“先互斥后渲染”的优先级被外部行为钉住 |
| MV-19 | `generateDocumentOutline: "true"`（字符串） | 红 | D3 + 纸张共 6 条 |
| MV-20 | `packages/cli/src/output.ts:126` 删 `"outline"` 键 | 红 | `--json 键集` |
| MV-21 | `packages/cli/src/tokens.ts:42` 删 `--no-outline` 词表项 | 红 | 2 条（`args-pdf` + `pdf-cli`） |

统计：19/21 套件内红；MV-18 由真机顺序检查红；MV-3 判定为等价变异。

## 6. 证据位置

- 真机基线与敌意产物：`/tmp/m45/*.pdf`、`/tmp/m45-h/*.pdf`、`/tmp/m45/hostile-results.json`
- 变异结果：`/tmp/m45/mutation-results.json`（脚本 `mutate3.mjs`，副本 `/tmp/m45-mut`）
- 验证日志：`/tmp/m45/verify-g3.log`（EXIT=0）
- 仓库工作树：`git diff --cached` 空；未新增/修改任何 `packages/**` 文件（仅 F1 既有改动与既有未跟踪文件）
