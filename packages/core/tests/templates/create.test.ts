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

describe("createFromTemplate · atomic rollback", () => {
  interface FakeSnapshot {
    readonly files: ReadonlyMap<string, string>;
    readonly dirs: ReadonlySet<string>;
    readonly links: ReadonlyMap<string, string>;
  }

  // The create lock lives under `.hreader/locks/` — infra, not payload: snapshots skip it so a
  // rollback check compares only the workspace tree (dirs, files, links and every byte of content).
  const isLockInfra = (path: string): boolean =>
    path === `${WS}/.hreader` || path.startsWith(`${WS}/.hreader/locks`);

  const snapshotOf = (fake: FakeFs): FakeSnapshot => ({
    files: new Map(
      [...fake.state.files]
        .filter(([path]) => !isLockInfra(path))
        .map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]),
    ),
    dirs: new Set([...fake.state.dirs].filter((path) => !isLockInfra(path))),
    links: new Map([...fake.state.links].filter(([path]) => !isLockInfra(path))),
  });

  const expectUnchanged = (fake: FakeFs, before: FakeSnapshot): void => {
    expect(snapshotOf(fake)).toEqual(before);
  };

  const assetTemplate = (): Record<string, string> =>
    htmlTemplate(TPL, {
      entry: '<html><head><title>T</title></head><body><img src="assets/a.png"></body></html>',
      assets: { "a.png": "PNG-A", "deep/x.bin": "BIN" },
    });

  const assetDirs = [`${TPL}/assets`, `${TPL}/assets/deep`];

  it("should refuse a pre-existing <stem>_files asset and write nothing", async () => {
    const fake = setup({ ...assetTemplate(), "/ws/collide_files/a.png": "FOREIGN" }, [
      ...assetDirs,
      `${WS}/collide_files`,
    ]);
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "collide.html" }));
    expect(error.code).toBe("file_exists");
    expect(error.message).toContain("collide_files");
    expectUnchanged(fake, before);

    // Retrying after the cause is removed must succeed: <stem>_files exists in any form → file_exists.
    fake.state.files.delete("/ws/collide_files/a.png");
    fake.state.dirs.delete("/ws/collide_files");
    await createAt(fake, { id: "my-tpl", target: "collide.html" });
    expect(textOf(fake, `${WS}/collide.html`)).toContain('src="collide_files/a.png"');
  });

  it("should refuse a regular file sitting at the <stem>_files path", async () => {
    const fake = setup({ ...assetTemplate(), "/ws/odd_files": "NOT-A-DIR" }, assetDirs);
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "odd.html" }));
    expect(error.code).toBe("file_exists");
    expect(error.message).toContain("odd_files");
    expectUnchanged(fake, before);
  });

  it("should reclaim created dirs and files when an asset write fails mid-copy", async () => {
    const fake = setup(assetTemplate(), assetDirs);
    fake.fail("link", systemError("EACCES"), (path: string) =>
      path.startsWith(`${WS}/mid_files/deep/x.bin.`),
    );
    const before = snapshotOf(fake);

    expect(await codeOfAsync(() => createAt(fake, { id: "my-tpl", target: "mid.html" }))).toBe(
      "io_failure",
    );
    expectUnchanged(fake, before);
  });

  it("should write every asset before the exclusive page create that publishes the result", async () => {
    const fake = setup(assetTemplate(), assetDirs);
    await createAt(fake, { id: "my-tpl", target: "order.html" });

    // `link:` log entries carry the tmp source `<target>.<digits>` — the page's link must be the last one.
    const links = fake.state.log.filter((line) => line.startsWith("link:"));
    expect(links.filter((line) => line.startsWith(`link:${WS}/order_files/`))).toHaveLength(2);
    expect(links[links.length - 1]?.startsWith(`link:${WS}/order.html.`)).toBe(true);
  });

  it("should roll back the copied assets when the final page write fails", async () => {
    const fake = setup(assetTemplate(), assetDirs);
    fake.fail("link", systemError("ENOSPC"), (path: string) => path.startsWith(`${WS}/roll.html.`));
    const before = snapshotOf(fake);

    expect(await codeOfAsync(() => createAt(fake, { id: "my-tpl", target: "roll.html" }))).toBe(
      "io_failure",
    );
    expectUnchanged(fake, before);
  });

  it("should surface an lstat failure on the assets dir as io_failure before any write", async () => {
    const fake = setup(assetTemplate(), assetDirs);
    fake.fail("lstat", systemError("EACCES"), (path: string) => path === `${WS}/mid_files`);
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "mid.html" }));
    expect(error.code).toBe("io_failure");
    expect(error.message).toContain(`${WS}/mid_files`);
    expectUnchanged(fake, before);
  });

  it("should surface an lstat failure on a parent dir as io_failure before any write", async () => {
    const fake = setup(htmlTemplate(TPL));
    fake.fail("lstat", systemError("EACCES"), (path: string) => path === WS);
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "x.html" }));
    expect(error.code).toBe("io_failure");
    expect(error.message).toContain(WS);
    expectUnchanged(fake, before);
  });

  it("should still create the page when every ancestor lstat reports ENOENT down to the fs root", async () => {
    const fake = setup(htmlTemplate(TPL));
    // `fail` is one-shot, so each ancestor needs its own entry for the walk to reach the root.
    fake.fail("lstat", systemError("ENOENT"), (path: string) => path === WS);
    fake.fail("lstat", systemError("ENOENT"), (path: string) => path === "/");

    await createAt(fake, { id: "my-tpl", target: "x.html" });
    expect(fake.state.files.has(`${WS}/x.html`)).toBe(true);
  });

  const deepAssetTemplate = (): Record<string, string> =>
    htmlTemplate(TPL, {
      entry: '<html><body><img src="assets/a/b/c.png"></body></html>',
      assets: { "a/b/c.png": "PNG-C" },
    });

  const deepAssetDirs = [`${TPL}/assets`, `${TPL}/assets/a`, `${TPL}/assets/a/b`];

  it("should remove the whole created dir tree when the pre-existing target wins", async () => {
    const fake = setup({ ...deepAssetTemplate(), "/ws/doc.html": "EXISTING" }, deepAssetDirs);
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "doc.html" }));
    expect(error.code).toBe("file_exists");
    expectUnchanged(fake, before);

    // Retry once the cause is removed: the whole tree must land.
    fake.state.files.delete("/ws/doc.html");
    await createAt(fake, { id: "my-tpl", target: "doc.html" });
    expect(textOf(fake, `${WS}/doc_files/a/b/c.png`)).toBe("PNG-C");
  });

  it("should remove the whole created dir tree when a deep asset write fails", async () => {
    const fake = setup(deepAssetTemplate(), deepAssetDirs);
    fake.fail("link", systemError("ENOSPC"), (path: string) =>
      path.startsWith(`${WS}/doc_files/a/b/c.png.`),
    );
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "doc.html" }));
    expect(error.code).toBe("io_failure");
    expectUnchanged(fake, before);

    // Retry after the cause is removed must succeed.
    await createAt(fake, { id: "my-tpl", target: "doc.html" });
    expect(textOf(fake, `${WS}/doc_files/a/b/c.png`)).toBe("PNG-C");
  });

  it("should remove the whole created dir tree when the final page write fails", async () => {
    const fake = setup(deepAssetTemplate(), deepAssetDirs);
    fake.fail("link", systemError("ENOSPC"), (path: string) => path.startsWith(`${WS}/doc.html.`));
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "doc.html" }));
    expect(error.code).toBe("io_failure");
    expectUnchanged(fake, before);
  });

  it("should refuse to mkdir under a parent swapped to an outside link after the probe", async () => {
    const fake = setup({ ...deepAssetTemplate(), "/outside/escape.html": "e" }, deepAssetDirs);
    // Mid-resolution TOCTOU: after the missing-dirs probe reports a/b absent, the parent chain is
    // swapped for an outside link. Hooks only fire on reads, so the swap lands on the a-probe itself.
    fake.once(
      "lstat",
      (path: string) => path === `${WS}/doc_files/a`,
      () => {
        fake.state.links.set(`${WS}/doc_files`, "/outside");
      },
    );
    const before = snapshotOf(fake);

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "doc.html" }));
    expect(error.code).toBe("path_outside_workspace");
    // The escape is caught before any mkdir or tmp staging write touches the fs (the lock's own
    // `.hreader/locks` mkdir is infra — excluded like the snapshot helpers do).
    const payloadOps = fake.state.log.filter(
      (line) =>
        (line.startsWith("mkdir:") || line.startsWith("writeFileAtomic:")) &&
        !isLockInfra(line.slice(line.indexOf(":") + 1)),
    );
    expect(payloadOps).toHaveLength(0);
    // The link itself was planted mid-run; payload files and dirs are untouched.
    expect(snapshotOf(fake).files).toEqual(before.files);
    expect(snapshotOf(fake).dirs).toEqual(before.dirs);
  });

  it("should keep the original failure when a rollback rmdir cannot empty a created dir", async () => {
    const fake = setup(assetTemplate(), assetDirs);
    fake.fail("rmdir", systemError("ENOTEMPTY"), () => true);
    fake.fail("link", systemError("ENOSPC"), (path: string) =>
      path.startsWith(`${WS}/roll2.html.`),
    );

    const error = await errorOf(() => createAt(fake, { id: "my-tpl", target: "roll2.html" }));
    expect(error.code).toBe("io_failure");
    // Copied files are still reclaimed; only the un-removable dirs survive.
    expect(fake.state.files.has(`${WS}/roll2_files/deep/x.bin`)).toBe(false);
    expect(fake.state.dirs.has(`${WS}/roll2_files`)).toBe(true);
    expect(fake.state.files.has(`${WS}/roll2.html`)).toBe(false);
  });
});

