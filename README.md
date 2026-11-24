<div align="center">
  <img src="packages/desktop/src-tauri/icons/icon.png" width="92" height="92" alt="hReader Logo" />
  <h1>hReader</h1>
  <p><strong>The document layer for AI agents: notes, reports, minutes, briefs, and slides in one tidy, reviewable, surgically editable HTML format.</strong></p>
  <p>
    <a href="https://github.com/JingMox/hReader/releases"><img src="https://img.shields.io/github/v/release/JingMox/hReader?display_name=tag&style=flat-square" alt="Release" /></a>
    <a href="https://github.com/JingMox/hReader/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JingMox/hReader/ci.yml?branch=main&label=CI&style=flat-square" alt="CI" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" alt="Node >= 22" />
  </p>
  <p>
    <a href="https://jingmox.github.io/hReader/">Live gallery</a> ·
    <a href="./docs/launch/why-html.en.md">Why HTML</a> ·
    <a href="https://github.com/JingMox/hReader/releases">Download</a> ·
    <a href="./README.zh-CN.md">简体中文</a>
  </p>
</div>

<p align="center">
  <img src="site/img/demo.gif" width="880" alt="Demo: select a sentence in the reader, leave a note, the agent patches only that block and the page live-reloads" />
</p>

<p align="center"><sub>Select a sentence, leave a note → the agent patches just that block over MCP → the reader live-reloads and archives the note.</sub></p>

Emitting HTML costs an AI no more than emitting Markdown — but AI layout is too free, and it changes every time. hReader constrains it with **8 semantic components and a theme**, **checks those constraints at write time**, and gives every block a **stable id** so an agent edits only the part you annotated. Every document is a plain `.html` file on your disk: double-click to open, readable and writable by any agent.

It is not just a note-taking tool. Anything an agent hands to a human — a weekly report, a research write-up, meeting minutes, a decision brief, a slide deck — can be the same format:

| Kind    | One command to start                | Skeleton                                                                                        |
| ------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Note    | `hr new note.html`                  | Free-form                                                                                       |
| Report  | `hr new q4.html --kind report`      | Conclusion → key numbers → analysis → options → risks → next steps                              |
| Minutes | `hr new weekly.html --kind minutes` | Decisions → discussion → action items → recording & transcript                                  |
| Brief   | `hr new brief.html --kind brief`    | Recommendation → evidence → cost & risk → next steps                                            |
| Slides  | `hr new deck.html --kind slides`    | One `<section>` per slide; scroll to advance, prints landscape one slide per page, zero scripts |

## Try it in one minute

Start with MCP or the Agent Skill (Node.js 22+ required).

