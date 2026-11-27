// Text-model parity: the annotator's DOM-side `domBodyMapOf` (running in REAL
// Chrome) must agree byte-for-byte with core's `bodyTextOf` (parse5 — the same
// HTML5 tree algorithm the browser implements) on generated hostile-ish markup,
// and every emitted selector path must resolve through core's
// `parseSelectorPath`/`elementByPath` to the same element with the same
// body-text span. fast-check drives the generator; a fixed seed keeps failures
// reproducible.
//
// Requires real Chrome (puppeteer-core); the whole suite skips without it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { elementByPath, parseHtml, parseSelectorPath } from "@hreader/core";
import fc from "fast-check";
import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { APP_DIR, chromeSkipReason } from "../harness/env.ts";
import { killAllTracked } from "../harness/proc.ts";
import { bodyMapOf } from "../../../packages/core/src/annotations/body-text.ts";

const skip = chromeSkipReason();

// ---- generated documents ---------------------------------------------------

const TEXT_CHARS = [
  "a",
  "b",
  "c",
  "x",
  "y",
  "z",
  "A",
  "Z",
  "0",
  "5",
  "9",
  " ",
  "\n",
  "\t",
  "中",
  "文",
  "字",
  "日",
  "本",
  "語",
  "한",
  "국",
  "어",
  "😀",
  "🎉",
  "é",
  "ü",
  "ñ",
  "Ω",
  "µ",
  "—",
  "…",
  "'",
  '"',
  "(",
  ")",
  ".",
  ",",
];

const SAFE_TAGS = [
  "p",
  "div",
  "span",
  "b",
  "i",
  "em",
  "strong",
  "section",
  "article",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "blockquote",
  "code",
  "pre",
  "mark",
  "small",
  "figure",
  "figcaption",
  "header",
  "footer",
  "main",
  "nav",
  "dl",
  "dt",
  "dd",
  "a",
  "sub",
  "sup",
  "kbd",
  "samp",
  "var",
  "abbr",
  "cite",
  "q",
  "s",
  "u",
  "dfn",
  "time",
  "address",
  "summary",
  "details",
];

const SKIP_TAGS = ["script", "style", "template", "noscript"];

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const rawText = fc
  .string({ unit: fc.constantFrom(...TEXT_CHARS), minLength: 1, maxLength: 24 })
  .map(escapeText);

// Entities exercise the decoder path — both parsers must decode identically.
const entity = fc.constantFrom(
  "&amp;",
  "&nbsp;",
  "&#x4e2d;",
  "&lt;b&gt;",
  "&quot;ok&quot;",
  "&hellip;",
  "&gt;",
  "&copy;",
  "&#128512;",
);

const comment = fc
  .string({ unit: fc.constantFrom(...TEXT_CHARS), minLength: 0, maxLength: 16 })
  .map((text) => `<!--${text.replaceAll("-", ".")}-->`);

// Raw-text code inside script/style: no `<` so a premature `</script` is impossible.
const safeCode = fc.string({
  unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789{}()=;" '.split("")),
  minLength: 0,
  maxLength: 20,
});

const attr = fc.option(
  fc.oneof(
    fc.constantFrom("x", "y", "main", "lead", "note", "hr-meta").map((id) => ` id="${id}"`),
    fc
      .array(fc.constantFrom("a", "b", "wrap", "t"), { minLength: 1, maxLength: 3 })
      .map((cls) => ` class="${cls.join(" ")}"`),
    fc.constant(' data-note="k"'),
  ),
  { nil: "" },
);

const leaf = fc.oneof(
  rawText,
  entity,
  comment,
  fc.constantFrom("br", "hr", "wbr").map((tag) => `<${tag}>`),
  // Unbalanced noscript on purpose — stray closer and unclosed opener: the
  // annotate frame always runs scripting-on, so both sides must treat noscript
  // as raw text ending at the first `</noscript>` (D54).
  fc.constantFrom("</noscript>", "<noscript>"),
);

