// This layer covers `parseArgs` for `style extract` (corpus slices, default id/name, flag whitelist); no subprocess, no fs.

import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

const EXTRACT = (extra: readonly string[] = []) =>
  parse(["style", "extract", "a.md", "b.html", ...extra]);

describe("parseArgs · style extract shapes", () => {
  it("should take every positional as corpus and default id from the first file", () => {
    expect(EXTRACT()).toMatchObject({
      ok: true,
      intent: {
        kind: "styleExtract",
        files: [`${CWD}/a.md`, `${CWD}/b.html`],
        id: "a",
        name: "a",
        idGiven: false,
        nameGiven: false,
        out: undefined,
        inheritsVisual: "atelier-editorial",
        noLlm: false,
        force: false,
      },
    });
  });

  it("should follow --id and --name when given", () => {
    expect(EXTRACT(["--id", "corpus", "--name", "三篇语料"])).toMatchObject({
      ok: true,
      intent: { id: "corpus", name: "三篇语料", idGiven: true, nameGiven: true },
    });
  });

  it("should default --name from --id when only --id is given", () => {
    expect(EXTRACT(["--id", "corpus"])).toMatchObject({ ok: true, intent: { name: "corpus" } });
  });

  it("should resolve --out against cwd and accept --no-llm / --force", () => {
    expect(EXTRACT(["--out", "styles/x.yaml", "--no-llm", "--force"])).toMatchObject({
      ok: true,
      intent: { out: `${CWD}/styles/x.yaml`, noLlm: true, force: true },
    });
  });
});

describe("parseArgs · style extract default ids", () => {
  it("should fall back to slug 'style' for a CJK file name", () => {
    expect(parse(["style", "extract", "三篇语料.md"])).toMatchObject({
      ok: true,
      intent: { id: "style" },
    });
  });

  it("should lowercase and dash-separate ASCII file names", () => {
    expect(parse(["style", "extract", "Docs 03 Section.md"])).toMatchObject({
      ok: true,
      intent: { id: "docs-03-section" },
    });
  });
});

describe("parseArgs · style extract rejections", () => {
  it("should reject an empty corpus", () => {
    expectFailure(["style", "extract"], "style extract 至少需要 1 篇语料（.md / .html）", "style");
  });

  it.each([["--visual", "x"], ["--tone", "x"], ["--lint"], ["--html", "x"], ["--max-bytes", "10"]])(
    "should reject flags that do not belong to extract (%j)",
    (...flag) => {
      expect(parse(["style", "extract", "a.md", ...flag]).ok).toBe(false);
    },
  );
});
