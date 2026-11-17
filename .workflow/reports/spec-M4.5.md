# spec-M4.5 — G0 前置：AC 矩阵 / 歧义点名 / 变异表（测试员，只出规格，不写测试代码）

> 依据：`.workflow/cards/M4.5.md`（v1）、`docs/03-collaboration-workflow.md` §四（测试矩阵）/§六（返工）/§七（上下文生命周期）。
> 本文件**不碰** `packages/**`、`docs/**`；不含任何测试实现，只给"执行命令 / 断言点 / 预期值来源"。
> 事实基线一律采信卡片 §1（协调者已实测），本文件只做**补测与反驳**，重跑基线不在 G0 范围。

---

## 0. 先给结论：卡与代码对不上的地方（G1 开工前必须裁决）

以下 8 条是 G0 读代码时发现、**卡片本身没写死或写错**的点。B1–B4 是"照卡执行会直接做不到"，B5 是"照卡写测试会必红"，B6–B8 是"口径冲突"。

| # | 发现 | 证据（真实路径:行） | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| B1 | `--outline` / `--no-outline` **目前根本进不了 tokenizer**：未登记的 `-` 开头 token 直接 `未知参数` → `exit 2`，而 AC-3 要求 `invalid_input` → `exit 1` | `packages/cli/src/tokens.ts:34-42`（`SWITCH_FLAGS` 无这两项）、`packages/cli/src/tokens.ts:63-65`（`未知参数`） | AC-1/AC-2/AC-3 全部做不到 | §6 白名单必须加 `packages/cli/src/tokens.ts` |
| B2 | `hr png --no-outline` 要被拒，必须改 png 的旗标表；`unusedFlag` 只认各命令自己的白名单 | `packages/cli/src/args-png.ts:8-18`（`PNG_FLAGS`）、`packages/cli/src/intent.ts:117-125`（`unusedFlag`） | AC-3 第二半做不到 | §6 白名单必须加 `packages/cli/src/args-png.ts` |
| B3 | 卡 §3 D3/§4 点名的 `packages/cli/src/chrome/pdf.ts` **不存在**；真接缝是 `cdp.ts` 的 `printParamsOf` / `renderPdfOverCdpOf` 与 `session.ts` 的 `RenderPdfInput` / `sessionPdfOf` | `packages/cli/src/chrome/cdp.ts:34-49`（`printParamsOf`）、`packages/cli/src/chrome/cdp.ts:186-216`、`packages/cli/src/chrome/session.ts:129-131`、`packages/cli/src/chrome/session.ts:250-256` | D3 的"可单测接缝"指错文件；写者会新建一个空壳 `pdf.ts` 或漏改 `session.ts` | 以 `cdp.ts`+`session.ts` 为准；白名单加 `chrome/session.ts`。`run.ts` **不用改**：`run.ts:200-201` 用 `{ ...renderInput }` 透传，只要 `RenderPdf` 类型加了字段就自动过 |
| B4 | `usage.ts` 的 synopsis 已列 `--page-size`/`--timeout`，未列 `--outline`；不改则 `hr pdf --help` 与实现不符 | `packages/cli/src/usage.ts:37`、`packages/cli/src/usage.ts:101` | 文档一致性（非 AC 硬指标，但审计会报） | 白名单加 `usage.ts`，或协调者明示"本卡不管 help" |
| B5 | **AC-6② 的"首章=第1页"是错的**：打印稿固定 cover → TOC → 正文，两处 `break-after: page`，首章必然 ≥ 第 3 页 | `packages/renderer-html/src/print-page.ts:41-49`（封面/目录标题用 `<p>`）、`packages/renderer-html/src/print-css.ts:125-141`（`.cover`/`.toc` 强制分页）、`packages/renderer-html/src/print-css.ts:182-193`（`section.chapter` 前分页，首章 `auto`） | 照卡写 → 必红，写者会去改 M4.3（越界）| AC-6② 改成"首章 = 第 3 页（短目录 fixture）+ 跨章页序严格不减" |
| B6 | `--json` 键集现有断言是 4 键，本卡要 5 键；同文件 `inputOf` 是必填字段工厂 | `packages/cli/tests/pdf-command.test.ts:73-87`、`packages/cli/tests/pdf-command.test.ts:35-68` | 写者加字段会连带红 | 允许测试大改（在白名单内）；断言顺序照 D2：`pdf,bytes,pages,outline,out` |
| B7 | `renderPdfOf` 的直接调用点有 10+ 处（session 各测试），新增必填参数会连带改 | `packages/cli/tests/chrome-session.test.ts:33,48,64` 等 11 处 `renderPdfOf({...})` 调用 + `packages/cli/tests/chrome-session-stderr.test.ts:42` | 机械改动，不影响契约 | 接受；但要求 `RenderPdfInput.outline` 是**必填**（不许可选 → 不许 `undefined` 哨兵） |
| B8 | D2 说 `outline` = heading 数，但 `buildOutline` 会**丢条目**：缺 `data-hr-id` 的标题、层级 > 4 的标题都不入 outline | `packages/core/src/ops/outline/walk.ts:130-133`（无 id 省略）、`packages/core/src/ops/outline/walk.ts:135-139`（深度上限省略）、`packages/core/src/ops/outline/constants.ts:23`（`OUTLINE_DEPTH_LIMIT = 4`） | 若 `outline` 用 `buildOutline().nodes` 计数，与 Chrome DOM 的 h1–h6 条目数**可能不等**，AC-6① 会红（且红得没有解释） | 见 A1：`outline` 必须数**打印稿 HTML 里的 `<h1..h6>` 元素**，不数 outline 节点 |

