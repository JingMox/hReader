// This layer covers `hr import` argv → intent (default out, --kind/--title/--out, usage errors); no disk.

import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

describe("parseArgs · import", () => {
  it("should default --out to <name>.hr.html next to the source", () => {
    expect(parse(["import", "deck.html"])).toEqual({
      ok: true,
      intent: {
        kind: "import",
        path: `${CWD}/deck.html`,
        docKind: undefined,
        title: undefined,
        out: `${CWD}/deck.hr.html`,
        force: false,
        json: false,
        workspace: CWD,
      },
    });
  });

  it("should derive the default out for nested paths and extension-less names", () => {
    // Same directory, same name + .hr infix: `sub/a.html` → `sub/a.hr.html`, `notes` → `notes.hr.html`.
    for (const [file, out] of [
      ["sub/a.html", `${CWD}/sub/a.hr.html`],
      ["notes", `${CWD}/notes.hr.html`],
    ] as const) {
      const parsed = parse(["import", file]);
      if (!parsed.ok || parsed.intent.kind !== "import") {
        throw new Error(`import ${file} should parse to an import intent`);
      }
      expect(parsed.intent.out).toBe(out);
    }
  });

  it("should take --kind / --title / --out / --force / --json when given", () => {
    expect(
      parse([
        "import",
        "a.html",
        "--kind",
        "slides",
        "--title",
        "Q4 汇报",
        "--out",
        "b/c.html",
        "--force",
        "--json",
      ]),
    ).toEqual({
      ok: true,
      intent: {
        kind: "import",
        path: `${CWD}/a.html`,
        docKind: "slides",
        title: "Q4 汇报",
        out: `${CWD}/b/c.html`,
        force: true,
        json: true,
        workspace: CWD,
      },
    });
  });
});

describe("parseArgs · import usage errors", () => {
  it("should reject a missing <file>", () => {
    expectFailure(["import"], "import 缺少 <file>", "import");
  });

  it("should reject a second positional argument", () => {
    expectFailure(
      ["import", "a.html", "b.html"],
      "import 只接受 1 个位置参数，多出 1 个",
      "import",
    );
  });

  it("should reject an empty --title and an empty --out", () => {
    expectFailure(["import", "a.html", "--title", ""], "--title 不能为空", "import");
    expectFailure(["import", "a.html", "--out", ""], "--out 不能为空", "import");
  });

  it("should reject a flag that belongs to another command", () => {
    expectFailure(["import", "a.html", "--write"], "--write", "import");
  });

  it("should reject an unknown --kind and list the choices", () => {
    expectFailure(
      ["import", "a.html", "--kind", "poster"],
      "未知的 --kind：poster（可选：note | report | minutes | brief | slides）",
      "import",
    );
  });

  it("should refuse --out pointing at the source itself", () => {
    // `./a.html` and `a.html` resolve to the same path: overwriting the input itself is a usage error (exit 2), never reaching the write guard.
    expectFailure(["import", "a.html", "--out", "./a.html"], "--out 不能指向源文件自身", "import");
    expectFailure(
      ["import", "sub/../a.html", "--out", "a.html"],
      "--out 不能指向源文件自身",
      "import",
    );
  });
});
