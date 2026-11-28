# Shared adversarial corpus

Reusable hostile inputs and independent checkers for every hReader suite. The corpus is
written from the attacker's perspective — entries name the stress an input applies, not
the behavior any one feature should exhibit. Feature code is never imported from here
(the only third-party import is parse5, used as the independent oracle).

Run the corpus self-tests before handing off work:

```bash
pnpm vitest run tests/adversarial --sequence.shuffle
```

They also run inside the normal `pnpm verify` (the root `vitest.config.ts` `include`
lists `tests/adversarial/**/*.test.ts`).

## Corpus data modules

| Module              | Contents                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `html-malformed.ts` | `MALFORMED_HTML`: curated malformed/edge HTML documents, each with a `why`. Byte entries carry encodings a string cannot (invalid UTF-8). `malformedHtmlText(entry)` decodes either form. `nestedTagHtml`/`balancedNestedHtml` generate depth stress.                                                                                                                 |
| `html-generator.ts` | `malformedHtmlArb`: a fast-check arbitrary composing documents from the same building blocks (unclosed tags, stray ends, raw-text shells, bogus markup, entities, foreign content, hostile text). `malformedHtmlSample(seed, n)` replays a seed deterministically.                                                                                                    |
| `paths.ts`          | `HOSTILE_PATHS` (traversal, encoding tricks, absolute escapes, NUL, length limits), `HOSTILE_FILENAMES` (names that become markup/URLs/control output), `CASE_ONLY_PAIRS`, and `symlinkEscapeFixture(baseDir?)` building a workspace with links pointing outside it.                                                                                                  |
| `xss.ts`            | `XSS_PAYLOADS`: markup breakouts, dangerous-scheme URLs and attribute carriers (with case/whitespace/entity variants), template-injection idioms, RTL/zero-width/control characters, and 100k+ length stress. Entries that parse to no dangerous structure carry `inertReason`; everything else must be rejected by `assertNoElementsFromData` when parsed as markup. |
| `urls.ts`           | `URL_CASES`: schemes, credentials, protocol-relative, IDN (incl. homographs), host oddities (dword/hex/octal IPv4, port overflow), whitespace and controls, and the exact 2048/2049 length boundary.                                                                                                                                                                  |

## Checkers

Pure functions — they judge output; they never call the feature being checked.

| Checker                                                   | Judgment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertNoHostPaths(output, extra?)`                       | Throws if `output` contains `/Users`, `/private`, `/tmp`, `/var`, `/home` (case-insensitive) at a path boundary (string start, a non-path delimiter, or a `file:` URL prefix — `file:`, `file://`, `file:////`, `file://localhost`, `file://.`, any case), a Windows drive (`C:\x`, `c:/x`) or UNC share (`\\s\s`, `//s/s` — never a URL scheme's `//`), or any literal in `extra` (pass the workspace's lexical path **and** its realpath). JSON escapes (`\/`, `\\`) and percent escapes (`%2F`) are decoded before scanning, in every combination. A bare `//host/path` is flagged as a UNC share even though it could be a protocol-relative URL — flagging is the accepted safe direction.                                                                                                                                                                                                                                                                                                                   |
| `diffStructure(beforeHtml, afterHtml, edited?, options?)` | Parses both documents with parse5 (scripting **off**) and compares every node **outside** the edited subtree — elements (tag, attributes, own direct text, ancestor chain), comments (their data), and the doctype (name, publicId, systemId). `edited` is a locator such as `byAttribute("data-hr-id", "hr-c4")` or `byTag("article")`. Returns `StructureDiff[]` — assert `toEqual([])` to prove the edit stayed in its subtree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `assertNoElementsFromData(container, expectedTexts)`      | Walks a rendered container (happy-dom `Window`/`Element`, a real DOM node, or any `DomNodeLike`) and throws on a dangerous element (`img`, `script`, `svg`, `iframe`, `object`, `embed`, `form`, `style`, `link`, `meta`, `base`, `math`, `annotation-xml`, `video`, `audio`, `source`, `details`, `marquee`, `noscript`), an `on*` handler or `srcdoc` attribute on any element, a `javascript:`/`vbscript:`/`data:` scheme in `href`/`src`/`action`/`formaction`/`xlink:href` (character references decoded, ASCII whitespace/controls stripped), or text nodes differing from `expectedTexts` (order and whitespace included). Every element must expose an enumerable attribute list — DOM `attributes` or parse5 `attrs`; a getAttribute-only node cannot be checked for `on*` handlers, so the checker throws `CheckerInternalError` instead of silently passing it. Any other unexpected exception inside the walk is likewise rethrown as `CheckerInternalError`, never confused with a caught violation. |

### `diffStructure` and the edited element

The edited subtree is excluded **wherever it lands** — its contents are never part of
the comparison. But the locator still owes you precision:

- The locator must match **at most one** element per document. Two or more matches
  throw — an ambiguous locator would silently excuse whole subtrees.
- Zero matches is how inserts and deletes are expressed: the element only exists in
  one document. For an insert (zero matches in `before`), the new subtree is the edit
  itself, so `diffStructure` returns `[]` — **assert the insertion position
  separately** (for example with a selector, or through the `extra-after` diff that
  appears when no locator is passed).
- When the locator matches exactly once in both documents, its ancestor chain and
  element-sibling index are compared across the two documents; a change is reported
  as a `moved` diff unless the caller passes `{ allowMove: true }`.

## Contribution rule

New cases **may be added** — a counter-example found during verification becomes a new
entry — but existing entries and checker judgments **must not be loosened**. If an entry
looks wrong, that is a finding about the feature or the corpus itself: report it; do not
patch the corpus to make the run green.
