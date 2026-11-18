# M4.2 G3′ · 变异 / 对抗测试（R1 返工后）

基线 `02f2649`（工作树未提交）。隔离方式：`rsync -a --exclude node_modules --exclude 'src-tauri/target'` → `/tmp/m42b-mut`，
再把 `node_modules`、`packages/*/node_modules`、`src-tauri/target` 用 `ln -s` 指回源树（cargo 一次都没抢锁，没触发"复制 target"分支）。
所有变异、所有失败用例都发生在副本里；源树只有本文件与别人写的 `audit-M4.2-r1.md` 是新增未跟踪项（见 §5）。

结论摘要：**A 段 10 条里 8 条被现有用例杀掉、2 条打成洞（M2 安装点、M6 语义面）；B 段 8 条里 6 条 PASS、1 条 FAIL（B5 启动窗口）、1 条 PASS 但带残留（B1 附带的 stale `daemon.json`）。**
另外顺手打出两个**与变异无关、在未变异源树上就能复现**的缺陷：`icons/icon.ico` 缺失让 Windows 侧 `cargo check/build` 直接红（§3.9）、`hr serve` 启动失败会删掉 `<home>/.hreader/daemon.json` 里"死 pid"的老记录（§3.10，判定为**设计如此**，不是缺陷）。

---

## 1. A 段变异表

`sed/python` 改了什么（原行 → 新行）、红没红、红的哪条。

| M# | 文件 / 原行 | 改成 | 期望 | 实际（红了哪条） | 判定 |
|---|---|---|---|---|---|
| M1 | `packages/desktop/src-tauri/src/lib.rs` `default_home_for`：macOS/Win/Linux 三条 `home.join(...).join(APP_DATA_DIR)` | `home.to_path_buf()`（回到 `$HOME`） | AC-26 单测红 | **红**：`tests::ac11_shell_home_is_app_scoped_and_never_the_user_home`、`tests::ac11_daemon_file_lands_outside_the_user_store`（`67 passed; 2 failed`） | KILLED-R |
| M2 | `lib.rs::run()`：`signals::watch();` 在 `if let Some(seconds) = options.hold` 之前（`connect()` 之前） | 删掉那行，改插到 `Ok(session) => {` 之后（即 `connect()` 之后） | 应有用例红 | **全绿**：`69 passed` + 集成 `3 passed`。R 层没有任何用例钉"安装点在 `connect()` 之前"；`ac14_watching_twice_is_idempotent` 只证幂等，`window::run()` 自己也会再装一次 | **SURVIVED（洞）** |
| M3a | `src/signals.rs`：`#[cfg(not(unix))] mod platform { ... }`（Windows 空桩整块 508 字符） | 整块删除 | 至少 `cargo check` 层报错 | macOS `cargo check` / `cargo test` **全绿**（`cfg(not(unix))` 本来就不参与编译）；用 `--target x86_64-pc-windows-msvc` 探针 crate 编译同一份 `signals.rs` → `error[E0432]: unresolved import 'platform'` | KILLED（平台门控层） |
| M3b | 同上，只去掉 `#[cfg(not(unix))]` 属性、保留桩 | `mod platform {`（第二份） | `cargo check` 报错 | **红**：`error[E0428]: the name 'platform' is defined multiple times`（`signals.rs:64` 与 `:11`） | KILLED-R |
| M4 | `src/supervisor.rs::serve_args()` 里 `"--exit-with-parent".to_string(),` | 删掉该行 | `ac14_*` 红 | **红**：`supervisor::tests::ac14_own_daemon_is_started_with_exit_with_parent` | KILLED-R |
| M5 | `packages/cli/src/parent-guard.ts`：`watch.readParentPid() !== watch.parentPid` | `void watch; return false;` | 必红 | **红 4 条**：`parentGone > should notice a re-parented process (ppid became 1)`、`… any other ppid change`、`… read ppid on every poll, not cache it`、`watchParent · 父进程消失 > should close once the parent disappears, and stop polling after that` | KILLED-R |
| M6 | `packages/cli/src/commands/serve.ts:44`：`watchParent(input.exitWithParent === true ? startupParentWatch() : undefined, running);` | `watchParent(startupParentWatch(), running);`（无条件） | 必红（用户自己的 daemon 也自杀） | **红 2 条**：`serve.test.ts > hr serve · 生命周期 > should print the daemon envelope, then release port + daemon.json on SIGTERM`、`> 第二个信号入口 > should clean up identically on SIGINT`（两条都是 `Test timed out in 5000ms`） | KILLED-R（**但红得不是地方**，见 M6b） |
| M6b | 在 M6 基础上再给定时器 `.unref?.()`（"合法写法"的变体） | `timer.unref()` + 无条件 watch | 仍应红 | **全绿**：`packages/cli` 58 files / 634 tests 全过。M6 的"红"来自**未清定时器拖住事件循环**（子进程不退出 → 超时），不是"用户 daemon 不该看父进程"这条语义断言 | **SURVIVED-R → S 层杀掉**（§3.7） |
| M7 | `src/shortcut.rs::accels_from_json`：`accels.sort_by(...); reject_duplicates(&accels)?;` | 删掉 `reject_duplicates(&accels)?;` | 必红 | **红**：`shortcut::tests::ac7_duplicate_accelerator_is_rejected_with_both_aliases`（另带 2 条 dead_code warning） | KILLED-R |
| M8 | `lib.rs::connect_with` 的 `Decision::Reuse(info)` 臂（`recheck` + 两条 `Err` 分支） | `Decision::Reuse(info) => Daemon::adopted(info),` | 必红 | **红 3 条**（`tests/connect_recheck.rs`）：`ac4_navigation_is_refused_when_the_daemon_died_before_it`、`ac4_navigation_is_refused_when_the_port_changes_hands_before_it`、`ac4_navigation_happens_when_the_same_daemon_still_answers`（第三条是正控，顺带钉住"复核确实被调了一次"） | KILLED-R |
| M9 | `src/url_build.rs::encode_path`：`if segment == "." \|\| segment == ".."` | `if segment == "."`（放过 `..`） | 必红 | **红**：`url_build::tests::ac2_dot_segments_are_rejected_at_the_url_layer` | KILLED-R |
| M10 | `packages/desktop/accels.json`：`{"showWindow": "CmdOrCtrl+Shift+H"}` | `{}` | 必红（证明跨包真读文件） | **红**：`packages/app/tests/accels-cross.test.ts > should find the accelerator file and parse it`（`AssertionError: expected 0 to be greater than 0`）；同一条变异在 Rust 侧也红：`shortcut::tests::ac7_default_accels_all_have_a_real_modifier` | KILLED-R |

