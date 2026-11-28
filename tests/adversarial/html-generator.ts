// Shared adversarial corpus: a fast-check arbitrary that composes malformed HTML
// documents from the same building blocks as the curated html-malformed list.
//
// Determinism contract: `malformedHtmlSample(seed, n)` returns the exact same
// sequence for the same seed — needed so a failing case can be re-run verbatim.

import fc from "fast-check";

/** Start tags that can stack without ever being closed. */
const OPEN_FRAGMENTS = [
  "<div>",
  "<p>",
  "<b>",
  "<i>",
  "<li>",
  "<dd>",
  "<td>",
  "<tr>",
  "<table>",
  "<a href=x>",
  "<span>",
  "<nobr>",
  "<button>",
  "<select>",
  "<option>",
  "<ul>",
  "<dl>",
  "<h1>",
  "<form>",
] as const;

/** End tags — matched or stray, both exercise the parser. */
const CLOSE_FRAGMENTS = [
  "</div>",
  "</p>",
  "</b>",
  "</li>",
  "</dd>",
  "</td>",
  "</tr>",
  "</table>",
  "</a>",
  "</span>",
  "</nobr>",
  "</button>",
  "</select>",
  "</option>",
  "</ul>",
  "</dl>",
  "</h1>",
  "</form>",
  "</body>",
  "</html>",
  "</>",
  "</p attr=x>",
] as const;

/** Tags whose content model changes what "markup" means after them. */
const RAW_TEXT_FRAGMENTS = [
  "<plaintext>",
  "<xmp>",
  "<textarea>",
  "<title>",
  "<noscript>",
  "<template>",
  "<iframe>",
  "<script>",
  "<style>",
] as const;

/** Tokens that are always parse errors: bogus comments, mid-body doctype, CDATA, PIs. */
const BOGUS_FRAGMENTS = [
  "<!DOCTYPE html>",
  "<!x>",
  "<?x>",
  "<?php echo 1 ?>",
  "<![CDATA[cdata]]>",
  "<!--",
  "-->",
  "<!-->",
] as const;

/** Entities: named, numeric, edge-codepoint, and invalid. */
const ENTITY_FRAGMENTS = [
  "&amp;",
  "&lt;",
  "&gt;",
  "&quot;",
  "&notin;",
  "&notit;",
  "&fake;",
  "&#65;",
  "&#x41;",
  "&#0;",
  "&#xD800;",
  "&#x110000;",
  "&#x80;",
  "&amp",
] as const;

/** Foreign-content fragments that flip the parser between namespaces. */
const FOREIGN_FRAGMENTS = [
  "<svg>",
  "</svg>",
  "<math>",
  "</math>",
  "<foreignObject>",
  "</foreignObject>",
  "<annotation-xml>",
  '<annotation-xml encoding="text/html">',
  "<desc>",
] as const;

/** Text runs including the characters that stress tokenizers: NUL, controls, ZWSP, RTL override. */
const TEXT_FRAGMENT_CHARS = [
  "a",
  "text ",
  "x&y",
  "<",
  ">",
  " ",
  "\n",
  "\r\n",
  "\r",
  "\0",
  "\uFEFF",
  "\u200B",
  "\u202E",
  "é",
  "😀",
] as const;

const fragmentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...OPEN_FRAGMENTS),
  fc.constantFrom(...CLOSE_FRAGMENTS),
  fc.constantFrom(...RAW_TEXT_FRAGMENTS),
  fc.constantFrom(...BOGUS_FRAGMENTS),
  fc.constantFrom(...ENTITY_FRAGMENTS),
  fc.constantFrom(...FOREIGN_FRAGMENTS),
  fc.constantFrom(...TEXT_FRAGMENT_CHARS),
);

/**
 * Malformed documents composed from 0–24 fragments: implied closes, stray ends, raw-text
 * shells, bogus markup, entities, foreign-content flips and hostile text runs.
 */
export const malformedHtmlArb: fc.Arbitrary<string> = fc
  .array(fragmentArb, { minLength: 0, maxLength: 24 })
  .map((parts) => parts.join(""));

/**
 * Samples `count` documents from `malformedHtmlArb`, deterministically: the same `seed`
 * always produces the same sequence, so a found counter-example reproduces verbatim.
 */
export const malformedHtmlSample = (seed: number, count: number): string[] =>
  fc.sample(malformedHtmlArb, { seed, numRuns: count });
