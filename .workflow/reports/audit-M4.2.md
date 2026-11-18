# M4.2 G2 审计（审计员 `8a114329` 首轮超时 → `19317eb0` 缩范围重派，2026-11-18）

判决：**CHANGES-NEEDED**（1 条 P1 经协调者独立核验为真 → 已并入 R1 的 W7）

## P1（已核验为真，已派 W7）

**`packages/desktop/src-tauri/src/lib.rs:249-253` 的 `default_home()` 返回真实 `$HOME`**，D1 的隔离名存实亡：

```rust
pub fn default_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}
```

双击 `.app` 的主路径（argv 只有文件路径、无 `--home`）走它 → 壳读的是**用户自己的** `~/.hreader/daemon.json`；spawn 时又把它当 `--home` 透传给 `hr serve`，于是会**覆写**用户的 `~/.hreader/daemon.json` 并在退出时删掉。AC-11/12/15 全用 `--home <tmp>` 注入 → 自动测试对此 100% 盲区。

## P2

| # | 位置 | 事实 | 处置 |
|---|---|---|---|
| 2 | `packages/desktop/src-tauri/tauri.conf.json:17` | `"targets": ["app","dmg","msi","nsis","deb","appimage"]` 含 `dmg`，macOS 上 `tauri build` 会真产 `.dmg`，违反 D6 | 已派 W8（删 `dmg`） |
| 3 | `packages/cli/src/{args,intent,run,tokens,usage}.ts` | 新增 `--home` 与 spec AC-25 的「CLI diff 为 0」冲突 | **协调者裁定**：AC-25 收窄——`core/app/renderer-html/docs` 必须零 diff，`cli/src` 只允许 `--home`/`--exit-with-parent` 两处增量；spec 已改 |
| 4 | `supervisor.rs:130-148` | `command.spawn()` → `registry.own(pid)` 之间隔着 `read_envelope`+`wait_ready`；此窗口内信号监听尚未安装 → SIGKILL 泄漏、SIGTERM 无收尸 | 已派 W9（`run()` 在 `connect()` 之前 `signals::watch()`，`hold()` 重复调用需幂等） |

## P3（口味，本轮不改）

- `packages/desktop/scripts/check.sh:10` 的层分界 grep 只认 `use tauri|tauri::|#[tauri::command]`，漏 `tauri_plugin_*::`（当前只有白名单内 `window.rs` 用，低风险）。
- `window.rs:54` `register()` 返回 `Box<dyn Error>` —— 全仓唯一非裸类型，tauri setup 闭包惯例，可接受。
- `.prettierignore` 未显式列 `src-tauri/{target,gen}`（靠 Prettier 默认读 `.gitignore`，`verify` 绿已验证可行）。
- `.gitignore:20` 只忽略 `gen/schemas/` 而非整个 `gen/`（当前够用）。

## 审计员实际核过的（可信）

- **D8 零豁免**：`src-tauri/src` 全量扫 `#[allow]/#[ignore]/unwrap/panic/expect` → 无任何 `#[allow]`/`#[ignore]`；`unwrap/expect` 命中（`shortcut.rs:159`、`options.rs:154/171/178`、`url_build.rs:55/56/63/88`、`daemon_file.rs:116/131`）**全在 `#[cfg(test)]` 内**，生产路径零 panic。
- **D2 唯一入口**：生产路径只有 `url_build.rs:38` 拼 `?t=`；`connect()` 与 `smoke()` 都经 `bootstrap_url`；cookie 由 webview 自己 302 收，Rust 不代拿。
- **`parse_daemon`/`decide`**（`daemon_file.rs:73-103`、`spawn_decision.rs:60-77`）：纯逻辑、探针注入、port/pid 限 `1..=max`、四态含「端口活但 pid 不匹配」；无「端口活即复用」洞。
- **spawn 异常收尸**：`read_envelope`/`wait_ready` 失败 → `child.kill()+wait()`（`supervisor.rs:139-145`）。
- **`daemon.json` 0600** 在 core 写侧（`daemon.ts:79` `chmod(tmp,0o600)`），壳不重写文件、权限保持。
- **CLI `--home` 增量**：默认 `undefined`→`homedir()`（`run.ts:239`）；`homeRealpathOf` 与 `workspaceRealpathOf` 同口径（不存在即 `UsageError`）；只加进 serve 允许 flag（`args.ts:183`）与 `tokens` 的 `VALUE_FLAGS`。
- **`check.sh` 白名单**：`lib.rs/main.rs/window.rs`；纯逻辑文件零 `tauri::`。
- **D7/M11**：`.gitignore` 新增 `target/`、`gen/schemas/`（窄、带注释）；`knip.json` 无 desktop 条目、无整包忽略；depcruise 无新增。
- **裸类型/可读性**：无 `impl Into`/`AsRef`、无单字段结构体（`DaemonInfo` 4 字段、`BadDaemonFile` 2 字段、`ShellOptions` 6 字段）。
- **CI `desktop` job**：matrix 三平台（非写死 ubuntu）、无 `continue-on-error`、走 `check.sh`（fmt/clippy/test）。

## 审计员自述没能力核的

- `git diff 02f2649` 全量对比（该 reviewer 会话没有 `bash`/`git` 工具，只有 `grep/find/read`）→ P2#3 是据当前文件新增推断的，**由我核验**：`--home` 确为新增，AC-25 已按裁定收窄。
- CI 真跑 / run 链接（无 push 权限）。附带风险：`signals.rs`（`libc` SIGTERM、`Command::new("kill")`）**未 `#[cfg(unix)]` 门控**，`windows-latest` job 可能编译失败 —— 不是「永远绿」，而是「跨平台未证」，需在报告里标 `未执行`。
- AC-20 真机双击（由我接手，见 `gui-ac20-m4.2.md`）。