const node = (depth: number): fc.Arbitrary<string> => {
  if (depth <= 0) return leaf;
  const element = fc
    .tuple(
      fc.constantFrom(...SAFE_TAGS),
      attr,
      fc.array(node(depth - 1), { minLength: 0, maxLength: 4 }),
    )
    .map(([tag, at, kids]) => `<${tag}${at}>${kids.join("")}</${tag}>`);
  // Skipped subtrees carry both raw code (script/style) and inert markup
  // (template/noscript): nothing inside may enter the domain. Nested noscript
  // is generated on purpose — core parses the annotation domain scripting-on,
  // so both sides must agree where the early `</noscript>` cuts the subtree.
  const skipped = fc.tuple(fc.constantFrom(...SKIP_TAGS), attr).chain(([tag, at]) => {
    return fc
      .oneof(
        safeCode,
        fc.array(node(depth - 1), { minLength: 0, maxLength: 3 }).map((xs) => xs.join("")),
      )
      .map((inner) => `<${tag}${at}>${inner}</${tag}>`);
  });
  return fc.oneof(leaf, element, skipped);
};

const docArb = fc.array(node(4), { minLength: 1, maxLength: 6 }).map((kids) => kids.join(""));

// ---- types exchanged with the page ------------------------------------------

interface Span {
  readonly start: number;
  readonly end: number;
}

interface Pick {
  readonly tag: string;
  readonly selector: string | undefined;
  readonly span: Span | undefined;
}

interface DomResult {
  readonly text: string;
  readonly picks: readonly Pick[];
}

const PICK_EXPR = `((html) => {
  document.body.innerHTML = html;
  const map = window.__tm.domBodyMapOf(document.body);
  const els = Array.from(document.body.querySelectorAll("*"));
  const idx = [0, Math.floor(els.length / 2), els.length - 1].filter(
    (i, pos, arr) => i >= 0 && i < els.length && arr.indexOf(i) === pos,
  );
  const picks = idx.map((i) => {
    const el = els[i];
    return { tag: el.localName, selector: map.selectorOf(el), span: map.spanOf(el) };
  });
  return { text: map.text, picks };
})`;

/** In-Chrome run of the annotator's text model on one generated document. */
const domSide = async (page: Page, html: string): Promise<DomResult> => {
  const value = await page.eval(`${PICK_EXPR}(${JSON.stringify(html)})`);
  assert(
    typeof value === "object" && value !== null && typeof Reflect.get(value, "text") === "string",
    `in-page text-model returned a bad shape: ${JSON.stringify(value)}`,
  );
  return value as DomResult;
};

