// This layer covers `hr template <list|show|new|save>` and `hr new --template` argv → intent
// (defaults, both flag syntaxes, usage errors); no disk.

import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

describe("parseArgs · template list", () => {
  it("should build a list intent with defaults", () => {
    expect(parse(["template", "list"])).toEqual({
      ok: true,
      intent: { kind: "templateList", home: undefined, json: false, workspace: CWD },
    });
  });

  it("should take --json and --home", () => {
    expect(parse(["template", "list", "--json", "--home", "/homes/u"])).toEqual({
      ok: true,
      intent: { kind: "templateList", home: "/homes/u", json: true, workspace: CWD },
    });
  });

  it("should reject positionals and foreign flags", () => {
    expectFailure(["template", "list", "x"], "list 不接受位置参数，多出 1 个", "template");
    expectFailure(["template", "list", "--kind", "note"], "--kind", "template");
  });
});

describe("parseArgs · template show", () => {
  it("should build a show intent from one id", () => {
    expect(parse(["template", "show", "my-tpl"])).toEqual({
      ok: true,
      intent: {
        kind: "templateShow",
        id: "my-tpl",
        home: undefined,
        json: false,
        workspace: CWD,
      },
    });
  });

  it("should reject a missing <id>, an extra positional and a foreign flag", () => {
    expectFailure(["template", "show"], "show 缺少 <id>", "template");
    expectFailure(
      ["template", "show", "a", "b"],
      "show 只接受 1 个位置参数，多出 1 个",
      "template",
    );
    expectFailure(["template", "show", "a", "--force"], "--force", "template");
  });
});

describe("parseArgs · template new", () => {
  it("should build a templateNew intent with both flag syntaxes", () => {
    const expected = {
      ok: true,
      intent: {
        kind: "templateNew",
        path: `${CWD}/doc.html`,
        template: "note",
        title: "标题",
        home: undefined,
        json: true,
        workspace: CWD,
      },
    };
    expect(
      parse(["template", "new", "doc.html", "--template", "note", "--title", "标题", "--json"]),
    ).toEqual(expected);
    expect(
      parse(["template", "new", "doc.html", "--template=note", "--title=标题", "--json"]),
    ).toEqual(expected);
  });

  it("should leave the title undefined when not given", () => {
    const result = parse(["template", "new", "doc.html", "--template", "note"]);
    expect(result).toEqual({
      ok: true,
      intent: {
        kind: "templateNew",
        path: `${CWD}/doc.html`,
        template: "note",
        title: undefined,
        home: undefined,
        json: false,
        workspace: CWD,
      },
    });
  });

  it("should reject a missing <file>, a missing --template and empty flag values", () => {
    expectFailure(["template", "new"], "new 缺少 <file>", "template");
    expectFailure(["template", "new", "a.html"], "new 缺少 --template <id>", "template");
    expectFailure(["template", "new", "a.html", "--template="], "--template 不能为空", "template");
    expectFailure(
      ["template", "new", "a.html", "--template", "note", "--title="],
      "--title 不能为空",
      "template",
    );
    expectFailure(
      ["template", "new", "a.html", "--template", "note", "b.html"],
      "new 只接受 1 个位置参数，多出 1 个",
      "template",
    );
    expectFailure(
      ["template", "new", "a.html", "--template", "note", "--global"],
      "--global",
      "template",
    );
  });
});

describe("parseArgs · template save", () => {
  it("should build a templateSave intent with defaults", () => {
    expect(parse(["template", "save", "page.html", "--id", "mine"])).toEqual({
      ok: true,
      intent: {
        kind: "templateSave",
        path: `${CWD}/page.html`,
        id: "mine",
        global: false,
        name: undefined,
        description: undefined,
        home: undefined,
        json: false,
        workspace: CWD,
      },
    });
  });

  it("should take --global, --name, --description and --home", () => {
    expect(
      parse([
        "template",
        "save",
        "page.html",
        "--id=mine",
        "--global",
        "--name",
        "我的模板",
        "--description=说明",
        "--home",
        "rel-home",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      intent: {
        kind: "templateSave",
        path: `${CWD}/page.html`,
        id: "mine",
        global: true,
        name: "我的模板",
        description: "说明",
        home: `${CWD}/rel-home`,
        json: true,
        workspace: CWD,
      },
    });
  });

  it("should reject a missing <file>, a missing --id, empty values and foreign flags", () => {
    expectFailure(["template", "save"], "save 缺少 <file>", "template");
    expectFailure(["template", "save", "a.html"], "save 缺少 --id <id>", "template");
    expectFailure(["template", "save", "a.html", "--id="], "--id 不能为空", "template");
    expectFailure(
      ["template", "save", "a.html", "--id", "t", "--name="],
      "--name 不能为空",
      "template",
    );
    expectFailure(
      ["template", "save", "a.html", "--id", "t", "--description="],
      "--description 不能为空",
      "template",
    );
    expectFailure(
      ["template", "save", "a.html", "--id", "t", "--template", "x"],
      "--template",
      "template",
    );
    expectFailure(
      ["template", "save", "a.html", "--id", "t", "b.html"],
      "save 只接受 1 个位置参数，多出 1 个",
      "template",
    );
  });
});

describe("parseArgs · template dispatch", () => {
  it("should reject a missing or unknown subcommand", () => {
    expectFailure(["template"], "template 缺少子命令：list | show | new | save", "template");
    expectFailure(
      ["template", "drop"],
      "未知的 template 子命令：drop（可选：list | show | new | save）",
      "template",
    );
  });
});

describe("parseArgs · new --template alias", () => {
  it("should produce the same templateNew intent as `template new`", () => {
    const aliased = parse(["new", "doc.html", "--template", "note", "--title", "T", "--json"]);
    const direct = parse([
      "template",
      "new",
      "doc.html",
      "--template",
      "note",
      "--title",
      "T",
      "--json",
    ]);

    expect(aliased).toEqual(direct);
    expect(aliased).toEqual({
      ok: true,
      intent: {
        kind: "templateNew",
        path: `${CWD}/doc.html`,
        template: "note",
        title: "T",
        home: undefined,
        json: true,
        workspace: CWD,
      },
    });
  });

  it("should accept --home on the alias, the same as `template new`", () => {
    const aliased = parse(["new", "doc.html", "--template", "note", "--home", "/u"]);
    const direct = parse(["template", "new", "doc.html", "--template", "note", "--home", "/u"]);

    expect(aliased).toEqual(direct);
    expect(aliased).toEqual({
      ok: true,
      intent: {
        kind: "templateNew",
        path: `${CWD}/doc.html`,
        template: "note",
        title: undefined,
        home: "/u",
        json: false,
        workspace: CWD,
      },
    });
    // Without --template the skeleton path still does not know --home.
    expectFailure(["new", "a.html", "--home", "/u"], "--home", "new");
  });

  it("should reject --template combined with --kind, --visual or --force", () => {
    for (const extra of [["--kind", "note"], ["--visual", "atelier-editorial"], ["--force"]]) {
      expectFailure(
        ["new", "a.html", "--template", "note", ...extra],
        "--template 不能与 --kind / --visual / --force 同用",
        "new",
      );
    }
  });

  it("should reject an empty --template value", () => {
    expectFailure(["new", "a.html", "--template="], "--template 不能为空", "new");
  });
});
