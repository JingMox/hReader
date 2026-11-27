// This layer: createFromTemplate — atomic create-only-if-absent entry write, title/h1 rewrite,
// style inlined as hr-theme, assets moved per the _files convention with references rewritten,
// node-id injection for the managed format. All lifecycle semantics reuse the existing
// resolveNewTarget/createNewFile guardrails.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { HrError } from "../../src/hr-error";
import type { HtmlElementNode, HtmlNode, ParsedHtml } from "../../src/html/constants";
import { encodeUtf8 } from "../../src/io/bytes";
import { classifyDocument, checkLayout, embeddedThemeCssOf, parseHtml } from "../../src";
import { textContentOf } from "../../src/html/text";
import { createFromTemplate } from "../../src/templates";
import { codeOfAsync, systemError } from "../io/harness";
import {
  depsAt,
  fakeFs,
  htmlTemplate,
  manifestText,
  rootsOf,
  seedDirs,
  type FakeFs,
  USER_TEMPLATES,
  WS,
  WS_TEMPLATES,
} from "./harness";

const TPL = `${USER_TEMPLATES}/my-tpl`;

const errorOf = async (run: () => Promise<unknown>): Promise<HrError> => {
  try {
    await run();
  } catch (error: unknown) {
    return error as HrError;
  }
  throw new Error("expected a throw but none happened");
};

const setup = (files: Record<string, string>, dirs: readonly string[] = []): FakeFs => {
  const fake = fakeFs({ "/ws/keep.html": "x", ...files });
  seedDirs(fake, USER_TEMPLATES, TPL, WS_TEMPLATES, WS, ...dirs);
  return fake;
};

const createAt = async (fake: FakeFs, input: { id: string; target: string; title?: string }) =>
  createFromTemplate(input, rootsOf(), depsAt(fake));

const findIn = (node: HtmlNode, tag: string): HtmlElementNode | undefined => {
  if (node.kind !== "element" && node.kind !== "document") return undefined;
  if (node.kind === "element" && node.tag === tag) return node;
  for (const child of node.children) {
    const found = findIn(child, tag);
    if (found !== undefined) return found;
  }
  return undefined;
};

const firstElement = (parsed: ParsedHtml, tag: string): HtmlElementNode => {
  const found = findIn(parsed.root, tag);
  if (found === undefined) throw new Error(`test document is missing <${tag}>`);
  return found;
};

const countElements = (node: HtmlNode, tag: string): number =>
  node.kind === "element" || node.kind === "document"
    ? (node.kind === "element" && node.tag === tag ? 1 : 0) +
      node.children.reduce((sum, child) => sum + countElements(child, tag), 0)
    : 0;

const textOf = (fake: FakeFs, absPath: string): string =>
  new TextDecoder().decode(fake.state.files.get(absPath) ?? new Uint8Array());

