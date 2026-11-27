# Interview-driven custom styles: from conversation to style.yaml

Goal: ask 6 questions and come out with a style that runs as-is — not "describe the style you want".

## Ask these 6 things first

Ask in order, one question at a time; if the user can't answer, offer the default and explain why.

1. **Who is the reader, and what should they do after reading?** → decides `persona` (the answerer's identity) and the granularity of judgment.
2. **Conclusion first or background first?** → decides the first entry of `narrative_rules` (default: conclusion first).
3. **Maximum sentences per paragraph?** → decides `sentence_rhythm.max_paragraph_sentences` (default 3).
4. **Which words do you want deleted on sight?** → goes into `vocabulary.forbidden` (offer 5 common filler phrases for the user to pick from).
5. **Which words are industry idioms worth keeping?** → goes into `vocabulary.recommended`.
6. **Give me one real "badly written" and one real "well written" sentence.** → goes into `examples`; this is the only field that calibrates taste — try hard to get it.

## Write the file

Put it at the project's `.hreader/style.yaml` (project level — picked up when its `id` matches the requested one), or at `~/.hreader/styles/<id>/style.yaml` (user level, resolved when `--tone <id>` is given).

```yaml
id: product-weekly
name: Product weekly voice
description: Judgment first, numbers on the ground, no filler — the weekly-report register
inherits_visual: atelier-editorial

language_style:
  persona: A product lead who has run a B2B product line for three years and writes the weekly report every Thursday night: conclusion first, then data, then a clean cut around what did not get done this week.
  narrative_rules:
    - The first sentence must be the week's most important judgment; never open with "this week's main work".
    - Every conclusion carries a number or a date; if there is no data, say so outright.
    - End every section with "what we will not do next week" to bound reader expectations by exclusion.
  sentence_rhythm:
    max_paragraph_sentences: 2
  vocabulary:
    forbidden: ["empower", "leverage", "synergy", "steady progress", "continued momentum"]
    recommended: ["could have", "cost", "blocker", "by next Monday"]
  examples:
    - bad: "This week we steadily pushed several requirements forward and overall progress was smooth."
      good: "This week we shipped exactly one thing: the checkout-page rewrite. The other three I cut, because nobody could write their acceptance criteria."
```

## Validate and dry-run

```bash
# 1. confirm it parses (a broken schema reports invalid_style and names the key)
node skills/hreader/scripts/hr.mjs style report.html --tone product-weekly --json

# 2. read the compiled prompt and check it actually constrains you
node skills/hreader/scripts/hr.mjs style report.html --tone product-weekly

# 3. run the banned-words list against an existing draft
node skills/hreader/scripts/hr.mjs style report.html --lint
```

## Common pitfalls

- `id` must be all lowercase, matching `^[a-z0-9]+(-[a-z0-9]+)*$`; for the user-level layout, the directory name must equal the `id` inside the file, or you get `invalid_style` — and a project `style.yaml` whose `id` does not match the requested id is skipped entirely (resolves onward to `unknown_style` if nothing else matches).
- `inherits_visual` names a theme id: the built-ins are `atelier-editorial` and `deck-noir`, and a user theme at `~/.hreader/styles/<id>/theme.css` also resolves; anything else gets `unknown_style`. It defaults to `atelier-editorial` when omitted.
- `narrative_rules` needs at least 1 entry; write falsifiable constraints, not "be professional".
- Words in `forbidden` are matched **case-folded and compatibility-folded** (NFKC + lowercase — full-width/half-width and case all collapse): enter word roots, not whole sentences.
- In `examples`, `bad`/`good` must come in pairs; a `good` alone is rejected with `invalid_style`.

## Don'ts

- Do not let the user "give an adjective" and call that a style: adjectives cannot land in YAML and only produce an unenforceable prompt.
- Do not copy someone else's `forbidden` list into your own style: banned words are team scars — borrowed ones don't hurt.
- Do not conflate the style file with theme CSS: `style.yaml` governs the writing, `theme.css` governs the layout, and the two connect through `inherits_visual`.
