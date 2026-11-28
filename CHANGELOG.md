# Changelog

All notable changes to **hReader** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Per-document metadata (tags + source URL)**: each doc can carry up to 32 tags (trim + NFC, 1–64 code points, case-insensitively deduped keeping the first spelling) and one `sourceUrl` (absolute `http:`/`https:` only, ≤2048 code points, credentials refused). Metadata lives in a single shared table `<workspace>/.hreader/meta.json` (`{ version: 1, docs: { <relPath>: { tags, sourceUrl?, createdBy?, savedAt? } } }`) — path-keyed, so renaming or moving a doc loses its metadata (known limitation). Reads tolerate corruption (bad JSON / wrong types / unknown version / `__proto__` keys read as empty with a code-only diagnostic), the next write backs the corrupt file aside first, the file is capped at 5 MB, and every write merges under the table lock through `writeAtomic`. `createdBy` (`user` / `agent` / `clipper`) and `savedAt` are set once on first write.
  - **HTTP**: `GET /api/doc/:docId/meta` (cookie) and `POST /api/doc/:docId/meta` (cookie+csrf) with a strict `{ tags?, addTags?, removeTags?, sourceUrl? }` body — only the given fields change, `sourceUrl: null` clears; `Origin: null` gets 403. Successful writes broadcast a new SSE event `doc.meta { docId }`; failed writes broadcast nothing.
  - **CLI**: `hr meta <file> [--tag <t>]... [--untag <t>]... [--source-url <u> | --clear-source-url] [--json]` — without mutation flags it prints the current metadata; usage errors exit 2.
  - **MCP**: `hr_get_meta { filePath }` and `hr_set_meta { filePath, tags?, addTags?, removeTags?, sourceUrl? }` — writes recorded `by: "agent"`; bounded output as usual.
  - **Search**: doc tags index as their own field with boost 2; the per-doc fingerprint gains a hash of the doc's meta-table entry so a tag edit re-indexes just that doc; the index version bumps to 4 (existing indexes rebuild once); `SearchHit` gains an additive `tags` field.
- **Document templates**: draft documents from saved template directories across three tiers — builtin < `~/.hreader/templates` < `<workspace>/.hreader/templates` (deeper tiers shadow by id). A template is a directory holding `template.json`, an entry HTML, `style.css`, `guide.md` and an optional `assets/`.
  - **CLI**: `hr template list` (merged table + `diagnostics` for broken entries), `hr template show <id>` (manifest fields, full guide, entry/style byte sizes), `hr template new <file> --template <id>` (draft from a template; assets land under `<stem>_files/`), and `hr template save <file> --id <id> [--global] [--name n] [--description d]` — the `<style id="hr-theme">` content becomes `style.css`, `<stem>_files/` becomes `assets/`, a `guide.md` draft is generated from the page's heading outline, and the write is all-or-nothing via a sibling staging dir (`file_exists` if the id is taken; no `--force`). `hr new <file> --template <id>` is an alias for `hr template new`; combining `--template` with `--kind`/`--visual` is a usage error. `HREADER_HOME` relocates the user template tier.
  - **MCP tools**: `hr_list_templates`, `hr_get_template` (bounded `entry`/`style`/`guide` with truncation markers), `hr_create_from_template` (`id` defaults to `blank-html`), and `hr_save_template` (`style`/`guide` args override the auto-extracted values, each bounded at 1 MiB).
  - **MCP prompt** `extract-template`: reads 1–5 sample pages (`hr_outline`, `hr_read_node`), derives shared visual and writing rules, and calls `hr_save_template`.
- **`HREADER_HOME` environment variable**: relocates the hReader config root (the directory holding `.hreader/permissions.json` and `daemon.json`) for commands that resolve it from `io.home` — `serve` without `--home`, `hr template` (the user tier and `save --global`), and the foreign-document permission lookup in `hr pdf` / `hr png`. Unlike `HOME`, it is not inherited by the spawned Chrome.
- **Agent annotation surface**: the sidecar store (`.hreader/annotations/`) now reaches agents on the same footing as legacy `<script id="hr-meta">` annotations.
  - **MCP**: `hr_outline` gains an additive `sidecarAnnotations` block (pending sidecar entries plus `sidecarDiagnostics`; byte-identical output for docs without a sidecar store — the keys are absent, not empty). `hr_resolve_annotation` keeps its meta lookup first and falls back to the sidecar store only on a bare not-found; the reply gains a `source` field (`meta` / `sidecar`). New tool `hr_list_annotations { filePath?, status? }`: with `filePath` it returns one doc's merged meta + sidecar entries; without it, a bounded workspace scan (≤500 docs, ≤1000 entries, `truncated` flag); `status` filters `pending` / `resolved` / `all`.
  - **CLI**: `hr annotations list <file> [--status pending|resolved|all]` prints the merged entries (status, source, excerpt, relocation), and `hr annotations migrate <file>` moves a doc's legacy hr-meta annotations into the sidecar store — idempotent, reporting migrated/skipped counts (`changed: false` when there is nothing to move).
  - **Pi extension**: pending-annotation pushes now merge `GET /api/doc/:docId/sidecar` into the meta-only feed — deduped by id, hr-meta wins collisions; meta-only behavior is unchanged.
