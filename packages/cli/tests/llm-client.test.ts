// This layer covers `llm/client`'s HTTP contract (request shape, shape validation, timeout, no leakage); no real network.

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

/** Always reply with one fixed response: `body` is raw text, so non-JSON / empty strings can be fed in verbatim. */
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
  throw new Error("expected an HrError, but the call succeeded");
};

describe("llm/client · request shape", () => {
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
      // Without this header the Zen gateway answers 400 directly.
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

describe("llm/client · failure surface", () => {
  it("should fail with llm_failure on a 500", async () => {
    const error = await failureOf(responseOf('{"error":"boom"}', 500));

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain('{"error":"boom"}');
  });

  it("should fail on a 500 even when the body is a valid completion", async () => {
    // An implementation that only checks body shape would misjudge this one as success: HTTP status is the failure signal.
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

describe("llm/client · empty body and timeout", () => {
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

    // 10 ms injected — do not really wait 30 s: what is asserted is "the signal really reaches fetch", not wall-clock time.
    const error = await failureOf(hanging, 10);

    expect(error.code).toBe("llm_failure");
    expect(error.message).toContain("LLM 请求没有完成");
  });
});

describe("llm/client · no leakage", () => {
  it("should truncate the snippet and never print the key", async () => {
    const error = await failureOf(responseOf(`{"x":"${"长".repeat(500)}"}`, 502));

    expect(error.message.length).toBeLessThan(400);
    expect(error.message).not.toContain("sk-test-LEAKCANARY");
    // Truncation keeps the first 200 chars: enough to locate, without pouring the whole response into the log.
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