---

## 1. AC-1..AC-8 可执行清单

记号：**U** = 单测（无 Chrome，假传输/假 render，`packages/cli/tests/**`）；**C** = 契约（真子进程 + 假 Chrome 或进程内命令层）；**E** = e2e（真 Chrome，`HREADER_CHROME` 必须显式给）。
"证据"列写的是**预期值来源**（代码/基线），不是"大概应该"。

统一执行命令（G3 用）：

```bash
# U + C（不需要 Chrome）
pnpm exec vitest run packages/cli/tests/args-pdf.test.ts packages/cli/tests/pdf-command.test.ts \
  packages/cli/tests/pdf-cli.test.ts packages/cli/tests/chrome-cdp.test.ts \
  packages/cli/tests/pdf-outline-scan.test.ts

# E（真 Chrome；HREADER_CHROME 是权威，见 session.ts:99-108）
HREADER_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
HREADER_REQUIRE_CHROME=1 \
pnpm exec vitest run packages/cli/tests/pdf-outline-e2e.test.ts

# 单条手工复核（等价于 runCli：harness.ts:12,75）
HREADER_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
node --experimental-strip-types packages/cli/src/main.ts pdf \
  packages/cli/fixtures/outline-multi.hreader --out /tmp/m45/multi.pdf --json

# AC-7 / AC-8
pgrep -fl 'hr-chrome-' | grep -v pgrep ; echo "exit=$?"
ls "${TMPDIR:-/tmp}" | grep '^hr-chrome-' ; echo "exit=$?"
pnpm verify
```

### AC-1 默认开大纲

| 项 | 内容 |
| --- | --- |
| 分层 | U（参数+键集+计数）、E（产物结构） |
| 执行命令 | `pnpm exec vitest run packages/cli/tests/args-pdf.test.ts packages/cli/tests/pdf-command.test.ts`；E 见上 |
| 断言点 | ① 无旗标时 `pdfIntent(...).outline === true`（解析层默认值唯一来源）。② 命令层交给渲染的入参含 `outline: true`（`RenderPdf` 入参对象，见 `packages/cli/src/commands/pdf.ts:17-21`）。③ 假传输发出的 `Page.printToPDF` 报文含 `"generateDocumentOutline":true`（`chrome/cdp.ts:34-49` 的纯构造 + `tests/chrome-helpers.ts:180-196` 的 responder.sent）。④ `--json` 键集与顺序精确 `["pdf","bytes","pages","outline","out"]`（`packages/cli/src/output.ts:115-125` 现有 4 键 + D2）。⑤ `outline > 0`（fixture 有 7 个 heading → 精确 `7`，见 §5 F-multi）。⑥ E：字节里 `/Type /Outlines` 出现 1 次，且 `/Outlines` 是 Catalog 的键（`/Outlines \d+ 0 R`）。 |
| 预期值来源 | 键集：卡 §3 D2 + `output.ts:115-125`；`outline=7`：§5 fixture 的 heading 数；`/Type /Outlines`：卡 §1 第 2 行（根对象形态）；exit 0：`packages/cli/src/exit-codes.ts:5`（`EXIT_OK`） |

### AC-2 `--no-outline`

| 项 | 内容 |
| --- | --- |
| 分层 | U（旗标→入参→报文一律 `false`）+ E（产物无键） |
| 执行命令 | 同上 |
| 断言点 | ① `pdfIntent([...,"--no-outline"]).outline === false`。② 渲染入参 `outline === false`。③ 报文 `"generateDocumentOutline":false`（**必须是布尔 `false`，不是缺键**——缺键就是协议层默认值/隐式回退，D1 禁止）。④ `--json.outline === 0`。⑤ E：`/\/Outlines\b/` 在整个字节里 0 命中（注意：只查键名，不查 `/Type /Outline`，见 A13）。 |
| 预期值来源 | D1（"协议层不许有默认值"）+ D2（无 heading / 关 → `0`）+ 卡 §1 第 7 行（无 heading 时 Catalog 根本没有 `/Outlines`） |

