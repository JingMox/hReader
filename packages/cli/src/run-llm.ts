// 这层管：`style extract` 的 LLM 传输层装配（env 默认值 + flag 覆盖 + 网络注入点）；`run.ts` 只做分发。
// 拆成独立文件是为了守住 `max-lines: 300`（本仓硬门禁），语义没有变化。

import type { Intent } from "./args";
import { LLM_TIMEOUT_MS, createLlmClient, type LlmPort } from "./llm/client";
import { baseUrlOf, modelOf, normalizeBaseUrl, sessionIdOf } from "./llm/session";

/** 传输层只在这里构造：`commands/*` 不许碰 env，网络实现也不该知道 flag 从哪来。 */
export const llmOf = (
  intent: Extract<Intent, { kind: "styleExtract" }>,
  fetch: typeof globalThis.fetch | undefined,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): LlmPort =>
  createLlmClient({
    apiKey: key,
    baseUrl: normalizeBaseUrl(intent.baseUrl ?? baseUrlOf(env)),
    model: intent.model ?? modelOf(env),
    sessionId: sessionIdOf(env),
    timeoutMs: LLM_TIMEOUT_MS,
    fetch: fetch ?? globalThis.fetch,
  });