- **Library-wide full-text search (MiniSearch)**: every HTML document in the workspace indexes its `<title>` (else first `<h1>`), heading texts, and visible body text, plus each of its annotations (hr-meta + sidecar, indexed as separate `kind: "annotation"` entries carrying `annotationId` and the text `note + exact`). The index persists at `<workspace>/.hreader/index/search.json` and updates incrementally at query time — a doc is re-indexed only when its mtime/size/sha or its sidecar store's mtime/size moved, deleted docs drop out, an unchanged library never rewrites the index file, and a corrupt or unknown-version index rebuilds fully with one diagnostic. The indexed body is a search-specific extraction: text nodes are joined with spaces so element boundaries (table cells, `<br>`, inline tags) never glue tokens together. Tokenization is `Intl.Segmenter("zh")` word segments (lowercased); terms of ≥2 code points get prefix matching, latin terms get 0.2 fuzzy, CJK terms match exactly; multi-term queries combine with AND first and fall back to OR on an empty intersection (`combine` reports which produced the list); field boosts are title 3 / headings 2 / body 1 / annotation 1. Bounds: ≤5000 docs (`truncated` + diagnostic), body text capped at 200 KB, queries 1..200 code points, `limit` 1..100 (default 20, decimal digits only), snippets ≤200 code points with `highlights` offsets into the snippet. Paths are always workspace-relative — in results and diagnostics alike.
  - **HTTP**: `GET /api/search?q=&limit=` under cookie auth (same layering as the other read routes; `Origin: null` gets 403).
  - **CLI**: `hr search <query> [--limit <n>] [--json]` — one result per line (`path`, kind, snippet); usage errors exit 2.
  - **MCP**: `hr_search { query, limit? }` with the bounded wire shape.

### Fixed

- `hr pdf` / `hr png` no longer stall for the full render deadline when `HOME` points at an empty or unwritable directory: the spawned Chrome now receives the passwd home — an empty `HOME` left its network stack stuck before the first request could even reach the export gate.

### Security

- **`hr pdf` / `hr png` on foreign HTML no longer bypasses the permission model.** Previously both commands fed every input through the print-sheet sanitizer, which silently rewrote foreign documents (dropping scripts but also sibling resources); a normalized edge case could still render unsanitized markup. Foreign documents now render as-is inside a capability-gated page: Chrome navigates to a minted `/f/<cap>/` URL on a never-resolved fake origin, and request interception answers every request through the same verdicts as the reader's `/f/` route — the document directory and its subdirectories only, the extension whitelist, and the per-effective-permission CSP. Export is a one-shot snapshot, so **document scripts never execute during export — not even for a document holding a scripts grant** (the grant exists for the interactive reader); the kill switch is a browser-level JavaScript disable, independent of the CSP. External requests (images, fonts, stylesheets, fetch) are released to the network only when the document's effective network permission is on, and `data:`/`blob:`/`about:` inline resources always pass. Managed and normalizable documents export byte-for-byte as before.

## [1.1.0] - 2026-11-27

### Added

