// 这层管：`hr new` / `hr check` 的 argv → intent（默认值、显式值、用法错误）；不碰盘。

import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

describe("parseArgs · new", () => {
  it("should default to a note titled after the file with the built-in theme", () => {
    expect(parse(["new", "drafts/q4.html"])).toEqual({
      ok: true,
      intent: {
        kind: "new",
        path: `${CWD}/drafts/q4.html`,
        docKind: "note",
        title: "q4",
        visual: "atelier-editorial",
        force: false,
        json: false,
        workspace: CWD,
      },
    });
  });

  it("should take kind, title, visual, force and json when given", () => {
    const argv = ["new", "deck.html", "--kind", "slides", "--title", "Q4 汇报"];

    expect(parse([...argv, "--visual", "mine", "--force", "--json"])).toEqual({
      ok: true,
      intent: {
        kind: "new",
        path: `${CWD}/deck.html`,
        docKind: "slides",
        title: "Q4 汇报",
        visual: "mine",
        force: true,
        json: true,
        workspace: CWD,
      },
    });
  });
});

describe("parseArgs · new 的用法错误", () => {
  it("should reject a missing <file>", () => {
    expectFailure(["new"], "new 缺少 <file>", "new");
  });

  it("should reject a second positional argument", () => {
    expectFailure(["new", "a.html", "b.html"], "new 只接受 1 个位置参数，多出 1 个", "new");
  });

  it("should reject an empty --title", () => {
    expectFailure(["new", "a.html", "--title", ""], "--title 不能为空", "new");
  });

  it("should reject a flag that belongs to another command", () => {
    expectFailure(["new", "a.html", "--write"], "--write", "new");
  });

  it("should reject an unknown --kind and list the choices", () => {
    expectFailure(
      ["new", "a.html", "--kind", "poster"],
      "未知的 --kind：poster（可选：note | report | minutes | brief | slides）",
      "new",
    );
  });
});

describe("parseArgs · check", () => {
  it("should build a check intent from one file", () => {
    expect(parse(["check", "a.html", "--json"])).toEqual({
      ok: true,
      intent: { kind: "check", path: `${CWD}/a.html`, json: true, workspace: CWD },
    });
  });

  it("should reject a missing <file>, an extra positional and a foreign flag", () => {
    expectFailure(["check"], "check 缺少 <file>", "check");
    expectFailure(["check", "a.html", "b.html"], "check 只接受 1 个位置参数，多出 1 个", "check");
    expectFailure(["check", "a.html", "--force"], "--force", "check");
  });
});
