// This layer: how LLM config values resolve (env -> value + defaults collected at the top); never reads `process.env`, never sends requests.

import { HrError } from "@hreader/core";

/** OpenCode Zen's compatible gateway: the default; `--base-url` / `HR_LLM_BASE_URL` can point at self-hosted or a proxy. */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";

const DEFAULT_MODEL = "deepseek-v4.1-flash";

type Env = Readonly<Record<string, string | undefined>>;

/** A blank value counts as unset: `KEY=""` is a common shell accident and must not count as "has key" (degradation would silently break). */
const valueOf = (env: Env, key: string): string | undefined => {
  const text = env[key]?.trim();
  return text === undefined || text === "" ? undefined : text;
};

/** The session header is OpenCode Zen's routing key; unspecified, each call generates a fresh UUID (stateless, not reused across processes). */
export const sessionIdOf = (env: Env): string =>
  valueOf(env, "HR_LLM_SESSION") ?? crypto.randomUUID();

export const apiKeyOf = (env: Env): string | undefined => valueOf(env, "OPENCODE_API_KEY");

/**
 * The request URL is built as `${baseUrl}/chat/completions`: trailing slashes are stripped (`v1/` would build
 * `v1//chat`), and empty or non-http(s) absolute URLs are refused (otherwise `fetch` throws TypeError,
 * misclassified as llm_failure).
 * env and `--base-url` share this one place so there is only one set of trimming rules.
 */
export const normalizeBaseUrl = (text: string): string => {
  const trimmed = text.trim().replace(/\/+$/u, "");
  // A non-absolute http(s) URL makes `fetch` throw TypeError, ending up wrapped as llm_failure plus misleading "just retry" text.
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : undefined;
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new HrError("invalid_input", `base url 必须是 http(s) 绝对地址：${text}`);
  }
  return trimmed;
};

export const baseUrlOf = (env: Env): string =>
  normalizeBaseUrl(valueOf(env, "HR_LLM_BASE_URL") ?? DEFAULT_BASE_URL);

export const modelOf = (env: Env): string => valueOf(env, "HR_LLM_MODEL") ?? DEFAULT_MODEL;
