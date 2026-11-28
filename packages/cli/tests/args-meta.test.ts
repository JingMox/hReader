// This layer pins `hr meta <file>` argument handling at the parse level: one positional
// file, repeated --tag/--untag, the --source-url/--clear-source-url pair, and every other
// flag stays unknown. Semantic validation (URL scheme, tag bounds) is core's job.

import { describe, expect, it } from "vitest";

import { expectFailure, parse } from "./args-helpers";

describe("parseArgs · meta", () => {
  it("should parse a bare file into a read intent", () => {
    expect(parse(["meta", "a.html"])).toMatchObject({
      ok: true,
      intent: {
        kind: "meta",
        path: "/repo/a.html",
        tags: [],
        untags: [],
        sourceUrl: undefined,
        clearSourceUrl: false,
        json: false,
      },
    });
  });

  it("should collect repeated --tag and --untag in order, both flag spellings", () => {
    expect(
      parse(["meta", "a.html", "--tag", "一", "--tag=二", "--untag", "三", "--untag=四"]),
    ).toMatchObject({
      ok: true,
      intent: { kind: "meta", tags: ["一", "二"], untags: ["三", "四"] },
    });
  });

  it("should accept --source-url and --clear-source-url alone, and --json", () => {
    expect(parse(["meta", "a.html", "--source-url", "https://x.test"])).toMatchObject({
      ok: true,
      intent: { sourceUrl: "https://x.test", clearSourceUrl: false },
    });
    expect(parse(["meta", "a.html", "--source-url=https://x.test"])).toMatchObject({
      ok: true,
      intent: { sourceUrl: "https://x.test" },
    });
    expect(parse(["meta", "a.html", "--clear-source-url", "--json"])).toMatchObject({
      ok: true,
      intent: { sourceUrl: undefined, clearSourceUrl: true, json: true },
    });
  });

  it("should reject --source-url together with --clear-source-url", () => {
    expectFailure(
      ["meta", "a.html", "--source-url", "https://x.test", "--clear-source-url"],
      "--source-url 与 --clear-source-url 不能同用",
      "meta",
    );
  });

  it("should reject a missing file and extra positionals", () => {
    expectFailure(["meta"], "meta 缺少 <file>", "meta");
    expectFailure(["meta", "a.html", "b.html"], "meta 只接受 1 个位置参数，多出 1 个", "meta");
  });

  it("should keep every other flag disallowed", () => {
    // Unregistered flags die at the tokenize layer (no topic); registered-but-disallowed
    // flags report the bare flag name with the meta topic — the existing convention.
    expectFailure(["meta", "a.html", "--status"], "未知参数：--status", undefined);
    expectFailure(["meta", "a.html", "--force"], "--force", "meta");
  });
});
