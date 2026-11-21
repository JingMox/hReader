# @hreader/desktop

hReader 的桌面端工作台（Tauri v2）：内置独立的 `hr` CLI daemon 与前端阅读应用资源，提供类 Typora + Obsidian 的工作区文件树、大纲视图、批注抽屉、自定义 JSON 主题、空工作区引导以及原生导出能力。

## 启动链路

1. 解析参数（`--home` / `--workspace` / `--cli-path` / `--port` / `--open` / `--smoke`）。
2. GUI 双击无参数启动时忽略文件系统根目录 `/`（Finder 默认 cwd），优先恢复上次工作区，其次回退到 `~/Documents/hReader`。
3. 定位 `hr`：`--cli-path` > `HREADER_CLI` > `PATH` > 应用包内置 `resources/cli/cli.mjs`（`src/cli_locate.rs`）。
4. 若工作区里已有 `.html` 文档：读 `<home>/.hreader/daemon.json` 并按三态决定复用/拉起 `hr serve`（`src/spawn_decision.rs` / `src/supervisor.rs`），打开本地服务页面并注入工作台交互层（`src/workbench.rs`），在 WKWebView 跨源首跳拦截 cookie 时自动触发 `/reauth` 完成同源鉴权。
5. 若工作区尚无 `.html` 文档（或空文件夹）：直接加载内置空工作区页面（`LaunchTarget::Empty` -> `ui/index.html`），等待用户新建文档、打开 HTML 文件或切换工作区目录后再按需拉起 daemon，不会在硬盘上生成未请求的临时文件。

## 模块分工

| 文件                         | 职责                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `src/options.rs`             | 参数解析（纯逻辑）                                                    |
| `src/open_arg.rs`            | `--open <file>` / 文件关联路径 -> workspace 相对 docId（纯逻辑）      |
| `src/cli_locate.rs`          | `hr` CLI 与内置打包资源多级定位（纯逻辑）                             |
| `src/daemon_file.rs`         | `daemon.json` 三态读取（纯逻辑）                                      |
| `src/spawn_decision.rs`      | 复用 / 拉起 / 端口冲突判定（纯逻辑）                                  |
| `src/child_registry.rs`      | 子进程注册表与优雅退出清理（纯逻辑）                                  |
| `src/shortcut.rs`            | `accels.json` 全局快捷键校验与解析（纯逻辑）                          |
| `src/url_build.rs`           | bootstrap / reader URL 转义与拼装（纯逻辑）                           |
| `src/redact.rs`              | 日志与诊断输出 token 脱敏（纯逻辑）                                   |
| `src/workbench.rs`           | 递归文件树、大纲自动跳转、底部悬停工具栏、自定义 JSON 主题、空状态 UI |
| `src/supervisor.rs`          | 平台副作用：探活、`hr serve` 子进程管理与收尸                         |
| `src/smoke.rs`               | `--smoke`：无窗口三层链路自检                                         |
| `src/window.rs`              | 平台副作用：Tauri 窗口、原生菜单、文件选择、全局快捷键、`/reauth`     |
| `src/lib.rs` / `src/main.rs` | 装配与进程入口                                                        |

`packages/desktop/scripts/check.sh` 静态门禁强制要求：`tauri::` / `use tauri` 仅能出现在 `src/{lib,main,window}.rs`，纯逻辑模块无需窗口或网络即可运行全部单元测试。

## 常用命令

```bash
pnpm desktop:check   # tauri 边界检查 + cargo fmt --check + cargo clippy --all-targets -- -D warnings + cargo test
pnpm desktop:build   # 同步内置 app/cli/styles 资源并执行 tauri build
```

无头 `--smoke` 检查（stdout 输出单行已脱敏 JSON）：

```bash
cd packages/desktop/src-tauri
cargo run -- --smoke --home /tmp/hr-home --workspace /tmp/hr-ws --cli-path /path/to/hr
```

## daemon 的 home 隔离

桌面端默认将自身状态存于应用私有数据目录而非 `$HOME`（macOS `~/Library/Application Support/com.hreader.desktop`、Windows `%APPDATA%/com.hreader.desktop`、Linux `~/.local/share/com.hreader.desktop`），避免误读或覆盖用户在终端里手动启动的 `~/.hreader/daemon.json`。
