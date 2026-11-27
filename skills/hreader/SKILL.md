---
name: hreader
description: Draft and edit HTML documents with hReader (notes, reports, meeting minutes, decision briefs, slides). Use when the user asks to write a report, organize meeting notes, produce an HTML write-up, revise one section, apply a layout theme, check layout constraints or banned words, or asks to "turn this content into a nicely formatted long read"; also for rewriting section by section along the outline without touching the rest.
---

# hReader: read and write long documents node by node

hReader splits a long HTML document into nodes you can read by id and patch by id; every write is a **byte-range replacement + atomic save + undoable**. You read one block, change one block — you never rewrite the whole document.

## When to use it

- The document is > 300 lines, or has several sections, and the user only wants one of them changed.
- You need the structure first to decide where to edit (`outline`).
- You need to read a section verbatim before rewriting it (`read`), then write it back (`patch`).
- You need a consistent voice (`style --tone`), consistent layout (`style --visual`), or a banned-words check (`style --lint`).

## Commands (all through `scripts/hr.mjs`)

```bash
node skills/hreader/scripts/hr.mjs new report.html --kind report --title "Q4 Retro"  # draft by kind
node skills/hreader/scripts/hr.mjs import deck.html --kind slides # foreign HTML → managed doc (defaults to <name>.hr.html)
node skills/hreader/scripts/hr.mjs outline report.html            # structure tree
node skills/hreader/scripts/hr.mjs read report.html s2-p1 --json   # read one node
node skills/hreader/scripts/hr.mjs patch report.html s2-p1 \
     --action replace --html-file /tmp/new.html                    # write back
node skills/hreader/scripts/hr.mjs style report.html --visual atelier-editorial
node skills/hreader/scripts/hr.mjs style report.html --tone atelier-editorial
node skills/hreader/scripts/hr.mjs style report.html --lint
node skills/hreader/scripts/hr.mjs check report.html               # layout-constraint check
node skills/hreader/scripts/hr.mjs template list                   # templates across builtin/user/workspace tiers
node skills/hreader/scripts/hr.mjs template show note              # manifest + guide + sizes for one template
node skills/hreader/scripts/hr.mjs template new draft.html --template note   # draft from a template
node skills/hreader/scripts/hr.mjs template save report.html --id my-style   # page → reusable template
```

Exit codes: `0` success, `1` business failure (missing node / invalid fragment / locked), `2` usage error, `3` IO and path problems, `70` internal error. **On any non-zero exit, read the error text on stderr first — do not guess.**

## Drafting from scratch: pick a kind first (`new`)

Do not hand-write a whole HTML skeleton. `new` generates a starter document of the chosen kind — ids filled in, theme applied, component placeholders included — then you `patch` block by block:

