# Plugin & Agent Integration Guide

hReader is built so human readers and AI coding agents work on the exact same `.html` files without copying files around or regenerating thousands of lines on every edit.

---

## 1. MCP Server (`@hreader/mcp-server`)

### Installation

Download `hreader-mcp-server.tar.gz` from [GitHub Releases](https://github.com/JingMox/hReader/releases) and extract it anywhere (only **Node.js `>= 22`** is required — all JS dependencies and built-in `styles/` are bundled):

```bash
tar -xzf hreader-mcp-server.tar.gz -C ~/.local/share/
```

Or build directly from this monorepo:

```bash
pnpm install --frozen-lockfile
pnpm -C packages/mcp-server build
# Entry: packages/mcp-server/dist/main.js
```

### Exposed MCP Capabilities

| Tool                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `hr_outline`            | Inspect compact heading/node IDs, word counts & annotations |
| `hr_read_node`          | Read a single subtree by CSS selector or `data-hr-id`       |
| `hr_create_doc`         | Create a new semantic HTML document inside `--workspace`; optional `kind` (`note` / `report` / `minutes` / `brief` / `slides`) starts from that kind's skeleton |
| `hr_patch_node`         | Atomic `replace`, `insert_before`, `insert_after`, `append`, or `delete`; layout problems in the fragment come back as `warnings` |
| `hr_apply_style`        | Apply visual theme CSS or check tone / forbidden words      |
| `hr_resolve_annotation` | Mark reader annotations resolved / replied                  |
| `hr_undo`               | Roll back the previous write snapshot                       |

Prompt exported: `use-hreader-style`.

### Client Configurations (`stdio`)

Always pass `--workspace <your-docs-dir>` so host apps that launch servers from `/` or `$HOME` enforce the right sandbox root.

#### Claude Desktop / Cursor / Antigravity (`mcpServers`)

```json
{
  "mcpServers": {
    "hreader": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/hreader-mcp-server/dist/main.js",
        "--workspace",
        "/ABSOLUTE/PATH/TO/YOUR/DOCUMENTS"
      ]
    }
  }
}
```

#### Streamable HTTP Transport

```bash
node /path/to/hreader-mcp-server/dist/main.js --http 3000 --workspace /path/to/docs
```

---

## 2. Standalone Agent Skill (`skills/hreader/`)

Download `hreader-skill.tar.gz` or `hreader-skill.zip` from Releases (or run `pnpm skill:pack` from source to build `release-artifacts/hreader-skill/`).

It contains:
- `SKILL.md` — Agent operating instructions and the 5-primitive workflow (`outline` -> `read` -> temp fragment -> `patch` -> verify)
- `references/components-spec.md` — Copy-ready HTML patterns for all 8 semantic components, plus the structure rules that `hr check` / `hr patch` enforce
- `references/style-authoring.md` — Authoring custom `style.yaml` voice specs
- `scripts/hr.mjs` — Launcher wrapping bundled `scripts/cli.mjs` and `scripts/styles/`

Quick test:

```bash
node /path/to/hreader-skill/scripts/hr.mjs outline /path/to/doc.html
```

---

## 3. Pi Coding Agent Extension (`packages/pi-extension`)

Single-file extension [`packages/pi-extension/pi-hreader.ts`](../packages/pi-extension/pi-hreader.ts):

- `/hreader <doc.html>` — Start/attach to `hr serve`, show local reader link, and subscribe to live reader SSE annotations.
- `/hr-style <style-id>` — Switch or inspect active writing-style rules (`atelier-editorial` or `.hreader/style.yaml`).
- Pending annotations made in the browser or desktop app are formatted into the agent session context automatically.

Smoke test in repo:

```bash
pnpm smoke:pi
```

---

## 4. DeepSeek Harness Bundle (`packages/dsh-bundle`)

Cordis plugin package [`packages/dsh-bundle/`](../packages/dsh-bundle):

```bash
pnpm -C packages/dsh-bundle build
dsh plugin --profile <your-profile> add "$(pwd)/packages/dsh-bundle"
```

- Weaves `hreader` language & semantic component specifications directly into `systemPrompt.section` via `compileTone`.
- Accepts optional `workspace` and `styleId` plugin configuration (defaults to current working directory and `atelier-editorial`).

---

## 5. Customizing Desktop UI Themes vs. Document Visual Styles

hReader cleanly separates **Desktop Chrome Appearance** from **Document Visual Print Styles**:

1. **Desktop UI Theme (`~/.hreader/themes/*.json` or `<workspace>/.hreader/themes/*.json`)**:
   Controls sidebar, background, accent, borders, and canvas surfaces inside the Tauri workbench without altering `.html` document bytes.
2. **Document Visual Style (`styles/<id>/theme.css` or `.hreader/style.yaml`)**:
   Controls embedded typographic layout, component styling, and editorial tone prompts stored with or compiled into the `.html` document itself (`hr style --visual` / `hr style --tone`).