复现命令（每条变异都在副本里跑，跑完立即从 `/tmp/m42b-orig/` 还原并 `diff -q` 比对源树）：

```
cd /tmp/m42b-mut/packages/desktop/src-tauri && cargo test --offline
cd /tmp/m42b-mut && npx vitest run packages/cli packages/app/tests/accels-cross.test.ts
```

副本收尾自证（还原后）：

```
for f in src/lib.rs src/signals.rs src/supervisor.rs src/shortcut.rs src/url_build.rs \
         packages/desktop/accels.json packages/cli/src/parent-guard.ts packages/cli/src/commands/serve.ts; do
  diff -q "/tmp/m42b-mut/$f" "/Users/liu/Documents/Project/hReader/$f" || echo "DIFFERS: $f"; done
→ 无输出（副本里零残留变异）
```

---

## 2. A 段结论

- **杀掉 8 / 洞 2**（M2、M6），M6 的洞在 S 层被真进程证据补掉（§3.7），M2 没有 S 层靶子（GUI 路径）→ 只能靠"读源码"钉，属**结构性洞**。
- M2 的真实风险被我量化过：窗口 = `connect()` 全程（spawn 路径上限 `READY_TIMEOUT = 20s`，`src/supervisor.rs:17`）。这期间收到 SIGTERM：进程按默认动作死、`Daemon::drop` 不跑、`daemon.json` 留在壳 home；但**自己拉起的 daemon 带 `--exit-with-parent`**，父死会自己走（§3.7 的 late 分支），所以后果被 W2 兜住，只剩"stale `daemon.json` + 20s 内窗口"（P3）。
- M6/M6b 的洞是本轮**最值钱**的一条：`--exit-with-parent` 默认关闭这条语义**没有任何断言**，只有"间隔定时器会把进程拖住"这个副作用在兜。S 层证明：一旦实现里给定时器加 `.unref()`，用户自己的 `hr serve` 就会在终端退出时被杀（§3.7）。