### AC-3 互斥与放错子命令

| 项 | 内容 |
| --- | --- |
| 分层 | C（真子进程，断言 exit/信封/不落盘） |
| 执行命令 | `pnpm exec vitest run packages/cli/tests/pdf-cli.test.ts` + §7 的手工复核命令 |
| 断言点 | ① `pdf a.hreader --out a.pdf --outline --no-outline` → exit **1**，`--json` 时 stdout 单行信封 `data.error.code === "invalid_input"`。② 同一条**不落盘**：`existsSync(a.pdf) === false`。③ **不启动 Chrome**：把 `HREADER_CHROME=/nonexistent/hr-chrome` 传进去，错误仍必须是 `invalid_input` 而不是 `chrome_missing`（证明确定性校验排在花钱调用之前，§11.25）。④ `hr png a.hreader --out a.png --no-outline` → exit 1 + `invalid_input`，`a.png` 不存在。⑤ `hr png ... --outline`（正向旗标也放错）→ 同 ④（见 A7）。 |
| 预期值来源 | `invalid_input → EXIT_FAILURE = 1`（`packages/cli/src/exit-codes.ts:6,20`）；M4.4 先例：`--page-size` 放错子命令是 `invalid_input`（`args-png.ts:5-6` 注释）；"不落盘"：`assertPdfOutOf` 的顺序（`packages/cli/src/commands/pdf.ts:76-81`）+ argc 层拒绝根本到不了命令层 |

### AC-4 无 heading

| 项 | 内容 |
| --- | --- |
| 分层 | U（`outline === 0`、不报错）+ E（产物无键） |
| 执行命令 | 同上（fixture `outline-plain.hreader`） |
| 断言点 | ① 命令层 `pdfCommand` 退出成功（不抛），`--json.outline === 0`，键**存在**。② E：exit 0、`/Outlines` 0 命中、`pages ≥ 1`。③ 反向：把"计数 0"误判成 `render_empty` 的实现在此红（`assertPdfOf` 只看页数，`commands/pdf.ts:67-73`）。 |
| 预期值来源 | 卡 §1 第 7 行 + D2（"文档无 heading 时为 0"）+ `printHtmlReportOf` 的 `empty_document` 只按**文本**判（`print-html.ts:214-221`），纯 `<p>` 文档不会触发 |

### AC-5 标题保真

| 项 | 内容 |
| --- | --- |
| 分层 | U（`pdf-scan` 的 `/Title` 解码，喂手写字节）+ E（真产物 vs 打印稿 heading 序列） |
| 执行命令 | `pnpm exec vitest run packages/cli/tests/pdf-outline-scan.test.ts`；E 见上 |
| 断言点 | ① oracle 取法与顺序：`hr export <fixture> --json` → `data.html`（`packages/cli/src/output.ts:105-107`）→ `parseHtml` → 文档序收集 `<h1..h6>` 的 `textContentOf`（`packages/core/src/html/text.ts:41-42`）→ `normalizeWhitespace`。② `pdf-scan` 沿 `/Outlines`→`/First`→`/Next` 还原的 `/Title` 序列与 ① **逐条相等**（长度、顺序、每条的归一文本）。③ 转义还原范围：literal 串的 `\( \) \\ \n \r \t \b \f`、八进制 `\ddd`、行尾续行；hex 串 `<FEFF…>` 去 BOM 后按 UTF-16BE；无 BOM 的 hex 串按 PDFDocEncoding（ASCII 直通）。④ 含中文/全角（ＡＢＣ）/`& < > "`/`&nbsp;`/连续空白的标题在 ① 与 ② 两边同规则归一后相等。 |
| 预期值来源 | 卡 §5 AC-5 + §1 第 4 行（`/Title` 是 heading 原文，非 ASCII 走 `<FEFF…>`）+ 归一规则见 A3（`packages/core/src/html/text.ts:44-45` 的实现口径） |

### AC-6 三条真 Chrome 不变量（必须 E）

| 项 | 内容 |
| --- | --- |
| 分层 | E（唯一真 Chrome） |
| 执行命令 | 见文首 E 命令；每份 fixture 各跑一次（两次渲染用于 ③） |
| 断言点 | ① 条目数（沿 `/Outlines` DFS 的条目字典数，**不是** `/Type /Outline`）== 打印稿 heading 数（AC-5 的 oracle 口径）== `--json.outline`。② 每条 `/Dest [<pageObj> /XYZ …]` 的 `pageObj` 经 `/Kids` 换算后的 1-based 页序：首章 == 3（短目录 fixture，见 B5）；同章节内后续条目 ≥ 前一条；跨章严格递增；全部落在 `1..pages`；且 `pdfPagesOf(bytes) === /Kids 叶子页数`。③ 同输入两次（两个 `--out`）的标题序列、条目的页序数组**完全相等**（不断言字节相等，D5）。 |
| 页序算法 | 见 §2，逐字实现，不许"再写一个正则数页" |
| 预期值来源 | 卡 §1 第 2/5/6/8 行（条目形态、`/Count`、`/Dest` 形态、`/Kids` 顺序）+ B5（首章页）+ `pdfPagesOf`（`commands/pdf.ts:55`）作为独立交叉校验 |

