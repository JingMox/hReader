# Shared adversarial corpus

Reusable hostile inputs and independent checkers for every hReader suite. The corpus is
written from the attacker's perspective — entries name the stress an input applies, not
the behavior any one feature should exhibit. Feature code is never imported from here
(the only third-party import is parse5, used as the independent oracle).

Run the corpus self-tests before handing off work:

```bash
pnpm vitest run tests/adversarial --sequence.shuffle
```

(They run inside the normal `pnpm verify` once the root `vitest.config.ts` `include`
lists `tests/adversarial/**/*.test.ts`. If the command above reports "No test files
found", that include entry is missing.)

## Corpus data modules

| Module              | Contents                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `html-malformed.ts` | `MALFORMED_HTML`: curated malformed/edge HTML documents, each with a `why`. Byte entries carry encodings a string cannot (invalid UTF-8). `malformedHtmlText(entry)` decodes either form. `nestedTagHtml`/`balancedNestedHtml` generate depth stress.                |
| `html-generator.ts` | `malformedHtmlArb`: a fast-check arbitrary composing documents from the same building blocks (unclosed tags, stray ends, raw-text shells, bogus markup, entities, foreign content, hostile text). `malformedHtmlSample(seed, n)` replays a seed deterministically.   |
| `paths.ts`          | `HOSTILE_PATHS` (traversal, encoding tricks, absolute escapes, NUL, length limits), `HOSTILE_FILENAMES` (names that become markup/URLs/control output), `CASE_ONLY_PAIRS`, and `symlinkEscapeFixture(baseDir?)` building a workspace with links pointing outside it. |
| `xss.ts`            | `XSS_PAYLOADS`: markup breakouts, script-scheme URLs (with case/whitespace/entity variants), template-injection idioms, RTL/zero-width/control characters, and 100k+ length stress.                                                                                  |
| `urls.ts`           | `URL_CASES`: schemes, credentials, protocol-relative, IDN (incl. homographs), host oddities (dword/hex/octal IPv4, port overflow), whitespace and controls, and the exact 2048/2049 length boundary.                                                                 |

## Checkers

Pure functions — they judge output; they never call the feature being checked.

| Checker                                              | Judgment                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assertNoHostPaths(output, extra?)`                  | Throws if `output` contains `/Users`, `/private`, `/tmp`, `/var`, `/home`, a Windows drive path, or any literal in `extra` (pass the workspace's lexical path **and** its realpath).                                                                                                                                                                               |
| `diffStructure(beforeHtml, afterHtml, edited?)`      | Parses both documents with parse5 (scripting **off**) and compares every element **outside** the edited subtree: tag, attributes, own direct text, ancestor chain. `edited` is a locator such as `byAttribute("data-hr-id", "hr-c4")` or `byTag("article")`. Returns `StructureDiff[]` — assert `toEqual([])` to prove the edit stayed in its subtree.             |
| `assertNoElementsFromData(container, expectedTexts)` | Walks a rendered container (happy-dom `Window`/`Element`, a real DOM node, or any `DomNodeLike`) and throws if a dangerous element (`img`, `script`, `svg`, `iframe`, `object`, `embed`, `form`, `style`, `link`, `meta`, `base`) or an `<a>` with a script-scheme href appears, or if the text nodes differ from `expectedTexts` (order and whitespace included). |

## Contribution rule

New cases **may be added** — a counter-example found during verification becomes a new
entry — but existing entries and checker judgments **must not be loosened**. If an entry
looks wrong, that is a finding about the feature or the corpus itself: report it; do not
patch the corpus to make the run green.