| `--kind`  | Purpose         | Skeleton sections                                                                                                                           |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `note`    | note            | one section `要点` (key points) to expand freely (default)                                                                                  |
| `report`  | report          | `结论` → `关键数据` → `分析` → `方案对比` → `风险` → `下一步` (conclusion → key data → analysis → option comparison → risks → next steps)   |
| `minutes` | meeting minutes | `结论与决定` → `讨论要点` → `待办` → `录音与逐字稿` (conclusions & decisions → discussion points → action items → recordings & transcripts) |
| `brief`   | decision brief  | `建议` → `依据` → `代价与风险` → `下一步` (recommendation → rationale → costs & risks → next steps)                                         |
| `slides`  | slides          | `（这一页的结论）` → `关键数字` → `方案对比` → `下一步` (this page's conclusion → key numbers → option comparison → next steps)             |

- Placeholder text is written inside fullwidth brackets (e.g. `（一句话结论：判断、证据、适用边界。）`, "one-sentence conclusion: judgment, evidence, boundary"): after `outline`, `replace` them block by block — **no bracket placeholders may remain at delivery**.
- `delete` whole sections you don't need; to add a page/section, `insert_after` a neighboring `<section>`.
- `slides` says one thing per page: one `<h2>` plus one component or two or three sentences. Scrolling in a browser turns pages; printing / saving to PDF yields one landscape page each — no script needed.
- When `<file>` already exists you need `--force`; without `--title` the file name is used.

## Drafting from a template (`template`)

Templates sit one level above kinds: a kind is a fixed skeleton, a template is a saved directory (`template.json` + entry HTML + `style.css` + `guide.md` + optional `assets/`) found in three tiers — builtin < `~/.hreader/templates` < `<workspace>/.hreader/templates`; deeper tiers shadow by id.

- `template list` prints every visible template (id, name, format, source, tags); broken entries warn on stderr and appear under `diagnostics` in `--json`.
- `template show <id>` prints the manifest fields, the full `guide.md`, and the entry/style byte sizes. **Read the guide before drafting from a template** — it carries the template's writing rules.
- `template new <file> --template <id> [--title t]` drafts a document from the template; `hr new <file> --template <id>` does the same (and combining `--template` with `--kind`/`--visual` is a usage error).
- `template save <file> --id <id> [--global]` distills an existing page into a reusable template: the `<style id="hr-theme">` content becomes `style.css`, `<stem>_files/` becomes `assets/`, and a `guide.md` draft is generated from the page's heading outline — **fill in the "Writing guidelines" section after saving**. `--global` writes to the user tier (`~/.hreader/templates`, honor `HREADER_HOME`); without it the template lands in `<workspace>/.hreader/templates`. There is no `--force`: an existing id fails with `file_exists`, pick another id.

## The five-primitive workflow

1. **See the structure**: `outline`. Prints one line per node, `- <id>  <heading>  (<n>w)`; headings without ids surface as warnings on stderr — fix ids before rewriting anything.
2. **Read the original**: `read <id>` returns the node's HTML fragment (it may be truncated — a `truncated_output` diagnostic comes at the end). Always read before editing; don't guess content from the outline.
   The second argument resolves as a selector first, then as a node id if the selector misses — so the ids printed by `outline`/`patch` feed straight back in. When a string is both a matching selector and a real `data-hr-id` it does not guess: it fails with `invalid_selector` (reason: ambiguous); write `#id` or `[data-hr-id="…"]` to be explicit.
3. **Write the fragment**: put the new content in a temporary `.html` file and use `--html-file` only (`--html` suits only short fragments without quotes or newlines).
4. **Commit**: pick an action —
   - `replace`: swap out the node wholesale (including its children).
   - `insert_after` / `insert_before`: **insert as a sibling of the node**, not inside its children; the inserted fragment must have exactly one root element.
   - `append`: insert at the end of the node's children (the target may be an empty element).
   - `delete`: remove the node and its subtree (takes no `--html*` source).
5. **Verify**: `--json` returns `{"ok":true,"data":{...}}`; watch `changed` (`false` means the written bytes were identical to the original — no history snapshot was created), `newIds` (ids auto-assigned inside inserted content), `replacedIds` (present when `replace` changed the target's id), `historyPath` (the undo anchor), and `warnings` (layout-constraint problems, see below).

## Layout constraints: checked at write time

Appearance belongs to the theme; body content only declares semantics. Two kinds of problems get flagged:

- **Wrong component structure** (`component_root` / `component_shape`): wrong root tag, wrong child count, missing required child elements. The spec table is in `references/components-spec.md`.
- **Inline `style`** (`inline_style`): no element may carry a `style` attribute (except inside inline SVG).

`patch` does not refuse the write for these — the fragment lands as usual and the problems appear in the receipt's `warnings`; use `check <file>` to re-check the whole document (under `--json`, watch `count`). **When you see a warning, patch once more to fix it; call it "done" only when `check` is clean.**

To use `check` as a gate, add `--strict`: exits 1 when error-level diagnostics exist (the report still goes to stdout first); `--strict=warning` fails on warnings too.

## What you cannot do inside the sandbox

- Fragments **may not** contain `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<base>`, or `<meta>` with `http-equiv`/`charset` attributes; no `on*` event attributes; no `javascript:` / `data:text/html` attribute values; no SVG animation elements that could write event handlers or dangerous URLs (`<animate>`/`<set>`). All are rejected with `forbidden_content` and the file does not change by a single byte.
- Fragments must have a **single root**: multiple roots, bare text, or a comment first are all rejected with `invalid_fragment`.
- Paths must stay inside `--workspace`; `../`, absolute paths, and symlinks pointing outside are rejected with `path_outside_workspace`.

## Component cheat sheet (copy-paste ready)

Full fragments live in `references/components-spec.md`. Eight components trigger theme styling via `data-hr-component`:

| Component          | Selector                              | Purpose                                        |
| ------------------ | ------------------------------------- | ---------------------------------------------- |
| KPI card grid      | `data-hr-component="kpi-bento"`       | 3–6 key numbers                                |
| insight callout    | `data-hr-component="callout-insight"` | a judgment the reader must remember            |
| risk callout       | `data-hr-component="callout-warning"` | costs, pitfalls, boundary conditions           |
| comparison columns | `data-hr-component="split-compare"`   | option A/B, before/after                       |
| collapsible depth  | `data-hr-component="deep-dive"`       | skippable reasoning details                    |
| step timeline      | `data-hr-component="step-timeline"`   | processes, roadmaps, retrospectives            |
| diagram stage      | `data-hr-component="diagram-stage"`   | image/SVG + caption                            |
| media card         | `data-hr-component="media-card"`      | audio/video + caption + collapsible transcript |

## Style and banned words

- Fetch the voice before writing: `style --tone <id>` returns a prompt — treat its rules as writing constraints.
- Run `style --lint` when done: each banned-word hit reports an `offset` (character offset within the block) and context; fix them one by one before calling it "done".
- The default style is `atelier-editorial`: conclusion first, a visual structure every three paragraphs, every claim anchored to a number or a source. See `references/style-authoring.md` for custom styles.

### Distilling your own style from 1..N corpus files (`style extract`)

```bash
# offline: run the statistics-only layer without a key (dev shells often hold a
# real key — copying the keyed version verbatim would spend real calls)
mkdir -p .hreader
env -u OPENCODE_API_KEY node skills/hreader/scripts/hr.mjs style extract voice-1.md voice-2.md \
  --id my-voice --name "My Voice" --out .hreader/style.yaml
```

- **No key is not an error**: without `OPENCODE_API_KEY` or with `--no-llm`, it runs the statistics-only version (rhythm + fixed vocabulary), printing one stderr line `未设置 OPENCODE_API_KEY，仅用统计结果` ("OPENCODE_API_KEY not set, using statistics only") — the `style.yaml` from either path works directly with `style --tone`.
- **`--out` must land on a discovery path** or `style --tone my-voice` won't find it: the project-level `<workspace>/.hreader/style.yaml`, or the user-level `~/.hreader/styles/my-voice/style.yaml`. Writing elsewhere is legal too (export/archival), but `--tone` resolves by id only — there is no path entry — so to make `--tone` use it, write to one of those two paths; writing elsewhere earns one stderr hint.
- `--out` pointing at an existing file needs `--force`, otherwise `file_exists`; the parent directory is not auto-created.
- Override the model/gateway with `--model` / `--base-url`; `--inherits-visual <id>` picks the inherited theme; `--json` prints `{ok,data:{path,stats,yaml,dropped}}` (`dropped` only appears on the LLM path), and errors are single-line JSON as well.
- Re-record `fixtures/llm/` whenever the fixtures or the model generation change (a different `--model` or a changed prompt), or the replay no longer proves today's model output.

## Letting the host carry the style itself (no per-round tone fetch)

Two surfaces in this repo turn the "fetch the voice" step into a standing host-side constraint, with the same effect as `style --tone` (the same `compileTone` compiler):

- **DeepSeek Harness (`dsh`)**: `@hreader/dsh-bundle` weaves the language spec into the system prompt, effective from session start. Install (`--profile` is required):
  ```bash
  dsh plugin --profile <profile> add "$(pwd)/packages/dsh-bundle"
  ```
  Without `config.workspace` it resolves the project style by the host process cwd and prints a `WARNING` line on stderr naming the directory used; an unknown `styleId` errors out directly and lists the available ids.
- **MCP**: the `use-hreader-style` prompt, pulled by the host on demand.

A related but different host surface: **Pi**'s `pi-hreader.ts` extension exposes `/hr-style`, which switches the **visual theme** of the currently bound document (it does not carry the language spec).

In other words: **when the user asks "how do I make the AI always write in this style", first check which host it runs in** — `dsh`/MCP have ready-made channels for the tone; don't make the agent hand-run `style --tone` every round.

## Error reference

| Error code               | Meaning                                  | Correct move                                      |
| ------------------------ | ---------------------------------------- | ------------------------------------------------- |
| `node_not_found`         | id typo, or that heading has no id       | run `outline` first and take ids from its output  |
| `invalid_selector`       | string is both a selector and a node id  | write `#id` or `[data-hr-id="…"]` explicitly      |
| `invalid_fragment`       | multi-root / bare text / comment first   | wrap it in a single root element                  |
| `forbidden_content`      | executable content matched               | show code in `<pre class="code">` instead         |
| `path_outside_workspace` | path escapes the workspace               | point `--workspace` at the document's directory   |
| `locked`                 | another process is writing the same file | retry after 2s; if it keeps failing, stop and ask |
| `not_a_file`             | path doesn't exist or isn't a file       | confirm the file path first                       |
| `needs_normalize`        | document lacks `data-hr-id`s             | run `hr normalize <file> --write` first           |
| `unknown_template`       | template id exists in no tier            | run `template list` and pick a printed id         |
| `invalid_template`       | template fails validation / too large    | fix the template directory or pick another id     |
| `file_exists`            | target file already exists               | add `--force`, or pick another path               |

## Don'ts

- Do not grant permissions on foreign documents for the user: the two dimensions 「脚本」 ("scripts") and 「联网」 ("network") are only toggled by the user inside the reader UI (the bottom-bar toggle or global settings). Agents have no tool or command that grants them; `hr serve`'s `/api/doc/<docId>/info` exposes a `permissions` field, but that is read-only state — per-document grants live in `<workspace>/.hreader/trust.json` (keyed by path) and the global mode lives in `~/.hreader/permissions.json`; neither is yours to write.
- Do not `read` the whole document and `write` it back wholesale: that bypasses the node mechanism and loses the untouched bytes.
- Do not stuff long fragments with newlines into `--html`: use `--html-file`.
- Do not rewrite `<script>` to dodge `forbidden_content`: tell the user this part needs manual handling.
- Do not `undo` more times than the retained history depth (10 snapshots by default).