### AC-7 进程卫生

| 项 | 内容 |
| --- | --- |
| 分层 | E（真 Chrome 跑完）+ C（复用假 Chrome 的既有用例） |
| 执行命令 | 文首 `pgrep` / `ls "$TMPDIR"`；C 见 `packages/cli/tests/pdf-cli.test.ts:100-130` |
| 断言点 | ① 每轮 e2e 结束后 `pgrep -fl 'hr-chrome-'`（去掉 pgrep 自身）为**空**、退出码 1。② `$TMPDIR` 下无 `hr-chrome-*` 残留。③ 若第二次渲染会失败（`--force` 不给），第一轮的 Chrome 也已被回收。 |
| 预期值来源 | 卡 §5 AC-7；既有实现：`packages/cli/tests/pdf-cli.test.ts:100-130`（同口径的假 Chrome 版本） |

### AC-8 全量门禁

| 项 | 内容 |
| --- | --- |
| 分层 | C（仓库级） |
| 执行命令 | `pnpm verify`（跑两遍，`EXIT=0`）；对照 `git ls-files 'packages/*/tests/*.test.ts' \| wc -l` 与用例数 |
| 断言点 | ① 两遍 `EXIT=0`。② 测试文件数、用例数只增不减。③ `coverage` 阈值 `perFile` 四维 100%（`vitest.config.ts:43-49`）对**新增 src 文件**也成立（若 B3 采用"新建 `chrome/pdf.ts`"，则该文件必须 100%）。④ `coverage` 的 `include` 只含 `packages/*/src/**/*.ts` 与 `packages/*/pi-hreader.ts`（`vitest.config.ts:37`）→ `tests/helpers/pdf-scan.ts` 不在覆盖率门禁内，但 D4 仍要求它**自带**三份手写字节用例。⑤ `git status --porcelain` 在变异测试后为空（§11.16：新文件不能 `git checkout` 复原）。 |
| 预期值来源 | `package.json:12`（verify 链）、`vitest.config.ts:30-50`、`docs/03-collaboration-workflow.md` §11.12/§11.16 |

---

## 2. 从 `/Kids` 算页序（AC-6② 的唯一算法）

基线（卡 §1）：产物是**经典 xref 表 + trailer**，无 ObjStm / 无 XRef 流，页对象可直接按 `N 0 obj` 扫到。因此：

1. **扫对象**：`/(\d+)\s+0\s+obj([\s\S]*?)endobj/g`，建 `Map<对象号, 字典文本>`（latin1 解码，PDF 结构字段都是 ASCII）。
2. **找根**：取 `trailer` 里的 `/Root (\d+) 0 R` → Catalog 字典 → `/Pages (\d+) 0 R`。
3. **深度优先、按 `/Kids` 数组顺序收集叶子**：
   ```
   order = []
   walk(num):
     dict = objects[num]
     for child in parseRefArray(dict, "/Kids"):        // 必须按数组字面顺序
       if /\/Type\s*\/Pages\b/.test(objects[child]):    // 中间节点：原地展开
         walk(child)                                    //   不能 append 到末尾
       else if /\/Type\s*\/Page\b(?!s)/.test(objects[child]):
         order.push(child)                              // 叶子页
       else: fail("未知 /Kids 子节点")
   ```
4. `pageIndexByObj = new Map(order[i] → i+1)`（1-based）。
5. **交叉校验**：`order.length === pdfPagesOf(bytes)`（`commands/pdf.ts:55`，正则 `/\/Type\s*\/Page\b(?!s)/gu`）。两条独立路径相等，才说明页序不是"数出来凑的"。
6. **取条目页**：`/\/Dest\s*\[\s*(\d+)\s+0\s+R/` 拿 `pageObj` → `pageIndexByObj`。找不到 → 测试直接 fail（不吞、不回落成 1）。

必测的边界（`pdf-scan` 自带用例）：
- `/Kids` 里出现 `/Type /Pages` 中间节点（三层：Pages → Pages → Page）→ 顺序必须按"原位置展开"，不是"叶子先收、中间节点后补"（变异 M11 的判据）。
- `/Kids` 顺序与对象号顺序**相反**的手写字节（对象 2 在前、对象 9 在后但 `/Kids` 反写）→ 页序必须跟 `/Kids`，不是跟对象号（变异 M8）。
- 单条目 / 三层嵌套 / 无 `/Outlines`（D4 要求的三份）+ 上面两份 = 5 份手写字节。