- **Document kinds** (`hr new <file> --kind note|report|minutes|brief|slides`, and an optional `kind` on MCP `hr_create_doc`): start from a themed skeleton that already carries every `data-hr-id` and the right components, then patch block by block. The kind is recorded as `data-hr-kind` on `<article>`.
- **Slides**: in a `slides` document each top-level `<section>` is one slide — scroll-snap paging in any browser and landscape one-slide-per-page printing, with no scripts.
- **Write-time layout checks**: `hr check <file>` reports component-structure problems (`component_root`, `component_shape`), inline `style` attributes (`inline_style`), and document-level diagnostics. The same checks run on every patch; findings are returned as `warnings` by `hr patch` and `hr_patch_node` (the fragment is still written).
- **`media-card` component**: one shell for audio/video with a caption and an optional collapsible transcript.
- `atelier-editorial` theme: emphasized KPI figures, numbered timeline markers, sidebar metadata styling, and audio/video sizing inside `diagram-stage`.
- GitHub Pages gallery (`site/`) with example documents, a Markdown vs. free-form HTML vs. hReader comparison, and `scripts/build-site.sh` to regenerate it.
- **Open any HTML**: `hr serve` starts in any workspace and classifies each file as `managed`, `normalizable`, or `foreign`. Foreign pages are served from `/s/<docId>` inside a sandboxed iframe that never carries `allow-same-origin`, under a Content-Security-Policy picked per effective permission (see SECURITY.md). New additive routes: `GET /api/doc/:id/info`, `POST /api/doc/:id/trust`, `POST /api/doc/:id/normalize`, `POST /api/doc/:id/annotations/:anId/resolve`.
- **`hr import` and the MCP tool `hr_import_doc`**: convert a foreign HTML file (saved web pages, scripted decks) into a managed `*.hr.html` document — scripts, event handlers and inline styles are stripped, sections get `data-hr-id`s, and a report lists what was dropped and why.
- **Presentation mode**: `P`/`F5` enters a keyboard-driven paged view on any managed document — a top-level `<h1>` becomes the cover page and each top-level `<section>` a slide, or every top-level block when there are no sections — with step reveal through `data-hr-step`, `#p=` deep links, and speaker notes hidden while presenting. The status-bar button appears only for `slides` documents; foreign and normalizable documents cannot present. Ships with `deck-noir`, a dark 16:9 theme for `slides` documents.
- **Script and network permissions for foreign HTML**: two independent dimensions. Each has a global mode — `allow`, `deny`, or `per-doc` (the default) — stored in `~/.hreader/permissions.json`; per-document grants are keyed by workspace-relative path in `<workspace>/.hreader/trust.json`, survive edits and theme switches, and are lost on rename or move. Legacy content-hash `local` grants migrate automatically to `{scripts: true, network: false}`. New routes `POST /api/doc/:id/permissions` and `GET`/`POST /api/permissions`, a `permissions.changed` SSE event, and an additive `permissions` field on `GET /api/doc/:id/info`. Grants are read-only for agents — no MCP tool or `hr` command can change them.
- **Immersive mode and native fullscreen**: `i` or the status-bar button hides all reader chrome; Esc or the top-edge hot-zone button exits, and it also works on managed documents as a pure reading view. On desktop, ⌘⇧I toggles immersive mode and ^⌘F/F11 toggles native fullscreen. Foreign iframes carry `allow="fullscreen"`, so pages can call the Fullscreen API themselves.

### Changed

- `hr pdf` / `hr png` now use the theme embedded in the document unless `--visual` is given.
- Desktop: links to external sites open in the system browser instead of navigating the workbench.
- Hand-rolled infrastructure replaced with mature libraries: `puppeteer-core` (driving Chrome for export), `pdf-lib`, `util.parseArgs`, `zod`, `yaml`, `write-file-atomic`, `chokidar`, plus `serde`, `percent-encoding`, `which` and `signal-hook` on the Rust side.
- The `trust` field of `GET /api/doc/:id/info` and `POST /api/doc/:id/trust` now reports the **effective** scripts permission: with a global `deny` mode it returns `off` even when the document carries a grant.
- The legacy `POST /api/doc/:id/trust` endpoint now only changes the scripts dimension; it no longer clears a granted network permission.
- Per-document permission grants are keyed by document path, not content hash.
- Edge-case status codes: a request with both a bad body and a missing document returns 400 before 404; lowercase HTTP methods return 405; a document ID containing NUL returns 400; `ENAMETOOLONG` returns 404; a non-UTF-8 body returns 400. Patch and annotation writes to a foreign document return 422 without touching the file, while a theme switch on one returns 200.
- Overlong diagnostic lines on `hr` and `hreader-mcp` stderr are truncated at 8 KiB with a `…[truncated N chars]` marker. stdout and `--json` output are unchanged.
- Internal: CI runs as parallel jobs with per-job timeouts, wall-clock test assertions were replaced with deterministic proofs, and absolute-time performance budgets moved into a dedicated `pnpm test:perf` suite that runs without coverage instrumentation.

### Fixed

- **Reader annotations now reach agents**: `hr outline` / `hr_outline` `pendingAnnotations` previously only recognized the legacy meta schema (`targetId` / `comment` / `pending_ai`), so notes written by the reader (`nodeId` / `note` / `pending`) were invisible to agents and the annotate → patch loop was broken. Both schemas are now read.
- The workspace watcher now recurses into subdirectories: files added, changed, renamed or removed inside subfolders broadcast `library.changed`, so the reader and desktop file trees stay fresh. Symlinks pointing outside the workspace cannot leak events, and `.hreader`, `.git`, `node_modules` and temp files are ignored at any depth.
- The watcher no longer swallows external writes, mishandles symlinked workspaces, or misses writes that landed before it became ready.
- The undo chain now includes style changes.
- `EPIPE` on closed pipes and a deep-nesting overflow in `print-html` no longer crash the CLI.
- Presentation-mode edge cases around keyboard input and step reveal.

