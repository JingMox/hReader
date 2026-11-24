// 这层管：`llm/client` 的 HTTP 契约（请求形状、形状校验、超时、不泄漏）；不打真网络。

import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { createLlmClient, LLM_TIMEOUT_MS, type LlmClientConfig } from "../src/llm/client";
import { fetchBodyOf, fetchUrlOf } from "./harness";

const BODY = { choices: [{ message: { content: "{}" } }] };

const configOf = (
  fetch: typeof globalThis.fetch,
  overrides: { readonly timeoutMs?: number } = {},
): LlmClientConfig => ({
  apiKey: "sk-test-LEAKCANARY",
  baseUrl: "https://llm.test/v1",
  model: "test-model",
  sessionId: "session-1",
  timeoutMs: overrides.timeoutMs ?? LLM_TIMEOUT_MS,
  fetch,
});

/** 只回一份固定响应：`body` 是原文，所以非 JSON / 空串都能照原样喂进去。 */
const responseOf =
  (body: string, status = 200): typeof globalThis.fetch =>
  () =>
    Promise.resolve(new Response(body, { status }));

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

const recordingOf = (
  body: string,
  status = 200,
): { sent: Sent[]; fetch: typeof globalThis.fetch } => {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    sent.push({ url: fetchUrlOf(input), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  };
  return { sent, fetch };
};

const failureOf = async (fetch: typeof globalThis.fetch, timeoutMs?: number): Promise<HrError> => {
  try {
    await createLlmClient(configOf(fetch, timeoutMs === undefined ? {} : { timeoutMs })).complete(
      "hi",
    );
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("期望抛出 HrError，但调用成功了");
};

describe("llm/client · 请求形状", () => {
  const sendOnce = async (): Promise<{ text: string; sent: Sent[] }> => {
    const recorder = recordingOf(JSON.stringify(BODY));
    const text = await createLlmClient(configOf(recorder.fetch)).complete("提示词");
    return { text, sent: recorder.sent };
  };

  it("should post to /chat/completions with the routing header and return the raw body", async () => {
    const { text, sent } = await sendOnce();

    expect(text).toBe(JSON.stringify(BODY));
    expect(sent[0]?.url).toBe("https://llm.test/v1/chat/completions");
    expect(sent[0]?.init.method).toBe("POST");
    expect(sent[0]?.init.headers).toMatchObject({
      authorization: "Bearer sk-test-LEAKCANARY",
      "content-type": "application/json",
      // 缺了这个头 Zen 网关直接 400。
      "x-opencode-session": "session-1",
    });
    expect(JSON.parse(fetchBodyOf(sent[0]?.init))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "提示词" }],
      temperature: 0,
      stream: false,
      max_tokens: 2048,
    });
    expect(sent[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("llm/client · 失败面", () => {
  it("should fail with llm_failure on a 500", async () => {
    const error = await failureOf(responseOf('{"error":"boom"}', 500));

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain('{"error":"boom"}');
  });

  it("should fail on a 500 even when the body is a valid completion", async () => {
    // 只看 body 形状的实现会把这一条误判为成功：HTTP 状态才是失败依据。
    const error = await failureOf(responseOf(JSON.stringify(BODY), 500));

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("HTTP 500");
  });

  it("should fail when a 200 body has no choices", async () => {
    const error = await failureOf(responseOf('{"foo":1}'));

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("choices[0].message.content");
  });

  it("should fail when the body is not JSON", async () => {
    const error = await failureOf(responseOf("<html>gateway</html>"));

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("<html>gateway</html>");
  });
});

describe("llm/client · 空流与超时", () => {
  it("should fail when content is not a string, and on an empty stream", async () => {
    const numeric = await failureOf(responseOf('{"choices":[{"message":{"content":42}}]}'));
    const empty = await failureOf(responseOf(""));

    expect(numeric.code).toBe("llm_failure");
    expect(empty.code).toBe("llm_failure");
    expect(empty.message).toContain("HTTP 200");
  });

  it("should abort through the signal when the fake transport hangs", async () => {
    const hanging: typeof globalThis.fetch = (_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };

    // 10 ms 注入，别真等 30 s：断言的是"signal 真接进 fetch"，不是墙钟时长。
    const error = await failureOf(hanging, 10);

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("LLM 请求没有完成");
  });
});

describe("llm/client · 不泄漏", () => {
  it("should truncate the snippet and never print the key", async () => {
    const error = await failureOf(responseOf(`{"x":"${"长".repeat(500)}"}`, 502));

    expect(error.message.length).toBeLessThan(400);
    expect(error.message).not.toContain("sk-test-LEAKCANARY");
    // 截断只留前 200 字符：够定位，又不至于把整份响应灌进日志。
    expect(error.message.length).toBeLessThan(320);
    expect(error.message).not.toContain("长".repeat(201));
  });

  it("should never print the key when the transport itself throws", async () => {
    const throwing: typeof globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));

    const error = await failureOf(throwing);

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message).not.toContain("sk-test-LEAKCANARY");
  });
});
