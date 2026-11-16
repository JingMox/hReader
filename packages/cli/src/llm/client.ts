// 这层管：`LlmPort` 的 HTTP 实现（`src/` 里唯一发网络请求的地方）；不含提示词、不重试、不落盘。

import { HrError } from "@hreader/core";
import type { ExtractStyleLlmInput } from "@hreader/core";

/** 传输层接口不单独公开：cli 只取 `ExtractStyleLlmInput` 上那个字段的形状，不复制 core 的接口。 */
export type LlmPort = ExtractStyleLlmInput["llm"];

/** 卡 D7：单次请求的硬上限，且**不自动重试**（写盘非幂等 + 费用不可控）。 */
export const LLM_TIMEOUT_MS = 30_000;

/** 错误消息里只留这么长的响应片段：够定位，又不至于把整份响应灌进日志与 `--json`。 */
const SNIPPET_CHARS = 200;

/** 与 `PROMPT_MAX_CORPUS_BYTES`（64 KiB）同一量级，防止一次调用撑成天价（卡 §10 R6）。 */
const MAX_TOKENS = 2048;

export interface LlmClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
  /** 用全局 `fetch` 的类型而不是另立签名：测试注入的假 fetch 因此仍是"真 fetch 的子集"。 */
  readonly fetch: typeof globalThis.fetch;
}

interface Exchange {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 压成一行再截断：响应体里的换行会让一条错误在 stderr 上散成好几行。 */
const snippetOf = (text: string): string => text.replace(/\s+/gu, " ").slice(0, SNIPPET_CHARS);

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** 只认 `choices[0].message.content` 且必须是非空字符串：空补全等于没有补全。
 * 这里先看形状是为了"提前失败"（错误里能带 HTTP 状态），不是替 core 解析 body。 */
const contentOf = (body: unknown): string | undefined => {
  const choices = isRecord(body) ? body["choices"] : undefined;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(choice) ? choice["message"] : undefined;
  const content = isRecord(message) ? message["content"] : undefined;
  if (typeof content !== "string" || content.trim() === "") return undefined;
  return content;
};

const headersOf = (config: LlmClientConfig): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${config.apiKey}`,
  "content-type": "application/json",
  // OpenCode Zen 的路由要求：缺了这个头直接 400，不是可选的遥测字段（D6）。
  "x-opencode-session": config.sessionId,
});

/** 网络层失败（含超时、body 读取中断）统一成 `llm_failure`：用户只看得到"没拿到响应"。 */
const exchangeOf = async (config: LlmClientConfig, prompt: string): Promise<Exchange> => {
  try {
    const response = await config.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headersOf(config),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        stream: false,
        max_tokens: MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error: unknown) {
    throw new HrError("llm_failure", `LLM 请求没有完成：${String(error)}`);
  }
};

export const createLlmClient = (config: LlmClientConfig): LlmPort => ({
  complete: async (prompt: string): Promise<string> => {
    const exchange = await exchangeOf(config, prompt);
    const detail = `HTTP ${String(exchange.status)}：${snippetOf(exchange.text)}`;
    if (!exchange.ok) throw new HrError("llm_failure", `LLM 返回了错误状态（${detail}）`);
    if (contentOf(jsonOf(exchange.text)) === undefined) {
      throw new HrError("llm_failure", `LLM 响应里没有 choices[0].message.content（${detail}）`);
    }
    // 交回整份 body（不是 content）：`suggestionsOf` 的解析入口就是 OpenAI 形状，port 不解释它。
    return exchange.text;
  },
});
