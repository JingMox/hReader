// This layer: the HTTP implementation of `LlmPort` (the only place in `src/` that makes network requests); no prompts, no retries, no disk.

import { HrError } from "@hreader/core";
import type { ExtractStyleLlmInput } from "@hreader/core";

/** The transport interface is not exported on its own: cli only needs the shape of that field on `ExtractStyleLlmInput`, not a copy of core's interface. */
export type LlmPort = ExtractStyleLlmInput["llm"];

/** Hard cap for a single request, with **no automatic retry** (writes are not idempotent and spend real money). */
export const LLM_TIMEOUT_MS = 30_000;

/** Only this much of the response is kept in error messages: enough to locate the problem without dumping the whole response into logs and `--json`. */
const SNIPPET_CHARS = 200;

/** Same order as `PROMPT_MAX_CORPUS_BYTES` (64 KiB), so one call cannot grow into an unbounded bill. */
const MAX_TOKENS = 2048;

export interface LlmClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
  /** Typed as global `fetch` rather than a bespoke signature: a fake fetch injected by tests stays a "subset of real fetch". */
  readonly fetch: typeof globalThis.fetch;
}

interface Exchange {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Collapse to one line, then truncate: newlines in a response body would scatter one error across several stderr lines. */
const snippetOf = (text: string): string => text.replace(/\s+/gu, " ").slice(0, SNIPPET_CHARS);

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Only `choices[0].message.content` counts, and only as a non-empty string: an empty completion is no completion.
 * The shape check comes first to "fail early" (the error can carry the HTTP status), not to parse the body for core. */
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
  // An OpenCode Zen routing requirement: the request 400s without this header — it is not optional telemetry.
  "x-opencode-session": config.sessionId,
});

/** Network-layer failures (timeout, truncated body reads) all fold into `llm_failure`: from the user's view it is just "no response". */
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
    // Hand back the whole body (not just content): `suggestionsOf` parses the OpenAI shape itself — the port does not interpret it.
    return exchange.text;
  },
});