---

## 3. B 段 · 对抗性实测

### 3.1 B1 双击主路径的隔离（不传 `--home`）—— **PASS**

```bash
APP=…/hReader.app/Contents/MacOS/hreader-desktop
snapshot() { { ls -la $HOME/.hreader; find $HOME/.hreader -type f -exec md5 {} \; ; stat -f 'dirmtime=%Sm' $HOME/.hreader; } | md5; }
rm -rf "$HOME/Library/Application Support/com.hreader.desktop"
before=$(snapshot)
"$APP" --workspace /tmp/m42b-b/ws --open /tmp/m42b-b/ws/a.html --cli-path /tmp/hr-gui/hr-shim &
```

输出原文：

```
~/.hreader snapshot(before) = e166abe670ad5f29a7077c12ef34d19b
app=1321 daemon=1324
壳 store = /Users/liu/Library/Application Support/com.hreader.desktop/.hreader/daemon.json
workspace(in json) = /private/tmp/m42b-b/ws
~/.hreader snapshot(after)  = e166abe670ad5f29a7077c12ef34d19b
user_store_untouched=yes
user_store_files=1
after SIGTERM: app=no daemon=no shell_daemon_json=none
```

判定：`~/.hreader` 的 listing + 每个文件的 md5 + 目录 mtime **全等**；壳自己的 store 落在 `~/Library/Application Support/com.hreader.desktop/.hreader/daemon.json`；退出后壳自己的 `daemon.json` 清掉。**PASS**

### 3.2 B2 stale `daemon.json` 三态 + 不误 adopt 用户 daemon —— **PASS（4/4）**

（用 `--smoke` 跑，和 GUI 共用 `decide()`/`spawn()`/`reap()` 同一条代码路径，省一个窗口。）

```
=== B2-1 死 pid + 关闭端口（stale 残留）→ 自愈重拉 ===
exit=0 before_pid=999999 out={"checks":["healthz","bootstrap-cookie","document"],"documentBytes":168,
"nav":"http://127.0.0.1:61998/s/a.html?t=***","ok":true,"pid":3433,"port":61998}
=== B2-2 端口被无关进程占 + 文件 pid 活着但不是 hreader ===
unrelated listener pid=3460 port=49551 alive=yes
exit=1 out=smoke 失败：端口被非 hReader 进程占着：换一个端口或先关掉它
listener still alive=yes json_still_same=3460
=== B2-3 文件 pid 已死 + 端口被无关进程占 ===
exit=1 out=smoke 失败：daemon.json 里的端口被别的进程占着：删掉它或换一个端口 listener_alive=yes
=== B2-4 用户在 $HOME/.hreader 起自己的 daemon，壳用隔离 home ===
```

B2-1 的 `after daemon.json pid=` 为空是**正常的**：`--smoke` 退出时 `Reaper::reap()` 把刚拉起的 daemon 带走并删掉了它自己写的 `daemon.json`（`ls` 报 `No such file`）。判定：三态各自走对分支、无关 listener 一个都没被杀、文件里的 pid 未被覆写。**PASS**

B2-4（真用户 daemon 在 `$HOME/.hreader`，壳不读它）：脚本第一次跑因 cwd 传错（`a.html` 相对 cwd 越界）用户 daemon 没起来，该子项**按 B8 的口径重做**——B8 用了同一台机器上真实 `$HOME/.hreader` 的 store 做对照（§3.8），结论同样成立：壳只认自己 home 里的 `daemon.json`，用户 store 的 md5 前后一致。**PASS（合并到 B8 证据）**

### 3.3 B3 双实例（同一 home 起两个壳）—— **PASS**

