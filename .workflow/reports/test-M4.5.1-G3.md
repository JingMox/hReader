# 测试报告 M4.5.1（G3，测试员 e7a2fc15 → 3cc487e2）

已按你指定的优先顺序完成，并且先确认了工作树：`git status` 里仍然只有 F1 的改动，`src/pdf/bookmarks.ts`、`output.ts`、`commands/pdf.ts` 与我中断前的备份逐字节一致（md5 `3e631430…` / `75aaf1f6…` / `0a05c929…`），所有变异都已还原，没有留下任何 mutate 痕迹。

## 0. 最关键的四个数（真 Chrome，三层嵌套大纲）

文档：h1 Part A > h2 Section A1 > h3 Sub A11 / Sub A12、h2 Section A2 > h3 Sub A21、h1 Part B > h2 Section B1，共 **8 条、三层**。

| 指标 | 值 |
| --- | --- |
| `--json.outline`（产物真值） | **8** |
| 测试侧 oracle 实走条目数（`pdf-scan.ts` 的 `outline`） | **8** |
| 产物根对象自报 `/Count`（`outlineCount` 原样） | **8** |
| 打印稿 `h1–h6` 元素数 | **8** |

**结论：四个数相等，`/Count` 强一致核对在真实嵌套大纲上不会误伤，不是 BLOCKER。** 抽出的树也正确嵌套（Part A @3 → 1.1 @3 → 1.1.1/1.1.2；Part B → 2.1），根对象原始字节为 `<</Type /Outlines /First … /Last … /Count 8>>`。普通三章文档同样四方相等（3/3/3/3）。

## 1. AC 表（真 Chrome）

| AC | 实测 | 判定 |
| --- | --- | --- |
| AC-1 正常多章（3 章） | `--json.outline`=3；oracle 实走=3；`/Count`=3；打印稿 `h1–h6`=3。另嵌套文档 8/8/8/8 | **PASS** |
| AC-2 隐藏标题 | `style="display:none"` 文档：`--json.outline`=**2**；oracle 实走=**2**；`/Count`=**2**；打印稿 `h1–h6`=**3**。`<h2 hidden>` 文档同样 2/2/2/3。<br>**行内 `style` 没有被打印层剥掉**——打印稿里原样保留 `style="display:none"`、`hidden=""`，只是 Chrome 不为它们生成书签。所以 `outline` 等于产物条目数，**比 DOM 数少 1 是正确行为**，不需要退化为 AC-1 | **PASS** |
| AC-3 `--no-outline` | `--json.outline`=0；产物 `grep -c /Outlines`=0；人读行 `(5 页, 0 条书签)` | **PASS** |
| AC-4 无标题 | `--json.outline`=0；oracle `outlineCount`=`undefined`（无 `/Outlines` 键）；exit 0，人读行 `(3 页, 0 条书签)` | **PASS** |
| AC-5 自相矛盾/断链 | 单测 14 例全绿（`/Count 3` 实走 2、`/First` 断链、非字典、成环、无 trailer、无 `/Root`、`/Outlines` 悬空）；命令层 `/Count` lie → `render_empty` exit 3 且不落盘 | **PASS** |
| AC-6 人读行 | `/…/normal-human.pdf (5 页, 3 条书签)`，`M` == `--json.outline`=3；无标题仍印 `0 条书签` | **PASS** |
| AC-7 旧代码删净 | `grep -rn "pdfHeadingsOf\|headingsOf\|近似值" packages/cli/src` → 空（exit 1）。`L-40` 的 docs 关闭不在我权限内 | **PASS（src 侧）** |

## 2. 变异表（8 条，全部全量 `npx vitest run` 一次）

| # | 变异 | 变红的用例 | 判定 |
| --- | --- | --- | --- |
| 1 | `/Count` 恒当答案、不实走 | `pdf-bookmarks`：根不带 `/Count`、`COUNT_LIE`、`/First` 断链、非字典、成环；`pdf-command-outline`：自相矛盾 | 红 ✔ |
| 2 | 实走不跟 `/Next` | `pdf-bookmarks`：三层嵌套、两条同级、`COUNT_LIE`、成环；`pdf-command-outline` 3 条；e2e 真 Chrome | 红 ✔ |
| 3 | 不跟 `/First`（只数第一层） | `pdf-bookmarks`：三层嵌套；e2e 真 Chrome | 红 ✔（仅 2 条，偏薄） |
| 4 | 交叉核对删掉 | `pdf-bookmarks`：`COUNT_LIE`；`pdf-command-outline`：自相矛盾不落盘 | 红 ✔（仅 2 条，偏薄） |
| 5 | 断链改成返回空字典 | `pdf-bookmarks`：`/First` 断链、Catalog `/Outlines` 悬空 | 红 ✔ |
| 6 | `/Outlines` 缺键也进树 | `pdf-bookmarks`：缺键=0；`pdf-command`/`outline` 共 11 条命令层 | 红 ✔ |
| 7 | 人读行 `M` 恒 0 | `pdf-command-outline`：`M` 与 `--json.outline` 同值 | 红 ✔（仅 1 条） |
| 8 | 数 `/Title`（模拟没从根进树） | `pdf-bookmarks`：`/Info` `/Title` 陷阱 + 9 条（含 e2e） | 红 ✔ |

