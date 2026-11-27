// This layer: consistency between the builtin templates and repo facts — the embedded theme.css is
// byte-identical to packages/core/themes/<visual>/theme.css (the regen output of scripts/embed-theme-css.mjs),
// and "create via the kind's builtin template == the hr new --kind product" (slides: --visual
// deck-noir, since the builtin ships it while `hr new` defaults to atelier-editorial), the F2a
// compatibility promise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyDocument, checkLayout, parseHtml, replaceTheme } from "../../src";
import { newDocumentHtml } from "../../src/layout/kinds";
import { BUILTIN_TEMPLATES } from "../../src/templates/builtin";
import { THEME_CSS } from "../../src/templates/builtin/theme-css";
import { createFromTemplate, readTemplate } from "../../src/templates";
import { fakeFs, rootsOf, depsAt } from "./harness";

const themeFile = (visual: string): string =>
  readFileSync(fileURLToPath(new URL(`../../themes/${visual}/theme.css`, import.meta.url)), "utf8");

const KINDS = ["note", "report", "minutes", "brief", "slides"] as const;

/**
 * The exact `hr new` equivalent of each builtin create: `hr new` defaults every kind to
 * atelier-editorial, but the slides builtin ships deck-noir (D33) — so slides compares against the
 * explicit `--visual deck-noir` product, the rest against the defaults.
 */
const HR_NEW_EQUIVALENT: Readonly<Record<(typeof KINDS)[number], string>> = {
  note: "hr new --kind note",
  report: "hr new --kind report",
  minutes: "hr new --kind minutes",
  brief: "hr new --kind brief",
  slides: "hr new --kind slides --visual deck-noir",
};

describe("builtin templates · theme.css byte-identical to repo source", () => {
  it("should keep embedded atelier-editorial and deck-noir css in lockstep with themes/", () => {
    expect(THEME_CSS["atelier-editorial"]).toBe(themeFile("atelier-editorial"));
    expect(THEME_CSS["deck-noir"]).toBe(themeFile("deck-noir"));
  });
});

describe("builtin templates · equivalence with newDocumentHtml (F2a compatibility promise)", () => {
  it("should ship each kind template whose entry is exactly newDocumentHtml output", () => {
    for (const kind of KINDS) {
      const builtin = BUILTIN_TEMPLATES.find((template) => template.manifest.id === kind);
      if (builtin === undefined) throw new Error(`builtin list is missing ${kind}`);
      expect(builtin.entry).toBe(newDocumentHtml({ kind, title: "Untitled" }));
      expect(builtin.manifest.format).toBe("managed");
    }
  });

  it.each(KINDS.map((kind) => [kind, HR_NEW_EQUIVALENT[kind]] as const))(
    "should create %s bytes identical to `%s --title <title>`",
    async (kind) => {
      const fake = fakeFs({ "/ws/keep.html": "x" });
      const builtin = BUILTIN_TEMPLATES.find((template) => template.manifest.id === kind);
      if (builtin === undefined) throw new Error(`builtin list is missing ${kind}`);
      const result = await createFromTemplate(
        { id: kind, target: `${kind}.html`, title: "等价标题" },
        rootsOf(),
        depsAt(fake),
      );
      expect(result.path).toBe(`${kind}.html`);

      const created = new TextDecoder().decode(
        fake.state.files.get(`/ws/${kind}.html`) ?? new Uint8Array(),
      );
      const parsed = parseHtml(created);
      expect(classifyDocument(parsed).cls).toBe("managed");
      expect(checkLayout(parsed.root)).toHaveLength(0);

      // Raw bytes, no normalization: `hr new` is replaceTheme(newDocumentHtml, <visual>) — for slides the
      // visual is deck-noir (HR_NEW_EQUIVALENT), for the rest the atelier-editorial default; both are
      // exactly builtin.style. The injected h1 id follows the retitled text, not "Untitled".
      const reference = replaceTheme(
        newDocumentHtml({ kind, title: "等价标题" }),
        builtin.style,
      ).html;
      expect(created).toBe(reference);
    },
  );
});

describe("builtin templates · blank-html", () => {
  it("should create a free-form html doc verbatim plus title/theme rewrite", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    const template = await readTemplate("blank-html", rootsOf(), depsAt(fake));
    const builtin = BUILTIN_TEMPLATES.find((one) => one.manifest.id === "blank-html");
    if (builtin === undefined) throw new Error("builtin list is missing blank-html");

    const result = await createFromTemplate(
      { id: "blank-html", target: "free.html", title: "Free" },
      rootsOf(),
      depsAt(fake),
    );
    const written = new TextDecoder().decode(
      fake.state.files.get("/ws/free.html") ?? new Uint8Array(),
    );

    // An html template with no assets: the skeleton is preserved byte-for-byte outside title/h1 and the theme block.
    const expected = template.entry
      .replace("<title>Untitled</title>", "<title>Free</title>")
      .replace("<h1>Untitled</h1>", "<h1>Free</h1>")
      .replace("</head>", `<style id="hr-theme">${builtin.style}</style></head>`);
    expect(written).toBe(expected);
    expect(result.assets).toHaveLength(0);
  });
});
