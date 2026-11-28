// This layer pins `hr search <query>` argument handling at the parse level: one positional
// query, `--limit` scoped to 1..100, and every other flag stays unknown.

import { describe, expect, it } from "vitest";

import { expectFailure, parse } from "./args-helpers";

describe("parseArgs · search", () => {
  it("should parse a bare query into a search intent", () => {
    expect(parse(["search", "摩托车"])).toMatchObject({
      ok: true,
      intent: { kind: "search", query: "摩托车", limit: undefined, json: false },
    });
  });

  it("should accept --json and a valid --limit", () => {
    expect(parse(["search", "摩托", "--json", "--limit", "50"])).toMatchObject({
      ok: true,
      intent: { kind: "search", query: "摩托", limit: 50, json: true },
    });
    expect(parse(["search", "摩托", "--limit=20"])).toMatchObject({
      ok: true,
      intent: { limit: 20 },
    });
  });

  it("should reject a missing query and extra positionals", () => {
    expectFailure(["search"], "search 缺少 <query>", "search");
    expectFailure(["search", "a", "b"], "search 只接受 1 个位置参数，多出 1 个", "search");
  });

  it("should reject out-of-range and malformed --limit as a usage error", () => {
    // Decimal digits only — Number() spellings (1e2, 0x10, " 5 ", 5.0) die at the CLI too.
    for (const value of [
      "0",
      "101",
      "-3",
      "abc",
      "1.5",
      "1e2",
      "0x10",
      " 5 ",
      "5.0",
      "9".repeat(30),
    ]) {
      expectFailure(["search", "摩托", "--limit", value], "--limit 必须是 1..100 的整数", "search");
    }
  });

  it("should keep every other flag disallowed", () => {
    // Unregistered flags die at the tokenize layer (no topic); registered-but-disallowed
    // flags report the bare flag name with the search topic — the existing convention.
    expectFailure(["search", "摩托", "--status"], "未知参数：--status", undefined);
    expectFailure(["search", "摩托", "--force"], "--force", "search");
  });
});