---

## 3. 歧义点名（每条：候选读法 → 建议）

### A1 `--json.outline` 的计数口径（**最重要**）
- 候选 A：打印稿 HTML 里 `<h1..h6>` 元素个数（`parseHtml(product.html)` 数元素）。
- 候选 B：`buildOutline(...).nodes` 摊平后的节点数。
- 候选 C：源文档 `<article>` 内的 heading 数（含被 M4.3 丢弃的部分）。
- **建议 A**。理由：AC-6① 比的是 Chrome 从**打印稿 DOM** 生成的条目；B 会因 `OUTLINE_DEPTH_LIMIT = 4`（`packages/core/src/ops/outline/constants.ts:23`）与"缺 `data-hr-id` 省略"（`walk.ts:130-133`）而变小；C 会把 `<article>` 外（封面/页头）的 heading 算进来，而它们不进打印稿。实现路径：命令层已持有 `product.html`（`commands/pdf.ts:82-95`），用 `parseHtml` 数元素即可，**不需要**引入 PDF 解析（非目标 1 不破）。

### A2 heading 算 h1–h6 还是 h1–h3
- 候选 A：h1–h6 全算。候选 B：只算 h1–h3。
- **建议 A**。证据：卡 §1 第 6 行（加 h4 条目从 9 变 10，Chrome 收全）；`packages/core/src/model/constants.ts:20-27` 的 `HEADING_LEVELS` 也只有 h1–h6。
- 未实测风险：h5/h6 是否同样收录（基线只验到 h4）。→ §5 用独立 fixture `outline-deep.hreader` 先测，再决定它进不进 AC-6① 的硬断言（见 §7 风险 R2）。

### A3 标题空白正常化
- 候选 A：`text.replace(/\s+/gu, " ").trim()`（= `packages/core/src/html/text.ts:45` 的 `normalizeWhitespace`）——连续空白折叠、全角空格与 NBSP 都折成一个半角空格。
- 候选 B：只折叠 ASCII 空白，NBSP 原样保留。
- 候选 C：只 `trim()`，不折叠中间空白。
- **建议 A**。理由：同一仓库已有唯一实现（`normalizeWhitespace`），`&nbsp;` 在 JS 的 `\s` 里（U+00A0）会被折叠；两边（打印稿 textContent / PDF `/Title`）用**同一个函数**归一，避免"两套正常化互相抵消"。必须写明：**不做 NFC/NFKC**（全角 ＡＢＣ 必须原样相等，AC-5 硬要求）。

### A4 `--no-outline` 与 `--json`
- 候选 A：键存在、值 `0`。候选 B：键省略。候选 C：`null`。
- **建议 A**。证据：D2 原文"键集精确、不省键"，且现有键集测试用 `keysOf(...)` 顺序比对（`packages/cli/tests/pdf-command.test.ts:73-87`）；省键会让 5 键断言变成条件断言。

### A5 `--no-outline` 与 `--force` / `--timeout` / `--page-size` 的组合
- 候选 A：彼此正交，任意组合都合法（`--force` 只决定覆盖；`--no-outline` 只决定 `generateDocumentOutline`）。
- 候选 B：`--no-outline` 与 `--force` 互斥（无理由）。
- **建议 A**，并补一条用例：`--no-outline --force` 覆盖已存在文件成功，`outline === 0`。这张卡里**只有** `--outline` × `--no-outline` 这一对是互斥的。

### A6 无 heading 时 `--json.outline`：`0` / 键不存在 / `null`
- **建议 `0`**（D2 明文 + AC-2/AC-4）。同时钉死：`0` 是**数字**，不是 `"0"`（现有 `pages` 是数字，`output.ts:122-124`）。

### A7 `--outline`（正向）放错子命令
- 候选 A：`hr png ... --outline` → `invalid_input` exit 1（与 `--no-outline` 对称，与 M4.4 的 `--page-size` 先例一致）。
- 候选 B：当作未知旗标 → `未知参数：--outline` exit 2。
- **建议 A**。理由：两个旗标是一对，语义上"大纲"对 PNG 都不成立；不对称会留下"正向旗标 exit 2、反向旗标 exit 1"的口径裂缝。代价：要改 `args-png.ts`（见 B2）。

### A8 互斥错误的**文案**是否算契约
- 候选 A：只断言 `code === "invalid_input"` + exit 1 + 不落盘；文案由写者定。
- 候选 B：把文案也钉进测试。
- **建议 A**。卡里没给文案；钉文案会把"改一句人话"变成返工。若协调者要钉，请先在卡里补原文。

