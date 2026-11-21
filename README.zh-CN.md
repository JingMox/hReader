<div align="center">
  <img src="packages/desktop/src-tauri/icons/icon.png" width="92" height="92" alt="hReader Logo" />
  <h1>hReader</h1>
  <p><strong>本地优先的单文件 HTML 阅读器、桌面笔记工作台与 AI Agent 结构化写作协议</strong></p>
  <p>
    <a href="https://github.com/JingMox/hReader/releases"><img src="https://img.shields.io/github/v/release/JingMox/hReader?display_name=tag&style=flat-square" alt="Release" /></a>
    <a href="https://github.com/JingMox/hReader/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JingMox/hReader/ci.yml?branch=main&label=CI&style=flat-square" alt="CI" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" alt="Node >= 22" />
    <img src="https://img.shields.io/badge/tauri-v2-24C8DB?style=flat-square" alt="Tauri v2" />
  </p>
  <p>
    <a href="./README.md">English</a> · <strong>简体中文</strong>
  </p>
</div>

---

hReader 把自包含的语义化 `.html` 长文档变成两样东西：**类 Typora + Obsidian 体验的桌面阅读/笔记工作台**（`hReader`），以及一套 **面向 AI Agent 的低 Token、高精度 DOM 读写协议**（CLI、MCP Server、Agent Skill、Pi Coding Agent 扩展、DeepSeek Harness 插件）。

## 为什么选择语义化 HTML 而不是纯 Markdown？

- **单文件即完整作品**：排版主题样式（`atelier-editorial`）、语义化内容组件（`kpi-bento`、`callout-insight`、`callout-warning`、`split-compare`、`deep-dive`、`step-timeline`、`diagram-stage`）、可折叠 `<details>`、内联 SVG 图表与读者批注全部内嵌在同一个 `.html` 文件里，任何浏览器双击即可完美呈现。
- **字节级精准 DOM 修补（`data-hr-id`）**：AI 改长文不再需要重写上千行。先看紧凑大纲（`hr outline` / `hr_outline`），再读取单个节点（`hr read` / `hr_read_node`），最后精确替换或插入该子树（`hr patch` / `hr_patch_node`），原子落盘且自动生成可撤销快照（`hr undo` / `hr_undo`）。
- **视觉主题与写作口吻正交解耦**：排版视觉样式（`styles/atelier-editorial/theme.css`）可独立切换而不污染正文；写作口吻约束（`hr style --tone`）与禁用词检查（`hr style --lint`）保证行文一致。
- **人机协同批注闭环**：读者在桌面工作台或浏览器阅读器（`hr serve`）中划词并留下 `pending_ai` 批注；Agent 拉取待处理批注、仅修改对应节点，工作台通过 SSE 实时热刷新。

---

## 桌面端工作台 (`hReader`)

基于 **Tauri v2** + TypeScript / Rust 构建，安装包内置独立 CLI（`cli.mjs` + `styles/`）与阅读器前端资源（`packages/app/dist/`）。

### 支持平台与安装包（[GitHub Releases](https://github.com/JingMox/hReader/releases)）

| 平台        | 架构                                   | 发布产物              |
| ----------- | -------------------------------------- | --------------------- |
| **macOS**   | Apple Silicon (`aarch64-apple-darwin`) | `.dmg`, `.app.zip`    |
| **macOS**   | Intel (`x86_64-apple-darwin`)          | `.dmg`, `.app.zip`    |
| **Windows** | x64 (`x86_64-pc-windows-msvc`)         | `.msi`, `.exe` (NSIS) |
| **Linux**   | x64 (`x86_64-unknown-linux-gnu`)       | `.deb`, `.AppImage`   |

### 运行前提与首次启动说明

- **Node.js `>= 22`**：需要安装在 `PATH`（或 nvm / fnm / Volta / Homebrew / Program Files 默认路径）中，用于运行内置本地服务与 CLI（`cli.mjs`）。
- **Google Chrome / Microsoft Edge / Chromium**（可选）：仅在使用 **导出 PDF**（`hr pdf`）与 **导出 PNG**（`hr png`）时需要。
- **未签名安装包首次打开方式**（`v1.0.0` 暂未购买 Apple / EV 签名证书）：
  - **macOS**：右键 `hReader.app` -> **打开**，或在终端运行 `xattr -dr com.apple.quarantine /Applications/hReader.app`。
  - **Windows**：在 SmartScreen 提示中点击 **更多信息 -> 仍要运行**。
  - **Linux**：运行 `.AppImage` 前先执行 `chmod +x *.AppImage`，或直接安装 `.deb` 包。

### 工作台核心特性

