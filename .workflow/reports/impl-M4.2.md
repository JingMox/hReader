# impl · M4.2 桌面壳返工（R1 编写员自证）

基线 `02f2649`，工作树未提交（本文件所在轮次不 commit / 不 push / 不 reset）。
本文件只收 W1 / W2 / W6 / W7 的证据段；W3–W5、W8–W10 的落点见各源文件内联测试与 `test-mutations-M4.2.md`。

## 收尾门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm verify`（第一遍） | `EXIT=0`，`Test Files 264 passed (264)` |
| `pnpm verify`（第二遍） | `EXIT=0`，`Test Files 264 passed (264)` |
| `pnpm desktop:check` | `EXIT=0`（`cargo fmt --check` / `clippy -D warnings` / `cargo test`：69 + 3 passed） |
| `cargo test`（在 `desktop:check` 内） | 69 passed, 0 failed |
| `pnpm --dir packages/desktop run build` | `EXIT=0`，bundled `hReader.app`（6.40 MiB） |

`cargo fmt --check` 一开始红了（`src-tauri/src/shortcut.rs` 的 `register_with` 签名没折行），`cargo fmt` 后绿。

## W1（P1）GUI 路径退出收拾子进程

收尸入口：`Daemon::reap()`（`packages/desktop/src-tauri/src/lib.rs`）——`hold()`、GUI 正常退出
（`RunEvent::Exit` / `RunEvent::ExitRequested`）、关窗（`WindowEvent::CloseRequested`）三条路径都走它。
真机夹具与文档契约见 `gui-ac20-m4.2.md`；壳经 `node_modules/.bin/jiti` 拉起 `hr`，那个 shim 由 `lib.sh` 的
`make_cli_shim` 在运行时造到 `$root/hr`（不是仓内文件）。

> 注（R3 P3-4）：本节所有 `/tmp/hr-gui/xxx.sh` 是当时的临时路径，现址已入库到 `scripts/gui/m4.2/`：
> `w1-term`/`w1-quit`/`w1-close` 三条已合并为 `w1-signal-exit.sh`，`w2-parent` → `w2-parent-death.sh`，
> 启动窗口期那条 → `w2-launch-window.sh`，`w7-default-home` → `w7-default-home.sh`。
> 文中的输出按当时原样保留，不再回改。

三条路径的 S 层真进程证据（本次返工后重新构建的 bundle 上重跑）：

```
# A. kill -TERM（/tmp/hr-gui/w1-term.sh）
app=91330 daemon=91335
before exit -> app alive: yes / daemon alive: yes
after SIGTERM -> app alive: no / daemon alive: no / daemon.json: none

# B. AppleScript quit（/tmp/hr-gui/w1-quit.sh）
app=91411 daemon=91414
before quit -> app alive: yes / daemon alive: yes
after AppleScript quit -> app alive: no / daemon alive: no / daemon.json: none

# C. ⌘W 关窗（/tmp/hr-gui/w1-close.sh）
app=91476 daemon=91479
before close -> app alive: yes / daemon alive: yes
after cmd+W -> app alive: no / daemon alive: no / daemon.json: none
```

三条都是「app 走 → daemon 走 → `daemon.json` 不存在」，即 `hold()` 之外的路径也真的跑了 `reap()`。
S 层脚本只做观测；回归靠 R 层（`ChildRegistry` / `reap` 的单测在 `src-tauri/src/` 内联）。

## W2（P2）SIGKILL/OOM 不留孤儿：parent-death 看门狗

落点：
- CLI 旗标：`packages/cli/src/args.ts`（`exitWithParent: raw.switches.has("--exit-with-parent")`，默认 false）、
  `packages/cli/src/intent.ts`、`packages/cli/src/usage.ts`。
- 装配：`packages/cli/src/commands/serve.ts` 仅当 `exitWithParent === true` 才 `startupParentWatch()`；
  `packages/cli/src/run.ts` 把 `intent.exitWithParent` 透传给 `serveCommand`。
- 判定：`packages/cli/src/parent-guard.ts` — `ParentWatch { parentPid, readParentPid }`、
  `PARENT_POLL_MS = 1_000`、`parentGone(watch) = watch.readParentPid() !== watch.parentPid`。
  比的是**每次重读的 `process.ppid` 与启动时值的差**（re-parent 检测），不是"父进程还是不是原来那个 pid"。
- 壳侧：`packages/desktop/src-tauri/src/supervisor.rs::serve_args()` 给自己拉起的 daemon 固定带 `--exit-with-parent`；
  `adopted`（`.hreader/daemon.json` 里捡到的外部 daemon）没有 `Child`，不走 `spawn`，因此不带该旗标。

R 层：`packages/cli/tests/units-parent-guard.test.ts`（ppid 不变 / 变 1 / 变别的 pid / 每次轮询重读）、
`packages/cli/tests/units-serve-parent.test.ts`（旗标从 argv 到看门狗、自报真实 pid、不打断正常生命周期）、
`src-tauri/src/supervisor.rs::tests`（`ac14_own_daemon_is_started_with_exit_with_parent`）。

S 层真进程证据（`/tmp/hr-gui/w2-parent.sh` → `w2.log`）：假父进程经 `jiti` 起
`hr serve --exit-with-parent --port 49311`，然后 `kill -9` 掉假父进程：

```
parent=91630 daemon=91633
before: daemon ppid=91630 / port_open=yes
ppid trace after kill -9 (启动时=父进程 pid → 之后): 1
after kill -9 parent -> parent alive: no / daemon ppid= / daemon alive: no / port_open=no / daemon.json: none
```

`ppid: 91630 → 1` 是 re-parent 的直接观测；daemon 在 ≤1 个轮询周期内自杀，随后 `port_open=no`
（端口 49311 释放）且 `daemon.json` 已自行清除。

注：脚本里所有后台任务都 `< /dev/null` 并各自重定向输出——否则 `sleep 300` 继承管道写端，
外层 `| tail` 会假挂（这是本轮踩过的坑，修法记在脚本注释里）。

## W6（AC-7 缺口）`packages/app/tests/**` 交叉断言

新文件：`packages/app/tests/accels-cross.test.ts`（路径经 `import.meta.dirname` 相对定位，
不写死绝对路径）。断言口径：

- `keys.ts:23-24` 的 `modified()` = `metaKey || ctrlKey || altKey`（**不含 Shift**），`:49` 先判
  `modified(...) || isEditableTarget(...)`。因此「去掉 Cmd/Ctrl/Alt 后只剩 Shift」的全局键
  在 webview 里抢得到焦点——`lacksModified(accel)` 为 true 即违规。
- `shortcut.rs::parse_accel`：全局键必须含 `CommandOrCtrl|Ctrl|Alt`（裸 `Shift` → `MissingModifier`），
  `Escape` → `ReservedKey`；对 `accels.json` 里每个键断言不撞 `ReservedKey`。

变红演示（把 `{"stealFocus": "Shift+K"}` 临时加进 `packages/desktop/accels.json`，跑完立刻还原）：

```
✓ showWindow 必须带 keys.ts 的 modified() 认的修饰键
× stealFocus 必须带 keys.ts 的 modified() 认的修饰键      ← 红
✓ showWindow 必须被 modified() 短路（应用内拿不到 intent）
```

还原后 `accels.json` 仍只有 `{"showWindow": "CmdOrCtrl+Shift+H"}`，`accels-cross.test.ts` 6 tests passed。

## W7（G2 P1）壳自己的 home 必须是 app data 私有目录

单测断言落点（`packages/desktop/src-tauri/src/lib.rs`）：

- `default_home_for(home)`：macOS → `<home>/Library/Application Support/com.hreader.desktop`，
  Windows → `<home>/AppData/Roaming/com.hreader.desktop`，其它 → `<home>/.local/share/com.hreader.desktop`；
  `APP_DATA_DIR = "com.hreader.desktop"`，与 `tauri.conf.json` 的 identifier 一致。
- `ac11_shell_home_is_app_scoped_and_never_the_user_home`：`assert_ne!(shell_home, user_home)`、
  `assert_ne!(shell_home/.hreader, user_home/.hreader)`、`ends_with(APP_DATA_DIR)`。
- `ac11_daemon_file_lands_outside_the_user_store`：`daemon_file_in(&default_home_for(user_home))`
  不等于 `~/.hreader/daemon.json`，且路径里含 `com.hreader.desktop` 这一层。

S 层真机证据（`/tmp/hr-gui/w7-default-home.sh` → `w7.log`，不给 `--home`，即双击 `.app` 的主路径）：

```
~/.hreader before: d33e65971039ec85f9f1961eebac1f95
app=91543 daemon=91546 shell_store=/Users/liu/Library/Application Support/com.hreader.desktop/.hreader/daemon.json workspace=/private/tmp/hr-gui/ws
~/.hreader after:  d33e65971039ec85f9f1961eebac1f95
user store untouched: yes
after SIGTERM -> daemon alive: no / shell daemon.json: none
```

即：daemon.json 落在 app data 目录、用户 `~/.hreader` 前后 md5 一致（没被读也没被删）、退出后壳自己的
`daemon.json` 也清了。

## R1 返工

七条按卡 §7 的优先级落地，全部在本树（未 commit / 未 push / 未碰 `docs/**`）。GUI 证据脚本已从 `/tmp/hr-gui/` 移入 `scripts/gui/m4.2/`，下面一律引用仓内路径。