### A9 默认值放在哪一层
- 候选 A：默认值只在 argv 解析层（`pdfIntent`）出现一次，`RenderPdf` 入参与 `printParamsOf` 都是**必填 `boolean`**。
- 候选 B：协议层 `outline ?? true` 兜底。
- **建议 A**（D1"协议层不许有默认值"）。可执行断言：`printParamsOf("a4", false).generateDocumentOutline === false` 且**键存在**；`renderPdfOf` 的入参类型里 `outline` 不可选（类型层断言：`// @ts-expect-error` 缺字段的用例，或直接靠 `tsc` 必填字段报错）。

### A10 `/Dest` 第一元素的形态
- 候选 A：页面对象引用 `N 0 R`（基线实测形态）。
- 候选 B：0-based 页索引整数。
- **建议 A，且不写 B 的防御分支**。理由：§11.23（防御性相等分支自己会变成死代码）；基线已实测 `[<pageObj> /XYZ x y 0]`。`pdf-scan` 遇到非 ref 形态应**抛错**，不是回退。

### A11 标题文本串解码
- 候选 A：hex 串以 `FEFF` 开头 → UTF-16BE；literal 串按 PDF 转义规则；无 BOM 的 hex 按 PDFDocEncoding（本项目可只做 ASCII 直通）。
- 候选 B：所有 hex 串都当 UTF-16BE（无 BOM 时会得到乱码/错位）。
- 候选 C：都当 UTF-8。
- **建议 A**。基线：非 ASCII 时 Chrome 写 `<FEFF…>`（卡 §1 第 4 行）。解码失败要**抛错**，不许静默丢字符（否则 AC-5 会假绿）。

### A12 `/Type /Outlines` 断言的措辞
- 卡 §1 已写明：条目字典**没有** `/Type`。AC-1 的 `/Type /Outlines` 只指根对象；AC-2 的"无 `/Outlines`"只指**键不存在**（`/\/Outlines\b/` 零命中）。
- **建议**：在测试名与注释里把"根对象类型"与"Catalog 键"分开写，禁止任何 `/Type /Outline\b` 的断言（会永远红）。

### A13 `/Title` 是否包含注入的章节编号
- 候选 A：oracle 取**打印稿** heading 的 `textContent`（含 `print-html.ts:181-190` 注入的编号 span）。
- 候选 B：取源文档 heading 原文（不含编号）。
- **建议 A**。基线实测 `/Title` = `(1.1 Section One)`（带编号）；且 AC-5 原文写的就是"打印稿 `<h1..h6>` 的 `textContent`"。

### A14 计数是否包含被 `OUTLINE_DEPTH_LIMIT` 挤掉的标题
- **建议"包含"**（同 A1：按打印稿 DOM 数）。这条同时是变异 M15 的判据。

---

## 4. 变异清单（写者实现后由测试员执行；每条必须"能红"）

- 复原方式统一按 `packages/cli/fixtures/cli-mutants.mjs` 的写法：`find`/`replace` 字面替换 + sha256 校验 + `git status --porcelain` 必须为空（§11.16 对新文件 `tests/helpers/pdf-scan.ts` 尤其重要：**先备份字节，再改，再写回**）。
- "红判据"指**哪条用例必须失败**；变异后跑该用例的最小集合（不跑全量，除 M-fail 收尾）。

