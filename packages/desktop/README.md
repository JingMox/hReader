# @hreader/desktop

hReader 的桌面壳（Tauri v2）。它自己**不托管阅读器**：定位 `hr` CLI、拉起/复用本地 daemon，
再把 webview 导航到 daemon 的 `/s/<docId>?t=<token>`。阅读器行为一行都不在这里。

## 一次启动发生了什么

1. 解析参数（`--home` / `--workspace` / `--cli-path` / `--port` / `--open` / `--smoke`）。
2. 定位 `hr`：`--cli-path` > `HREADER_CLI` > `PATH`（`src/cli_locate.rs`）。
3. 读 `<home>/.hreader/daemon.json`（`src/daemon_file.rs`）：可用 / 没有 / 存在但坏。
4. 判三态（`src/spawn_decision.rs`）：`/healthz` 回的 pid 与文件一致才复用；端口被别的进程占着时报错而不是接管。
5. 需要时拉起 `hr serve`（`src/supervisor.rs`），读它的启动信封、等 `/healthz` 就绪；失败先收尸再报错。
6. webview 打开 `http://127.0.0.1:<port>/s/<docId>?t=<token>`（`src/url_build.rs`）。

第 6 步**不能**改成 `/?t=<token>`：只有 `/s/<docId>?t=` 会 302 到同名路径并 `Set-Cookie`，
cookie 必须由 webview 自己收下；Rust 侧代拿没用，`core` 的认证语义也不许为壳改动。

## 文件分工

| 文件                         | 职责                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `src/options.rs`             | 壳自己的参数解析（纯逻辑）                                  |
| `src/open_arg.rs`            | `--open <file>` / 双击路径 → workspace 相对 docId（纯逻辑） |
| `src/cli_locate.rs`          | `hr` 三级定位（纯逻辑，存在性由调用方注入）                 |
| `src/daemon_file.rs`         | `daemon.json` 三态读取（纯逻辑）                            |
| `src/spawn_decision.rs`      | 复用/拉起/第三态的判断（纯逻辑，探针由调用方注入）          |
| `src/child_registry.rs`      | 哪些 pid 是壳自己的孩子（纯逻辑）                           |
| `src/shortcut.rs`            | 全局快捷键配置解析（纯逻辑）                                |
| `src/url_build.rs`           | bootstrap URL 的转义与拼装（纯逻辑）                        |
| `src/redact.rs`              | 输出脱敏（纯逻辑）                                          |
| `src/supervisor.rs`          | 平台副作用：真实探活、拉起、收尸                            |
| `src/smoke.rs`               | `--smoke`：无窗口跑一遍真实链路                             |
| `src/window.rs`              | 平台副作用：建窗口、注册全局快捷键                          |
| `src/lib.rs` / `src/main.rs` | 装配与进程入口                                              |

纯逻辑模块**不碰 syscall**，所以 `cargo test` 不需要网络、不需要 `hr`、也不需要窗口。

## 命令

```bash
pnpm desktop:check   # cargo fmt --check + cargo clippy -- -D warnings + cargo test
pnpm desktop:build   # tauri build（产物在 src-tauri/target/release/bundle/）
```

`--smoke` 用真实 daemon 跑三层证据（healthz 的 pid / bootstrap 的 Set-Cookie / 带 cookie 取到文档页），
stdout 只打一行 JSON，token 已脱敏：

```bash
cd packages/desktop/src-tauri
cargo run -- --smoke --home /tmp/hr-home --workspace /tmp/hr-ws --cli-path /path/to/hr
```

## 全局快捷键

`accels.json` 是唯一真源：值为 `null` 表示关掉全部全局快捷键；每条必须含 `CmdOrCtrl`/`Ctrl`/`Alt`
（只有 `Shift` 不算，会抢阅读器的 `Shift+D`），且不许占用 `Escape`。

## daemon 的 home 隔离

壳的 home 是**应用私有目录**，不是 `$HOME`（`default_home_for`）：macOS
`~/Library/Application Support/com.hreader.desktop`，Windows `%APPDATA%/com.hreader.desktop`，
Linux `~/.local/share/com.hreader.desktop`；daemon 记录落在 `<那个目录>/.hreader/daemon.json`。

为什么不能用 `$HOME`：双击 `.app` 时 argv 里没有 `--home`，壳若把 `$HOME` 当归宿，就会读用户自己的
`~/.hreader/daemon.json`，并在 spawn 时把 `--home $HOME` 透传给 `hr serve`——启动覆写、退出删掉用户那份记录。
目录不存在时由壳先 `mkdir -p`（`hr serve --home` 要求目录已存在，否则打错字会变成隐形的新 home）。

测试或并行实例请用 `--home <dir>` 指到独立的 home：那个目录下的 daemon 一定是"自己这台壳"拉起的，
用户手动跑的 `hr serve` 不会被误判、更不会被误杀。
