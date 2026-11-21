<div align="center">
  <img src="packages/desktop/src-tauri/icons/icon.png" width="92" height="92" alt="hReader Logo" />
  <h1>hReader</h1>
  <p><strong>Local-First, Single-File HTML Reader, Desktop Notes Workbench &amp; Agent Authoring Protocol.</strong></p>
  <p>
    <a href="https://github.com/JingMox/hReader/releases"><img src="https://img.shields.io/github/v/release/JingMox/hReader?display_name=tag&style=flat-square" alt="Release" /></a>
    <a href="https://github.com/JingMox/hReader/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JingMox/hReader/ci.yml?branch=main&label=CI&style=flat-square" alt="CI" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" alt="Node >= 22" />
    <img src="https://img.shields.io/badge/tauri-v2-24C8DB?style=flat-square" alt="Tauri v2" />
  </p>
  <p>
    <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
  </p>
</div>

---

hReader turns self-contained semantic `.html` documents into both a **Typora + Obsidian inspired desktop reading & editing workbench** (`hReader`) and a **surgical, token-efficient authoring substrate for AI Agents** (CLI, MCP Server, Agent Skill, Pi Coding Agent Extension, DeepSeek Harness Bundle).

## Why Semantic HTML Instead of Markdown?

- **One Self-Contained Artifact**: Layout CSS themes (`atelier-editorial`), semantic blocks (`kpi-bento`, `callout-insight`, `callout-warning`, `split-compare`, `deep-dive`, `step-timeline`, `diagram-stage`), interactive `<details>` disclosures, inline SVG charts, and reader annotations all live inside a single `.html` file that opens cleanly in any browser.
- **Surgical DOM Patching (`data-hr-id`)**: Instead of rewriting thousands of lines to fix one section, AI agents inspect the compact outline (`hr outline` / `hr_outline`), read one node (`hr read` / `hr_read_node`), and patch that exact subtree (`hr patch` / `hr_patch_node`) with atomic writes and undo snapshots (`hr undo` / `hr_undo`).
- **Orthogonal Visual Theme + Writing Tone**: Visual themes (`styles/atelier-editorial/theme.css`) restyle a document cleanly without touching prose; language tone specs (`hr style --tone`) and forbidden-phrase linters (`hr style --lint`) enforce editorial consistency.
- **Human ↔ Agent Co-Editing**: Readers highlight passages and add `pending_ai` annotations in the desktop workbench or browser reader (`hr serve`); agents pull pending annotations, patch only the affected nodes, and the workbench live-reloads over SSE.

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
# Inspect structure & pending annotations
hr outline report.html [--json]

# Inject deterministic data-hr-id anchors (if missing)
hr normalize report.html --write [--json]

# Read a node by CSS selector or data-hr-id
hr read report.html s2-p1 [--json] [--max-bytes 65536]

# Surgical node patch (replace | insert_before | insert_after | append | delete)
hr patch report.html s2-p1 --action replace --html-file patch.html [--json]

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
