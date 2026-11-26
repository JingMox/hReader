// This layer covers `llm/session` value rules (defaults, blank counts as unset, URL trailing slash); no requests sent.

import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { apiKeyOf, baseUrlOf, modelOf, normalizeBaseUrl, sessionIdOf } from "../src/llm/session";

describe("llm/session · address normalization", () => {
  it("should strip every trailing slash and surrounding blanks", () => {
    expect(normalizeBaseUrl(" https://proxy.test/v1/// ")).toBe("https://proxy.test/v1");
  });

  it("should refuse anything that is not an absolute http(s) url", () => {
    // These values make `fetch` throw a TypeError, which gets wrapped as llm_failure + misleading "run it again" copy.
    for (const text of ["  ", "/", "v1", "::bad", "ftp://x/v1", "file:///tmp/v1"]) {
      expect(() => normalizeBaseUrl(text)).toThrow(HrError);
      expect(() => normalizeBaseUrl(text)).toThrow(/base url 必须是 http\(s\) 绝对地址/u);
    }
  });
});

describe("llm/session · defaults", () => {
  it("should fall back to the Zen gateway and the pinned model", () => {
    expect(baseUrlOf({})).toBe("https://opencode.ai/zen/go/v1");
    expect(modelOf({})).toBe("deepseek-v4.1-flash");
  });

  it("should treat a blank env value as absent", () => {
    expect(apiKeyOf({ OPENCODE_API_KEY: "   " })).toBeUndefined();
    expect(apiKeyOf({})).toBeUndefined();
    expect(baseUrlOf({ HR_LLM_BASE_URL: "" })).toBe("https://opencode.ai/zen/go/v1");
    expect(modelOf({ HR_LLM_MODEL: "" })).toBe("deepseek-v4.1-flash");
  });

  it("should take the env overrides, trimming the key", () => {
    expect(apiKeyOf({ OPENCODE_API_KEY: " sk-env " })).toBe("sk-env");
    expect(baseUrlOf({ HR_LLM_BASE_URL: "https://proxy.test/v1/" })).toBe("https://proxy.test/v1");
    expect(modelOf({ HR_LLM_MODEL: "other-model" })).toBe("other-model");
  });
});

describe("llm/session · session id", () => {
  it("should take HR_LLM_SESSION when given", () => {
    expect(sessionIdOf({ HR_LLM_SESSION: "run-42" })).toBe("run-42");
  });

  it("should mint a UUID per call when absent", () => {
    const id = sessionIdOf({});

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    // No caching: each run gets its own session, never reused across processes.
    expect(sessionIdOf({})).not.toBe(id);
  });
});
