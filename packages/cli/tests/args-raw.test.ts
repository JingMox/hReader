// This layer covers the lexical powers gained from node:util parseArgs (`--flag=val`, the `--` terminator, repeated `--allow-host`, switches refusing values).

import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

describe("parseArgs · node:util parseArgs lexical upgrades", () => {
  it("should accept inline --flag=value for value options", () => {
    expect(parse(["outline", "a.html", "--workspace=/w"])).toEqual({
      ok: true,
      intent: { kind: "outline", path: `${CWD}/a.html`, json: false, workspace: "/w" },
    });
  });

  it("should treat tokens after `--` as positionals even when they start with `-`", () => {
    expect(parse(["outline", "--", "--literal.html"])).toEqual({
      ok: true,
      intent: { kind: "outline", path: `${CWD}/--literal.html`, json: false, workspace: CWD },
    });
  });

  it("should reject inline values passed to boolean switch flags", () => {
    expectFailure(["outline", "a.html", "--json=true"], "参数 --json 不接受取值", undefined);
  });

  it("should reject unknown short flags with the raw token", () => {
    expectFailure(["outline", "a.html", "-x"], "未知参数：-x", undefined);
  });

  it("should collect repeatable --allow-host flags and split comma-separated entries", () => {
    expect(
      parse([
        "serve",
        "doc.html",
        "--allow-host",
        "a.example",
        "--allow-host",
        "b.example, c.example",
      ]),
    ).toMatchObject({
      ok: true,
      intent: { kind: "serve", allowHosts: ["a.example", "b.example", "c.example"] },
    });
  });
});