| ID | 变异 | 落点（符号） | 红判据（必须失败的断言） |
| --- | --- | --- | --- |
| MV-1 | `generateDocumentOutline` 恒 `false` | `packages/cli/src/chrome/cdp.ts` `printParamsOf` | AC-1 的报文断言 + E 的 `/Type /Outlines` 出现 |
| MV-2 | 恒 `true` | 同 MV-1 | AC-2 的报文 `false` + E 的 `/Outlines` 零命中 |
| MV-3 | 协议/会话层塞默认值（`outline ?? true`，参数改可选） | `packages/cli/src/chrome/cdp.ts` 或 `chrome/session.ts` `sessionPdfOf` | AC-2 的报文 `false`（会变成 `true`）+ AC-3 的 png 用例不变红但 AC-2 红 → 同时暴露 D1 |
| MV-4 | `--no-outline` 不生效（解析层恒 `true`） | `packages/cli/src/args-pdf.ts` `pdfIntent` | AC-2 全部 |
| MV-5 | `outline` 恒 `0` | `packages/cli/src/commands/pdf.ts` `pdfCommand` | AC-1 `outline === 7` + AC-6① |
| MV-6 | `outline` 抄 `pages` | 同 MV-5 | AC-1/AC-4（`4 ≠ 7`、`1 ≠ 0`） |
| MV-7 | png 静默接受 `--no-outline` | `packages/cli/src/args-png.ts` `PNG_FLAGS` | AC-3 ④（会 exit 0 落盘） |
| MV-8 | `pdf-scan` 的 `/Kids` 顺序反转 | `packages/cli/tests/helpers/pdf-scan.ts` 收集循环 | AC-6② 首章页 + `pages` 交叉校验 + `pdf-scan` 自带"反序 /Kids"用例 |
| MV-9 | `--outline` 显式传走另一条分支（显式 true 时实际传 `false`，或默认值被覆盖） | `packages/cli/src/args-pdf.ts` | AC-1 的"显式 `--outline`"用例（必须与默认开逐字段相等） |
| MV-10 | `/Title` 解码漏 BOM（`FEFF` 不去掉） | `pdf-scan.ts` 的 hex 解码 | AC-5 的中文/全角标题（首字符多出 U+FEFF） |
| MV-11 | `/Kids` 的中间 `/Type /Pages` 节点被当叶子或子项追加到末尾 | `pdf-scan.ts` 的 `walk` | `pdf-scan` 自带三层嵌套用例 + AC-6② 首章页（会变成 2 或 1） |
| MV-12 | 大纲遍历只跟 `/First` 不跟 `/Next` | `pdf-scan.ts` 的 DFS | AC-6① 条目数（只 2 个根条目）+ AC-5 序列长度 |
| MV-13 | `/Title` 把 UTF-16BE 当 UTF-8 | `pdf-scan.ts` | AC-5 全部非 ASCII 条目 |
| MV-14 | heading 计数只算 `<h1>` | `packages/cli/src/commands/pdf.ts` 计数处 | AC-1 `outline === 7`（只算 h1 得 1） |
| MV-15 | `outline` 改用 `buildOutline().nodes` 计数 | `commands/pdf.ts` | `outline-deep.hreader`（含 h5/h6）上 `outline` 变小 + AC-6① 不等 |
| MV-16 | 空白正常化退化成 `trim()` | `pdf-scan.ts` 或测试 oracle | AC-5 的"连续空白"标题 |
| MV-17 | 互斥取后者（两个旗标同传不报错） | `args-pdf.ts` | AC-3 ①（exit 0） |
| MV-18 | 互斥校验挪到渲染之后 | `commands/pdf.ts` | AC-3 ③（`HREADER_CHROME=/nonexistent` 时变成 `chrome_missing`/exit 3） |
| MV-19 | `generateDocumentOutline` 传字符串 `"true"` | `cdp.ts` | AC-1 报文断言用 `toBe(true)`（严格相等，`"true"` 红） |
| MV-20 | `--json` 键省掉 `outline`（无 heading 时） | `commands/pdf.ts` | AC-4 键集（`keysOf` 顺序比对） |
| MV-21 | tokenizer 去掉 `--no-outline` 登记 | `packages/cli/src/tokens.ts` `SWITCH_FLAGS` | AC-2/AC-3（先红 `未知参数` exit 2，证明 B1 是真接缝） |

> MV-21 与 MV-8/MV-15 是"测试自身有效性"的变异（§四 强制动作 3），其余是"实现有效性"。两类别都必须至少一条红。

---

## 5. fixture（G1 落 `packages/cli/fixtures/**`，G3 直接用）

| 名字 | 内容要点 | 期望 heading 数 | 用途 |
| --- | --- | --- | --- |
| `outline-multi.hreader` | 2 个 `section.chapter`；章内 h1 + h2×2 + h3 + h4；一条标题写成 `1.1 连续  空白`（两个空格）；一条含 `（ＡＢＣ）` + `&amp;&lt;&gt;"` + `&nbsp;`；第二条章用 `<h2 data-hr-id>` 起 | 7 | AC-1/AC-5/AC-6①②③ |
| `outline-single.hreader` | 单章：h1 + h2，正文短（一屏） | 2 | AC-6② 首章页的**定值**用例（短目录 → 封面 p1、目录 p2、首章 p3） |
| `outline-plain.hreader` | `<article>` 里只有 `<p>`（含足够文字，避免 `empty_document`） | 0 | AC-4 |
| `outline-deep.hreader` | 单章 h1→h2→h3→h4→h5→h6 连续 | 6 | A1/A2/A14 + MV-15（`OUTLINE_DEPTH_LIMIT=4` 会丢 h5/h6 的 outline 节点） |

约束：
- 每个 heading 都给合法 `data-hr-id`（否则 `walk.ts:130-133` 会省略，干扰 A1 的判别）。
- 章节标题的层级必须**不跳级**（`validate.ts` 会对 `heading_level_jump` 出 warning；虽然不影响 PDF，但会污染 stderr 断言）。
- 文件扩展名用 `.hreader`（与既有 fixture 一致）；不放二进制，全部 UTF-8 文本。

---

## 6. 探测点：哪些断言**必须** e2e（写者禁止把它们硬编进 unit）

