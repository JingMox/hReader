# fixtures/llm/

真模型响应体的回放数据（D12：`pnpm verify` 里零真实调用）。文件名即测试里的用途。

| 文件           | 来源（2026-11-16，`deepseek-v4.1-flash`，2 篇语料 `fixtures/extract/*.md`）                                                                               | 手工加工                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ok.json`      | `finish_reason: stop`，usage `{prompt: 2991, completion: 1441, reasoning: 859}`；content 是裸 JSON                                                        | 无                                                                                                         |
| `fenced.json`  | content 取自 `ok.json` 那次调用                                                                                                                           | **仅**在 content 首尾各加一行 ` ```json ` / ` ``` `，content 一个字符未改；用于钉 `parseJsonOf` 的围栏分支 |
| `dropped.json` | `finish_reason: stop`，usage `{prompt: 8821, completion: 1431, reasoning: 888}`；3 篇语料那次调用，content 之外多一个不归风格所有的键（链路 `dropped 1`） | 无                                                                                                         |

重录方法见 `packages/cli/scripts/record-llm-fixture.ts`（一次性脚本，`pnpm verify` 永不执行）。fixture 依赖 model id：换模型或改 prompt 都要重录，否则回放证明的不再是"今天的模型输出能被吃下"。