```
shell#1=3297 daemon#1=3300 json_pid=3300
shell#2=3311 json_pid_now=3300 (应为 3300 = Reuse)
serve 进程清单:
3300 node …/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti-cli.mjs …/packages/cli/src/main.ts \
     serve a.html --workspace /tmp/m42b-b/ws --home /tmp/m42b-b/b3home --json --exit-with-parent --port 0
shell#2 stderr: (空)
shell#1 alive=yes shell#2 alive=yes daemon#1 alive=yes
after TERM shell#2: daemon#1 alive=yes json=present   <- 复用的 daemon 不许被第二个壳带走
after TERM shell#1: daemon#1 alive=no json=none
```

判定：`pgrep -fl "main.ts serve"` 只有 **1 行**（一个 daemon）、第二个壳 `Reuse` 且 `stderr` 空、`daemon.json` 的 pid 一直是 3300（无双写）、第二个壳退出**没杀**复用的 daemon、owner 壳退出才收尸。**PASS**

### 3.4 B4 spawn 失败（`--cli-path /nonexistent`）—— **PASS**

```
=== B4 spawn 失败：--cli-path /nonexistent ===
exit=1 alive=no
stderr: --cli-path 指向的 /nonexistent 不存在
stdout: (空)
daemon.json: none
orphan(hr serve / main.ts serve): (空)
shell home listing: (空，连 home 目录都没建)
```

判定：非 0 退出、一行可读错误、无孤儿、无残留 `daemon.json`、甚至没留下壳 home 目录。**PASS**

### 3.5 B5 启动窗口期被 SIGKILL —— **FAIL（真洞）**

壳路径（`kill -9` 落在 `hr serve` 刚 spawn、还没 ready 时），3 次全一致：

```
app=2031 daemon(child)=2036 daemon_ppid=2031 ready_at_kill=no
ppid trace: before(after spawn)=2031 -> +1s=(alive=no) -> +2s=(alive=no) -> +3.5s=(alive=no)
daemon.json at +3.5s: present / port from json: 61478
（另两次：app=1423/daemon=1428、app=2119/daemon=2124，同样 present）
```

`daemon.json` 残留（pid 已死、端口已关）：

```
{"port":61372,"token":"dzk3p5tp2xAU-yXCl57Jj4m9s524Ih2c","pid":1428,"workspace":"/private/tmp/m42b-b/ws"}
nc -z 127.0.0.1 61372 → port-closed；pgrep -fl "main.ts serve" → 空
```

**变异无效？不，是 parent-death 本身在启动窗口失效。** 把同一现场搬到 CLI 层（stdout 写文件，排除管道因素）后真相出来了：

```
# 父进程在 startupParentWatch() 采集 ppid 之前被 kill -9（0.03s）
kill parent=2946 at 0.03s (daemon=2974, ppid_now=2946, json=no)
t+1s: daemon_alive=yes ppid=1 port=open json=present
t+2s: daemon_alive=yes ppid=1 port=open json=present
t+3s: daemon_alive=yes ppid=1 port=open json=present
t+4s: daemon_alive=yes ppid=1 port=open json=present
ORPHAN 2974                     ← 4 秒后还活着，ppid 已经是 1

# 对照：父进程在采集点之后被 kill -9（0.6s）
kill parent=3033 at 0.6s (daemon=3060, ppid_now=3033, json=yes)
t+1s: daemon_alive=no ppid= port=closed json=none     ← 正常自杀 + 清 json
```

根因（读码确认）：`packages/cli/src/parent-guard.ts:20-21`

```ts
export const startupParentWatch = (): ParentWatch => ({
  parentPid: process.ppid,        // ← 采集点被 serve.ts:44 放在 await startServer(...) 之后
  readParentPid: () => process.ppid,
});
```

父进程若在 `await startServer()`（jiti 冷启动 + 建服务器，实测 100–300ms）期间死掉，`process.ppid` 在采集时**已经是 1**，于是 `parentPid === readParentPid()` 永远成立 → 看门狗形同虚设。出口是 ppid=1 的孤儿 daemon，端口一直占着（`daemon.json` 也还在，下一次壳启动会 `Reuse` 它，所以不会重复拉起，但"壳被 OOM/kill -9 不留孤儿"的承诺在这里破了）。