### Security

- Foreign pages always render in a sandboxed iframe whose `sandbox` attribute never contains `allow-same-origin`, and every `/s/` response carries a CSP `sandbox` directive so even a top-level navigation stays in an opaque origin (see SECURITY.md).
- Fixed CSS-comment `</style>` injection and print-export mXSS through `<noscript>`.
- Fixed CSS URL filter bypasses that could lead to SSRF during export.
- The desktop bridge is authenticated with a per-session token, and native navigation follows an allowlist.
- Fixed `</script>` injection into the desktop startup script.
- Terminal escape sequences are stripped from CLI output.
- MCP `ui://` resource views sanitize document HTML instead of inlining raw workspace bytes.
- With the network permission off, a foreign page's self-navigation is blocked, and prefetch-type `<link>` hints (`dns-prefetch`, `preconnect`, `prefetch`, `prerender`, `modulepreload`) are stripped from the served markup.

## [1.0.0] - 2026-11-21

Initial open-source release of **hReader**.

### Highlights

- **Desktop Workbench (`hReader`, Tauri v2 + TypeScript/Rust)**:
  - Bundled standalone CLI daemon (`cli.mjs` + `styles/`) and workbench frontend directly inside installers across macOS (Apple Silicon & Intel `.dmg` / `.app.zip`), Windows (`.msi` / NSIS `.exe`), and Linux (`.deb` / `.AppImage`).
  - Typora + Obsidian inspired workspace layout: macOS seamless `Overlay` titlebar with hidden title divider, full-height recursive Vault folder tree (`scan_workspace_tree`) with auto-jump to `OUTLINE` on opening a note, centered reading/editing canvas, and collapsible annotation drawer.
  - Clean Empty Workspace screen when opening a folder without `.html` files yet (Create Starter Note, Open HTML File, Switch Workspace Folder) instead of erroring or generating unsolicited files on launch.
  - Hover-to-reveal bottom toolbar with Settings toggle between **Floating Frosted Pill** (`floating`) and **Full-Width Slide-Up Bar** (`bar`).
  - Pure Native Light (`ui:light`) default theme, Warm Paper (`ui:paper`), Pro Dark (`ui:dark`), plus JSON-configurable user custom themes in `~/.hreader/themes/*.json` and `<workspace>/.hreader/themes/*.json`.
  - Automatic WKWebView same-origin token/cookie reauth recovery and native window drag region support.
  - Built-in PDF, PNG, and printable HTML export, block tag conversion (`p` / `h1`–`h3` / `blockquote`), semantic component insertion, source mode, focus mode, and snapshot undo.

- **Document Core & CLI (`@hreader/core`, `@hreader/cli`)**:
  - Deterministic `data-hr-id` addressing (`hr normalize`), compact structural outline (`hr outline`), byte-bounded node reading (`hr read`), atomic interval patching with XSS/script guardrails and undo snapshots (`hr patch`, `hr undo`).
  - Style subsystem (`hr style`) supporting orthogonal visual CSS injection (`atelier-editorial`), writing-tone prompt compilation (`--tone`), forbidden-phrase linting (`--lint`), and `style.yaml` corpus extraction (`style extract`).
  - Local authenticated HTTP + SSE reader server (`hr serve`) with `SameSite=Strict` cookie sessions and live reload.

- **Plugins & Agent Integrations**:
  - **MCP Server (`@hreader/mcp-server`)**: Standalone bundled server (`stdio` and Streamable HTTP) exposing `hr_outline`, `hr_read_node`, `hr_create_doc`, `hr_patch_node`, `hr_apply_style`, `hr_resolve_annotation`, `hr_undo`, plus `use-hreader-style` prompt and `--workspace` safety boundary.
  - **Portable Agent Skill (`skills/hreader/`)**: Self-contained distributable bundle (`hreader-skill.tar.gz` / `.zip`) with `SKILL.md`, component/style specifications, and zero-install CLI wrapper (`scripts/hr.mjs`).
  - **Pi Coding Agent Extension (`packages/pi-extension`)**: Single-file extension with `/hreader`, `/hr-style`, and live annotation injection.
  - **DeepSeek Harness Bundle (`packages/dsh-bundle`)**: Cordis plugin integrating hReader system prompt specs and typed workspace services.

[Unreleased]: https://github.com/JingMox/hReader/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/JingMox/hReader/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/JingMox/hReader/releases/tag/v1.0.0