describe("createFromTemplate · managed (incl. builtins)", () => {
  it("should create a managed doc from a builtin template with title, h1 and theme", async () => {
    const fake = setup({});
    const result = await createAt(fake, {
      id: "note",
      target: "docs/note.html",
      title: "我的第一份笔记",
    });

    const text = textOf(fake, `${WS}/docs/note.html`);
    expect(text.length).toBeGreaterThan(0);
    expect(result).toEqual({
      path: "docs/note.html",
      bytes: encodeUtf8(text).byteLength,
      assets: [],
    });

    const parsed = parseHtml(text);
    expect(classifyDocument(parsed).cls).toBe("managed");
    expect(checkLayout(parsed.root)).toHaveLength(0);
    expect(textContentOf(firstElement(parsed, "title"))).toBe("我的第一份笔记");
    expect(textContentOf(firstElement(parsed, "h1"))).toBe("我的第一份笔记");
    expect(embeddedThemeCssOf(text)?.length).toBeGreaterThan(0);
  });

  it("should accept an h1-free managed skeleton (title still replaced)", async () => {
    const entry =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Untitled</title></head>' +
      "<body><article><section><p>x</p></section></article></body></html>";
    const fake = setup(
      htmlTemplate(TPL, { manifest: manifestText({ id: "my-tpl", format: "managed" }), entry }),
    );

    const result = await createAt(fake, { id: "my-tpl", target: "a.html", title: "New T" });
    const parsed = parseHtml(textOf(fake, `${WS}/a.html`));

    expect(classifyDocument(parsed).cls).toBe("managed");
    expect(checkLayout(parsed.root)).toHaveLength(0);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("should reject a managed template whose skeleton has no article", async () => {
    const entry =
      "<!DOCTYPE html><html><head><title>Untitled</title></head><body><main></main></body></html>";
    const fake = setup(
      htmlTemplate(TPL, { manifest: manifestText({ id: "my-tpl", format: "managed" }), entry }),
    );

    expect(await codeOfAsync(() => createAt(fake, { id: "my-tpl", target: "x.html" }))).toBe(
      "invalid_template",
    );
  });
});

describe("createFromTemplate · html (incl. byte-for-byte skeleton)", () => {
  it("should write the entry byte-faithfully except title/h1 and theme insertion", async () => {
    const entry =
      '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>OLD</title>\n</head>\n' +
      "<body>\n<h1>OLD</h1>\n<p>keep</p>\n</body>\n</html>\n";
    const style = "body { margin: 0 }";
    const fake = setup(htmlTemplate(TPL, { entry, style }));

    await createAt(fake, { id: "my-tpl", target: "out.html", title: "A" });
    const text = new TextDecoder().decode(fake.state.files.get(`${WS}/out.html`));

    // Expected product = title/h1 rewritten plus a style element inserted in head — everything else byte-for-byte.
    const expected = entry
      .replace("<title>OLD</title>", "<title>A</title>")
      .replace("<h1>OLD</h1>", "<h1>A</h1>")
      .replace("</head>", `<style id="hr-theme">${style}</style></head>`);
    expect(text).toBe(expected);
  });

  it("should escape markup-significant characters inside the title", async () => {
    const entry = "<html><head><title>OLD</title></head><body><h1>OLD</h1><p>x</p></body></html>";
    const fake = setup(htmlTemplate(TPL, { entry }));

    await createAt(fake, { id: "my-tpl", target: "esc.html", title: 'a<b&"c"🚀' });
    const parsed = parseHtml(textOf(fake, `${WS}/esc.html`));

    expect(textContentOf(firstElement(parsed, "title"))).toBe('a<b&"c"🚀');
    expect(textContentOf(firstElement(parsed, "h1"))).toBe('a<b&"c"🚀');
  });

  it("should still inline the theme when the entry lacks a literal <head>", async () => {
    // A parse5-synthesized head has no source span: replaceTheme degenerates to creating head after the <html> open tag.
    const fake = setup(htmlTemplate(TPL, { entry: "<html><body>x</body></html>", style: "x{}" }));

    await createAt(fake, { id: "my-tpl", target: "x.html" });
    expect(embeddedThemeCssOf(textOf(fake, `${WS}/x.html`))).toBe("x{}");
  });

  it("should copy assets under <stem>_files and rewrite assets/ references", async () => {
    const entry =
      "<html><head><title>OLD</title></head><body>" +
      '<img src="assets/a.png" srcset="assets/a-1x.png 1x, other/c.png 3x,assets/single.png" alt="">' +
      '<link href="assets/font.css">' +
      '<img src="other/b.png">' +
      "</body></html>";
    const fake = setup(
      htmlTemplate(TPL, {
        entry,
        assets: {
          "a.png": "PNG-A",
          "a-1x.png": "PNG-1",
          "single.png": "PNG-S",
          "font.css": "FONT",
          "deep/x.bin": "BIN",
        },
      }),
      [`${TPL}/assets`, `${TPL}/assets/deep`],
    );

    const result = await createAt(fake, { id: "my-tpl", target: "nested/out.v1.html" });
    expect([...result.assets].sort()).toEqual([
      "nested/out.v1_files/a-1x.png",
      "nested/out.v1_files/a.png",
      "nested/out.v1_files/deep/x.bin",
      "nested/out.v1_files/font.css",
      "nested/out.v1_files/single.png",
    ]);

    const written = textOf(fake, `${WS}/nested/out.v1.html`);
    expect(written).toContain('src="out.v1_files/a.png"');
    expect(written).toContain(
      'srcset="out.v1_files/a-1x.png 1x, other/c.png 3x,out.v1_files/single.png"',
    );
    expect(written).toContain('href="out.v1_files/font.css"');
    expect(written).toContain('src="other/b.png"');
    expect(written).not.toContain('"assets/');

    const readAsset = (rel: string): string => textOf(fake, `${WS}/nested/${rel}`);
    expect(readAsset("out.v1_files/a.png")).toBe("PNG-A");
    expect(readAsset("out.v1_files/deep/x.bin")).toBe("BIN");
  });

  it("should name the asset dir off a target without extension", async () => {
    const fake = setup(
      htmlTemplate(TPL, {
        entry: "<html><head><title>O</title></head></html>",
        assets: { "x.txt": "X" },
      }),
      [`${TPL}/assets`],
    );

    const result = await createAt(fake, { id: "my-tpl", target: "README" });
    expect(result.assets).toEqual(["README_files/x.txt"]);
    expect(fake.state.files.has(`${WS}/README_files/x.txt`)).toBe(true);
  });

  it("should refuse to copy an asset symlink that escapes or cannot resolve", async () => {
    const fake = setup(htmlTemplate(TPL, { assets: { "pic.png": "PNG" } }), [`${TPL}/assets`]);
    fake.state.links.set(`${TPL}/assets/hole`, "/outside");

    expect(await codeOfAsync(() => createAt(fake, { id: "my-tpl", target: "x.html" }))).toBe(
      "invalid_template",
    );
  });

  it("should refuse a style that fails the theme tokenizer", async () => {
    const fake = setup(htmlTemplate(TPL, { style: "@import 'https://evil/x.css';" }));

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "x.html" }));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("内联");
  });
});