壳路径之所以"看起来死了"，是另一条偶发链路（shell 死后子进程 stdout 管道读端消失，daemon 在写信封/日志时被打断），**3/3 都留下了 stale `daemon.json`** 就是它的指纹。判定：**FAIL**（现象层"daemon 走了"成立，机制层 W2 没生效，且留残留）。

### 3.6 B6 `--home` 目录不存在 —— **PASS**

```
=== B6a 壳侧：--home 指向不存在的深目录 ===
B6a: dir=yes app=3248 daemon=3251
B6a after TERM(+6x0.5s): app=no daemon=no json=none      # ≤3s 内收干净

=== B6b CLI 侧：hr serve --home /tmp/…/nope/a（不存在）===
exit=2
半成品目录: none / none
```

判定：壳先 `create_dir_all`（`lib.rs:203`），CLI 侧 `--home` 不存在 → `exit 2` 且**一个目录都没建**（`mkdir` 只在壳侧发生，`homeRealpathOf` 语义没被偷偷改）。**PASS**

### 3.7 B6′ 变异 M6b 的 S 层落地：用户自己的 daemon 该不该活 —— **PASS（未变异代码）**

真实"终端里跑 `hr serve`（不带旗标），终端退出"：

```
MUTATED-uncond-watch(serve.ts 恒装看门狗 + timer.unref()):
  term=932 daemon=939 ppid=932
  before: daemon alive=yes port_open=yes daemon.json=present
  after kill -9 term: daemon ppid= alive=no port_open=no daemon.json=none   ← 被误杀

CONTROL unmutated(源树):
  term=977 daemon=984 ppid=977
  before: daemon alive=yes port_open=yes daemon.json=present
  after kill -9 term: daemon ppid=1 alive=yes port_open=yes daemon.json=present  ← 该活着的活着
```

判定：**未见变异**时语义正确（`ppid 977 → 1` 后仍活、端口仍开）；但同一场景下"恒装 + unref"的变异**全绿通过 634 条 R 层用例**，只有这条 S 层证据能杀它。→ R 层缺一条"旗标为 false 时 `serveCommand` 不安装看门狗"的断言（`units-parent-guard.test.ts` 只测 `watchParent(undefined)` 这个分支本身，没测 `serve.ts:44` 的接线）。

### 3.8 B7 异常路径 —— **PASS（4/4）**

