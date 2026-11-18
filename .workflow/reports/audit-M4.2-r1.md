# M4.2 G2′ 复审（审计员 `e79a1d58`，R1 返工后，2026-11-18）

结论：**PASS WITH NOTES** —— 11 项必查里 10 项"通过"（逐条给到 `文件:行`），无 P0/P1，3 条 note。

## 通过项（审计员逐条核过的落点）

| 项 | 证据落点 | 判定要点 |
|---|---|---|
| W7 隔离 | `lib.rs:282-290` `default_home_for` → `<home>/Library/Application Support/com.hreader.desktop`（Win `AppData/Roaming`、Linux `.local/share`）；`lib.rs:203` `create_dir_all` 在 `Spawn` 分支、`Daemon::spawn` 之前；`lib.rs:275` `APP_DATA_DIR="com.hreader.desktop"` == `tauri.conf.json:5` `identifier` | 无分叉 |
| W1 收尸 | `lib.rs:48-54` `Reaper::reap`（`slot.take()`+drop，天然幂等）；`window.rs:58-63` `app.run` 收 `RunEvent::Exit/ExitRequested/WindowEvent::CloseRequested/Destroyed`，`window.rs:63` 返回后再兜一次 | 三条路径同一入口 |
| W9 安装点 | `run()` 里 `signals::watch()` 在 `connect()` 之前（`lib.rs:136-138` 注释写明"必须早于 connect，覆盖 READY_TIMEOUT 窗口"）；`WATCHED.swap(true)` 短路幂等 | 有 `ac14_watching_twice_is_idempotent` |
| W10 门控 | `signals.rs` unix `platform` 与 `#[cfg(not(unix))]` 桩签名逐一对齐；桩被 `run()`/`hold()`/`window.rs:40` 无条件调用（非死代码） | 全仓 `#[allow(dead_code)]` grep 空 |
| W5 | `url_build.rs:25-33` 空段→`EmptySegment`、`.`/`..`→`DotSegment`；单测覆盖 `../x`/`a/../x`/`./x`/`a//b`/`""`，`a..b.html` 保留 | ✓ |
| AC-7 | `packages/app/tests/accels-cross.test.ts` 经 `import.meta.dirname` 定位 `packages/desktop/accels.json`（Rust 侧真源），并 import `../src/keys.ts` 的 `intentOf` | 真跨包 |
| D8 | `src-tauri/src` 全量 `#[allow`/`#[ignore]` 为空；`unwrap/expect` 全在 `#[cfg(test)]` | ✓ |

## Findings

- **P2 —— GUI 真机证据脚本未入库，不可复核。** `impl-M4.2.md` 的 W1/W2/W7 证据引用 `/tmp/hr-gui/*.sh`，`/tmp` 会被清空 → 评审无法复跑。修法：脚本入库（`scripts/gui/m4.2/` 或 `.workflow/reports/gui-m4.2/`，取前者），报告改引用仓内路径。
- **P3 —— Windows `default_home()` 落到 cwd。** `lib.rs:267` 只读 `HOME`；Windows 常规只有 `USERPROFILE`，回退 `PathBuf::from(".")` 会把 `daemon.json` 写进当前目录，正好违背 W7 初衷。修法：`HOME → USERPROFILE` 回退链 + 注入 `USERPROFILE` 的单测。
- **P3 —— 信号注册错误被吞。** `signals.rs` `let _ = registered;` 丢弃 `register` 的 `Err`，且 `WATCHED` 已置 true 不重试 → 注册失败即静默无 SIGTERM 收尸。修法：失败 `WATCHED.store(false)` 回滚 + `eprintln!` 一次（不阻断启动）。

## 审计员自述的能力边界（重要，不许含糊）

- **未执行**：`pnpm verify`×2、`pnpm desktop:check`、`cargo test`、`tauri build`、任何真机 GUI（SIGTERM / AppleScript quit / ⌘W / kill -9）。这些数字均来自编写员自报 —— **由协调者独立复算**（见 `state.md` 本轮 CI 记录）。
- Windows / 非 unix 桩仅做签名与调用点静态核对，**未在 Windows 构建**。
- 按派单纪律只做定点 grep/sed 读取，未通读全集。
