// This layer covers the stderr-flood buffer cap and listener cleanup; it does not test Chrome rendering itself.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chromeProcessOf, stderrBufferOf } from "../src/chrome/process";
import { chromeDepsOf, renderPdfOf } from "../src/chrome/session";
import { fakeBrowserOf, fakePageOf } from "./chrome-helpers";
import { NEVER } from "./chrome-session-setup";

const FAKE_CHROME = fileURLToPath(new URL("../fixtures/fake-chrome.mjs", import.meta.url));

describe("stderr buffering", () => {
  it("should keep only the first 64 KiB of a single 5 MB chunk", () => {
    expect(stderrBufferOf("", "x".repeat(5 * 1024 * 1024))).toHaveLength(65536);
  });

  it("should still truncate at 65536 when appending across chunks", () => {
    expect(stderrBufferOf("y".repeat(65_000), "z".repeat(100_000))).toHaveLength(65536);
  });

  it("should stop appending once 64 KiB is full", () => {
    const full = "x".repeat(65_536);
    expect(stderrBufferOf(full, "tail")).toBe(full);
  });
});

describe("renderPdfOf · stderr flood", () => {
  it("should still parse DevTools lines and leave zero stderr listeners afterwards", async () => {
    const base = chromeDepsOf({ HREADER_CHROME: FAKE_CHROME });
    let child: ChildProcess | undefined;
    const deps = {
      ...base,
      killGraceMs: 5,
      spawn: (file: string, args: readonly string[], options: SpawnOptions) => {
        child = spawn(file, [...args], { ...options, env: { ...process.env, FAKE_MODE: "flood" } });
        return chromeProcessOf(child);
      },
      connect: () => Promise.resolve(fakeBrowserOf(fakePageOf({ pages: 1 }))),
    };
    const result = await renderPdfOf({
      source: { kind: "sheet", html: "<p>x</p>" },
      pageSize: "a4",
      outline: true,
      preferCSSPageSize: false,
      stop: NEVER,
      timeoutMs: 5000,
      deps,
    });
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(child?.stderr?.listenerCount("data")).toBe(0);
  }, 10_000);
});