```
=== B7-1 文档名含空格/中文/# ===
{"checks":["healthz","bootstrap-cookie","document"],"documentBytes":224,
 "nav":"http://127.0.0.1:62114/s/%E6%88%91%E7%9A%84%20%E6%96%87%E6%A1%A3%231.html?t=***","ok":true,"pid":3695,"port":62114}
=== B7-2 --workspace 与 --open 跨目录 ===
smoke 失败：文档 /tmp/m42b-b/other/x.html 不在 workspace 内     exit=1
=== B7-3 daemon.json 是半截 JSON（`{`）===
smoke 失败：/tmp/m42b-b/b7home/.hreader/daemon.json: … 不是可用的 daemon.json：不是 JSON   exit=1
daemon.json after: {                                       ← 不被顺手删/覆盖，留给人工
=== B7-4 --open 指向目录 ===
smoke 失败：/tmp/m42b-b/b7ws 不是 .html/.htm 文档             exit=1
```

判定：`空格→%20`、`中文→UTF-8 百分号`、`#→%23` 全对（`#` 没把 `?t=` 截成 fragment，正文 224 字节真取到）；跨目录/目录参数/半截 JSON 都是**一行人读错误 + non-zero**，无 panic（`BadDaemonFile` 分支）。**PASS**

### 3.9 额外发现①：`icons/icon.ico` 缺失，Windows 侧构建直接红（未变异源树上复现）

```
$ cd /tmp/m42b-mut/packages/desktop/src-tauri && cargo check --offline --target x86_64-pc-windows-msvc
error: failed to run custom build command for `hreader-desktop`
  `/…/packages/desktop/src-tauri/icons/icon.ico` not found; required for generating a Windows Resource file during tauri-build

$ ls packages/desktop/src-tauri/icons/
icon.icns  icon.png          ← 没有 icon.ico
```

影响：`desktop:check`（`cargo fmt/clippy/test`）在 **windows-latest 上必然红**，AC-22/AC-24 的"CI matrix 就位"目前只是文本就位。修法：`tauri icon` 生成 `icon.ico`（或 `bundle.icon` 里补 `.ico`）—— 属下一卡。

### 3.10 额外发现②：启动失败会删掉 `<home>/.hreader/daemon.json` 里"死 pid"的老记录

```
$ hr serve ../a.html --workspace /tmp/m42b-b/ws --home /tmp/m42b-b/b2x --json   # 文档越界，exit 3
{"ok":false,"code":"path_outside_workspace",…}     exit=3
after: /tmp/m42b-b/b2x/.hreader/daemon.json GONE         # 我手写的、pid=999997（死）的记录被删

# 对照：同一失败路径、记录里的 pid 活着（sleep 40 的 pid）
live record after failure: {"port":49571,"token":"someone-elses-token-AAAAAAAAAA","pid":3650,…}   # 保留
```

查码后判定：这是 `packages/core/src/server/server.ts:179-183` `ensureNoDaemon` 的既定行为（`staleDaemonOf` → `removeDaemonOf`，只删 pid 已死的残尸），**不是缺陷**，但值得记一笔：任何"启动失败也删记录"的观感会让人误判；且它解释了为什么我 B 段跑到一半时真实 `~/.hreader/daemon.json` 里那条 `pid 98909` 的**测试残尸**消失（已按字节还原，见 §5）。

### 3.11 额外发现③：`packages/cli/tests/units-run.test.ts` 会写真用户 `~/.hreader`

`units-run.test.ts:12` 只把 workspace 换成 `mkdtemp`，`serve` 臂没换 `HOME`/没传 `--home`（对比 `serve.test.ts:60` 的 `env: { HOME: home }`）。跑一次 CLI 套件就会在真实 `~/.hreader/daemon.json` 里留一条 `hr-run-*` 残尸。属 P3 测试卫生，但会污染"`~/.hreader` 前后一致"这类隔离断言的现场（本轮我用**开工快照 + 结束字节还原**规避）。

---

## 4. 洞里哪些是真风险、哪些建议进下一卡

| # | 洞 / 发现 | 严重度 | 真风险 | 建议 |
|---|---|---|---|---|
| 1 | **W2 启动窗口失效**（`parent-guard.ts:20-21` 采集点晚于 `await startServer()`） | **P1** | 壳在 daemon ready 前被 SIGKILL/OOM → 出口 ppid=1 的孤儿 daemon，端口被一个没人管的进程长期占着 | 进下一卡：`startupParentWatch` 改成"进程一进来就采集"（`run.ts`/`main.ts` 顶部），或采集时 `if (process.ppid === 1)` 直接判 gone。真机用例就用 §3.5 的 0.03s / 0.6s 对照 |
| 2 | **`--exit-with-parent` 默认关闭这条语义无 R 断言**（M6b 全绿） | **P2** | 实现者顺手 `.unref()`/重构一下，用户终端退出就把用户自己的 daemon 带走 | 进下一卡：`units-serve-parent` 补"`exitWithParent: false` ⇒ 不装看门狗（假时钟推进 3 个周期 close 未被调）"，把 §3.7 的 S 层案固化成脚本 |
| 3 | **shell 崩溃后残留 stale `daemon.json`**（3/3） | P3 | 下一次启动 `Spawn{stale:true}` 自愈，只多一条残记录 | 下一卡顺手：`close()` 里先删文件再关 socket，或让 §3.5 的真机案断言"crash 后壳 home 里没有 `daemon.json`" |
| 4 | `signals::watch()` 安装点只在 `hold()` 里被覆盖，GUI 路径无断言（M2） | P3 | 窗口 ≤ `READY_TIMEOUT`(20s)，后果被 `--exit-with-parent` 兜住；若哪天去掉该旗标就变 P1 | 结构上补一条可断言的打点（如 `run()` 前先 `signals::watch()` 并让 `connect` 接受一个已安装标志），别只靠注释 |
| 5 | `icons/icon.ico` 缺失 | **P1（对 AC-22/AC-24）** | Windows CI job 首次真跑必红；`cargo check --target windows` 本地不可用 | 下一卡：`tauri icon` 补 `.ico`，并在报告里把"Win/Linux 已支持"改成"配置就位、CI 未跑" |
| 6 | `units-run.test.ts` 写真 `~/.hreader` | P3 | 测试之间互相污染"隔离"证据 | 下一卡：给该测试注入 `HOME`/`--home`（与 `serve.test.ts:60` 同口径） |
| 7 | Windows 侧 `signals.rs` 空桩（M3a） | P3 | macOS 上永远编译不到，只有 Windows target 能证；M3a 就是靠探针 crate 才见红 | CI 的 windows job 覆盖（前提是先修 #5），报告里写明"本机只验到探针层" |

---

## 5. 源树未被污染

开工快照 vs 收尾快照（`git status --porcelain`），**逐字节 diff**：

```
$ git status --porcelain > /tmp/baseline-status.txt      # 开工（27 行）
$ git status --porcelain > /tmp/end-status.txt           # 收尾
$ diff /tmp/baseline-status.txt /tmp/end-status.txt
15a16
> ?? .workflow/reports/audit-M4.2-r1.md
```

即：**除审计员并发写的 `audit-M4.2-r1.md` 之外，源树与开工时逐字节一致**；本文件（`test-M4.2-r1.md`）是唯一由我新增的路径（写完之后会再多这一行 `??`，属交付物本身）。`git diff --cached` 为空（全程没有 `git add`）。

其他清理与还原：

- 副本 `/tmp/m42b-mut`、探针 crate `/tmp/sigwin` 已 `rm -rf`；`ls /tmp/m42b-mut` → `No such file or directory`。
- 变异期间 `cargo check --target x86_64-pc-windows-msvc` 往**共享 target** 里落了 `target/x86_64-pc-windows-msvc`（194M），已 `rm -rf`（该目录在 `.gitignore` 内，且不受 `git status` 跟踪）。
- 真用户 store：B 段拿 `$HOME/.hreader` 做对照期间，那条 `pid 98909` 的测试残尸被 §3.10 的 stale 清理删掉过，收尾已用开工快照 `cp` 还原 → `cmp /tmp/m42b-b/user-store.before ~/.hreader/daemon.json` **字节相同**。
- 幽灵进程：收尾 `pgrep -fl "main.ts serve|hreader-desktop"` 空。

---

## 6. 未执行项及原因

| 项 | 状态 | 原因 |
|---|---|---|
| A 段 10 条变异 | 全部执行（另加 M6b 变体、M3 两个读法） | — |
| B 段 8 条 | 8/8 都有实测（B2-4 合并到 B8 的对照里，理由见 §3.2） | — |
| `cfg(not(unix))` 在**真 Windows** 上跑 `cargo test` | 未执行 | 本机只有 macOS；只能 `--target x86_64-pc-windows-msvc` 走到 build-script 层并被 `icon.ico` 挡住（§3.9），代码层用探针 crate 代替 |
| AC-20③ 人工双击看正文 | 本轮未重跑 | R1 没改 webview/导航路径，`gui-ac20-m4.2.md` 的结论仍适用；本轮 `--smoke` 的 `documentBytes=224` 只证 daemon 侧正文可取 |
| 真 OOM / `panic=abort` 场景 | 未执行 | 只能造 `kill -9`；`OOM` 需要 cgroup/内存压力，本机不可控 |
| 修好 #1 之后的回归 | 不可执行 | 本轮是只读的测试轮，改代码越界 |

---

## 7. 一句话给协调者

R1 的 W1/W2/W6/W7 在"正常路径"上都站住了（B1/B3/B4/B6/B7/B8 全 PASS，A 段 8 条被杀），但 **W2 的启动窗口是真空的**（§3.5：父死早于 ppid 采集 → ppid=1 的孤儿 daemon 活 4s+、端口不还），而 W2 的"默认关闭"语义**没有任何 R 层断言**（M6b 634 条全绿）。这两条是下一卡必须带走的；`icons/icon.ico` 会让 Windows CI 首跑就红，属于同一批要修的小坑。