- **Typora + Obsidian 融合布局**：macOS 无割裂 Overlay 标题栏（`hiddenTitle`），通高可折叠 Vault 递归文件夹树（`scan_workspace_tree`），点击文档自动切换到 `OUTLINE` 大纲；居中的阅读/编辑画布与右侧批注抽屉。
- **空白工作区空状态页面**：打开一个尚无 `.html` 文档的空文件夹（或首次启动无文档）时，优雅进入空状态页，提供 **新建示例笔记**、**打开 HTML 文档** 与 **切换工作区文件夹** 入口，不报错也不偷偷写入未授权文件。
- **悬停显隐底部工具栏**：阅读时默认隐藏做到零干扰，鼠标靠近底部边缘自动浮现；可在设置中一键切换 **悬浮毛玻璃胶囊 (`floating`)** 或 **通栏滑入工具条 (`bar`)**。
- **多外观模式与用户自定义 JSON 主题**：默认 **纯净原生白 (`ui:light`)**，内置 **暖纸典藏 (`ui:paper`)** 与 **深色静谧 (`ui:dark`)**，并支持从 `~/.hreader/themes/*.json` 与 `<workspace>/.hreader/themes/*.json` 热加载用户自定义主题。
- **原生菜单与完整写作工具链**：双击/快捷键编辑块 HTML、段落与标题标签切换（`p` / `h1`–`h3` / `blockquote`）、插入 7 类语义化组件、快照撤销、源码模式、专注模式、PDF / PNG / 打印版 HTML 导出。

### 快捷键一览

| 功能                          | 快捷键（`macOS` / `Win & Linux`） |
| ----------------------------- | --------------------------------- |
| 新建文档                      | `Cmd/Ctrl + N`                    |
| 快速切换文档                  | `Cmd/Ctrl + O`                    |
| 从访达 / 文件管理器打开 HTML  | `Cmd/Ctrl + Shift + O`            |
| 打开工作区文件夹              | `Cmd/Ctrl + Alt + O`              |
| 立即保存                      | `Cmd/Ctrl + S`                    |
| 系统打印                      | `Cmd/Ctrl + P`                    |
| 编辑当前选中块 HTML           | `Cmd/Ctrl + E`                    |
| 打开语义组件面板              | `Cmd/Ctrl + Shift + K`            |
| 撤销文档快照                  | `Cmd/Ctrl + Shift + Z`            |
| 显隐左侧边栏（文件树 / 大纲） | `Cmd/Ctrl + Shift + L`            |
| 显隐右侧批注抽屉              | `Cmd/Ctrl + Shift + R`            |
| 切换源码模式                  | `Cmd/Ctrl + /`                    |
| 专注模式                      | `Cmd/Ctrl + Shift + F`            |
| 刷新窗口视图                  | `Cmd/Ctrl + R`                    |
| 偏好设置                      | `Cmd/Ctrl + ,`                    |

### 自定义外观主题（JSON 配置）

将 `.json` 文件放到 `~/.hreader/themes/`（全局生效）或 `<workspace>/.hreader/themes/`（仅当前工作区生效，同 `id` 覆盖全局）。也可以在菜单栏点击 **主题 -> 打开自定义主题目录…**，会自动生成可直接改写的 `nord-example.json` 示例：

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

### 从源码构建桌面端

环境依赖：**Node.js `>= 22`**、**pnpm `11`**、**Rust `1.98.0`**（通过 `rust-toolchain.toml` 自动锁定）。Linux 额外需要 WebKitGTK 系统开发库（`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev`）。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm desktop:build
```

---

## 命令行工具 (`hr`)

`@hreader/cli` 可编译为单文件独立包（`packages/cli/dist/cli.mjs` + `styles/`，Release 中同时提供 `hreader-cli.tar.gz`）。

```bash
# 查看文档结构与待处理批注
hr outline report.html [--json]

# 注入确定性 data-hr-id 节点锚点
hr normalize report.html --write [--json]

# 按 CSS 选择器或 data-hr-id 读取单节点
hr read report.html s2-p1 [--json] [--max-bytes 65536]

# 精准节点修补 (replace | insert_before | insert_after | append | delete)
hr patch report.html s2-p1 --action replace --html-file patch.html [--json]

# 视觉排版 / 写作口吻提示词 / 禁用词检查 / 从语料抽取 style.yaml
hr style report.html --visual atelier-editorial
hr style report.html --tone atelier-editorial
hr style report.html --lint
hr style extract sample1.md sample2.md --id my-voice --out .hreader/style.yaml [--no-llm]

# 撤销最近一次落盘快照
hr undo report.html [--json]

# 导出与渲染
hr export report.html --visual atelier-editorial --out print.html [--force]
hr pdf report.html --out report.pdf [--page-size a4|letter|a5] [--force]
hr png report.html --out report.png [--width 256..4096] [--scale 1..3]

