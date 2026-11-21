# Changelog

All notable changes to **hReader** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
