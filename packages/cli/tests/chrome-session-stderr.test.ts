// 这层管：stderr 洪流下的缓冲上限与监听器回收（§15.3）；不测 Chrome 渲染本身。
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chromeDepsOf, chromeProcessOf, renderPdfOf, stderrBufferOf } from "../src/chrome/session";
import { responderOf, VERSION_TEXT } from "./chrome-helpers";
import { NEVER } from "./chrome-session-setup";

const FAKE_CHROME = fileURLToPath(new URL("../fixtures/fake-chrome.mjs", import.meta.url));

describe("stderr 缓冲", () => {
  it("单块 5 MB 只保留前 64 KiB", () => {
    expect(stderrBufferOf("", "x".repeat(5 * 1024 * 1024))).toHaveLength(65536);
  });

  it("跨块追加也在 65536 处截断", () => {
    expect(stderrBufferOf("y".repeat(65_000), "z".repeat(100_000))).toHaveLength(65536);
  });

  it("已满 64 KiB 后不再继续拼接", () => {
    const full = "x".repeat(65_536);
    expect(stderrBufferOf(full, "tail")).toBe(full);
  });
});

describe("renderPdfOf · stderr 洪流", () => {
  it("DevTools 行仍能解析，结束后 stderr 监听器归零", async () => {
    const base = chromeDepsOf({ HREADER_CHROME: FAKE_CHROME });
    let child: ChildProcess | undefined;
    const deps = {
      ...base,
      killGraceMs: 5,
      spawn: (file: string, args: readonly string[], options: SpawnOptions) => {
        child = spawn(file, [...args], { ...options, env: { ...process.env, FAKE_MODE: "flood" } });
        return chromeProcessOf(child);
      },
      fetchText: () => Promise.resolve(VERSION_TEXT),
      connect: () => responderOf({}).transport,
    };
    const result = await renderPdfOf({
      html: "<p>x</p>",
      pageSize: "a4",
      stop: NEVER,
      timeoutMs: 5000,
      deps,
    });
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(child?.stderr?.listenerCount("data")).toBe(0);
  }, 10_000);
});