describe("createFromTemplate · control characters in the title", () => {
  it("should normalize NUL and C0 controls to U+FFFD for both formats", async () => {
    for (const [format, entry] of [
      ["html", "<html><head><title>OLD</title></head><body><h1>OLD</h1></body></html>"],
      [
        "managed",
        "<html><head><title>OLD</title></head><body><article><h1>OLD</h1><p>x</p></article></body></html>",
      ],
    ] as const) {
      const fake = setup(
        htmlTemplate(TPL, { manifest: manifestText({ id: "my-tpl", format }), entry }),
      );
      await createAt(fake, { id: "my-tpl", target: `c0-${format}.html`, title: "a\0b\x01c\td" });

      const text = textOf(fake, `${WS}/c0-${format}.html`);
      expect(text).not.toContain("\u0000");
      expect(text).not.toContain("\u0001");
      const parsed = parseHtml(text);
      // Tab (and LF/CR) are the only C0 controls kept; everything else is one U+FFFD each.
      expect(textContentOf(firstElement(parsed, "title"))).toBe("a\uFFFDb\uFFFDc\td");
      expect(textContentOf(firstElement(parsed, "h1"))).toBe("a\uFFFDb\uFFFDc\td");
    }
  });
});

describe("createFromTemplate · property tests", () => {
  // \0 is normalized to U+FFFD by createFromTemplate and \r is normalized to \n in preprocessing:
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
