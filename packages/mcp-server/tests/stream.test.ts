// This layer: "does it die" on the protocol edge — broken input and oversized frames.
// Same rationale as `stdio.test.ts` (real artifact, real subprocess), but pinning two abnormal paths:
// ① malformed / unknown / missing-param / out-of-bounds all still get JSON-RPC frames, and logs only ever go to stderr;
// ② when a single frame overflows the SDK's 10MB `ReadBuffer`, the process must leave a stderr line instead of vanishing silently.

import { beforeAll, describe, expect, it } from "vitest";

import { isRecord } from "./harness";
import {
  BROKEN_INPUT,
  HANDSHAKE,
  HANDSHAKE_COUNT,
  binPathOf,
  buildDist,
  byIdOf,
  errorCodeOf,
  oversizedProbeOf,
  probeOf,
  resultOf,
  textOf,
} from "./probe";

beforeAll(buildDist, 180_000);

describe("dist/main.js · broken input", () => {
  it("should answer broken input with json-rpc frames and log the rest to stderr", async () => {
    const { lines, frames, stderrText, exitCode } = await probeOf(await binPathOf(), {
      lines: [...HANDSHAKE, ...BROKEN_INPUT],
      expected: HANDSHAKE_COUNT + 3,
    });
    const byId = byIdOf(frames);

    // ① Every line is still JSON-RPC: the SDK drops the malformed line outright (no -32700, no id:null),
    //    the process did not crash, and stdout gained no non-protocol text.
    expect(byId.has(null)).toBe(false);
    expect(frames.every((frame) => frame["jsonrpc"] === "2.0")).toBe(true);
    expect([...byId.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // ② The three bad inputs each get their answer: unknown method / missing params / out-of-bounds path.
    expect(errorCodeOf(byId.get(5))).toBe(-32601);
    expect(resultOf(byId.get(6))["isError"]).toBe(true);
    expect(resultOf(byId.get(7))["isError"]).toBe(true);
    expect(textOf(byId.get(7))).toContain("[path_outside_workspace]");

    // ③ Logs really go to stderr (prefix and tool name included); not one character lands on stdout.
    expect(stderrText).toContain("[hreader-mcp]");
    expect(stderrText).toContain("hr_outline");
    expect(lines.join("")).not.toContain("[hreader-mcp]");
    expect(exitCode).toBe(0);
  }, 45_000);
});

describe("dist/main.js · oversized frame", () => {
  // On ReadBuffer overflow the SDK only calls `onerror` then closes itself; without `onerror` wired, the process exits silently.
  it("should say on stderr that the frame was too big instead of vanishing silently", async () => {
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "hr_outline", arguments: { filePath: "x".repeat(11 * 1024 * 1024) } },
    });
    const { lines, stderrText, exitCode } = await oversizedProbeOf(await binPathOf(), frame);
    // The SDK reassembles the frame as `{"result":…,"jsonrpc":"2.0","id":1}` (key order is not contract), so compare as JSON.
    const frames = lines.map((line): unknown => JSON.parse(line));
    const isFrame = (frame_: unknown): boolean =>
      typeof frame_ === "object" && frame_ !== null && "jsonrpc" in frame_;
    // Only "answered success to id:9" counts as a violation; answering an error frame, or nothing at all, both pass.
    const isIdOf = (frame_: unknown, id: number): boolean =>
      isRecord(frame_) && frame_["id"] === id;
    const hasNoErrorOf = (frame_: unknown): boolean => isRecord(frame_) && !("error" in frame_);

    // The contract is "leaves a trace, never silently half-dead": every handshake frame arrives, the oversized request never gets a success frame, stderr has something to say, the process exits normally.
    // "No frame for an oversized request" is current SDK behavior, not our contract — so frame counts are asserted as invariants, not equalities.
    expect(frames.filter(isFrame).length).toBeGreaterThanOrEqual(HANDSHAKE_COUNT);
    expect(frames.some((frame_: unknown) => isIdOf(frame_, 9) && hasNoErrorOf(frame_))).toBe(false);
    expect(stderrText).toContain("[hreader-mcp] 传输错误：");
    expect(exitCode).toBe(0);
  }, 45_000);
});