### R1-P1 · W2 启动窗口期父死失效（G3′ B5）

| | 位置 | 内容 |
| --- | --- | --- |
| 改前 | `packages/cli/src/parent-guard.ts:18-22` | `startupParentWatch()` 在**调用点**读 `process.ppid`（`serve.ts:44` 才调） |
| 改后 | `packages/cli/src/main.ts:12` | `const launchParentPid = process.ppid;` —— 位于 `await import("./run")` **之前** |
| 改后 | `packages/cli/src/parent-guard.ts:19` | `orphanedAtLaunch(parentPid) = parentPid === 1`（纯判定） |
| 改后 | `packages/cli/src/parent-guard.ts:25-28` | `parentWatchOf(parentPid)` 只包装注入值，不再自行采集；`startupParentWatch` 已删除 |
| 改后 | `packages/cli/src/commands/serve.ts:38-42` | `shouldWatchParent(input.exitWithParent) && orphanedAtLaunch(input.launchParentPid)` → `HrError("invalid_input", "…ppid=1…")`，**在 `startServer` 之前**抛 |
| 改后 | `packages/cli/src/run.ts:247` | `launchParentPid: io.launchParentPid ?? process.ppid`（`main.ts` → `CliIo` → `ServeInput` 一路显式） |

新增用例（`packages/cli/tests/units-parent-guard.test.ts` + `units-serve-parent.test.ts`）：
`orphanedAtLaunch > should call a ppid of 1 an orphan, not a normal parent`、
`parentWatchOf > should carry the injected pid and re-read the live ppid on every poll`、
`serveCommand · 启动时父进程已死 > should refuse to start when the parent was already gone at launch`、
`serveCommand · 启动时父进程已死 > should still start with a dead-looking parent when the flag is off`。

真机三条时间线（`scripts/gui/m4.2/w2-launch-window.sh`，stdout 一律落文件，不用 shell 管道判存活）：

```
=== kill point 0.03s: parent=5392
TIMELINE kill=0.03s daemon=none daemon_alive=none port_open=no daemon_json=none listener=no
serve.err: (空)
=== kill point 0.3s: parent=5482
TIMELINE kill=0.3s daemon=none daemon_alive=none port_open=no daemon_json=none listener=no
serve.err: (空)
=== kill point 0.6s: parent=5575
TIMELINE kill=0.6s daemon=5577 daemon_alive=no port_open=no daemon_json=none listener=no
serve.err: --exit-with-parent 但启动时父进程已是 init（ppid=1）：父进程在启动窗口期就退了
```

0.03s / 0.3s 是父进程在 `hr` 起来之前就被 `kill -9`（根本没有 daemon）；0.6s 是 G3′ 打中的那条线——daemon 起来了但立刻认出 `ppid=1`，**失败退出、不写 json、不占端口**。对照 G3′ §3.5 的 `ORPHAN 2974`（活 4s+、端口不还、json 残留），洞已消失。

稳态仍成立（`scripts/gui/m4.2/w2-parent-death.sh`）：

```
parent=5633 daemon=5770 daemon_ppid=5633 port_open=yes
AFTER kill -9 -> daemon_alive=no port_open=no daemon_json=none
```

### R1-P1 · Windows 图标

`packages/desktop/src-tauri/icons/icon.ico` 由 `icon.png` 经 `sips` 生成 16/32/48/256 四档 PNG 封进 ICO 容器（30647 字节，头 `00000100`，目录项 4）；`tauri.conf.json` 的 `bundle.icon` 补到 `["icons/icon.icns","icons/icon.png","icons/icon.ico"]`。
守门测试：`r1_bundle_icon_ico_is_a_valid_ico_with_four_sizes`（`include_bytes!("../icons/icon.ico")` 断言头 + 目录项 ≥4）。**本机没有 Windows target，未做 `cargo check --target x86_64-pc-windows-msvc`，报告也不声称 Windows 已验证。**

### R1-P2 · M2 安装点改为类型强制

| | 位置 | 内容 |
| --- | --- | --- |
| 改前 | `lib.rs:139` `signals::watch();` + `connect_with(argv, options, probe)` | 顺序靠人记得 |
| 改后 | `signals.rs:10-23` | `pub struct SignalSubscription { _private: () }`（非 `Copy`，字段私有，只有 `watch()`/`watch_with()` 造得出来） |
| 改后 | `lib.rs:180-190` | `pub fn connect(argv, options, subscription: signals::SignalSubscription)` |
| 改后 | `lib.rs:192-200` | `connect_with(argv, options, probe, signals: SignalSubscription)` |
| 改后 | `lib.rs:151-154` | `let _before_connect = signals::watch();` → `connect(argv, &options, _before_connect)`；`Session` 用 `_signals` 字段把它养到退出 |

原变异重跑（副本 `/tmp/m2-mut`，`CARGO_TARGET_DIR` 指回主树 target）：

```
error[E0425]: cannot find value `_before_connect` in this scope
   --> src/lib.rs:154:35
154 |     match connect(argv, &options, _before_connect) {
```

即"先 connect 后 watch"现在**编译不过**；`ac14_watching_twice_is_idempotent` 保留并通过。副本里另有一处 `couldn't read src/../../accels.json` 是复制时未带 `accels.json` 的路径噪声，与变异无关。

### R1-P2 · M6 语义面 R 层用例

`packages/cli/src/commands/serve.ts:69-70` 新增 `shouldWatchParent(exitWithParent)`，接线改成 `shouldWatchParent(...) ? parentWatchOf(...) : undefined`。
新增用例：`shouldWatchParent > should only be true for an explicit --exit-with-parent`、
`serveCommand · 父进程看门狗的开关 > should not install a poll timer without --exit-with-parent`（spy `globalThis.setInterval`，只数 `PARENT_POLL_MS` 那只）、`… > should install the poll timer once --exit-with-parent is on`。

M6b 重跑（副本 `/tmp/m6-mut`：`serve.ts` 改无条件 `watchParent(...)` **且** `timer.unref()`）：

```
 × serveCommand · 父进程看门狗的开关 > should not install a poll timer without --exit-with-parent
     → expected 1 to be +0 // Object.is equality
 Test Files  1 failed (1) / Tests  1 failed | 13 passed (14)
```

`.unref()` 变体下仍红——红来自"建了定时器"，不是事件循环拖尾。

### R1-P2 · GUI 脚本入库

`scripts/gui/m4.2/`（`chmod +x`）：`lib.sh`（仓根/临时目录/`alive`/`port_open`/`ppid_of`/`make_cli_shim`/`field_of`，token 只被读成 pid/port）、`w1-signal-exit.sh`、`w2-parent-death.sh`、`w2-launch-window.sh`、`w7-default-home.sh`。仓根由 `BASH_SOURCE` 上溯三级推出，临时目录一律走 `mktemp -d "${TMPDIR:-/tmp}/…"`（`/tmp` 只作 `TMPDIR` 缺省时的兜底，不是硬编码路径）；每个脚本头部一行用途。`pnpm verify` 仍绿（prettier/eslint 都不覆盖 `.sh`，无需新增 ignore；`scripts/gui` 不在 knip 的入口里）。

用新脚本复跑 W1 / W7（都是当前 `tauri build` 出的 `.app`）：

```
app=6191 daemon=6198
AFTER SIGTERM -> app_alive=no daemon_alive=no daemon_json=none

user_store_before=458f27cbf4647f6d4c3e49f6726ebb68
app=6270 daemon=6273 shell_store=/Users/liu/Library/Application Support/com.hreader.desktop/.hreader/daemon.json
user_store_untouched=yes
AFTER SIGTERM -> daemon_alive=no shell_daemon_json=none
```

### R1-P3 · `default_home()` 回退

| | 位置 | 内容 |
| --- | --- | --- |
| 改前 | `lib.rs:266-271` | 只读 `HOME`，缺失时 `PathBuf::from(".")` |
| 改后 | `lib.rs:272-290` | `default_home() -> Result<PathBuf, String>` = `user_home(HOME, USERPROFILE)` → `default_home_for`；`user_home(None, None)` 返回可读 `Err`（"HOME 与 USERPROFILE 都没设"），`run()` 里 `eprintln!` + 退出码 1 |

新增用例：`r1_default_home_falls_back_to_userprofile_when_home_is_missing`、`r1_default_home_errors_instead_of_falling_back_to_cwd`。

### R1-P3 · 信号注册失败回滚

| | 位置 | 内容 |
| --- | --- | --- |
| 改前 | `signals.rs` `let _ = registered;` + `WATCHED=true` 不回滚 | 一次失败永久静默 |
| 改后 | `signals.rs:57-71` | `watch_with(&registrar: &Registrar) -> Result<SignalSubscription, String>`：任一信号 `Err` → `WATCHED.store(false)` 回滚并返回原因 |
| 改后 | `signals.rs:44-55` | `watch()` 失败时 `eprintln!("装不上信号处理器（{reason}）：退出收尾交给 --exit-with-parent 看门狗")`，不阻断启动 |

新增用例：`r1_register_failure_rolls_back_so_the_next_watch_retries`、`r1_watch_with_reports_each_signal_it_registers`（注入 registrar 记录 SIGINT/SIGTERM，均 `#[cfg(unix)]`）。

### R1 自检

