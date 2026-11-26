// This layer covers the normalize sub-table of `parseArgs` (argv → normalize Intent / usage errors); no subprocess, no fs.

import { describe, expect, it } from "vitest";

import { expectFailure, parse } from "./args-helpers";

describe("parseArgs · normalize (id injection only)", () => {
  it("should parse the file plus --write into a normalize intent", () => {
    expect(parse(["normalize", "a.html", "--write", "--workspace", "w"])).toEqual({
      ok: true,
      intent: {
        kind: "normalize",
        path: "/repo/a.html",
        write: true,
        json: false,
        workspace: "/repo/w",
      },
    });
  });

  it("should default --write to false (print to stdout only, not a single byte on disk)", () => {
    expect(parse(["normalize", "a.html"])).toMatchObject({ ok: true, intent: { write: false } });
  });

  it("should reject a second positional and name the count", () => {
    expectFailure(
      ["normalize", "a.html", "b.html"],
      "normalize 只接受 1 个位置参数，多出 1 个",
      "normalize",
    );
  });

  it("should reject a missing <file>", () => {
    expectFailure(["normalize"], "normalize 缺少 <file>", "normalize");
  });

  it("should reject a flag normalize cannot honour (--out belongs to export)", () => {
    const parsed = parse(["normalize", "a.html", "--out", "x.html"]);

    expect(parsed).toMatchObject({ ok: false, topic: "normalize" });
    // The message must name the extra flag: just saying "wrong arguments" would make the user try them one by one.
    expect(String(Reflect.get(Object(parsed), "message"))).toContain("--out");
  });
});