**没有一条变异能保持全绿 → 测试网没有 BLOCKER 级洞。** 但 #3/#4/#7 各只由 1–2 条用例兜住，建议返工时补一条"嵌套 + 同级混合且 `/Count` 正确"的夹具，把 #3/#4 的触发器加厚。

## 3. 主动找 bug 清单（重点）

| 我做了什么 | 结果 | 是否缺陷 |
| --- | --- | --- |
| 真 Chrome 标题含 `endobj`（如 `endobj`、`Why endobj matters`，后接第二个 h1） | **exit 3，报 `PDF 大纲结构解析不出：/Count 自报 2 条，实走 1 条`，整份 PDF 不落盘、无输出文件**。原始字节：`53 0 obj\n<</Title (1 endobj)\n/Dest […]\n/Next 54 0 R>>\nendobj`——`OBJECT` 正则 `([\s\S]*?)endobj` 在标题里的字面 `endobj` 处截断，`/Next` 被切掉 | **BLOCKER**：无需恶意，章节名里出现 `endobj` 即硬失败 |
| 真 Chrome 标题为 `/First 99 0 R` | exit 3：`找不到 大纲条目 对象 99 0 R`（`refOf` 在标题文本里捡到 `/First`） | **BLOCKER（同一根因）** |
| 真 Chrome 标题为 `/Next 77 0 R` | exit 3：`找不到 大纲条目 对象 77 0 R` | **BLOCKER（同一根因）** |
| 标题含 `) (` `\` `<< >>`、`/Count 99`、emoji/代理对、`trailer`、`startxref`、`99 0 obj` | 全部 exit 0，条数正确 2/2 | 否 |
| 150 条书签 | `--json.outline`=150、oracle 实走=150、`/Count`=150、页数 23 | 否 |
| `/Info` 里塞 `<< /Type /Outlines /Title (fake) /First 77 0 R /Count 9 >>` | `bookmarkCountOf`=1（正确，从 Catalog 的 `/Outlines` 进树） | 否 |
| 页面注释里出现 `trailer << /Root 99 0 R >>`（在真 trailer 之前） | =1（取最后一个 trailer，正确） | 否 |
| **注释出现在真 trailer 之后** `% trailer << /Root 99 0 R >>` | `render_empty`：`找不到 Catalog 对象 99 0 R`（"最后一个 trailer"启发式被注释骗到） | 低危（Chrome 不产注释；但说明启发式不严谨） |
| `/Count 0` 但树非空 | `render_empty`（正确） | 否 |
| `/Count` 比实走大 | `render_empty`（正确） | 否 |
| 0 字节输入 / 非 PDF 文本改 `.pdf` / HTML 改 `.pdf` 喂 `hr pdf` | 前三者都先被 HTML 入口拦下：`源文档里没有 <article>，无法导出打印稿` exit 1；HTML 改名的内容本身是合法源，正常出 PDF | 否（既有文案保留） |
| 空字节 / 非 PDF 字节经假 render 喂命令层 | 既有单测 `pdf-command.test.ts:194/205` 覆盖，`render_empty` + 既有文案 | 否 |
| 可观测性：拿上面真实的 `endobj` 失败看 message | 只给 `/Count 自报 2 条，实走 1 条`，指不到"标题文本被当结构"这一层；用户无法自查 | 次要 UX 缺陷 |

## 4. 新增测试 / verify

- **我没有在仓里新增或修改任何测试**（发现的是 src 缺陷，落一条红测试会让 `pnpm verify` 变红；证据用 `/tmp/hr-g3/` 下的可复现脚本与真实产物提供，未入库）。
- 复现命令：`node --experimental-strip-types packages/cli/src/main.ts pdf <print.html>`，源文档 `<h1>endobj</h1><p>x</p><h1>Second</h1>`。
- `pnpm verify`：**EXIT=0**，尾部
```
 Test Files  261 passed (261)
      Tests  2913 passed (2913)
All files          |     100 |      100 |      100 |      100 |
$ depcruise … ✔ no dependency violations found (563 modules, 2355 dependencies cruised)
$ knip
```
- 工作树：未改 src/docs、未 commit；`git status` 仅 F1 原有改动。

## 5. 一句话结论

**`src` 必须返工**：`packages/cli/src/pdf/bookmarks.ts` 用正则直接扫对象体，Chrome 写出的 `/Title` 字面串里的 `endobj` / `/First …` / `/Next …` 会被当成结构，导致**合法文档（标题含这些字样）exit 3、整份 PDF 不落盘**——这是 BLOCKER；修法应让对象/键匹配跳过括号字符串（至少 `(/Title)` 与流），并为该场景补一条真机或手写字节回归测试；`/Count` 强一致核对本身在真实嵌套大纲上正确（8/8/8/8），不需放宽。