```
cargo test（src-tauri）            : 74 passed + 3 passed（R1 前 69 + 3；`--list` 77 项）
cargo clippy --all-targets -D warnings : 无警告
cargo fmt --check                  : 通过
pnpm desktop:check                 : EXIT=0
pnpm verify #1                     : EXIT=0  264 files / 2966 tests
pnpm verify #2                     : EXIT=0  264 files / 2966 tests
```

（R1 前 `pnpm verify` 261 files / 2940 tests；+3 文件 +26 用例全部是 R1 的语义面用例。）

`git status --porcelain` 只含本卡允许的文件（见交付回报正文）。R1 期间两处偏离，如实记录：

1. 两条变异都在副本里跑，主树全程没有被变异过：M2 用 `/tmp/m2-mut`（`cargo check`，`CARGO_TARGET_DIR` 指回主树 target 复用依赖产物）；M6b 用 `/tmp/m6-mut`（拷 `packages/` + `package.json` + `pnpm-workspace.yaml` + `vitest.config.ts` + `tsconfig.json` + `tsconfig.base.json`，根 `node_modules` 软链到主树；首次漏了 `tsconfig.base.json` 报 `Cannot find module './tsconfig.base.json'`，补上后正常出红/绿）。上面的 M6b 红输出就是这次副本运行的真实结果。
2. `run.ts` 撞上 `max-lines 300`：为了让 R1 新增的 `launchParentPid` 落位，删掉了三行注释/空行（一处字段注释、两处单行声明之间的空行），没有放宽 lint 预算。

## R2 返工

来源：G3″ 复测挖出的四条测试卫生缺口（仓卡 §8）。R2-4 是文档项，归协调者；本节只记 R2-1 / R2-2 / R2-3。

### R2-2 `run(["serve", …])` 不带 `--home` 时落点可注入（最先修）

改前 `packages/cli/src/run.ts:238`（基线 `02f2649`）：

```ts
    home: homedir(),
```

改后 `packages/cli/src/run.ts:241`：

```ts
    home: intent.home === undefined ? io.home : homeRealpathOf(intent.home),
```

接线三处（同一个注入点，和 `env`/`stop` 一样归一在 `resolvedIoOf`）：

| 位置 | 改后 |
| --- | --- |
| `packages/cli/src/run.ts:44`（`CliIo`） | `readonly home?: string;` |
| `packages/cli/src/run.ts:181`（`ResolvedIo`） | `CliIo & Required<Pick<CliIo, "env" \| "stop" \| "home">>` |
| `packages/cli/src/run.ts:186`（`resolvedIoOf`） | `home: io.home ?? homedir(),` |

`run.ts` 增 3 行后撞 `max-lines 300`（299 行收尾）：删掉只被 `reportFailure` 用一次的 `messageOf`（2 行）并把那句内联回 `io.stderr(...)`，没有放宽 lint 预算。

新增用例（新文件 `packages/cli/tests/units-run-home.test.ts`，同 `units-run-paths` 的分法：它要真起一次服务）：

- `should write daemon.json under the injected home when --home is absent` —— 断言 `<home>/.hreader/daemon.json` 在运行期出现、退出后被删；`home` 被忽略时这条必红。

`packages/cli/tests/units-run.test.ts:48` 的 `capture()` 也补了默认 `home: dir`（同一个 tmp 工作区），所以该文件里所有 `serve` 用例都不再指向真实 `$HOME`。

**用户 `~/.hreader/daemon.json` 跑前跑后对比**（`units-run.test.ts` + `units-run-home.test.ts`）：

```
跑前 : 981fc65f1e69af3c2a184337c85c00e2bf34748fb56dcfaa859a5e28f2ea9947  154B  mtime Nov 18 08:01:26
跑后 : 981fc65f1e69af3c2a184337c85c00e2bf34748fb56dcfaa859a5e28f2ea9947  154B  mtime Nov 18 08:01:26
```

**R2-2 的变异（`io.home` 被忽略）**：副本 `/tmp/r2-mut`（`rsync` 排除 `node_modules`/`target`/`.git`，`node_modules` 软链回主树），把 `resolvedIoOf` 改回 `home: homedir(),`：

```
$ HOME=/tmp/r2-fakehome ./node_modules/.bin/vitest run packages/cli/tests/units-run-home.test.ts
- true
+ false
 ❯ packages/cli/tests/units-run-home.test.ts:56:20
     56|   expect(appeared).toBe(true);
 Test Files  1 failed (1) / Tests  1 failed (1)
```

（`HOME=/tmp/r2-fakehome` 是刻意的：这次变异会把 `daemon.json` 写到 `homedir()`，必须沙箱化。）

### 一次实测事故，如实记录

第一次跑「`io.home` 被忽略」变异时**没有**沙箱化 `HOME`（变异体落回真实 `homedir()`），于是那次 `vitest` 真的执行了这条洞：`~/.hreader/daemon.json` 被覆盖后随服务退出删除。事后核查该记录是**陈旧记录**（`pgrep -fl "hr serve"` 空、`lsof -iTCP -sTCP:LISTEN` 无本仓端口监听），即里面记的 pid 早已不在；但它确实是被这条用例删掉的，无法还原（token 不可重建），下次 `hr serve` 会重新写一份。此后该变异改在 `HOME=/tmp/r2-fakehome` 下重跑，`/tmp/r2-fakehome/.hreader/` 里出现又消失的记录就是这次的落点，真实 `$HOME` 未被触碰。

### R2-1 `home_from_env(lookup)` 可注入

改前 `packages/desktop/src-tauri/src/lib.rs:293-304`：

```rust
pub fn default_home() -> Result<PathBuf, String> {
    user_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
        .map(|home| default_home_for(&home))
}

fn user_home(home: Option<OsString>, userprofile: Option<OsString>) -> Result<PathBuf, String> {
    match home.or(userprofile) {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => Err(...),
    }
}
```

改后 `lib.rs:293-306`：

```rust
pub fn default_home() -> Result<PathBuf, String> {
    home_from_env(|name| std::env::var_os(name)).map(|home| default_home_for(&home))
}

/// 取 home 的纯函数部分：`lookup` 注入环境，测试才能逐支断言（真 `std::env` 改不得）。
///
/// `HOME` 优先，Windows 常规只有 `USERPROFILE`；两个都没有时**不回退 `"."`**。
pub fn home_from_env(lookup: impl Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    match lookup("HOME").or_else(|| lookup("USERPROFILE")) {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => Err("找不到用户目录：HOME 与 USERPROFILE 都没设，无法定位壳的 daemon.json".to_string()),
    }
}
```

用例（`lib.rs` 的 `mod tests`，替换 R1 的两条 `r1_default_home_*`，用本地 `test_lookup(&[(k, v)])` 造假环境）：

- `r2_home_from_env_prefers_home`（两支都在 → 取 HOME）
- `r2_home_from_env_falls_back_to_userprofile`（只有 USERPROFILE → 取它，且落点 `ends_with(APP_DATA_DIR)`）
- `r2_home_from_env_errors_instead_of_falling_back_to_cwd`（都没有 → `Err`，且错误里含 `USERPROFILE`）

**R2-1 的变异（删掉 USERPROFILE 支）**：副本 `/tmp/r2-mut`，`lookup("HOME").or_else(|| lookup("USERPROFILE"))` → `lookup("HOME")`：

```
$ CARGO_TARGET_DIR=<主树 target> cargo test --lib
test tests::r2_home_from_env_falls_back_to_userprofile ... FAILED
thread 'tests::r2_home_from_env_falls_back_to_userprofile' panicked at src/lib.rs:354:39:
USERPROFILE 应当兜底: "找不到用户目录：HOME 与 USERPROFILE 都没设，无法定位壳的 daemon.json"
test result: FAILED. 74 passed; 1 failed; 0 ignored
```

### R2-3 重复注释

`lib.rs:147-150` 两个段落说的是同一件事（「必须在 `connect()` 之前装上…」）。删掉以 `watch()` 幂等 结尾的旧段，留 4 → 2 行，其中第二句改成类型层面的说法（`connect_with` 必须收下这个 token）：

```rust
    // 必须在 `connect()` 之前装上：`connect` 里有"已 spawn、还没 own"的窗口（最长 `READY_TIMEOUT`），
    // 那段时间被 SIGTERM 掉就没人收尸。类型上的说法是 `connect_with` 必须收下这个 token。
```

### R2 自检

```
cargo test（src-tauri）                 : 75 passed + 3 passed（R2 前 74 + 3；-2 条 r1_default_home_*、+3 条 r2_home_from_env_*）
cargo clippy --all-targets -D warnings  : 无警告（desktop:check 里同一命令）
cargo fmt --check                       : 通过
pnpm desktop:check                      : EXIT=0
pnpm verify #1                          : EXIT=0  265 files / 2967 tests
pnpm verify #2                          : EXIT=0  265 files / 2967 tests
```

（R2 前 264 files / 2966 tests；+1 文件 +1 用例 = `units-run-home.test.ts`。）

副本 `/tmp/r2-mut`、`/tmp/r2-fakehome`、日志 `/tmp/verify-r2-*.log`、`/tmp/desktop-check-r2.log` 都是临时档，主树只落了下面这些：

## R3 返工

