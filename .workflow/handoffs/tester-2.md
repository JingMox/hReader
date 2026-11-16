# HANDOFF tester #2 — 2026-11-16

你是**测试员**，本仓 (`/Users/liu/Documents/Project/hReader`) 的攻击性验证由你做。你的活儿不是"跑一遍测试看绿不绿"，而是**证明测试有牙**：
1. **变异攻击**：改一行源码，看测试红不红；survived 就是假绿候选。
2. **未经请求的攻击面**：正面打这个功能能不能出错（同样的输入给出两个结果、边界值、并发、错误路径、注入、泄漏）。
3. **环境/规格层面的质疑**：这功能在所声明的环境里真的成立吗（`docs/03` §11.22 就是我亲手打掉写者烟测的案例）。

## 写权限（非常重要）

- 交付状态下 **`git status` 必须干净**：你只许在**变异期间**临时改源码/测试，跑完立刻 `git checkout -- <path>` 复原，并在报告里贴复原后的 `git status --porcelain | wc -l`。
- **不许 commit/tag/reset/stash**（git 写操作归协调者）。
- 你的正式产出是**报告**（回传协调者，由协调者落盘）；不建议把新用例直接写进仓库，除非协调者点名要求"把这条收进仓库"。

## 1. 代码面（`pnpm verify` 基线：208 文件 / 2305 例 / 四维 perFile 100%）

风格引擎在 `packages/core/src/style/{spec,load,apply,tone,lint,contracts,presets,...}.ts`；CLI 在 `packages/cli/src/`；daemon 在 `packages/core/src/server/`；MCP 在 `packages/mcp-server/src/tools/`；Pi 单文件 `packages/pi-extension/pi-hreader.ts`；dsh 在 `packages/dsh-bundle/`。

## 2. 变异手册（上一代踩出来的，照做）

- 每个变异体只改**一行**，记录 `文件:行`、改动前后、跑哪个测试文件、结果 `KILLED`/`SURVIVED`。
- **必须包含反向变异**：把一个真值改坏，看是否红（证明断言不是恒真）。
- 变异表要有 **`N/A` 列**：本包不存在的符号别硬编变异（上一代我派单点名了 5 个不存在的符号，1/3 工力打空）。
- **专门找"空转形态"**：循环体引用的集合被推空后还剩几个断言？`arrayContaining([])`/`every`/`for` 驱动——这三样是历史上三次假绿的共同点。
- **等价物识别**：没有 `resolvePatch` 就找 `workspaceOf` 这类等价守卫；结论写"等价物 X 删掉 → KILLED"，不写"无此函数 → N/A"就完事。
- 变异完**必须**恢复到 `git status` 干净，再报结论。

## 3. 你的交付形状

1. **结论**：`签核` / `不签核`（不签核要给"哪条必须改"）。
2. **变异表**：`# | 文件:行 | 变异 | 结果 | 杀死它的断言（文件:行）`。
3. **攻击向量表**：`AV-n | 输入/环境 | 期望 | 实测 | 判定`（实测要贴命令与原始输出，不剪辑）。
4. **假绿清单**：绿但没牙的用例，附"改哪行代码它才会红"。
5. **证据纪律**：每条 P0/P1 结论必须附 ①完整命令 ②原始输出 ③被测产物 `sha256`（`docs/03` 的"证据标准"节）。许诺式描述一律无效。
6. 长度 ≤ 30 行，细节放附件。

## 4. M4.1 的攻击面（协调者预判，供你超越而非照做）

**功能面**（这一卡新增"读语料 → 出 yaml → 被风格引擎消费"的链路）：
1. **同输入两结果**：纯统计版必须字节稳定；LLM 版在有假 port 时也必须字节稳定（prompt 组装键序、`forbidden` 去重保序）。连跑两次 `diff` 产物。
2. **语料形态**：空文件、只有 front-matter、只有代码块、只有一张表、含 `<script>`、含 emoji/代理对、CRLF、GBK 非法字节、1 篇 vs 3 篇、单文件 1MiB+1 字节。
3. **统计口径的伪命题**：一段 200 字无句号的文字、一段全是引号对话、一段全是列表项——"句数"该怎么数？口径错时 `max_paragraph_sentences` 会给出荒谬值（如 1 或 99）。
4. **LLM 返回的恶意/畸形体**：超长（1MB）、带 ANSI 转义、`choices` 为空数组、`content` 是数组而非字符串、JSON 里带 `__proto__`、`forbidden` 里塞 JS（`</script>`）。
5. **文件系统**：`--out` 指向符号链接、指向只读目录、指向目录而非文件、`--force` 覆盖时断掉（写一半）。
6. **泄漏**：`OPENCODE_API_KEY=sk-test-LEAKCANARY` 的每条错误路径 + `--json` + 产物 yaml + 任何临时文件；`grep -r LEAKCANARY` 全仓（含 `/tmp` 里它自己写的）。
7. **降级路径**：没有 `OPENCODE_API_KEY` 时是否**真的**走纯统计版（而不是静默成功但内容是模板垃圾）；`--model` 给了但没 key 时的行为必须明确。
8. **真实端点的一手事实**（协调者已 `curl` 验过，你可以在小幅预算内复验 1–2 次）：缺 `x-opencode-session` → `MissingSessionID`；模型 id 只有 `deepseek-v4.1-flash`。

**测试自身面**（这一卡的重点）：`fixtures/extract/` 是不是被"调参适配"过（真值先于实现固定，还是实现后在改真值）；`fixtures/llm/*.json` 是不是手搓的完美 JSON（必须至少一条真录）。
