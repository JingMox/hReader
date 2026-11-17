# fixtures/llm/

真模型响应体的回放数据（D12：`pnpm verify` 里零真实调用）。文件名即测试里的用途。

| 文件           | 来源（2026-11-16，`deepseek-v4.1-flash`）                                                                                                                 | 手工加工                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ok.json`      | `finish_reason: stop`，usage `{prompt: 2991, completion: 1441, reasoning: 859}`；content 是裸 JSON                                                        | 无                                                                                                         |
| `fenced.json`  | content 取自 `ok.json` 那次调用                                                                                                                           | **仅**在 content 首尾各加一行 ` ```json ` / ` ``` `，content 一个字符未改；用于钉 `parseJsonOf` 的围栏分支 |
| `dropped.json` | `finish_reason: stop`，usage `{prompt: 8821, completion: 1431, reasoning: 888}`；3 篇语料那次调用，content 之外多一个不归风格所有的键（链路 `dropped 1`） | 无                                                                                                         |

重录方法见 `packages/cli/scripts/record-llm-fixture.ts`（一次性脚本，`pnpm verify` 永不执行）。fixture 依赖 model id：换模型或改 prompt 都要重录，否则回放证明的不再是"今天的模型输出能被吃下"。

## 调用账（D12：预算 10 次）

计数口径：录制脚本**每执行一次 = 一次上游调用**（脚本内只调一次 `complete`）。下表是 2026-11-16 那次录制会话的全部执行，时间取日志时间戳；`--out` 即日志里的实参。脚本先把响应体写盘、再交给 core 校验，所以"core 判 `llm_failure`"的行**也花了钱、也可能留下 body**——`ok.json` 的 body 就来自第 1 次（以最终落盘内容与 `usage.prompt_tokens: 2991` 为准；同一次执行退出非 0 与 body 可用并不矛盾，校验发生在写盘之后）。

| #   | 时间  | 语料                                                               | 用途                             | 结果                                                                                                                                                                  |
| --- | ----- | ------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 22:31 | `docs-03` + `docs-05` + `style-authoring`                          | `--out fixtures/llm/ok.json`     | body 已落盘、本次执行以 `llm_failure` 退出（日志只留了 `code 3`，未细分原因）→ 保留该 body 为 `ok.json`：今日回放 `code 0`、persona “工程笔记”                        |
| 2   | 22:32 | `docs-05-m33` 单篇                                                 | `--out fixtures/llm/ok.json`     | 同上，`llm_failure`；body 被覆盖，弃                                                                                                                                  |
| 3   | 22:33 | 三篇                                                               | `--out fixtures/llm/fenced.json` | `llm_failure`，弃                                                                                                                                                     |
| 4   | 22:34 | 三篇                                                               | `--out /tmp/ignored.json`        | HTTP 200 但 `choices[0].message.content` 取不到，`llm_failure`，弃                                                                                                    |
| 5   | 22:34 | `/tmp/corpus-fenced.md`（加围栏引导语料）                          | `--out fixtures/llm/fenced.json` | `llm_failure`，弃                                                                                                                                                     |
| 6   | 22:36 | `style-authoring` + `docs-03` + `/tmp/corpus-fenced.md`            | `--out fixtures/llm/fenced.json` | **成功**（`已录制 … dropped 1 条`，`reasoning_tokens: 888`）→ body 保留为 `dropped.json`（同一次调用）；`fenced.json` 另由 `ok.json` 的 body 加围栏行复制（0 次调用） |
| 7   | 22:36 | `docs-05-m33` + `style-authoring` + `/tmp/corpus-fenced-strong.md` | `--out /tmp/fenced-try.json`     | 成功但 content 无围栏，弃                                                                                                                                             |
| 8   | 22:37 | `style-authoring` + `docs-03` + `/tmp/corpus-fenced-strong.md`     | `--out /tmp/fenced-try2.json`    | 成功但 content 无围栏，弃                                                                                                                                             |

合计 **8 次**（预算 10），其中 1 次产出最终保留的 `dropped.json`、1 次的 body 成为 `ok.json`、`fenced.json` 为 `ok.json` 的 0 调用加工件。此后的复验轮（测试员 2026-11-17）另发生约 5 次误用真 key 的调用，不属本账，记在卡 §9。