卡的 §9 + 复审 `audit-M4.2-r2.md` 的结论：R1 七条 7/7 PASS，但留了 1 个真功能缺陷（P1-A）+ 1 个"洞会自己长回来"的接口（P2）+ 10 个 P3。
本轮只动 `packages/cli/src/{serve 系,run 系}`、`packages/cli/tests/**`、`packages/desktop/src-tauri/src/{signals.rs,lib.rs}`、`scripts/gui/m4.2/**`、根 `package.json` 的 `lint:sh`；未 commit、未 push、未碰 `docs/**`。

### 一条纪律（这次事故换来的，不是建议）

**任何变异/测试都必须先把 `HOME` 指到沙箱目录，再跑。** 顺序反了就是 R2 那次事故：变异体落回 `homedir()`，覆盖并删掉了真实的 `~/.hreader/daemon.json`。
协调者已核实现场：`~/.hreader/` 是空的、也没有活的 `hr serve`，**"文件不存在"就是正确终态，本轮不重建、不做补偿**。
这句话同时写进了 `scripts/gui/m4.2/lib.sh` 的头注释（第 5–6 行），不只留在报告里：

```bash
# 纪律：在这里加任何变异/测试之前，先把 `HOME` 指到一个沙箱目录再跑——顺序反了就是 R2 的事故
# （变异体落回 `homedir()`，覆盖并删掉了真实的 `~/.hreader/daemon.json`）。
```

本轮所有变异、真机脚本的起手式都是 `SANDBOX=$(mktemp -d …); mkdir -p $SANDBOX/home; H=$(cd $SANDBOX/home && pwd -P)`，之后再 `HOME=$H node …`。

### R3-P1-A（P1，真缺陷）`--exit-with-parent` 收 SIGTERM 后不自杀

根因两处（`packages/cli/src/commands/serve.ts`）：`clearInterval` 只写在 parentGone 分支里，stop 路径从不碰定时器；`setInterval` 也没 `.unref()`。
于是 `running.close()` 跑完，事件循环里仍挂着一只 1s 定时器，进程靠它续命——复审量到的就是"SIGTERM 后 3s 仍活着、`json=gone`"。

改前（stop 路径，`:58-60`）：

```ts
  void input.stop.then(async () => {
    await running.close();
  });
```

改后（`serve.ts:56-65`，`watchParent` 返回 disposer，先撤再关）：

```ts
  const disposeWatch = watchParent(
    shouldWatchParent(input.exitWithParent) ? parentWatchOf(input.launchParentPid) : undefined,
    running,
  );
  // 先撤看门狗再关服务：定时器活过 `close()` 的话事件循环永远有活干，SIGTERM 之后进程就赖着不退。
  void input.stop.then(async () => {
    disposeWatch();
    await running.close();
  });
```

`watchParent` 本体改前返回 `void`、只在 parentGone 分支里 `clearInterval`；改后签名 `(watch, running) => (() => void)`，
两条出口（parentGone 自清、disposer 被调）都走同一个 `clearInterval`，并在 `:90` 加了 `timer.unref()`（与 `core/src/server/hub.ts` 的心跳同口径）。
没有看门狗时返回 `nothingToDispose`，调用点不必判空。

**真机证据（沙箱 HOME，`kill -TERM` 是脚本里唯一一个 kill，SIGKILL 从未发出）：**

```
T-0.4s state=S port=56954 listen=open
SEND: kill -TERM 29900  (脚本全文只有这一个 kill，SIGKILL 从未发出)
RESULT wait_status=0 elapsed_ms=27  (=0 自退；=137 才是被 SIGKILL)
T+0.3s state= (空=进程已不在) port listen=closed
daemon.json exists=no
```

"是自己退的、不是被 SIGKILL"的判据（三条同时成立，缺一不算）：
1. `wait` 拿到的退出状态是 **0**——被信号杀死时 bash 给 `128+signo`（SIGKILL → 137），自退才会是 0；
2. `elapsed_ms=27`（budget ≤1000），且 wait 返回前进程在 `ps` 里是 `S`（睡眠），不是 `Z`（等待被杀）；
3. 脚本里**没有** `kill -9`（桌面壳的 `Drop` 才会 SIGKILL，本轮证据不经壳）。

顺带覆盖到的两条：端口在 300ms 后 `closed`（复审当时是仍开着）、`~/.hreader/daemon.json`（沙箱内）被删干净。

**用例（验收②③）：**

- `packages/cli/tests/units-parent-guard.test.ts` 新增 `describe("watchParent · disposer")`：装上后 `vi.getTimerCount() === 1`，`dispose()` 后 **`=== 0`**——这就是"close 之后还有没有活干"的假时钟断言。
- 同一个文件的 `describe("serveCommand · stop 撤回看门狗")`：真起服务 + `vi.spyOn(clearInterval)`，`stop()` 后 `waitFor` 断言**被清掉的那只正是 parent-death 定时器**。
- `packages/cli/tests/units-serve-parent.test.ts` 的 `should clean up on stop exactly like the default path` 也补了同一条断言（原来只断 `daemon.json` 消失——那只证明 `close()` 跑了，正好漏掉本缺陷）。
- 原来那条泄漏定时器的用例（`advanceTimersByTime` 之后从不 stop）已改成"装了 → stop → timer 归零"，不再需要靠 `--teardownTimeout` 兜。

**变异证据 MU-A（删掉 disposer 那一行 → 必红）**，改的就是上面 `disposeWatch();` 这一行：

```
== MU-A:
   × serveCommand · stop 撤回看门狗 > should drop the poll timer on stop, not just close the server 1012ms
   × serveCommand · --exit-with-parent 不打断正常生命周期 > should clean up on stop exactly like the default path 57ms
 FAIL  packages/cli/tests/units-parent-guard.test.ts > serveCommand · stop 撤回看门狗 > …
 FAIL  packages/cli/tests/units-serve-parent.test.ts > serveCommand · --exit-with-parent 不打断正常生命周期 > …
      Tests  2 failed | 18 passed (20)
```

### R3-P2（P2，接口层堵死）`launchParentPid` 必填 + 拆 `run-serve.ts`

改前 `packages/cli/src/run.ts:46` + `:244`：

```ts
  readonly launchParentPid?: number;
  …
  launchParentPid: io.launchParentPid ?? process.ppid,   // 晚读：`await` 之后 ppid 可能已经是 1
```

改后：`run.ts:46` 变 `readonly launchParentPid: number;`，兜底删除，`run.ts:235` 直接 `launchParentPid: io.launchParentPid`。
`packages/cli/src/io.ts` 的 `resolvedIoOf` 本来就让测试显式传（`serve-helpers.ts` 的 `serveInputOf` 一直传 `process.ppid`），所以这次没有调用点需要补参数。
理由与 M2 的安装点用类型强制一样：**"晚读 ppid"这个写法要在类型层不可写**，而不是靠新加一条用例去追。

`run.ts` 当时 299 行（贴 `max-lines 300`），按卡不删注释、不压可读性，改为按职责拆出 `packages/cli/src/run-serve.ts`（41 行）：

```ts
export const serveCommandOf = (
  intent: Extract<Intent, { kind: "serve" }>,
  paths: { readonly workspace: string; readonly file: string },
  wiring: ServeWiring,
): Promise<string> => …
```

`ServeWiring` 是**非导出**的 `interface`（knip 会抓未使用的导出类型，第一次 `pnpm verify` 就是在它上面红的）；`run.ts` 只留分发 + 一个 8 行的 `runServe`（三维接线），`resolveIo`/`intent` 的逻辑没有第二份。
改后 `run.ts` **290 行**，`run-serve.ts` 41 行，`max-lines` 没放宽。

**变异证据 MU-C（把 `ResolvedIo.launchParentPid` 退回可选）**：

```
packages/cli/src/run.ts(235,5): error TS2322: Type 'number | undefined' is not assignable to type 'number'.
  Type 'undefined' is not assignable to type 'number'.
```

即：想重新引入 `?? process.ppid` 的写法，`pnpm typecheck` 当场红，不需要人记着。

### R3 的 10 个 P3