# 启动支持 SSE 热刷新的本地阅读服务
hr serve report.html [--workspace <dir>] [--port <n>]
```

退出码约定：`0` 成功，`1` 业务/校验错误，`2` 用法错误或需先 `normalize`，`3` IO 或越界路径错误，`70` 内部异常。

---

## 插件与 AI Agent 集成

详细接入配置见 [插件与 Agent 集成指南](./docs/06-plugins-and-integrations.md)。

### 1. MCP Server (`@hreader/mcp-server`)

打包输出 `packages/mcp-server/dist/main.js` + `styles/`（Release 中提供免安装 `hreader-mcp-server.tar.gz`，有 Node 22+ 即可直接启动）。

- **7 个工具**：`hr_outline`、`hr_read_node`、`hr_create_doc`、`hr_patch_node`、`hr_apply_style`、`hr_resolve_annotation`、`hr_undo`
- **Prompt**：`use-hreader-style`
- **传输协议**：
  - `stdio`（适用于 Claude Desktop、Cursor、Antigravity 等）：`node /path/to/hreader-mcp-server/dist/main.js --workspace /path/to/your/docs`
  - `Streamable HTTP`：`node /path/to/hreader-mcp-server/dist/main.js --http 3000 --workspace /path/to/your/docs`

> 建议始终显式传入 `--workspace <dir>`，避免部分客户端从 `/` 或 `$HOME` 启动服务进程导致工作区边界回退。

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

### 2. 独立 Agent Skill (`skills/hreader/`)

生成自包含 Skill 目录（`release-artifacts/hreader-skill/`，Release 提供 `hreader-skill.tar.gz` 与 `hreader-skill.zip`），内置 `SKILL.md`、组件/风格参考文档、`scripts/hr.mjs`、`scripts/cli.mjs` 与 `scripts/styles/`。

```bash
pnpm skill:pack
node release-artifacts/hreader-skill/scripts/hr.mjs outline /path/to/doc.html
```

将解压后的 `hreader-skill/` 放入任意兼容 Agent Skills 的目录即可使用；`scripts/hr.mjs` 会优先调用同目录内置的 `cli.mjs`。

### 3. Pi Coding Agent 扩展 (`packages/pi-extension`)

单文件扩展 [`packages/pi-extension/pi-hreader.ts`](packages/pi-extension/pi-hreader.ts)，提供 `/hreader <path>`、`/hr-style` 与基于 SSE 批注事件的会话上下文自动注入。

### 4. DeepSeek Harness 插件 (`packages/dsh-bundle`)

Cordis 插件 [`packages/dsh-bundle/src/index.ts`](packages/dsh-bundle/src/index.ts)，在宿主启动时自动将 `hreader` 写作规约编织进 `systemPrompt.section` 并暴露强类型文档服务。

---

## 工程结构

| 包路径                   | 职责                                                                              |
| ------------------------ | --------------------------------------------------------------------------------- |
| `@hreader/core`          | 语义化 HTML 解析、`data-hr-id` 树、大纲、精准修补、风格编译器与本地 HTTP/SSE 服务 |
| `@hreader/protocol`      | 共享 MCP / 工具 Schema 与协议契约                                                 |
| `@hreader/renderer-html` | 基于无头 Chromium 的 PDF / PNG / 打印版 HTML 导出渲染器                           |
| `@hreader/app`           | 桌面端与浏览器共用的阅读/批注交互前端（`dist/`）                                  |
| `@hreader/cli`           | 独立 `hr` 命令行与本地 daemon 服务                                                |
| `@hreader/desktop`       | Tauri v2 桌面壳（Rust 原生菜单、工作区树、自研工作台脚本与打包）                  |
| `@hreader/mcp-server`    | 独立 MCP Server（`stdio` & Streamable HTTP）                                      |
| `@hreader/pi-extension`  | Pi Coding Agent 集成扩展                                                          |
| `@hreader/dsh-bundle`    | DeepSeek Harness（Cordis）插件包                                                  |
| `skills/hreader`         | 跨宿主独立 Agent Skill                                                            |

---

## 开发与质量门禁

仓库对所有源码实施严格的 ESLint 规则、Prettier 格式校验、`vitest` 100% 覆盖率（statement / branch / function / line）、`dependency-cruiser` 零环依赖校验、`knip` 零死代码校验以及 Rust `clippy -D warnings`。

```bash
# 安装依赖
pnpm install

# 完整 10 步 JS/TS CI 门禁
pnpm verify

# Rust 桌面壳检查（cargo fmt + clippy -D warnings + 全部 Rust 单测与集成测试）
pnpm desktop:check

# 可选：打印渲染 E2E 测试（需本机 Chrome/Edge/Chromium）与 Pi 扩展冒烟测试
pnpm test:e2e
pnpm smoke:pi
```

---

## 相关文档

- [English README](./README.md)
- [插件与 Agent 集成指南](./docs/06-plugins-and-integrations.md)
- [更新日志 (CHANGELOG)](./CHANGELOG.md)
- [贡献指南 (CONTRIBUTING)](./CONTRIBUTING.md)
- [安全策略 (SECURITY)](./SECURITY.md)
- [系统架构与路线图](./docs/02-architecture-and-roadmap.md)
- [工程与代码标准](./docs/04-engineering-standards.md)
- [桌面端实现说明](./packages/desktop/README.md)
- [已知缺陷台账](./docs/known-defects.md)

---

## 开源协议

[MIT](./LICENSE) © 2026 hReader Contributors
