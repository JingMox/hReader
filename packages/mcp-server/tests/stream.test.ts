// 这层管：协议边缘上"会不会死"——坏输入与超限帧。
// 与 `stdio.test.ts` 同一条理由（测的是真产物、真子进程），但钉的是两种异常路径：
// ① 畸形 / 未知 / 缺参 / 越界，全部仍是 JSON-RPC 帧，日志一律只走 stderr；
// ② 单帧越过 SDK 的 10MB `ReadBuffer` 时，进程必须留一条 stderr，而不是无声消失。

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

    // ① 每一行都还是 JSON-RPC：畸形行让 SDK 直接丢弃（不回 -32700、也不给 id:null），
    //    进程没崩、stdout 也没多出任何非协议文本。
    expect(byId.has(null)).toBe(false);
    expect(frames.every((frame) => frame["jsonrpc"] === "2.0")).toBe(true);
    expect([...byId.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // ② 三种坏输入各自的答复：未知方法 / 缺参数 / 越界路径。
    expect(errorCodeOf(byId.get(5))).toBe(-32601);
    expect(resultOf(byId.get(6))["isError"]).toBe(true);
    expect(resultOf(byId.get(7))["isError"]).toBe(true);
    expect(textOf(byId.get(7))).toContain("[path_outside_workspace]");

    // ③ 日志真的走 stderr（含前缀与工具名），stdout 里一个字符都没有。
    expect(stderrText).toContain("[hreader-mcp]");
    expect(stderrText).toContain("hr_outline");
    expect(lines.join("")).not.toContain("[hreader-mcp]");
    expect(exitCode).toBe(0);
  }, 45_000);
});

describe("dist/main.js · oversized frame", () => {
  // SDK 的 ReadBuffer 超限时只调 `onerror` 然后自己 close；不接 `onerror` 就是无声退出。
  it("should say on stderr that the frame was too big instead of vanishing silently", async () => {
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "hr_outline", arguments: { filePath: "x".repeat(11 * 1024 * 1024) } },
    });
    const { lines, stderrText, exitCode } = await oversizedProbeOf(await binPathOf(), frame);
    // SDK 拼回的帧是 `{"result":…,"jsonrpc":"2.0","id":1}`（键序不是契约），所以按 JSON 断。
    const frames = lines.map((line): unknown => JSON.parse(line));
    const isFrame = (frame_: unknown): boolean =>
      typeof frame_ === "object" && frame_ !== null && "jsonrpc" in frame_;
    // 只认"给 id:9 回了成功"这一种违约；至于回的是 error 帧还是干脆不回，都算合格。
    const isIdOf = (frame_: unknown, id: number): boolean =>
      isRecord(frame_) && frame_["id"] === id;
    const hasNoErrorOf = (frame_: unknown): boolean => isRecord(frame_) && !("error" in frame_);

    // 契约是"留痕且不静默半死"：握手帧一条不少、绝不给超大请求一个成功回帧、stderr 有话说、进程正常退出。
    // "超限请求不回任何帧"是当前 SDK 的行为，不是我们的契约——所以帧数用不变量，不用等号。
    expect(frames.filter(isFrame).length).toBeGreaterThanOrEqual(HANDSHAKE_COUNT);
    expect(frames.some((frame_: unknown) => isIdOf(frame_, 9) && hasNoErrorOf(frame_))).toBe(false);
    expect(stderrText).toContain("[hreader-mcp] 传输错误：");
    expect(exitCode).toBe(0);
  }, 45_000);
});
