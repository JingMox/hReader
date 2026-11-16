// 这层管：LLM 配置的取值口径（env → 值 + 默认值集中在文件头）；不读 `process.env`、不发请求。

import { HrError } from "@hreader/core";

/** OpenCode Zen 的兼容网关：默认值；`--base-url` / `HR_LLM_BASE_URL` 可指向自建或代理。 */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";

const DEFAULT_MODEL = "deepseek-v4.1-flash";

type Env = Readonly<Record<string, string | undefined>>;

/** 空白值等于没给：`KEY=""` 是常见的 shell 事故，不能当"有 key"用（D2 的降级会因此失效）。 */
const valueOf = (env: Env, key: string): string | undefined => {
  const text = env[key]?.trim();
  return text === undefined || text === "" ? undefined : text;
};

/** D6：会话头是 OpenCode Zen 的路由键；没指定就每次调用生成一个 UUID（无状态，跨进程不复用）。 */
export const sessionIdOf = (env: Env): string =>
  valueOf(env, "HR_LLM_SESSION") ?? crypto.randomUUID();

export const apiKeyOf = (env: Env): string | undefined => valueOf(env, "OPENCODE_API_KEY");

/**
 * 请求 URL 由 `${baseUrl}/chat/completions` 拼出：尾部斜杠要去掉（`v1/` 会拼成 `v1//chat`），
 * 空值与非 http(s) 绝对地址要拒（否则 `fetch` 抛 TypeError，被误分类成 llm_failure）。
 * env 与 `--base-url` 共用这一处，免得两套裁剪规则。
 */
export const normalizeBaseUrl = (text: string): string => {
  const trimmed = text.trim().replace(/\/+$/u, "");
  // 非绝对 http(s) 地址会让 `fetch` 抛 TypeError，最后被包成 llm_failure + "重跑一次"的误导文案。
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : undefined;
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new HrError("invalid_input", `base url 必须是 http(s) 绝对地址：${text}`);
  }
  return trimmed;
};

export const baseUrlOf = (env: Env): string =>
  normalizeBaseUrl(valueOf(env, "HR_LLM_BASE_URL") ?? DEFAULT_BASE_URL);

export const modelOf = (env: Env): string => valueOf(env, "HR_LLM_MODEL") ?? DEFAULT_MODEL;