describe("createFromTemplate · existing guardrails", () => {
  it("should return file_exists when the target already exists", async () => {
    const fake = setup({ ...htmlTemplate(TPL), "/ws/exists.html": "taken" });
    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "exists.html" }));

    expect(error.code).toBe("file_exists");
  });

  it("should create missing parent directories before writing", async () => {
    const fake = setup(htmlTemplate(TPL));
    const result = await createAt(fake, { id: "my-tpl", target: "deep/nested/doc.html" });

    expect(result.path).toBe("deep/nested/doc.html");
    expect(fake.state.files.has(`${WS}/deep/nested/doc.html`)).toBe(true);
  });

  it("should keep workspace path gates for the target", async () => {
    const fake = setup(htmlTemplate(TPL));
    for (const [target, code] of [
      ["../out.html", "path_outside_workspace"],
      ["/abs/x.html", "path_outside_workspace"],
      [".hreader/sneak.html", "path_outside_workspace"],
      ["a/bad\0name.html", "invalid_request"],
    ] as const) {
      expect(await codeOfAsync(() => createAt(fake, { id: "my-tpl", target }))).toBe(code);
    }
  });

  it("should propagate unknown_template and invalid_template through creation", async () => {
    const fake = setup(htmlTemplate(TPL, { manifest: "{broken" }));
    expect(await codeOfAsync(() => createAt(fake, { id: "ghost", target: "x.html" }))).toBe(
      "unknown_template",
    );
    expect(await codeOfAsync(() => createAt(fake, { id: "my-tpl", target: "x.html" }))).toBe(
      "invalid_template",
    );
  });

  it("should surface an asset read failure as invalid_template", async () => {
    const fake = setup(htmlTemplate(TPL, { assets: { "pic.png": "PNG" } }), [`${TPL}/assets`]);
    fake.fail("readFile", systemError("EIO"), (path: string) => path.endsWith("pic.png"));

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "x.html" }));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("pic.png");
  });
});

describe("createFromTemplate · property tests", () => {
  // \0 is replaced by the parser with U+FFFD and \r is normalized to \n in preprocessing:
  // neither is in the "roundtrippable text" domain, so filter them out.
  const safeTitle = fc
    .string({ unit: "grapheme" })
    .filter((text) => !text.includes("\0") && !text.includes("\r"));

  it("should roundtrip arbitrary titles through title and h1 (fast-check)", async () => {
    const entry =
      '<html><head><meta charset="utf-8"><title>OLD</title></head><body><h1>OLD</h1><p>body</p></body></html>';

    await fc.assert(
      fc.asyncProperty(safeTitle, async (title) => {
        const fake = setup(htmlTemplate(TPL, { entry }));
        await createAt(fake, { id: "my-tpl", target: "prop.html", title });
        const parsed = parseHtml(textOf(fake, `${WS}/prop.html`));

        expect(textContentOf(firstElement(parsed, "title"))).toBe(title);
        expect(textContentOf(firstElement(parsed, "h1"))).toBe(title);
        // No title may break the structure: head/body both present, h1 and p still exactly one each.
        expect(firstElement(parsed, "body")).toBeDefined();
        expect(countElements(parsed.root, "h1")).toBe(1);
        expect(countElements(parsed.root, "p")).toBe(1);
      }),
      { numRuns: 80 },
    );
  });

  it("should roundtrip arbitrary safe css into the hr-theme slot and keep title intact", async () => {
    const entry = "<html><head><title>OLD</title></head><body><h1>OLD</h1></body></html>";
    const cssSegment = fc.string({ unit: fc.constantFrom(..."@ab".split(""), "{", "}", ";", ":") });
    const safeCss = fc
      .array(cssSegment, { minLength: 0, maxLength: 40 })
      .map((parts) => `body { ${parts.join("")} }`);

    await fc.assert(
      fc.asyncProperty(safeCss, safeTitle, async (style, title) => {
        const fake = setup(htmlTemplate(TPL, { entry, style }));
        await createAt(fake, { id: "my-tpl", target: "p.html", title });
        const written = textOf(fake, `${WS}/p.html`);
        const parsed = parseHtml(written);

        expect(textContentOf(firstElement(parsed, "title"))).toBe(title);
        expect(embeddedThemeCssOf(written)).toBe(style);
      }),
      { numRuns: 60 },
    );
  });
});