**MCP** (Claude Desktop, Cursor, …): download `hreader-mcp-server.tar.gz` from [Releases](https://github.com/JingMox/hReader/releases), extract it, and add:

```json
{
  "mcpServers": {
    "hreader": {
      "command": "node",
      "args": ["/path/to/hreader-mcp-server/dist/main.js", "--workspace", "/path/to/your/docs"]
    }
  }
}
```

**Agent Skill** (Claude Code, …): download `hreader-skill.zip` and extract it into your agent's skills directory:

```bash
unzip hreader-skill.zip -d ~/.claude/skills/
```

Then ask your agent: "Use hreader to turn this meeting into notes."

## Same content, three ways

<p align="center">
  <a href="https://jingmox.github.io/hReader/compare/"><img src="site/img/compare.png" width="880" alt="Left: Markdown; middle: free-form AI HTML; right: hReader" /></a>
</p>

Left: Markdown — audio is a bare link or a naked player. Middle: free-form AI HTML — pretty, but every block has its own style and the next generation looks different again. Right: hReader — same content, with recordings, summaries, and collapsible transcripts always in the same place. [See it live →](https://jingmox.github.io/hReader/)

## Why HTML instead of Markdown

- **Markdown won by not letting you do layout.** Humans paid the cost of layout, so we chose the least expressive, cheapest format.
- **AI just paid that cost.** For a model, HTML is as cheap as Markdown — cards, comparisons, disclosures, audio, video, and charts come for free.
- **But AI layout is too free.** Ten documents, ten looks; a library of them is messier than Markdown. So constrain it: components declare meaning only (`data-hr-component="callout-warning"`), the theme decides the look, and re-theming never touches prose.
- **Patch, don't regenerate.** Every block has a stable `data-hr-id`. Agents read the outline (`hr_outline`), read one block (`hr_read_node`), and patch one block (`hr_patch_node`) with atomic writes and undo (`hr_undo`).
- **The file is yours.** Local `.html`, no vendor lock-in; works with Claude Code, Cursor, Codex, DeepSeek, or any agent that speaks MCP or Skills.

Full argument: [In the AI era, your notes should be HTML, not Markdown](./docs/launch/why-html.en.md).

## Status

v1.0 was just open-sourced and it's early: 8 components and 1 theme so far; layout constraints are now checked at write time (`hr check`, and `warnings` in every `hr patch` receipt) but only warn, never reject; the slides kind is a standalone-file experience in the browser for now — an in-reader presentation mode and landscape `hr pdf` export are not done yet; the desktop app needs Node 22 locally and installers aren't signed yet. Next on the roadmap: more themes, Markdown import, and controlled interactive components. Tell me what you'd want to embed in [Issues](https://github.com/JingMox/hReader/issues).

---

## Desktop App (`hReader`)

Built with **Tauri v2** + TypeScript/Rust, bundling the standalone CLI (`cli.mjs` + `styles/`) and workbench frontend (`packages/app/dist/`) inside the application package.

### Supported Platforms ([GitHub Releases](https://github.com/JingMox/hReader/releases))

| Platform    | Architecture                           | Release Artifacts     |
| ----------- | -------------------------------------- | --------------------- |
| **macOS**   | Apple Silicon (`aarch64-apple-darwin`) | `.dmg`, `.app.zip`    |
| **macOS**   | Intel (`x86_64-apple-darwin`)          | `.dmg`, `.app.zip`    |
| **Windows** | x64 (`x86_64-pc-windows-msvc`)         | `.msi`, `.exe` (NSIS) |
| **Linux**   | x64 (`x86_64-unknown-linux-gnu`)       | `.deb`, `.AppImage`   |

### Runtime Prerequisites & First-Launch Notes

- **Node.js `>= 22`** is required on `PATH` (or standard nvm / fnm / Volta / Homebrew / Program Files locations) to run the bundled daemon/CLI (`cli.mjs`).
- **Google Chrome / Microsoft Edge / Chromium** _(optional)_ is required only for **Export PDF** (`hr pdf`) and **Export PNG** (`hr png`).
- **Unsigned Binaries**: `v1.0.0` installers are not Apple-notarized or EV-signed yet:
  - **macOS**: Right-click `hReader.app` -> **Open**, or run `xattr -dr com.apple.quarantine /Applications/hReader.app`.
  - **Windows**: Click **More info -> Run anyway** on the SmartScreen prompt.
  - **Linux**: `chmod +x *.AppImage` before launching, or install the `.deb` package.

### Workbench Highlights

- **Typora + Obsidian Layout**: Seamless macOS Overlay Titlebar with hidden native title bar divider, full-height recursive Vault folder tree (`scan_workspace_tree`) that automatically switches to `OUTLINE` when opening a note, centered reading/editing canvas, and collapsible right annotation drawer.
- **Clean Empty Workspace State**: Opening an empty folder (or launching without prior documents) opens a clean Empty State page with direct actions to **Create Starter Note**, **Open HTML File**, or **Switch Workspace Folder** instead of throwing errors or writing unsolicited files.
- **Hover-to-Reveal Bottom Toolbar**: Hidden by default for zero-distraction reading and revealed when hovering the bottom edge — switchable in Settings between **Floating Frosted Pill** (`floating`) and **Full-Width Slide-Up Bar** (`bar`).
- **Appearance & User Custom Themes**: Defaults to **Pure Native Light** (`ui:light`), with **Warm Paper** (`ui:paper`), **Pro Dark** (`ui:dark`), and user-defined `.json` themes loaded from `~/.hreader/themes/*.json` or `<workspace>/.hreader/themes/*.json`.
- **Native Menus, Block Editing & Export**: Inline block editing, tag switching (`p` / `h1`–`h3` / `blockquote`), semantic component insertion, snapshot undo, source mode, focus mode, and one-click PDF / PNG / print HTML export.

### Keyboard Shortcuts

| Action                                | Shortcut (`macOS` / `Win & Linux`) |
| ------------------------------------- | ---------------------------------- |
| New Document                          | `Cmd/Ctrl + N`                     |
| Quick Switch Document                 | `Cmd/Ctrl + O`                     |
| Open HTML File (Finder / File Picker) | `Cmd/Ctrl + Shift + O`             |
| Open Workspace Folder                 | `Cmd/Ctrl + Alt + O`               |
| Save Now                              | `Cmd/Ctrl + S`                     |
| System Print                          | `Cmd/Ctrl + P`                     |
| Edit Selected Block HTML              | `Cmd/Ctrl + E`                     |
| Insert Semantic Component Panel       | `Cmd/Ctrl + Shift + K`             |
| Undo Document Snapshot                | `Cmd/Ctrl + Shift + Z`             |
| Toggle Left Sidebar (Files / Outline) | `Cmd/Ctrl + Shift + L`             |
| Toggle Right Annotations Drawer       | `Cmd/Ctrl + Shift + R`             |
| Toggle Source Mode                    | `Cmd/Ctrl + /`                     |
| Toggle Focus Mode                     | `Cmd/Ctrl + Shift + F`             |
| Reload Window View                    | `Cmd/Ctrl + R`                     |
| Settings                              | `Cmd/Ctrl + ,`                     |

### Custom UI Theme Configuration

Place `.json` files inside `~/.hreader/themes/` (global) or `<workspace>/.hreader/themes/` (workspace-local, overrides matching IDs). Use **Theme -> Open Custom Themes Folder…** in the app menu to auto-generate an editable `nord-example.json`:

```json
{
  "id": "nord-slate",
  "name": "Nord Slate",
  "base": "dark",
  "vars": {
    "--hr-paper": "#1d222b",
    "--hr-bg": "#1d222b",
    "--hr-fg": "#e5e9f0",
    "--hr-ink": "#eceff4",
    "--hr-accent": "#88c0d0",
    "--hr-rule": "#2e3440",
    "--hr-border": "#2e3440",
    "--hrd-panel-bg": "#171b22",
    "--hrd-sb-bg": "rgba(23, 27, 34, 0.92)",
    "--hrd-guide": "#323946",
    "--hrd-card-bg": "#242933"
  },
  "css": ""
}
```

### Build Desktop App from Source

Prerequisites: **Node.js `>= 22`**, **pnpm `11`**, and **Rust `1.98.0`** (auto-selected via `rust-toolchain.toml`). On Linux, install WebKitGTK/Tauri system packages (`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev`).

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm desktop:build
```

---

## CLI (`hr`)

`@hreader/cli` builds into a standalone single-file executable bundle (`packages/cli/dist/cli.mjs` + `styles/`, also published as `hreader-cli.tar.gz` in GitHub Releases).

```bash
# Start a document from a kind skeleton (ids in place, themed, components pre-placed)
hr new report.html [--kind note|report|minutes|brief|slides] [--title <title>] [--force]

# Inspect structure & pending annotations
hr outline report.html [--json]

# Inject deterministic data-hr-id anchors (if missing)
hr normalize report.html --write [--json]

# Read a node by CSS selector or data-hr-id
hr read report.html s2-p1 [--json] [--max-bytes 65536]

# Surgical node patch (replace | insert_before | insert_after | append | delete)
hr patch report.html s2-p1 --action replace --html-file patch.html [--json]

# Check layout constraints: component structure, inline styles, document diagnostics (read-only)
hr check report.html [--json]

# Apply visual theme, inspect tone prompt, lint forbidden phrases, or extract style.yaml
hr style report.html --visual atelier-editorial
hr style report.html --tone atelier-editorial
hr style report.html --lint
hr style extract sample1.md sample2.md --id my-voice --out .hreader/style.yaml [--no-llm]

# Undo last write snapshot
hr undo report.html [--json]

# Export & Render
hr export report.html --visual atelier-editorial --out print.html [--force]
hr pdf report.html --out report.pdf [--page-size a4|letter|a5] [--force]
hr png report.html --out report.png [--width 256..4096] [--scale 1..3]

# Launch local reader server with live SSE reload
hr serve report.html [--workspace <dir>] [--port <n>]
```

Exit codes: `0` success, `1` domain/validation error, `2` usage/needs-normalize error, `3` I/O or workspace-boundary error, `70` internal error.

---

## Plugins & Agent Integrations

See [Plugin & Integration Guide](./docs/06-plugins-and-integrations.md) for detailed setups across hosts.

### 1. MCP Server (`@hreader/mcp-server`)

Bundled into `packages/mcp-server/dist/main.js` + `styles/` (published as `hreader-mcp-server.tar.gz` in GitHub Releases — runs directly with `node`, no `npm install` required).

- **7 Tools**: `hr_outline`, `hr_read_node`, `hr_create_doc`, `hr_patch_node`, `hr_apply_style`, `hr_resolve_annotation`, `hr_undo`
- **Prompt**: `use-hreader-style`
- **Transports**:
  - `stdio` _(Claude Desktop, Cursor, Antigravity, etc.)_: `node /path/to/hreader-mcp-server/dist/main.js --workspace /path/to/your/docs`
  - `Streamable HTTP`: `node /path/to/hreader-mcp-server/dist/main.js --http 3000 --workspace /path/to/your/docs`

> Passing `--workspace <dir>` is strongly recommended when an MCP host launches servers from `/` or `$HOME`.

```json
{
  "mcpServers": {
    "hreader": {
      "command": "node",
      "args": ["/path/to/hreader-mcp-server/dist/main.js", "--workspace", "/path/to/your/documents"]
    }
  }
}
```

### 2. Standalone Agent Skill (`skills/hreader/`)

Generates a self-contained skill bundle (`release-artifacts/hreader-skill/`, also published as `hreader-skill.tar.gz` and `hreader-skill.zip`) containing `SKILL.md`, `references/components-spec.md`, `references/style-authoring.md`, `scripts/hr.mjs`, `scripts/cli.mjs`, and `scripts/styles/`.

```bash
pnpm skill:pack
node release-artifacts/hreader-skill/scripts/hr.mjs outline /path/to/doc.html
```

Drop `hreader-skill/` into your agent's skills directory; `scripts/hr.mjs` resolves the bundled `./cli.mjs` before falling back to repo source or global `hr`.

### 3. Pi Coding Agent Extension (`packages/pi-extension`)

Single-file extension [`packages/pi-extension/pi-hreader.ts`](packages/pi-extension/pi-hreader.ts) supporting `/hreader <path>`, `/hr-style`, and live annotation injection over `hr serve` SSE events.

### 4. DeepSeek Harness Bundle (`packages/dsh-bundle`)

Cordis plugin [`packages/dsh-bundle/src/index.ts`](packages/dsh-bundle/src/index.ts) weaving `hreader` language specifications into `systemPrompt.section` and exposing typed document services.

---

## Architecture & Monorepo Packages

| Package                  | Role                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `@hreader/core`          | Semantic HTML parser, `data-hr-id` tree, outline, surgical patch, style & HTTP/SSE server |
| `@hreader/protocol`      | Shared MCP / tool schemas and protocol contracts                                          |
| `@hreader/renderer-html` | Print/PDF/PNG HTML renderer via headless Chromium                                         |
| `@hreader/app`           | Browser/webview reader application bundle (`dist/`)                                       |
| `@hreader/cli`           | Standalone `hr` CLI & local server daemon                                                 |
| `@hreader/desktop`       | Tauri v2 desktop workbench shell (`Rust` + embedded workbench UI)                         |
| `@hreader/mcp-server`    | Standalone MCP server (`stdio` & Streamable HTTP)                                         |
| `@hreader/pi-extension`  | Pi Coding Agent extension                                                                 |
| `@hreader/dsh-bundle`    | DeepSeek Harness (Cordis) plugin                                                          |
| `skills/hreader`         | Portable Agent Skill (`SKILL.md` + bundled CLI wrapper)                                   |

---

## Development & Quality Gates

All workspace source packages enforce strict ESLint bounds, Prettier formatting, 100% test coverage across statements/branches/functions/lines (`vitest`), circular-dependency checks (`dependency-cruiser`), dead-code checks (`knip`), and Rust Clippy (`-D warnings`).

```bash
# Install dependencies
pnpm install

# Full 10-step JS/TS verification gate
pnpm verify

# Rust desktop shell checks (cargo fmt + clippy -D warnings + Rust tests)
pnpm desktop:check

# Optional print E2E (requires Chrome/Edge/Chromium) & Pi extension smoke test
pnpm test:e2e
pnpm smoke:pi
```

---

## Documentation

- [简体中文文档](./README.zh-CN.md)
- [Plugin & Agent Integration Guide](./docs/06-plugins-and-integrations.md)
- [Changelog](./CHANGELOG.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)
- [Architecture & Roadmap](./docs/02-architecture-and-roadmap.md)
- [Engineering Standards](./docs/04-engineering-standards.md)
- [Desktop Shell Internals](./packages/desktop/README.md)
- [Known Defects Ledger](./docs/known-defects.md)

---

## License

[MIT](./LICENSE) © 2026 hReader Contributors