describe.skipIf(skip !== undefined)("annotator-parity", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await browser.open("about:blank");
    // The built module is self-contained ESM — a base64 data URL dodges any
    // document-URL or CSP concern on about:blank.
    const source = await readFile(join(APP_DIR, "assets/annotator/text-model.js"), "utf8");
    const loaded = await page.eval(
      `import("data:text/javascript;base64,${Buffer.from(source).toString("base64")}").then((m) => { window.__tm = m; return typeof m.domBodyMapOf; })`,
    );
    assertEq(loaded, "function", "the built annotator text-model did not load into the page");
  });

  afterAll(async () => {
    await browser.close();
    await killAllTracked();
  });

  test("should match core bodyTextOf on generated documents and resolve every emitted selector to the same span", async () => {
    const cases = fc.sample(docArb, { numRuns: 250, seed: 20261201 });
    for (const [index, html] of cases.entries()) {
      const dom = await domSide(page, html);
      // scriptingEnabled:true — the annotation domain parses like the browser.
      const parsed = parseHtml(`<!doctype html><html><body>${html}</body></html>`, {
        scriptingEnabled: true,
      });
      const core = bodyMapOf(parsed);
      assertEq(
        dom.text,
        core.text,
        `body text diverged on generated case ${String(index)}: ${JSON.stringify(html.slice(0, 200))}`,
      );
      for (const pick of dom.picks) {
        assert(
          pick.selector !== undefined,
          `selectorOf(${pick.tag}) was undefined on case ${String(index)}`,
        );
        const steps = parseSelectorPath(pick.selector);
        assert(
          steps !== undefined,
          `core could not parse emitted selector "${pick.selector}" (case ${String(index)})`,
        );
        const resolved = elementByPath(parsed.root, steps);
        assert(
          resolved !== undefined,
          `emitted selector "${pick.selector}" resolved to nothing (case ${String(index)})`,
        );
        assertEq(
          resolved.tag,
          pick.tag,
          `selector "${pick.selector}" resolved to the wrong tag (case ${String(index)})`,
        );
        const span = core.spans.get(resolved);
        // Skipped subtrees (script/style/template/noscript) get NO span on
        // either side — the parity is that both maps agree they cover nothing.
        if (pick.span === undefined) {
          assertEq(
            span,
            undefined,
            `core gave a body span for skipped ${pick.tag} (case ${String(index)})`,
          );
          continue;
        }
        assert(span !== undefined, `core span missing for ${pick.tag} on case ${String(index)}`);
        assertEq(
          pick.span.start,
          span.start,
          `span start diverged for selector "${pick.selector}" (case ${String(index)})`,
        );
        assertEq(
          pick.span.end,
          span.end,
          `span end diverged for selector "${pick.selector}" (case ${String(index)})`,
        );
      }
    }
  });

  test("should match core on targeted hostile constructs", async () => {
    const targeted: readonly string[] = [
      // hr-meta on a NON-script element: counted by both (the parity fix).
      `<div id="hr-meta">amc</div><p>tail</p>`,
      `<p>a<script id="hr-meta">{"k":1}</script>b</p>`,
      `<pre>\nleading newline</pre><p>after</p>`,
      `a&amp;b&nbsp;c&lt;d&gt;&hellip;`,
      `<textarea>inert <b>markup</b> as text</textarea><p>real</p>`,
      `<p>emoji 😀🎉 and 中文</p>`,
      `<table><tr><td>cell</td></tr></table><p>after</p>`,
      `<ul><li>one<li>two<li>three</ul>`,
      `<div><template><p>inert</p></template><span>live</span></div>`,
      `<noscript><p>noscript markup</p></noscript><p>out</p>`,
      // Nested/unbalanced noscript — D54: both sides read the scripting-on
      // tree (raw text ending at the first `</noscript>`).
      `<noscript>a<noscript>b</noscript>c</noscript><p>tail</p>`,
      `<noscript><p>x</noscript>rest<p>tail</p>`,
      `<noscript>unclosed<p>rest`,
      `<p>one</p></noscript><p>two</p>`,
      `<noscript>a</noscript>mid<noscript>b<noscript>c</noscript>d</noscript>tail`,
      `<style>p { color: red; }</style><p>styled</p>`,
      `<script>var x = "</p" + ">";</script><p>after</p>`,
      `<select><option>opt a<option>opt b</select><p>tail</p>`,
      `<svg><desc>svg text</desc><foreignObject><p>fo text</p></foreignObject></svg><p>tail</p>`,
      `<p>one</p><p>one</p><p>one</p>`,
      `<xmp>raw <b>markup</b> here</xmp><p>tail</p>`,
      `<div><p>a</p></div><div><p>b</p></div>`,
      `text only, no elements`,
      `<br><br><br>`,
      `<h1>T</h1><!-- mid --><p>P</p>`,
    ];
    for (const [index, html] of targeted.entries()) {
      const dom = await domSide(page, html);
      const parsed = parseHtml(`<!doctype html><html><body>${html}</body></html>`, {
        scriptingEnabled: true,
      });
      const core = bodyMapOf(parsed);
      assertEq(
        dom.text,
        core.text,
        `targeted case ${String(index)} diverged: ${JSON.stringify(html)}`,
      );
    }
  });
});