| 断言 | 为什么单测做不到 | 正确做法 |
| --- | --- | --- |
| 产物含/不含 `/Outlines`（AC-1⑥、AC-2⑤、AC-4②） | 字节来自 Chrome；假传输返回的是 `pdfOf(n)` 这类**罐头字节**（`packages/cli/tests/chrome-helpers.ts`） | U 只断言"发出去的 params"（D3）；产物结构一律 E |
| `/Title` 序列保真、UTF-16BE（AC-5） | 编码策略是 Chrome 的行为，不是本仓库的行为 | `pdf-scan` 用**手写字节**测解码器；真保真度 E |
| AC-6① 条目数 == heading 数 | 只有真 Chrome 会生成 outline | E；单测只能证"计数函数"与"打印稿 DOM"一致 |
| AC-6② 页序（AC-6 全文） | `/Kids`/`/Dest` 的形状由 Chrome 产出 | E；`pdf-scan` 的算法用 5 份手写字节测 |
| AC-6③ 两次渲染一致 | 需要真渲染 | E（两次渲染，两个 out） |
| AC-7 进程/临时目录卫生 | 真进程 | E + 既有假 Chrome 用例（`pdf-cli.test.ts:100-130`） |
| `pages` 交叉校验 | 需要真产物 | E（`pdfPagesOf` 是独立正则，可作 U 的纯函数测，但交叉相等只能 E） |

反向纪律（写者必须遵守）：
1. **unit 里不许出现 Chrome 路径、`spawn` Chrome、`HREADER_CHROME`**。单测的渲染注入口是 `RenderPdf`（`commands/pdf.ts:17-21`）与假传输（`tests/chrome-helpers.ts`）。
2. e2e 文件必须显式门控：读 `process.env.HREADER_CHROME`；缺失且 `HREADER_REQUIRE_CHROME === "1"` → **fail**（不是 skip）；缺失且未设 → skip 并在用例名里写 `(skipped: no HREADER_CHROME)`。杜绝"没 Chrome 也算绿"（§11.13/§11.26）。
3. e2e 用例名必须带卡号与 AC 号（`M4.5 AC-6② …`），便于审计反查。
4. `pdf-scan.ts` 只活在 `packages/cli/tests/helpers/`，**不许**被 `src` import（审计 G2 的检查项）；`knip`/`depcruise` 会替我们抓（`package.json:12`）。
5. 不断言 PDF 字节相等（D5）；只断言标题序列、页序数组、条目数。

---

## 7. 执行顺序（G3 拿到实现后的 runbook）

1. 先跑 U/C：`args-pdf` → `pdf-command`（键集/计数/入参）→ `chrome-cdp`（报文 params）→ `pdf-outline-scan`（5 份手写字节）。
2. 再跑 C 的 CLI 矩阵：AC-3 四条（互斥、不落盘、不启 Chrome、png 两条）→ AC-7（`pgrep`/`$TMPDIR`）。
3. 最后跑 E：`outline-multi` / `outline-single` / `outline-plain` / `outline-deep`，两次渲染 → AC-1/2/4/5/6/7。
4. 变异 21 条逐条跑最小集合，记录"红/未红"（未红 = 测试缺陷，进 P1）。
5. `pnpm verify` 两遍 + 文件数/用例数对比（AC-8）。

风险预判（给协调者）：
- **R1**：B1/B2/B3 白名单缺口不补，写者只有三条路：越界改文件 / 改不出来 / 绕过 tokenizer 手搓 argv。建议 G1 前先补白名单。
- **R2**：h5/h6 是否被 Chrome 收录**未实测**（基线只验到 h4）。若 Chrome 不收录，AC-6① 与"`outline` = h1–h6 计数"会互斥 → 需要协调者在 G3 实测后二选一（要么 `outline` 改口径，要么 AC-6① 排除 h5/h6）。`outline-deep.hreader` 就是为这个判别点准备的。
- **R3**：`outline-single` 的"首章 = 第 3 页"依赖"目录只占一页"。若 TOC 因主题字号撑到两页，定值会红；故该 fixture 只放 2 个 heading、标题短。
- **R4**：`--json.outline` 的计数实现若用正则数 `<h[1-6]`（在 `product.html` 字符串上），会把 `data-hr-id` 里偶然出现的字符串算进来。建议 `parseHtml` 数元素；若坚持正则，至少锚定 `/<h[1-6][\s>]/`。

---

## 8. 给 G2（审计）的交接点

- D1：查 `printParamsOf` 的 `generateDocumentOutline` 是否**必填**、有无 `??` 兜底；查 `RenderPdfInput.outline` 是否可选。
- D3：查 `printParamsOf` 是否导出、`chrome-cdp.test.ts` 是否断言了**报文文本**里的 `generateDocumentOutline`（只断言入参对象不算到位）。
- 非目标 3：`git diff 53e456a -- packages/renderer-html/src` 必须为空；`packages/core/src/ops/outline/constants.ts` 的 `OUTLINE_DEPTH_LIMIT` 也必须没动。
- `pdf-scan.ts` 只活在 `tests/helpers/`，且被至少 5 份字节用例覆盖。
