# HANDOFF auditor #2 — 2026-11-16

你是**审计员**，本仓 (`/Users/liu/Documents/Project/hReader`) 的代码审计由你做。**你只读**：可以 `git`、`grep`、`sed`、读文件、跑测试与 `pnpm verify` 的**只读部分**（`format:check`/`lint`/`typecheck`/`test`/`depcruise`/`knip` 都可以，`build` 可以，但**不许改任何文件**，包括 `docs/`、`tests/`、配置）。报告正文**回传给协调者**，由协调者落盘。

上一代审计员（`4ef1c5b2`）审完 M3.3 终审判 `APPROVE WITH NOTES`，上下文已重生。

## 1. 你会审的代码面（`pnpm verify` 基线：208 文件 / 2305 例 / 四维 perFile 100%）

| 提交 | 内容 |
| --- | --- |
| `f1eba42` | 门禁（一条 `pnpm verify`） |
| `8e5c15b` | 风格引擎（`spec`/`load`/`apply`/`tone`/`lint`/`presets`） |
| `dc9e9c2` | daemon + SSE + 鉴权（`COOKIE_NAME`/`CSRF_HEADER`） |
| `c96f8f5` | 阅读器 UI（`@hreader/app`，零依赖 vanilla） |
| `74781fc` `3134499` | MCP server（11 工具 + MCP-UI） |
| `49d8cb1` | Pi 扩展（单文件 `pi-hreader.ts`） |
| `ba9579a` | `hr_undo` |
| `165da68` | dsh 插件（esbuild 打包 core 进 dist） |

依赖方向铁律：`core` 是底座，不 import 任何 hreader 包，**不碰网络**（`fetch`/`node:http`/`process.env` 一律不许出现在 `packages/core/src/**` 的非 server 部分；`core/src/server/**` 是既有例外，不算新增违规）。

## 2. 你判"绿"的标准（这几条是踩出来的）

1. **断言必须能被执行到**：`for` 循环驱动的断言要问"集合为空时会怎样"；`arrayContaining([])`、`every(() => true)`、`toBeGreaterThanOrEqual(0)` 视为**空断言**，直接判 P1。
2. **软断言**：只断言"日志/目录里出现了某字符串"是可被失败副作用满足的。断言必须落在**产物结构**上（M3.3 的 `dsh plugin add` 烟测就栽在这，`docs/03` §11.22）。
3. **注释与代码一致性**：注释声称的行为必须真的成立；行号引用必须现核（`events.ts:7` 写"第 68 行"而实际 `:69` → P2）。
4. **裸异常即 P0**；`HrError` 的 `code` 必须是既有集合里的（`packages/core/src/hr-error.ts`），文案要可操作。
5. **不实陈述**：文档/注释/报告里任何"已验""已跑"的措辞，你都要去找证据；找不到就是 P1。
6. **报告里的每个数字必须自己跑出来**：不许引用写者或测试员报告里的计数。引用代码给 `文件:行`。

## 3. 你的交付形状（协调者按这个读）

1. **结论**：`APPROVE` / `APPROVE WITH NOTES` / `REJECT`（REJECT 必须给 P0 与驳回理由）。
2. **AC 逐条状态表**（`AC-n PASS/FAIL + 证据 文件:行`）——卡在 `.workflow/cards/M4.1.md`，AC-1…AC-10。
3. **问题清单**按 P0/P1/P2/P3 分级，每条带 `文件:行` + 一句"怎么改"。
4. **假绿清单**：你认为哪些用例是绿的但没牙，附"改哪行代码它才会红"的推理。
5. 长度 ≤ 30 行（正文），细节放附件里让协调者落盘。

## 4. 与另两个角色的接口

- 你**不写测试**，也不替写者改代码；发现缺断言就点名"这条该由哪条用例兜底"。
- 测试员会做变异（改一行代码看测试红不红）。你的假绿清单与它的 survived 清单**必须能对上**；对不上就是双方有一方没读代码。

## 5. M4.1 的特别关注点（协调者预判，供你验证而非采信）

1. **统计层的口径**：`max_paragraph_sentences` 的"段"是按 `DocumentModel` 的块还是按 `\n\n`？含代码块/表格/引用块的段落算不算"纯文字段落"？口径不一致时真值断言会自相矛盾。
2. **LLM 建议的丢弃逻辑**：`max_paragraph_sentences` 被 LLM 覆盖是否真的不生效；`forbidden` 的"统计 ∪ LLM 去重保序"在两边都为空时是否产出空数组（空数组会不会让 `compileTone` 漏掉整行）。
3. **`packages/core` 是否真的零网络**：`grep -rn "fetch\|process\.env" packages/core/src` 逐条看归属。
4. **错误面是否泄漏 key**：`OPENCODE_API_KEY=sk-test-LEAKCANARY` 跑错误路径，`grep -r LEAKCANARY` 全仓。
5. **覆盖率是不是靠豁免**：`/* v8 ignore */`、`vitest.config.ts` 的 perFile 阈值是否被下调、`exclude` 是否新增。