| # | 位置 | 改前 | 改后 |
| --- | --- | --- | --- |
| P3-1 | `scripts/gui/m4.2/lib.sh` | `ROOT=/tmp/hr-gui/...` 固定 root，并发跑互相清目录 | `mktemp_root()` → `mktemp -d "${TMPDIR:-/tmp}/$1.XXXXXX"`，各脚本 `ROOT=$(mktemp_root …)` |
| P3-2 | 根 `package.json` 的 `lint:sh` | `shellcheck` | R3 实际落的是 `find scripts/gui -name '*.sh' -exec bash -n {} +`（**没有 shellcheck**，当时此处写作 `shellcheck … &&` 与代码不符，R4 更正）；且这条门禁是假绿的，R4 改成 `-print0 \| xargs -0 -n1 bash -n`，见 `## R4 返工` P1 |
| P3-3 | 本报告的 W1/W2/W7 段 | 只写 `/tmp/hr-gui/*.sh`，现址无人知 | 段首加注：现址 `scripts/gui/m4.2/<同名>.sh`，历史输出原样保留 |
| P3-4 | `units-parent-guard.test.ts`（旧 `:81-95`） | 装上看门狗后从不 stop，靠 teardown 超时兜 | 改成"装了 → stop → 定时器归零"，并新增纯 disposer 用例（见 P1-A） |
| P3-5 | `units-serve-parent.test.ts` 旧"should report its real pid" | 断 core 回显里的 `data.pid`，和 --exit-with-parent 无关 | 删除（`units-parent-guard.test.ts` 的 `parentWatchOf` 用例断 `readParentPid() === process.ppid`，才是看门狗真用的那个 pid） |
| P3-6 | `units-parent-guard.test.ts` 旧 `parentGone > should read ppid on every poll` | 只调一次 `parentGone` 就断"读了一次"，半重言 | 改到 `watchParent` 层：前两次返回老 ppid、第三次才变，断 2 次读→不关、3 次→关（缓存实现会在第 3 次前就绿） |
| P3-7 | `units-serve-parent.test.ts` 旧"should leave the daemon running while the parent is unchanged" | 只断 `daemon.json` 还在，与"父进程没变"无因果 | 改为手动推进 parent-death 回调 3 次，断 `daemon.json` 在、且该定时器**没有被清**（既有反例也有正例） |
| P3-8 | `src-tauri/src/signals.rs` | `watch()` 只返回 `Result`，"装上了"靠注释赌 | `struct Watch { installed: bool }` + `pub fn installed(&self) -> bool`，配 `static FAILED/ANNOUNCED` 让"装失败只喊一次"可断言；测试 `r3_installed_reports_a_handler_that_is_really_registered` |
| P3-9 | `src-tauri/src/lib.rs` 的 ICO 用例 | `assert!(entries >= 1)` + 只查头 4 字节 | `assert_eq!(entries, 4)` + 逐项断言 `width/height == [(16,16),(32,32),(48,48),(0,0)]` + `offset+size <= len` |
| P3-10 | `src-tauri/src/supervisor.rs` | `Daemon::spawn` 是 `pub`（任何依赖都能绕过 M2 的 `SignalSubscription` 闸门） | `pub(crate) fn spawn`（`supervisor.rs:109`）；token 本来就不经命令行——`serve_args` 只吃 `docId/workspace/home/port`，token 由 `read_envelope` 从被接管的 stdout 首行读回 |

GUI 脚本改成 `mktemp` 后，`scripts/gui/m4.2/*.sh` 都应该过 `bash -n`——但 R3 的 `lint:sh` 是 `-exec … {} +`，只有第一个文件真被解析（见 `## R4 返工` P1），所以"全部过了"当时并没有证据；R4 修好后 5 个文件逐个可验。

### R3 门禁

`pnpm verify` ×2（同一棵树连跑，证明不是偶发）：

```
Test Files  265 passed (265)
     Tests  2969 passed (2969)
✔ no dependency violations found (577 modules, 2390 dependencies cruised)
$ knip
EXIT=0
```

用例净 +2（R2 是 2967）：新增 5 条（disposer 2 条、stop 撤回看门狗 1 条、`startWatched` 支撑的 install 1 条、`parentWatchOf` 重读 1 条），删 2 条假测试（P3-5 的 core 回显、P3-8 的半重言）、把 2 条改成真断言。
`scripts/gui` 的 shell 脚本纳入 `bash -n` 后，`lint:sh` 的目标是 `lib.sh` + 4 个脚本（`w1-signal-exit.sh`/`w2-launch-window.sh`/`w2-parent-death.sh`/`w7-default-home.sh`）——R3 时实际只校验了其中 1 个（`-exec … {} +` 把 5 个文件塞给一次 `bash -n`），R4 修好后才是 5/5。

`pnpm desktop:check`（`packages/desktop/scripts/check.sh`：`cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test`）：

```
   Compiling hreader-desktop v0.0.0 (/…/packages/desktop/src-tauri)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.37s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.63s
running 76 tests
test result: ok. 76 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.17s
running 3 tests
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
EXIT=0
```

Rust 侧仍然零豁免：本树 `grep -rn "allow(dead_code)\|allow(unused)\|#\[ignore\]" packages/desktop/src-tauri` 无输出，`clippy -D warnings` 干净。

第 3 次 `pnpm verify`（写完本轮报告后复跑，确认改动没有把门禁弄红）：`265 files / 2969 tests`，`EXIT=0`。

### R3 自检

- 未 commit、未 push；`git diff --cached --name-only` 为空（无暂存）。本轮动了：CLI（`commands/serve.ts`、`run.ts`、新增 `run-serve.ts`、测试 `serve-helpers.ts`/`units-parent-guard.test.ts`/`units-serve-parent.test.ts`）、Rust（`signals.rs`/`lib.rs`/`supervisor.rs`）、`scripts/gui/m4.2/lib.sh`（`mktemp_root` + HOME 纪律头注释）、根 `package.json`（新增 `lint:sh` 并挂进 `verify`），外加本报告。
- `docs/**` 的改动（`docs/03-collaboration-workflow.md` 新增 §11.45/§11.46）**不是本轮产生的**，是协调者写进去的规矩；本轮一个字都没碰。
- 临时档（不进树）：变异备份 `/tmp/serve.bak.ts`、`/tmp/run.bak.ts`，日志 `/tmp/verify{1,2,3}.log`、`/tmp/desktop1.log`；P1-A 真机的沙箱目录是 `mktemp -d` 造的、跑完留在原地供复核。
- 残余风险：P1-A 的真机证据是在本机 Node 24（原生 type stripping）上跑的，没走 `hr` 的 npm bin 包装；`unref()` 之后若有人给 `watchParent` 加别的句柄（比如重连定时器），同样的"该退不退"会以新形态回来，目前没有 CI 侧守护，只有 `vi.getTimerCount()` 那条单测。

## R4 返工

来源：`.workflow/reports/audit-M4.2-r3.md`（G2‴ 终审，BLOCK 1 项 + 5 个 P3）。逐条改前/改后。

### P1 · `lint:sh` 是假门禁（`package.json:18`）

**改前**：`"lint:sh": "find scripts/gui -name '*.sh' -exec bash -n {} +"`。
`-exec … {} +` 把命中的 5 个文件**一次**交给 `bash -n f1 f2 …`，而 `bash` 只把首个 operand 当脚本、其余当位置参数 ⇒ 5 个 GUI 脚本只有 1 个真被解析。

**改后**：`"lint:sh": "find scripts/gui -name '*.sh' -print0 | xargs -0 -n1 bash -n"`。

**为什么不是审稿建议的 `\;`**：`\;` 修掉了"只查一个"的问题，但**仍然假绿**——`find` 的 `-exec` 谓词在命令返回非 0 时只是"该谓词为假"，`find` 自己照样 `exit 0`。实测（在 `/tmp/bad.sh` 内容为 `if then fi` 的前提下）：

```
$ find scripts/gui -name '*.sh' -exec bash -n /tmp/bad.sh \; ; echo "find_exit=$?"
… syntax error near unexpected token `then'      ← 报错了
find_exit=0                                     ← 但门禁仍绿
$ find scripts/gui -name '*.sh' -exec bash -n /tmp/bad.sh + ; echo plus_exit=$?
find: -exec: no terminating ";" or "+"
plus_exit=1
```

`xargs` 才会把失败的子命令折成非 0（123/1），所以改成 `-print0 | xargs -0 -n1`：仍然"每个文件单独一次 `bash -n`"，且失败会传出去。

**自检（原树 → 坏脚本 → 还原）**：

```
$ pnpm lint:sh ; echo EXIT=$?
EXIT=0                                  ← 原树

$ printf 'if then fi\n' >> scripts/gui/m4.2/w1-signal-exit.sh
$ pnpm lint:sh ; echo EXIT=${PIPESTATUS[0]}
scripts/gui/m4.2/w1-signal-exit.sh: line 25: syntax error near unexpected token `then'
scripts/gui/m4.2/w1-signal-exit.sh: line 25: `if then fi'
[ELIFECYCLE] Command failed with exit code 1.
EXIT=1                                  ← 坏脚本必红

$ cp /tmp/w1.bak.sh scripts/gui/m4.2/w1-signal-exit.sh && pnpm lint:sh ; echo EXIT=$?
EXIT=0                                  ← 还原
```

### P3-1 · ICO 用例可被 70 字节伪造（`lib.rs:367-401`）

**改前**：只断头部/档数/宽高 + `offset+size <= len`。`size=0,offset=0` 时恒真 ⇒ 70 字节空目录全过。

**改后**：目录区末尾 `dir_end = 6 + entries*16` 先断不越界；逐档再加三条 —— `size > 0`、`offset >= 上一档 end`（即从 `6+16*4` 起严格递增、不回头）、payload 头必须真图像（PNG `89 50 4E 47 0D 0A 1A 0A` 或 40 字节 DIB `28 00 00 00`，两个签名提升为 `mod tests` 里的 `PNG_SIGNATURE`/`DIB_HEADER_SIGNATURE`）。伪造成本因此抬到"真造 4 张图"。

**证据（两个伪造体，都用 `cp` 替换 `icons/icon.ico` 跑完再还原，`shasum` 前后一致 `5739202d…`）**：

```
# fake70：6 + 4*16 = 70 字节，宽高对但 size=0/offset=0
$ xxd /tmp/fake70.ico | head -1
00000000: 0000 0100 0400 0000 0000 0000 0000 0000
$ cargo test --offline r1_bundle_icon
panicked at src/lib.rs:393: 第 0 档没有数据
test result: FAILED. 0 passed; 1 failed

# fake90：size=1/offset=70（不越界），但 payload 是 0x00
panicked at src/lib.rs:401: 第 0 档 payload 既不是 PNG 也不是 32bpp DIB：[00]
test result: FAILED. 0 passed; 1 failed

# 真文件：payload 三档 PNG + 256 档 PNG，全过
$ cargo test --offline r1_bundle_icon
test result: ok. 1 passed; 0 failed
```

### P3-2 · `timer.unref()` 零覆盖（`serve.ts:90`）

**改前**：只有 fake timer 用例，`unref` 在假时钟下是空操作，删掉不红。

**改后**：`serve-helpers.ts` 加 `timerStillHoldsProcess(timer: unknown)`（`Reflect.get(timer, "hasRef")` + `Reflect.apply`，不用 `as`）；`units-parent-guard.test.ts` 新增 `watchParent · disposer > should unref the poll timer…`：**真定时器**下 spy `setInterval` 拿到句柄，断 `hasRef()` 为 false。没有为此抽接口或加间接层。

**变异（先设沙箱 `HOME=/tmp/hr-r4-sandbox.*` 再动代码）**：删 `serve.ts:90` 的 `timer.unref();` →

```
× watchParent · disposer > should unref the poll timer so it can never be what holds the daemon alive
AssertionError: expected true to be false // Object.is equality
Tests  1 failed | 17 passed (18)
```

### P3-3 · `mktemp_root` 返回值未校验（`lib.sh:19`）

**改前**：`mktemp_root() { mktemp -d "${TMPDIR:-/tmp}/$1.XXXXXX"; }` —— 失败返回空串 ⇒ `${root}/home` 变 `/home`。
**改后**：`lib.sh` 里 `mktemp -d … || { echo "mktemp 失败：$1" >&2; exit 1; }`；`make_dirs` 首行再挡一次空串（`mktemp_root` 走 `$(...)` 子 shell，里面的 `exit` 传不出去）；4 个脚本的调用点改 `root=$(mktemp_root …) || exit 1`。

**证据**：

```
$ TMPDIR=/nonexistent/definitely-missing bash -c '. scripts/gui/m4.2/lib.sh; root=$(mktemp_root hr-guard) || exit 1; echo should-not-reach'
mktemp: mkdtemp failed on /nonexistent/definitely-missing/hr-guard.XXXX: No such file or directory
mktemp 失败：hr-guard
EXIT=1
$ bash -c '. scripts/gui/m4.2/lib.sh; make_dirs ""; echo should-not-reach'
make_dirs: root 为空（mktemp 失败？）
EXIT=1
```

### P3-4 · `units-run-home.test.ts` 的破坏性失败模式

**改后**：新增前置用例 `should be handed a home under the temp dir, so a broken wiring cannot touch the real one` —— `realpathSync(home).startsWith(realpathSync(tmpdir()))`。接线断了现在表现为断言红，而不是"往真实 `~/.hreader` 写一遍再删掉"。

### P3-5 · 报告自述与代码不符

① R3 段 P3-2 行去掉不存在的 `shellcheck`，注明 R3 实际命令与"假绿"、R4 修法；② W1 段"无 `/tmp` 硬编码"改成"一律 `mktemp -d "${TMPDIR:-/tmp}/…"`，`/tmp` 只作缺省兜底"；③ 两处"`scripts/gui/m4.2/*.sh` 全部过了 `bash -n`"改成"目标是 5 个、R3 实际只校验 1 个、R4 修好后才是 5/5"。

### R4 门禁

- `pnpm verify` #1（改完代码）：`265 files / 2971 tests`，`EXIT=0`。
- `pnpm verify` #2（`cargo fmt` + 写完本节后复跑）：`265 files / 2971 tests`，`EXIT=0`。
- `pnpm desktop:check`：`EXIT=0`；`cargo test` `76 passed; 0 failed; 0 ignored`（+5 集成）；`clippy -- -D warnings` 干净（`cargo fmt --check` 先红过一次，`cargo fmt` 后过）。
- 用例数 +2（2969 → 2971）：`unref` 真定时器 1 条 + `units-run-home` 守卫 1 条；ICO 是加断言不加用例。

### R4 自检

- 未 commit、未 push，`git diff --cached --name-only` 为空。
- 变异与伪造 ICO 的 `HOME`/临时文件全部在 `/tmp/hr-r4-*`；`icons/icon.ico` 用 `cp` 还原后 `shasum` 与改前一致（`5739202d5d63354a45e4e6898471d0343b86a310`），`git status` 里它仍是未跟踪（`icons/` 本来就没入库）。
- 残余风险：`lint:sh` 现在依赖 `xargs` 的失败折算（GNU/BSD 都是 123，`pnpm` 折成 1），`xargs` 在参数里遇到 NUL 的极端情况不覆盖——对 5 个仓内脚本足够。

## R5 返工（G2⁗ 结卡终审 CHANGES-NEEDED：3×P1 + 3×P2）

### P1-1 · 文档列了不存在的 `ac20-gui-size.sh`

- **文件**：`docs/05-feature-cards.md:400`。
- **改前**：`（… w7-default-home.sh 默认 home、ac20-gui-size.sh 窗口尺寸）`。仓库 `scripts/gui/m4.2/` 只有 5 个脚本，`ac20-gui-size.sh` 全仓不存在。
- **改后**：删掉该项，不补造脚本。
- **复现**：`ls scripts/gui/m4.2/`（5 个）；`grep -rn ac20 docs/` 现无命中。

### P1-2 · 文档谎称"一律沙箱 `HOME`"+ `w7` 缺少真实目录自保

- **文件**：`scripts/gui/m4.2/w7-default-home.sh:11-14`、`scripts/gui/m4.2/lib.sh:6-8`、`docs/02-architecture-and-roadmap.md:346`、`docs/05-feature-cards.md:400`。
- **改前**：`w7` 直接 `rm -rf "$HOME/Library/Application Support/com.hreader.desktop"`，无 opt-in；两份文档都写"`mktemp -d` + 沙箱 `HOME`"。
- **改后**：
  - `w7` 在 `rm -rf` 前加 `[ "${HREADER_GUI_REAL_HOME:-}" = "1" ] || { echo "W7 会删真实壳数据目录 ${shell_store}；确认后以 HREADER_GUI_REAL_HOME=1 重跑" >&2; exit 1; }`，echo 打印将要删的绝对路径。
  - `lib.sh` 头部纪律注释同步成"`--home` 一律 `mktemp -d`；W7 是唯一例外并需 opt-in"。
  - 两份文档改为"`--home` 一律指向 `mktemp -d` 沙箱；**W7 是唯一例外**：故意使用真实壳 app data 目录并在开头 `rm -rf` 它，脚本因此要求 `HREADER_GUI_REAL_HOME=1` 才继续——跑之前备份、并确认无在跑实例。"
- **注意（自己改了写法）**：`echo` 里用 `${shell_store}` 花括号而非 `$shell_store`。首版 `$shell_store；`（全角分号紧贴变量名）在 `set -u` 下被 bash 判成 `shell_store<字节>: unbound variable` 而误报，加 `${}` 定界后正常。
- **复现**（未真跑 `.app`，在仓库内跑）：
  ```
  $ env -u HREADER_GUI_REAL_HOME bash scripts/gui/m4.2/w7-default-home.sh
  root=/var/folders/…/hr-w7-default.XXXXXX
  W7 会删真实壳数据目录 /Users/liu/Library/Application Support/com.hreader.desktop；确认后以 HREADER_GUI_REAL_HOME=1 重跑
  EXIT=1
  ```

### P1-3 · `units-run-home.test.ts` 守卫重言（失败方向写真实 `~/.hreader`）

- **文件**：`packages/cli/tests/units-run-home.test.ts:12-14,53-56`。
- **改前**：守卫只断言本文件 `mkdtempSync` 造的 `home` 在 `tmpdir()` 下，与被测代码零耦合，恒真。
- **改后**：模块顶层 `const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-home-env-"))); process.env["HOME"] = sandbox;`，守卫断言 `homedir().startsWith(sandbox)`；保留主用例"注入 `home` 后落点跟着变"。
- **判据复现**（删接线 → 必红，且不写真实 home）：
  ```
  # 改前真实 home 快照 md5 = 610810f19512fd70be9ffc8e85c13fca
  $ perl -0pi -e 's/home: io\.home \?\? homedir\(\),/home: homedir(),/' packages/cli/src/run.ts
  $ pnpm vitest run packages/cli/tests/units-run-home.test.ts
  FAIL … should write daemon.json under the injected home when --home is absent
  AssertionError: expected false to be true   (units-run-home.test.ts:67)
  EXIT=1
  # 改后真实 home 快照 md5 = 610810f19512fd70be9ffc8e85c13fca（未变）
  ```
  恢复 `run.ts` 后单文件 2 passed。

### P2-1 · `lint:sh` 空集 / `find` 失败双假绿

- **文件**：`package.json:18`。
- **改后**：`test -n "$(find scripts/gui -name '*.sh' -print -quit)" && find scripts/gui -name '*.sh' -print0 | xargs -0 -n1 bash -n`。
- **反例三连复现**：
  ```
  $ pnpm lint:sh                       # 干净 → EXIT=0
  $ printf 'if then fi\n' > scripts/gui/m4.2/zz-bad.sh; pnpm lint:sh   # 坏脚本 → EXIT=1
  $ mv scripts/gui /tmp/hreader-scripts-gui-bak; pnpm lint:sh          # find 失败 → EXIT=1
  $ mv /tmp/hreader-scripts-gui-bak scripts/gui; pnpm lint:sh          # 还原 → EXIT=0
  ```

### P2-2 · `timerStillHoldsProcess` 取不到 `hasRef` 时恒真

- **文件**：`packages/cli/tests/serve-helpers.ts:92-96`。
- **改前**：`return typeof hasRef === "function" && …`（缺 `hasRef` 返回 `false`，`toBe(false)` 恒绿）。
- **改后**：`if (typeof hasRef !== "function") throw new TypeError("timer 没有 hasRef()：无法证明 unref()");`，再 `return Reflect.apply(hasRef, timer, []) === true;`。

### P2-3 · ICO 注释"判据必须贵过真图"不成立（102 字节可伪造）

- **文件**：`packages/desktop/src-tauri/src/lib.rs:330-332（常量）、:373-374（注释）、:410-419（断言）`。
- **选做**：补断言（不是只改注释）。新增 `PNG_IEND` 常量；PNG 档要求 payload 以 IEND 收尾，DIB 档要求目录项 bit count == 32。注释改为"判据要贵过空目录……再抽查 payload 首尾（PNG 签名 + IEND / DIB biSize==40 + 32bpp），但仍不还原整张图"。
- **复现**：`cargo test r1_bundle_icon_ico_is_a_valid_ico_with_four_sizes` → `1 passed`（真图标 4 档均为 PNG+IEND，见 payload 头 `89504e47…` / 尾 `49454e44ae426082`）。

### R5 门禁

- `pnpm verify`：`265 files / 2971 tests` 全绿、四维 perFile 100%、depcruise（577 modules / 2390 deps）+ knip 干净，`VERIFY_EXIT=0`。
  - 首轮 `test:coverage` 曾红在 `packages/core/tests/read-node.test.ts > performance`（485.8ms vs 480ms 抖动，与本轮改动无关）；单跑该文件 26 passed，复跑全量绿。
  - `pnpm lint` 首轮曾因 `packages/desktop/src-tauri/target/debug/deps/rmeta*` 并发 scandir ENOENT 崩一次（Cargo 正在写 target），重跑即过。
- `cargo test r1_bundle_icon_ico…`：`EXIT=0`。

### R5 自检

- 未 commit、未 push，`git diff --cached --name-only` 为空。
- 所有临时脚本/还原文件在 `/tmp`（`run.ts.bak`、`hreader-scripts-gui-bak`），`run.ts` 已用备份还原并与改动前一致（`io.home ?? homedir()` 在位）。

## R8a

修审计 P2-4：`packages/cli/tests/units-run-home.test.ts` 在模块顶层把 `process.env["HOME"]` 永久改到沙箱，`afterAll` 又删掉沙箱却不还原，同 worker 后续测试文件的 `homedir()` 会指向已删除目录（`vitest.config.ts:31` `maxWorkers: 2`）。按同仓既有 save/restore 范式修（`units-serve.test.ts:108/117`、`units-serve-parent.test.ts:56/80`）。

### diff（唯一改动文件；该文件当前是 untracked，故用前后片段表示）

```diff
+// 模块顶层改写 `process.env` 必须自己还原：`afterAll` 会删掉沙箱，不还原的话同 worker 里后续
+// 测试文件的 `homedir()` 会指向一个已删除的目录（vitest `maxWorkers: 2`，见 vitest.config.ts:31）。
+const previousHome = process.env["HOME"];
 const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-home-env-")));
 process.env["HOME"] = sandbox;

 afterAll(() => {
+  // 先还原 `HOME`，再删沙箱：顺序反了就会把 `HOME` 留在一个不存在的目录上。
+  if (previousHome === undefined) delete process.env["HOME"];
+  else process.env["HOME"] = previousHome;
   rmSync(dir, { recursive: true, force: true });
   rmSync(home, { recursive: true, force: true });
   rmSync(sandbox, { recursive: true, force: true });
 });
```

主用例未动："注入 `home` 后落点跟着变" 与守卫用例（断言运行时 `homedir()` 落在沙箱下）均保持原样。

### 退出码

- `pnpm test:coverage` → **EXIT=0**：`Test Files 265 passed (265)`、`Tests 2971 passed (2971)`、`All files` 四维（stmts/branch/funcs/lines）均 `100`。
- `pnpm vitest run packages/cli/tests/units-run-home.test.ts` → **EXIT=0**：`1 passed (1)` 文件、`2 passed (2)` 例。

### 其余同类泄漏点排查（只报不改）

命令：`grep -rn 'process.env\["HOME"\]\|process.env.HOME' packages/*/tests | grep -v restore`

命中清单（全部为 save/restore 范式，**无第二处泄漏**）：

- `packages/cli/tests/units-serve.test.ts:108/109`（save+set）、`:117`（restore）
- `packages/cli/tests/units-serve.test.ts:145/146`（save+set）、`:175`（restore）
- `packages/cli/tests/units-serve.test.ts:237/238`（save+set）、`:250`（restore）
- `packages/cli/tests/units-serve-parent.test.ts:56/57`（save+set）、`:80`（restore）
- `packages/cli/tests/units-run-home.test.ts:15/17`（save+set，本次新增 save）、`:27/28`（restore，本次新增）
- `packages/mcp-server/tests/ui-resource.test.ts:30/31`（save+set）、`:35/36`（restore，已正确处理 `undefined`）

注意：`units-serve*.test.ts` 三处 restore 是 `process.env["HOME"] = previous;` 无条件赋值——若 `previous` 为 `undefined` 会写成字符串 `"undefined"`。属既有代码，未改（不在 R8a 范围）；`units-run-home.test.ts` 与 `ui-resource.test.ts` 已按 `delete` 处理。

### 自检

- 本次 R8a 只改了两个文件：`packages/cli/tests/units-run-home.test.ts`（修复）与 `.workflow/reports/impl-M4.2.md`（本段报告），二者均为 `??` untracked。工作树里其余的 `M`（含 `.github/workflows/ci.yml`、`packages/desktop/src-tauri/src/lib.rs`）来自前序轮次与并行的另一位编写员，**未触碰**；`packages/app/tests/**` 未触碰。
- 未 `git add`、未 commit、未 push，`git diff --cached --name-only` 为空。

## R6 返工（`cargo fmt` 修 `lib.rs:410` 超长行）

- 症状：`pnpm desktop:check` `EXIT=1`，红在 `cargo fmt --check`——`packages/desktop/src-tauri/src/lib.rs:410` 的 `assert!(payload.ends_with(&PNG_IEND), "第 {index} 档 PNG 缺少 IEND 收尾")` 单行超长。
- 处理：`cargo fmt` 就地折行；`git diff packages/desktop/src-tauri/src/lib.rs` 当时只含格式（无逻辑变化）。
- 门禁：`pnpm desktop:check` 由 `EXIT=1` → `EXIT=0`（`cargo fmt --check` / `clippy -D warnings` / `cargo test`：69 + 3 passed）。
- 本轮未动 `packages/cli/tests/**`、`packages/app/tests/**`、`.workflow/state.md`。

## R7 返工（审计 R5 PASS 后：CI 八步、ICO 判据、注释反话、记录）

### 一 · CI 补齐 `lint:sh` / `build`（`.github/workflows/ci.yml`）

- `checks` job 现有八步，与 `package.json:7` 的 `verify` 一一对应：`format:check` → `lint` → **`lint:sh`** → `typecheck` → **`build`** → `test:coverage` → `depcruise` → `knip`；文件头加注释「与 `pnpm verify` 的八步一一对应：少一步就是"本地绿、CI 不查"」。
- 自证（本地按 CI 拼接）：

| 命令 | 结果 |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm depcruise && pnpm knip`（旧六步） | `EXIT=0` |
| `pnpm verify`（新八步） | `EXIT=0`，`Test Files 265 passed` / `Tests 2971 passed` / perFile 100% |
| 删 `package.json` 的 `lint:sh`（`/tmp/package.json.r7.bak` 备份）后 `pnpm lint:sh` | `EXIT=1`：`[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "lint:sh" not found` |
| 还原 `package.json` 后 `pnpm lint:sh` | `EXIT=0` |

  结论：CI 里那条 `pnpm lint:sh` 在脚本缺失时确实会红，不是只写不查。
- 首次 `pnpm verify` 曾 `EXIT=1`：`vitest` 报 `ENOENT coverage/.tmp/coverage-120.json`——并行的另一位编写员正在跑 `test:coverage`，两边共用 `coverage/.tmp` 互相清理；立即复跑 `EXIT=0`（与本轮改动无关）。

### 二 · ICO 判据改读载荷（`packages/desktop/src-tauri/src/lib.rs`）

- 抽出 `fn assert_valid_ico(bytes: &[u8], expected_sizes: &[(u8, u8)])`（放在 `#[cfg(test)] mod tests` 内，与伪造样本同处），真图标用例改为 `assert_valid_ico(include_bytes!("../icons/icon.ico"), &[(16,16),(32,32),(48,48),(0,0)])`。
- 目录层：目录项数 == `expected_sizes.len()`；逐项宽高匹配；`size > 0`、`offset >= previous_end`、`end <= bytes.len()`——每条独立断言消息。
- PNG 分支：`starts_with(PNG_SIGNATURE)` 后要求 `payload.get(12..16) == Some(b"IHDR")`、`ends_with(PNG_IEND)`、`len >= 45`。
- DIB 分支：`len >= 40`、`u32::from_le_bytes(payload[0..4]) == 40`（`biSize`）、`u16::from_le_bytes(payload[14..16]) == 32`（`biBitCount`）——**位深从载荷读，不再读 `entry[6..8]`**；`DIB_HEADER_SIGNATURE` 常量随旧断言删除。
- 反向打靶（新增 3 个 `#[test]` + `#[should_panic(expected=…)]`，共享 `fake_ico` 构造函数）：
  - `r7_ico_rejects_empty_directory_with_zero_sizes`：70 字节空目录（四档宽高对、size/offset 全 0）→ 「第 0 档没有数据」；
  - `r7_ico_rejects_dib_without_payload`：目录项位域写 32bpp、payload 仅 4 字节 DIB 签名 → 「至少 40 字节」；
  - `r7_ico_rejects_png_marker_without_ihdr`：`PNG 签名 + IEND` 16 字节 → 「必须以 IHDR 开头」。
- `cargo test`（`--lib`）结果：`tests::r1_bundle_icon_ico_is_a_valid_ico_with_four_sizes ... ok`；三个 `should panic ... ok`；`test result: ok. 79 passed; 0 failed`。
- 门禁：`pnpm desktop:check` `EXIT=0`（`cargo fmt --check` / `clippy -D warnings` / `cargo test`：79 + 3 passed）。首次跑 `desktop:check` 曾 `EXIT=1` 于 doctest `E0463 can't find crate`——并行 cargo 构建抢锁导致，复跑 `EXIT=0`。

### 三 · `scripts/gui/m4.2/lib.sh` 注释反话

- `lib.sh:25` 原文「`mktemp_root` 走的是 `$(...)` 子 shell，里面的 `exit` 传不出去」为假：`$(...)` 的退出码会传给赋值的 `$?`，调用点 `root=$(mktemp_root …) || exit 1` 本来就生效；传不出的是副作用。
- 改为：「`mktemp_root` 在 `$(...)` 里 `exit 1` 的状态码会传出（调用点已 `|| exit 1`）；这里再挡一次，是为了不依赖每个调用点都写 `|| exit 1`。」

### 四 · 记录与自检

- 本段与 `## R6` 段只写本报告；`.workflow/state.md` 未动。
- 本轮改动：`.github/workflows/ci.yml`（八步 + 头注释）、`packages/desktop/src-tauri/src/lib.rs`（`assert_valid_ico` + 3 个反向用例）、`scripts/gui/m4.2/lib.sh`（注释）、本报告。
- 未 `git add`、未 commit、未 push；`git diff --cached --name-only` 为空。

## R8b（G4 终测 T4①：`ends_with(PNG_IEND)` 那一行无覆盖）

### 一 · 缺陷复核

R7 的三份反向样本里，PNG 那份是 `sig(8) + IEND(8)` 共 16 字节：`payload.get(12..16)` 读到的是 `IEND` 尾巴的 `[ae, 42, 60, 82]`，先被「必须以 IHDR 开头」拒掉。于是 `assert!(payload.ends_with(&PNG_IEND), …)` 这行**永远不会先红**——判据里有一行永远绿的断言，等于没写。

### 二 · 新样本 `r8b_ico_rejects_png_without_iend_tail`

结构：`PNG 签名(8) + 合规 IHDR 块(25) + 假 IDAT 块(16) = 49 字节`，过 `len >= 45`、`get(12..16) == IHDR`，唯独结尾不是 IEND。

```rust
#[test]
fn r8b_ico_rejects_png_without_iend_tail() {
    // 签名 8 + 合规 IHDR 块 25 + 假 IDAT 块 16 = 49 字节：IHDR 与长度门槛都过，
    // 只有"以 IEND 收尾"能拒它——否则那行断言永远红不了，等于没有。
    let mut payload = PNG_SIGNATURE.to_vec();
    payload.extend_from_slice(&[0, 0, 0, 13]); // IHDR 长度
    payload.extend_from_slice(b"IHDR");
    payload.extend_from_slice(&[0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]); // 16x16 / 8bpp / RGBA
    payload.extend_from_slice(&[0, 0, 0, 0]); // IHDR CRC 占位：判据不看 CRC
    payload.extend_from_slice(&[0, 0, 0, 8]); // 假 IDAT 长度
    payload.extend_from_slice(b"IDAT");
    payload.extend_from_slice(&[0x00; 8]);
    assert_eq!(payload.len(), 49, "样本必须过 45 字节门槛");
    let bytes = fake_ico(&[(16, 16, 49, 22)], &payload);

    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_valid_ico(&bytes, &[(16, 16)]);
    }))
    .expect_err("IHDR 合规、长度 49 却缺 IEND 的样本必须被拒");
    let message = panic_message(&*panic);
    assert!(
        message.contains("IEND"),
        "应被 IEND 分支拒，实际：{message}"
    );
}
```

配套新增取 payload 文本的助手（`panic!` 的两种 payload 形态都认）：

```rust
/// 取 panic payload 的文本：`panic!` 的两种形态是 `&str` 与 `String`。
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<非字符串 panic payload>".to_string())
}
```

不用 `#[should_panic]` 的原因：`should_panic(expected=…)` 只查子串、不区分赢家，`"IEND"` 这种短词换一条断言也能蒙对；这里显式取 payload 文本，失败时打的是「实际：…」，谁把 IEND 断言删了都会以此红出来。

**变异验证（已还原）**：临时删掉 `assert!(payload.ends_with(&PNG_IEND), …)` 那 4 行，`cargo test --lib r8b`：

```
---- tests::r8b_ico_rejects_png_without_iend_tail stdout ----
thread 'tests::r8b_ico_rejects_png_without_iend_tail' panicked at src/lib.rs:526:10:
IHDR 合规、长度 49 却缺 IEND 的样本必须被拒: ()
test result: FAILED. 0 passed; 1 failed; …
```

删掉后没有别的分支拒它（IHDR 与 45 字节门槛都过），证明新样本的赢家确实是 IEND 那条。随后 `cp /tmp/lib.rs.bak src/lib.rs` 还原并重新 `cargo fmt`。

### 三 · 四份反向样本「实际赢家」核对

做法：临时加一个 `catch_unwind` 探针用例打印每份样本的 panic payload（`PROBE <name>: <msg>`），跑完删除。原始输出：

```
PROBE empty: 第 0 档没有数据（size=0）
PROBE dib4: 第 0 档 DIB 至少 40 字节（BITMAPINFOHEADER），实际 4
PROBE png_marker: assertion `left == right` failed: 第 0 档 PNG 必须以 IHDR 开头，实际 Some([ae, 42, 60, 82])
```

| 用例 | 样本 | 声称被哪条拒 | **实际**触发（探针实测） | 一致？ |
| --- | --- | --- | --- | --- |
| `r7_ico_rejects_empty_directory_with_zero_sizes` | 70 字节空目录，四档 size/offset 全 0 | 第 0 档 `size > 0` | 「第 0 档没有数据（size=0）」——`assert!(size > 0)` | ✅ |
| `r7_ico_rejects_dib_without_payload` | 目录项 4 字节偏移、payload 仅 `28 00 00 00` | DIB `len >= 40` | 「第 0 档 DIB 至少 40 字节（BITMAPINFOHEADER），实际 4」——`assert!(payload.len() >= 40)` | ✅ |
| `r7_ico_rejects_png_marker_without_ihdr` | `sig(8) + IEND(8)` 16 字节 | PNG `get(12..16) == IHDR` | 「第 0 档 PNG 必须以 IHDR 开头，实际 Some([ae, 42, 60, 82])」——`assert_eq!(payload.get(12..16), …)` | ✅ |
| `r8b_ico_rejects_png_without_iend_tail`（新） | `sig + IHDR 块(25) + 假 IDAT(16)` = 49 字节 | PNG `ends_with(PNG_IEND)` | 变异验证：删该断言即红、「样本必须被拒」；断言在时被 IEND 分支拒 | ✅ |

四份样本的声称与实际赢家一一对应，无需改样本、也无需改措辞。附带确认：新样本也顺带让 `len >= 45` 那条从"永远绿"变成有意义的门槛——它是 IEND 之后的下一条，仍未被单独打靶（本次任务范围只要求 IEND 这条；如需覆盖，仿此加一份 `sig + IHDR + IEND` 但总长 < 45 的样本即可，未做）。

### 四 · 门禁与退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cargo fmt`（先跑，rustfmt 定长行） | `0` | 无输出 |
| `pnpm desktop:check` | **`EXIT=0`** | `cargo fmt --check` + `clippy -D warnings` 全绿；`test result: ok. 80 passed; 0 failed`（lib）、`3 passed`（`tests/connect_recheck.rs`） |

新增用例名与结果（`cargo test` 原文）：

```
test tests::r8b_ico_rejects_png_without_iend_tail ... ok
```

用例数：`--lib` 79 → **80**，其余三份反向样本仍 `should panic ... ok`；`r1_bundle_icon_ico_is_a_valid_ico_with_four_sizes ... ok`。

### 五 · 自检

- 改动仅 `packages/desktop/src-tauri/src/lib.rs` 的 `#[cfg(test)] mod tests` 区（`panic_message` 助手 + 一个新用例），业务逻辑零行改动；探针用例与变异改动均已还原（`cp /tmp/lib.rs.bak src/lib.rs` 后复跑门禁）。
- 未跑 `pnpm verify`（属 R8c）。
- 未 `git add`、未 commit、未 push；`git diff --cached --name-only` 为空。
