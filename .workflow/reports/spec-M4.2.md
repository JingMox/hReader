# M4.2 立卡前 AC 矩阵（G0 测试员）

> 事实基线全部采信 `.workflow/cards/M4.2.md` §1，未重跑侦察。本报告只补**协议事实**（下表标注 `file:line`），用于把 §5 的 10 条 AC 变成可施工、可证伪的 25 行。
> 归属层代号：**R** = Rust 纯逻辑 `cargo test`；**S** = `--smoke` 真机（真 socket/真子进程）；**B** = `tauri build` 产物；**CI** = 配置/脚本；**M** = 仅人工（每行都注明，不用 M 替代 R/S）。

## 0. 三条必须先读的协议事实（它们改写了卡 §3）

| # | 事实 | 出处 |
|---|---|---|
| P1 | `GET /` 的认证级别是 **`cookie`**，不是 `token`；`?t=` 只被 **`/s/<docId>`** 接受。 | `packages/core/src/server/routes.ts:66`（`route("GET", [], "cookie", "home")`）、`routes.ts:5`（注释："`token` = 唯一允许 `?t=` 的入口（`/s/<docId>`）"）、`packages/core/src/server/http-io.ts:196-200` |
| P2 | 拿到 cookie 的唯一途径是 webview **自己**加载 `/s/<docId>?t=<token>`：服务端 302 到不带 token 的同路径，同时 `Set-Cookie: hr=<token>; HttpOnly; SameSite=Strict` —— Rust 侧代拿 cookie 没用（它是 webview 的 jar）。 | `packages/core/src/server/server.ts:120-126`、`server.ts:41-42`、`http-io.ts:198` |
| P3 | `~/.hreader/daemon.json` **只有** `{port, token, pid, workspace}`，没有 docId；`docId` 是 `hr serve <file>` 的启动参数。 | `packages/core/src/server/contracts.ts:34-39`、`packages/cli/src/commands/serve.ts:8-22` |

**推论**：卡 §3 的「导航到 `http://127.0.0.1:<port>/?token=…`」按现协议必然 401。且 `/` 若已带 cookie，服务端会 302 到 `/?doc=<docId>`（`packages/core/src/server/static.ts:82-86`），docId 由服务端自己填 —— 所以壳**不需要**知道 docId，但**必须**先有 cookie，而 cookie 只能通过 `/s/<docId>?t=` 拿到，docId 又只有 `hr serve` 的启动者知道。见歧义 **A1（阻断）**。

## 1. AC 矩阵 A：R 层（`cargo test`，纯逻辑）+ CI 脚本可静态证的两条

| AC | 一句话断言 | 怎么造 | 断言什么 | 怎么证伪（什么改动会"变绿但其实坏了"） | 层 |
|---|---|---|---|---|---|
| AC-1 | `daemon.json` 解析是**三态**（可用 / 无文件 / 存在但坏），坏文件不得被当成"可用"，也不得被当成"无 daemon"以外的第三态 | `src-tauri/src/daemon_file.rs` 单测 + `tests/fixtures/daemon/{ok,missing,bad-json,field-missing,port-zero,token-empty,port-string}.json`（`missing` 用不存在的路径模拟） | `Ok(Some(info))` / `Ok(None)` / `Err(bad_daemon_file)`；`port:0`、`token:""`、`"8123":string` 全部落 `Err`，且 `Err` 的 `Display` 不含路径外的任何字段值 | 把三类全并成 `Option`（坏文件 = 没有 daemon）→ 所有用例只要断言"没崩"就绿，代价是用户被一个坏文件永久挡住却"看起来正常拉起新 daemon"；或 `serde` 加 `#[serde(default)]` 让 `port:0` 过门，测试只覆盖 `ok` 就绿 | R |
| AC-2 | bootstrap URL 的拼装对 docId 与 token **都**做转义，docId 走 path-segment、token 走 query | `src-tauri/src/url_build.rs`：`bootstrap_url(port, doc_id, token)`；样例 `doc_id ∈ {a/b.html, "空格 x.html", "a#b", "a?b", "../x.html"}`、`token ∈ {base64url 48 字符, "a&b=c", "a+b"}` | 拼出 `http://127.0.0.1:<port>/s/<pct-encoded>?t=<pct-encoded>`；再喂一个"最小 RFC3986 解码器"回读，得到原值（往返相等）；`doc_id` 里 `/` **不被**转义、`#`/`?`/`%` 被转义 | 用 `format!(".../s/{}?t={}", doc_id, token)` 直接插值，测试样例只取 `a.html` + 全 `[A-Za-z0-9]` 的 token → 全绿；真实 docId 带 `#` 时 token 被截断成 fragment → 401，没人发现 | R |
| AC-3 | 日志脱敏是一个**纯函数**且所有日志路径共用它：任何 ≥16 字符的 base64url 串都不许出现在输出里 | `src-tauri/src/redact.rs`：`redact(text, token)`；用例：`token` 出现在 query/`#`/`&t=`/JSON `"token":"…"`/`Debug` 的 `Url{…}` 形态里 | 六种形态的输出都不含 token 原文；函数对"token 不在串里"必须原样返回（否则会被误当通用来"干净"掉一切）；`redact` 的输入断言用**真实 48 字符 token**（`randomBytes(24).toString("base64url")`，见 `server.ts:37`） | 实现成 `text.replace(&format!("t={}", token), "t=***")` → 只挡一种形态；或用 `text.replace(token, "")` 但测试里 token 取 `"abc"` → 绿得毫无意义（`abc` 会命中任何串） | R |
| AC-4 | "该不该我拉起 daemon"是纯决策函数，输入三态（无文件 / 有文件+端口活 / 有文件+端口死）**加**第四态（端口活但 pid 不是文件里那个） | `src-tauri/src/spawn_decision.rs`：`decide(daemon_file_state, probe_result, expected_pid_alive) -> Spawn \| Reuse \| Conflicted` | 四态各自返回唯一结果；`Conflicted` 必须携带"人读一行"的错误文案 key（不拼字符串，key 由 UI 层翻译，便于 AC-23 的措辞检查）；端口探测结果通过 trait 注入（`PortProbe`），单测用假实现 | 把 `probe_result == Open` 就当 `Reuse` → 端口被任何进程占用（`nc -l 8123`）时复用 → 后续 401；若单测只喂"自己的 daemon"这一种 live 情形，永远绿。**必须**有一例 `Open + pid 不匹配` | R |
| AC-5 | 子进程归属是显式记账：壳只 kill `spawned_pids` 集合里的 pid，且 `spawned_pids` 不含从 `daemon.json` 读到、又不是自己拉起的 pid | `src-tauri/src/child_registry.rs`：`Registry::adopt_external(pid)` / `Registry::own(pid)`；`should_kill(pid)` | `own(1) → should_kill(1)=true`；`adopt_external(2) → should_kill(2)=false`；重复 `own(1)` 幂等；`own(1)` 后再 `adopt_external(1)` 不降级为 false（先到先得，记录冲突） | 只实现"退出时 kill 我拉起的那个"而没有 `adopt_external` 概念 → 单测只看 own 分支，绿；真实场景里壳重启后 `daemon.json` 里的 pid 被当作"自己的"，退出时把用户的 daemon 杀了。**这一行挡不住真实误杀，AC-15 才是主证据** | R |
| AC-6 | `.html` 启动参数 → 动作映射是纯函数：合法路径映射为 workspace 相对 docId + `OpenDocument` 动作；不带参数映射为 `NoAction`（不报错）；非法输入映射为具名错误 | `src-tauri/src/open_arg.rs`：`action_of(argv, workspace) -> Action`；样例 `["--open","/ws/a.html"]`、`["--open","a/b.html"]`（相对 cwd）、`["--open","/etc/x.html"]`（越界）、`["--open","/ws/a.txt"]`、`["--open"]`（缺值）、`[]`（无参数）、`["--open","/ws/a%2Fb.html"]` | 合法 → 相对路径精确等于 `a.html`/`a/b.html`；越界 → `Err(open_arg_outside_workspace)`；缺值 → `Err(open_arg_missing_value)`；`[]` → `NoAction` 且**不是** `Err`；`.txt` 的处理需协调者裁定后写死（见 A5） | 实现成 `Path::file_name()` 或 `to_string_lossy()` 原样下发 → 单层 `a.html` 的用例绿，`a/b.html` 变成 `b.html`（打错文件）、`../x.html` 逃出 workspace；`[]` 分支若 `unwrap`，无参数启动直接崩，"不带参数不报错"的用例没人写就发现不了 | R |
| AC-7 | 全局快捷键配置可解析、可关闭（`null`），且默认 accelerator **必含修饰键**（所以与 `keys.ts` 的无修饰 reader 键不冲突） | `src-tauri/src/shortcut.rs`：`parse_accel(&str)`、`default_accels()`；外加 `packages/desktop/accels.json`（唯一真源）+ 一条 vitest（`packages/app/tests/keys.test.ts` 旁新增，见 A6 授权问题）读同一 JSON 断言与 `intentOf` 冲突集为空 | `parse_accel("CmdOrCtrl+Shift+H")` 得结构化值；`parse_accel("H")` **必须 Err**（违反"必含修饰键"）；`parse_accel("")`/`"CmdOrCtrl+"` Err；`accels.json` 每条都含 `CmdOrCtrl`/`Ctrl`/`Alt` 之一且 ≠ `Escape`；`null` 配置 → 返回空列表（不是 Err、不崩） | 默认值取 `"h"`（正好是 reader 的 `toggleFocus`，`packages/app/src/keys.ts:13`）→ 单测"能解析"绿，冲突没人查；或 `null` 走 `unwrap_or_default()` 之外的分支直接 `?` 早退，于是"关掉快捷键"变成"起不来" | R |
| AC-8 | 层分界可静态证：`use tauri` / `WebviewWindow` / `ShellExt` **只**出现在白名单文件的薄壳里，纯逻辑模块零依赖 | `scripts/desktop-layering.mjs`（或 `desktop:check` 里的一步）：对 `src-tauri/src/**.rs` 逐文件 grep，白名单 = `{lib.rs, main.rs, window.rs, shell.rs}` | 非白名单文件里 `use tauri` / `tauri::` / `#[tauri::command]` 命中数 = 0；白名单文件里的业务判断 < 3 处（人读条款，写进报告）；脚本 exit 0 | 把全部逻辑塞进 `main.rs`（白名单）→ 脚本绿、`cargo test` 也能测（因为 `main.rs` 里的 `fn` 可测），但"纯逻辑与平台副作用分开"这条实质作废。→ 故 AC-8 只作**下界**，实质由 AC-1..7 的文件粒度兜底 | CI |

## 2. AC 矩阵 B：S 层（`--smoke` 真机）/ B 层（`tauri build`）/ CI

> 统一前置（所有 S 行共用，写者必须在脚本里实现）：`SMOKE_HOME=$(mktemp -d)`、`HOME=$SMOKE_HOME HR_PORT=<空闲端口>`，argv 形如 `hreader-desktop --smoke --home $SMOKE_HOME --port <port>`；用 `lsof -nP -iTCP:<port>` 与 `kill -0 <pid>` 抓真凭证。`hr serve` 的 `home` 已是 `ServeInput` 字段（`packages/cli/src/commands/serve.ts:11`），可注入，不需要改 core。

| AC | 一句话断言 | 怎么造 | 断言什么 | 怎么证伪 | 层 |
|---|---|---|---|---|---|
| AC-9 | `--smoke` 正例：无窗口 → 拉起（或复用）daemon → `GET /healthz` 200 → exit 0 | `packages/desktop/scripts/smoke.sh`：`HOME=$(mktemp -d) ./target/release/hreader-desktop --smoke --port 0 --json` （`--port 0` = 自选，实际端口从 stdout 的 JSON 读） | exit 0；stdout 有一行 JSON `{ok:true,port,pid}`；`kill -0 <pid>` 为真在 smoke 结束时**已不成立**（smoke 退出了自己拉起的 daemon）；`~/.hreader/daemon.json` 在退出后**不存在**或已指向别的活 daemon | `fn main(){ if smoke { std::process::exit(0) } }` → 绿。或用"端口能 connect"代替 `GET /healthz` → 绿，但 daemon 是僵尸/半初始化（`/healthz` 是唯一不碰构建产物也不碰文档的页，`server.ts:88`），所以必须真发 HTTP 并校验 body 含 `"ok":true` | S |
| AC-10 | `--smoke` 反例：daemon 起不来（node/hr 不存在、端口被占）→ exit **非 0** 且 stderr **恰一行**人读错误、且不含 token | `PATH=/nonexistent ./target/release/hreader-desktop --smoke`；另一例先 `nc -l 127.0.0.1 8123` 再 `--smoke --port 8123`；第三例 `--smoke --port 1`（权限） | exit code ∈ {1..}；stderr `grep -c '^'` ≤ 2；stderr 不含 48 字符 base64url 串；不含 `t=` | 错误分支 `eprintln!` 后 `return Ok(())`/`if err { return }` → 恒 0；或 `anyhow` 的 `{:?}` 打整条链含 URL → 泄漏 token 且行数爆炸（这条同时挡 AC-17）。**注意**：`PATH=/nonexistent` 时 `sh` 自身都跑不了，脚本要用绝对路径调二进制 | S |
| AC-11 | `--smoke` 不污染用户环境：跑完 `$HOME` 里除临时目录外零新增，且不杀用户在**别的**端口起的 daemon | 起 smoke 前先手动 `HOME=/tmp/u1 hr serve /tmp/u1/a.html --port 8300 &` 记 `P_u`；跑 `HOME=/tmp/smoke ./hreader-desktop --smoke`；结束 `kill -0 P_u` + `curl -s 127.0.0.1:8300/healthz` | `P_u` 仍活、healthz 200；smoke 用的临时 HOME 内 `daemon.json` 已清理；`ls /tmp/u1/.hreader` 的 mtime 未变 | 实现"退出时按 `pkill -f 'hr serve'` 收拾" → 单次 smoke 场景全绿（因为只有它自己的），CI 里与他人 daemon 共存时误杀，只有这条能抓 | S |
| AC-12 | 复用不重复拉起：`daemon.json` 指向活 daemon → 第二次启动后 **pid 与端口都不变** | ① `HOME=$H ./hreader-desktop --smoke` 记 `pid1/port1`；② 再跑一次（`daemon.json` 仍在，但第一次退出时若已清理，则改用 daemon 常驻：`hr serve` 于 `$H`）；③ 两次 `--smoke` 之间再起一次壳进程 | 第二次读到的 `port` 与前一次相同；`lsof -nP -iTCP:<port>` 只有 1 个 LISTEN 的 pid；`~/.hreader/daemon.json` 的 `pid` 字段未变 | 每次启动都 spawn（不看文件）→ 第二次端口不同，"健康"全绿；或"文件存在即复用"而不探活 → 死端口复用时 401 但 smoke 只查 `/healthz`（S 层的 curl 打新端口？不，打到死端口会失败，所以此变异会被 AC-9 抓）。真正难抓的是"复用后 webview 未认证"——见 A1 | S |
| AC-13 | 死端口残留清理且**不删别人的**：文件指向死端口 → 删除文件 + 拉起新 daemon；文件指向**活着的**外部 daemon → 绝不删除、不拉起 | ① 手写 `$H/.hreader/daemon.json` 为 `{port: 1, token:"x", pid: 999999, workspace:"$H"}`（端口 1 必死、pid 不存在）；② 另一例：先 `hr serve` 于 8300 拿到真 `daemon.json`，再起壳 | ① 起壳后文件被替换为新端口、`kill -0` 新 pid 成立；② 起壳后文件**字节不变**（`shasum` 相同）、8300 的 daemon pid 不变、壳退出后仍不变 | 实现为"启动先 `remove(daemon.json)`" → ①绿②也绿（因为文件被删后 core 会重写… 不，外部 daemon 不会重写 → 文件消失但 8300 仍活，**shasum 检查**才抓得住）；这一条是最容易"看起来对"的假绿 | S |
| AC-14 | 退出清理：壳拉起的 daemon 在壳退出后死（真监听 socket 消失） | `HOME=$H ./hreader-desktop --smoke` 起来后（用一个 `--hold 3` 或 `--smoke` 的 dry-run 变体），读 `daemon.json` 的 `pid`；给壳 `SIGTERM`（模拟"正常退出"）与 `SIGKILL`（模拟"被 Activity Monitor 强杀"）两种 | SIGTERM：3s 内 `lsof -iTCP:<port>` 无 LISTEN、`kill -0 pid` 假；SIGKILL：**允许**泄漏，但必须在 `daemon.json` 留下可被下次启动清理的残留（由 AC-13① 兜住） | 只处理 `window.close` 事件 → SIGTERM 场景泄漏（macOS 关窗口 ≠ 退出）；用 `Child::kill()` 而不 `wait()` → 僵尸进程 + 端口仍 TIME_WAIT，`lsof` 检查写法不当会误判 | S |
| AC-15 | **误杀反例（本卡最关键的一条）**：用户手起的 daemon 不许被壳杀掉 | ① `HOME=$H hr serve $H/a.html --port 8300 &` → `P_u`；② 壳以 `--smoke`（或真窗口）启动，注入同一 `$H`，壳发现 8300 活着 → 复用，`P_u` **不是**壳的子进程；③ 壳退出 | `kill -0 P_u` 真、`curl 127.0.0.1:8300/healthz` 200、`daemon.json` 的 `pid` 仍是 `P_u` | 用 `killpg`/`pkill -f hr`/"kill 所有我见过的 pid" → AC-9/AC-14 全绿，只有这条红；或壳"退出时把自己的 token 对应的 daemon 杀掉"，而两者 token 相同（复用时 token 是 `P_u` 的）→ 杀错。**必须**断言具体 pid，不能断言"healthz 还通"（杀错后 healthz 也可能通，如果壳又拉了一个新的到同一端口——端口冲突时不通，但不同端口就通） | S |
| AC-16 | 端口被**无关进程**占用：壳识别为 `Conflicted`，exit 非 0 + 一行可读错误，不尝试 kill 那个进程 | `nc -l 127.0.0.1 8123 &` 记 `P_n`；`$H/.hreader/daemon.json` 指向 8123/一个不存在的 pid；`./hreader-desktop --smoke` | exit 非 0；stderr 一行，含"端口"语义的 key；`kill -0 P_n` 仍真（没去杀别人的进程） | 实现"端口活就复用"（AC-4 的变异）→ 复用 `nc` → smoke 的 `/healthz` 请求会拿到 `nc` 的空回包 → 若 HTTP 解析宽松（只看"连上了"）就绿；严格校验 `ok:true` 才红 | S |
| AC-17 | token 不泄漏：壳的 stdout/stderr、`ps` 可见的 argv、`daemon.json` 的权限三处 | `./hreader-desktop --smoke > /tmp/o 2>/tmp/e`；`ps -o command= -p <shell_pid>,<daemon_pid>`；`stat -f '%Sp' $H/.hreader/daemon.json` | `/tmp/o`、`/tmp/e` 中 48 字符 base64url 命中 0；argv 中不含 token（token 经 env 或文件传，不经 argv）；`daemon.json` 仍是 `600`（core 写的是 600，`daemon.ts:80` 附近 `chmod(tmp, 0o600)`——壳若重写文件必须保持） | 只脱敏"含 `t=` 的那一行" → `ps` 与 `{:?}` 泄漏；或壳为了省事以 `--token <t>` 传给 `hr serve`（若未来加该 flag）→ argv 全泄漏，日志 grep 一条都抓不到 | S |
| AC-18 | 本地 `tauri build` 真产物：`.app` 存在、其中**二进制**（不是 `cargo run`）`--smoke` exit 0 | `cd packages/desktop/src-tauri && cargo tauri build`（`npx @tauri-apps/cli@2`）；`ls target/release/bundle/macos/hReader.app/Contents/MacOS/`；直接执行 `.../Contents/MacOS/hreader-desktop --smoke` | 产物路径存在；该二进制 `--smoke` exit 0（走 AC-9 同一脚本，`BIN` 变量替换）；`codesign -dv` 显示 ad-hoc 或未签名（本卡非目标：签名/公证） | 只 `test -d hReader.app` → build 成功即绿；而"双击起不来"（找不到 node）在本机也可能绿，因为开发机 PATH 里有 node → 必须用 `env -i PATH=/usr/bin:/bin:... --smoke` 复现 LaunchServices 的最小 PATH（见 A3） | B |
| AC-19 | `Info.plist` 声明就位：文档类型（.html）+ 最低系统版本 + bundle id 稳定 | `plutil -p hReader.app/Contents/Info.plist` | `CFBundleDocumentTypes` 含 `public.html`（或 `public.html` 的 UTI 扩展声明）；`LSMinimumSystemVersion` 存在；`CFBundleIdentifier` 与 `tauri.conf.json` 的 `identifier` 一致；`CFBundleShortVersionString` 与 `package.json`/`Cargo.toml` 的版本一致 | 手工在 `tauri.conf.json` 写 `bundle.macOS` 但忘了 `fileAssociations`（Tauri 的字段名是 `bundle.fileAssociations`）→ build 成功、plist 无 `CFBundleDocumentTypes`，只有这条会红 | B |
| AC-20 | "壳能起来"的第二层证据（webview 真加载）：服务端观察到一个来自壳的 `GET /s/<docId>?t=…`（302）与随后的 `GET /?doc=<docId>`（200） | **macOS 无 webview 自动化**（tauri-driver 不支持 macOS）→ 只能两条腿：① 壳侧 `--smoke --nav` 打印"将导航的 URL（已脱敏）"+ 服务端侧可信；② 人工一次：双击 `.app`，肉眼见阅读器正文与封面，报告记 `M` | ① 导航 URL 的 path 以 `/s/` 开头、query 有 `t`（值脱敏）；② 人工记录：截图或文字描述"见 `<标题>` 正文与 TOC"+ 时间戳。**不得**用"窗口进程存活"替代 | 把"进程活着 + 窗口数 1"当证据（Tauri 的 `WebviewWindow::is_visible()` 在加载失败时也真）→ 绿得彻底；404/401 页面在 webview 里同样是"窗口可见"。所以 AC-20 必须落在**人工 + 导航 URL**，工程化程度到此为止（见 A2） | S/M |
| AC-21 | `desktop:check` 三件套：`cargo fmt --check` + `cargo clippy -- -D warnings` + `cargo test` 全绿，且不进 `pnpm verify` | `packages/desktop/scripts/check.sh`；根 `package.json` 加 `"desktop:check": "bash packages/desktop/scripts/check.sh"` | 三者 exit 0；`pnpm verify` 的输出里 `grep desktop` 命中 0（即 verify 不调用它） | `check.sh` 写成 `cargo test || true` 或只跑 test 漏 clippy → 绿；`cargo clippy` 不加 `--all-targets` 会漏 `tests/` 里的死代码 | CI |
| AC-22 | CI Rust job 真能跑且固定工具链：`rust-toolchain.toml` 存在（`channel = "1.98.0"`），CI 里 `cargo` 步骤与 `pnpm verify` 步骤**并列**（不同 job） | `.github/workflows/ci.yml` 新增 `desktop` job；`rust-toolchain.toml` 提交 | `cargo fmt --check`、`clippy`、`test`、`desktop:check` 在 ubuntu 上 exit 0；job 无 `continue-on-error`；`rust-toolchain.toml` 的 channel 与卡 §1 的 1.98.0 一致 | 有人把 Rust 步骤塞进现有 `checks` job（node matrix ×2）→ 慢一倍且 rustup 未预装会红；`cargo test` 里若有"真起 daemon"的用例在 CI 无 node 的 runner 上红 → 有人 `#[ignore]` 了它（S 层用例因此**永远**不在 CI 跑，必须写明哪些 S 用例只能在本地） | CI |
| AC-23 | `pnpm verify` 七步不被 Rust 目录搞红、也不被"整包忽略"蒙混：`format:check`/`lint`/`typecheck`/`build`/`test:coverage`/`depcruise`/`knip` 对新增目录 exit 0，且忽略规则**窄**到生成物 | 在 `packages/desktop/src-tauri/{target,gen}` 有内容的情况下跑 `pnpm verify`；再逐条 `pnpm knip`/`pnpm depcruise` 看输出 | 七步 exit 0；`knip` 报 0 issue；覆盖率的 perFile 四维 100%（`vitest.config.ts:43-49`）不因新 workspace 变化（`packages/desktop` 不得有 `src/**/*.ts`）；`.prettierignore`/`eslint.config.mjs`/`.gitignore` 的忽略项以 `src-tauri/target`、`src-tauri/gen` 为**最小单位**，禁止 `packages/desktop` 整包 | 把 `packages/desktop` 整包加进 `.prettierignore`+`knip.ignore` → verify 绿，代价是将来该包任何 `.json`/`.ts` 都不再被检查（`tauri.conf.json` 拼错只能运行时炸）；或 `cargo build` 前未清 `target/` 导致 prettier 扫十几万文件超时（`format:check` 慢到 timeout → 红，但原因被误读成"格式错误"） | CI |
| AC-24 | Windows/Linux 只"配置就位"且措辞不许吹：`tauri.conf.json` 的 `bundle.targets`/`bundle.windows`/`bundle.linux` 字段齐全，CI matrix 就位，报告不出现"已支持 Win/Linux" | 读 `tauri.conf.json`；`node -e` 断言字段存在；CI 里 `matrix.os: [ubuntu-latest, windows-latest, macos-latest]`；报告措辞检查 `grep -n "已支持\|already supported" .workflow/reports/impl-M4.2.md` 命中 0 | targets 含 `app`（mac，**不含 `dmg`**——D6 只产 `.app`）、`msi`/`nsis`（win）、`deb`/`appimage`（linux）；CI 里 matrix job **已在某次真跑中 green**（贴 run 链接）或明确标 `未执行`；报告措辞命中 0 | 配置写了字段但 CI job 从未跑（"就位"=文本存在）；或 matrix 里加 `continue-on-error: true` 把红抹平；或 G3 用"配置文件里有 nsis"当"能装" | CI |
| AC-25 | 本卡不改协议语义：`packages/core/**`、`packages/app/src/**`、`packages/renderer-html/**`、`docs/**` 相对基线 `02f2649` 的 diff 为 0；`packages/cli/src/**` **只允许**两处增量（`--home`、`--exit-with-parent`），既有旗标语义不变 | `git diff --stat 02f2649 -- packages/core packages/app/src packages/renderer-html docs`（必须空）+ `git diff 02f2649 -- packages/cli/src`（人工核只含这两处） | 前者为空；后者只出现 `home`/`exit-with-parent` 相关行 | 若 A1 的裁定是"core 允许 `GET /?t=`"，这条会红 → 必须由协调者显式改写 §2.4 与 §6，否则写者会偷偷改 `routes.ts:66` 让整条 bootstrap 通，而没人记录协议变更 | CI |

## 2.1 R1 增补（协调者改，2026-11-18）

审计 G2 与测试 G3 交回后新增，**与上表同等效力**：

| AC | 要求 | 怎么验 | 通过标准 |
|---|---|---|---|
| AC-26 | D1 的牙齿：`default_home()` 指向 appData 作用域（macOS `~/Library/Application Support/hreader`），**不是** `$HOME`；spawn 前该目录已存在 | R 层：注入 `$HOME=/Users/x` 的纯函数单测；S 层：真跑一次 GUI（无 `--home`），比对真 `~/.hreader` 的 listing 与 mtime 不变 | 单测断言落点不在 `~/.hreader`；真 `~/.hreader` 前后一致；把 `default_home()` 改回 `$HOME` 时单测变红 |
| AC-27 | `accels.json` 出现重复 accelerator 时**加载期报错**（指出哪两个别名），`register` 的 `Err` 冒泡成启动失败 | 新增单测：重复键 → `Err`；`register` 失败 → 冒泡（不得 `let _ =`） | 两条用例存在且能在改坏时变红 |
| AC-28 | `decide()` 判 `Reuse` 后、导航前的 TOCTOU 窗口关闭：导航前再核「pid 活 + 健康载荷是 hreader」，核不过按 `CONFLICTED` | 注入式 probe：第一次 `Reuse`、第二次改 pid → 断言拒绝且未导航 | 用例存在；把二次校验删掉时变红 |
| AC-29 | `signals::watch()` 在进入 `connect()` **之前**安装（`hold()` 里重复调用幂等） | 读 `lib.rs` 的 `run()`；单测断言 `watch()` 两次不 panic | 安装点在 `connect()` 之前；幂等用例存在 |
| AC-30 | 壳被 `SIGKILL` 不留孤儿：`hr serve --exit-with-parent` 检测被 re-parent 即退出；**`adopted` 外部 daemon 不带该旗标** | S 层：`hr serve --exit-with-parent` 的假父进程被 `kill -9` 后它自行退出且端口释放；R 层：ppid 判定纯函数单测 | 两条证据齐；`adopted` 路径不传该旗标（grep 断言） |

## 3. 歧义与风险清单（按严重度；前三条写了"不解决会怎样"）

**A1（阻断，必须裁定）bootstrap 认证链不闭合。** 事实：`/` 是 `cookie` 级（`routes.ts:66`），`?t=` 只在 `/s/<docId>`（`http-io.ts:196-200`），cookie 只能由 webview 加载 `/s/<docId>?t=` 后由服务端 302 种下（`server.ts:120-126`），而 `docId` 不在 `daemon.json`（`contracts.ts:34-39`）。
- 不解决会怎样：卡 §3 的「导航到 `/?token=…`」写下去就是错的，AC-20（壳能显示正文）无解，写者只有三条歪路：偷偷改 `routes.ts:66`（越界、违反 §2.4）、在 Rust 里读 `~/.hreader` 猜 docId（猜不到）、或让 webview 停在 401 页而 smoke 仍绿。**这是"壳能起来"能不能被证明的地基。**
- 三个候选（要协调者选一个，并同步改 §2.4/§3/§6/AC-25）：
  - **(a) 改 core 最小面**：`GET /` 的 `auth` 从 `"cookie"` 改为 `"token"`（`routes.ts:66` 一处），于是壳可一把导航 `http://127.0.0.1:<port>/?doc=<docId>&t=<token>`… 仍缺 docId；更小的是新增 `route("GET", ["__auth"], "token", ...)`。**代价**：改协议语义，须新开 AC 与安全复核（`?t=` 进 Referer/历史记录的风险）。
  - **(b) 壳只支持"自起或自启动的 daemon"**：壳自己 `hr serve <file>`（它知道 docId）→ 自起路径可闭合；**复用路径**（用户手起）降级为"打开 daemon 首页的未认证提示 + 一行'请用 hr open'"，不复用 webview 会话。**代价**：AC-12"复用不重复拉起"变成"复用但不保证可见正文"，与卡 §3 的意图有落差。
  - **(c) 壳做平台 cookie 注入**（macOS `WKHTTPCookieStore`、Windows WebView2 cookie manager）：能闭合但 platform-specific、要 unsafe FFI、与"薄壳"分层冲突。**建议否决**。
- 我的建议：**(b)** 作为本卡范围，(a) 另立卡讨论。理由：(b) 不需要动 core、AC-15（误杀）与 AC-12（复用）仍可测，且"复用"的真实价值（不重复占端口）保留。

**A2（阻断 AC-20 的证伪力）GUI 不可 headless 断言，`--smoke` 不够。** `--smoke` 只走 `/healthz`（`server.ts:88` 明写这是唯一不碰产物也不碰文档的页），它证明的是"能拉起并连上 daemon"，**不证明** webview 把 `dist/index.html` 加载成阅读器。而 tauri-driver 不支持 macOS（Linux/Windows only），本机没有 webview 自动化。
- 不解决会怎样：会写出"smoke 绿 → 壳可用"的报告，而 401 页/白屏同样绿。AC-20 必须写成三层证据（导航 URL + 服务端 302/200 观察 + 一次人工），并明确"人工这一层不可被替代、本卡不追求自动"。
- 最小可证伪证据（建议写进卡）：① `--smoke` exit 0 且 stderr 无 token；② 壳打印**将导航的 URL（脱敏）**，其 path 必须 `/s/` 或 `/`；③ 人工一次：双击 `.app` 看到 `<标题>` 正文与 TOC，报告记时间戳与产物版本。**不要求**截图自动化。

**A3（阻断 AC-18 的可信度）打包后的 `.app` 从哪找 node 与 `hr`。** `hr serve` 是 Node 程序（`packages/cli/src/commands/serve.ts`），而 LaunchServices 启动的 GUI 进程 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，拿不到 nvm/fnm/homebrew 的 node；本卡又不许把 Node 逻辑搬进 Rust（§3 末）。
- 不解决会怎样：开发机（`open` 时继承或 PATH 恰好有 node）绿，干净机器必挂；写者会硬编码 `/opt/homebrew/bin/node` 或本机绝对路径，audit 时无法分辨。
- 建议裁定：壳的 daemon 启动器接受显式解析顺序 `$HREADER_HR` → `$HREADER_NODE`+`packages/cli/src/main.ts` → `PATH` 里的 `hr`；全都找不到时**停在 AC-10 的错误分支**（exit 非 0 + 一行"未找到 hr，请设置 HREADER_HR"）。AC-18 的 `--smoke` 必须用 `env -i PATH=/usr/bin:/bin` 复跑一次，证明"找不到时报错"而不是"静默成功"。

**A4 `--smoke` 的环境隔离未定义。** 是否允许 spawn 真 daemon？它会写 `~/.hreader/daemon.json`（`daemon.ts:12-16`），CI 里并发两次会互相踩、也会污染开发者机器。建议：`--smoke` **必须**用 `--home <dir>`（或 `HREADER_HOME`）注入临时目录，S 层每个用例都 `HOME=$(mktemp -d)`；这条应写进卡 §3 的 `--smoke` 定义里，否则 AC-11 无从断言。

**A5 文件关联的界线。** 真正的 `.html` 双击关联 = LaunchServices 注册（`Info.plist` 的 `CFBundleDocumentTypes` + 装到 `/Applications` + `lsregister`），会改用户系统状态、且"装一次"本身不可脚本化回滚；`--open <file>` 只是 argv 近似。
- 界线（建议写死）：本卡只证 ①`Info.plist` 声明（`plutil -p`，AC-19）；②`--open <file>` 的**参数映射（Rust 纯逻辑，AC-6）+ 一次真进程**的 argv 证据。**不证**"双击 Finder 能打开"，报告措辞也不许写"已支持文件关联"。
- 另一处未定：`.txt`/无扩展名/目录 的 `--open` 是忽略还是报错；`--open` 达标后"进入既有导入路径"具体是哪条路径 —— 库里没有 `hr import`（`packages/cli/src/commands/` 只有 serve/read/print/pdf/png/patch/style/outline/undo/exportPrint/printSkip/styleExtract），最接近的是"把文件路径当 docId 交给 `hr serve`"。**需点名**，否则 AC-6 只能测"映射出了 path"，测不到"文档被导入"。

**A6 全局快捷键的冲突面与"注册失败"。** `packages/app/src/keys.ts` 的 reader 键全是无修饰单键 `Escape / / / j / k / h / c / w / Shift+D`，且 `intentOf` 一跳过任何带修饰键的事件（`keys.ts:29-31`）⇒ **可判定规则**：全局 accelerator 必含 `CmdOrCtrl`/`Ctrl`/`Alt` 且 ≠ `Escape`，则与 reader 零冲突。但"注册失败（被别的 App 占用）"在 macOS 上无法确定性地造 —— 建议用**同进程注册两次同一 accelerator**（第二次必失败）来造，断言 warn + 窗口照常起 + exit 0。
- 授权缺口：`keys.ts` 的键表与 Rust 侧 accelerator 清单的"同源"检查要新增一条 vitest（放 `packages/app/tests/keys.test.ts` 旁），而 §6 没授权改 `packages/app/tests/**`（只禁了 `src/**` 的**行为**）。需明示授权或改用"把清单抄进 `packages/desktop/accels.json` 并人读比对"。

**A7 `pnpm verify` 七步与 Rust 目录（兼卡 §1 的小错）。** `verify` = `format:check && lint && typecheck && **build** && test:coverage && depcruise && knip`（`package.json`），卡 §1 列了 6 个名字漏了 `build`（七步是对的，清单少一项）。真实风险三条：
- `prettier --check .` 会走进 `src-tauri/target/**`（几万文件、大量 `.json`）与 `src-tauri/gen/**`（生成的 schema）→ 慢 + 可能报格式错；`.prettierignore`（现仅 node_modules/dist/coverage/pnpm-lock/.stryker-tmp/docs/.workflow）**需要新增 `src-tauri/target`、`src-tauri/gen`**，但 `.prettierignore` 不在 §6 可改清单。
- `eslint . --max-warnings=0`：`.rs`/`.toml` 天然被忽略，但 `eslint.config.mjs:25-31` 的 ignores 无 Rust 生成物 → `gen/schemas/*.json` 无影响（不是 TS），**但**若写者往 `packages/desktop` 放任何 `.ts` 脚本，会被 `TS_FILE_PATTERNS` + `strictTypeChecked` 抓（这是好事，需明示允许）。
- `knip`：`workspaces` 是显式列出的（`knip.json`），新增 `packages/desktop` 若**无** `package.json`，pnpm workspace glob（`pnpm-workspace.yaml:2` = `packages/*`）会跳过它 → 但 `pnpm install --frozen-lockfile` 与 `knip` 的行为要实测；若**有** `package.json` 却无 entry，`knip` 会报"unused"→ 必须在 `knip.json` 里给 `packages/desktop` 一个**窄**条目。
- 另：`.gitignore` 无 `target/`（现无任何 Rust 忽略项）→ 不补则 `git status` 一片嘈杂，`no staged files` 纪律容易被破坏。`.gitignore` 同样不在 §6 清单。
- **需裁定**：§6 可改文件清单应加 `.prettierignore`、`eslint.config.mjs`（仅 ignores 段）、`.gitignore`、`vitest.config.ts`（仅当需要排除）。否则 AC-23 无法达成。

**A8 第三态未定义：端口被无关进程占用。** `daemon.json` 指向的端口 LISTEN，但 pid 不是文件里的 pid（或 pid 已死）。壳判"活"→ 复用 → webview 401；判"死"→ 拉起 → `EADDRINUSE`。建议 `Conflicted`：exit 非 0 + 一行"端口 x 已被其他程序占用"（AC-4/AC-16）。

**A9 `--smoke` 与窗口的互斥未写。** `--smoke` 是否也建窗口（"无窗口起来"）？若建窗口，CI/无头环境下 `NSApplication` 仍可起但不显示；建议明确"`--smoke` 不创建窗口、只走 daemon 生命周期"，并把"无窗口"作为 AC-9 的一条（用 `--smoke` 进程的窗口数 0；macOS 上无法直接读窗口数，靠"事件循环不进入 GUI 阶段"的实现约束 + 人读代码，标注为**弱断言**）。

**A10 `.dmg` 建议直接砍（见 §4 的 AC-8）。** 生成 `.dmg` 要 `create-dmg`/hdiutil 与额外时间，本卡非目标里也没有"分发"，价值低。

## 4. 对卡 §5 的修订建议（逐条）

| 卡 §5 | 建议 | 理由 |
|---|---|---|
| AC-1 | **改**：删"每条 `if` 都要有反例"（不可证伪：谁来数 `if`）。换成"矩阵 R 层每一行至少一条具名用例，命名 `ac<n>_<场景>`，`cargo test -- --list` 的输出全列贴进 `impl-M4.2.md`"，并要求模块清单（`daemon_file`/`url_build`/`redact`/`spawn_decision`/`child_registry`/`open_arg`/`shortcut`）逐个有模块 | 反例数量不可审计，命名清单可 `grep` |
| AC-2 | **补**：非 0 判据写死"exit ≠ 0 且 stderr ≤ 2 行且不含 48 字符 base64url"；要求 `--home` 注入临时目录 | 否则"人读一行"与"不打印 token"两条都不可断言（AC-10/AC-11） |
| AC-3 | **补/改**：加第三态"端口被无关进程占用 → `Conflicted`"与"`daemon.json` 的 pid 交叉核对"；"死端口"判据写死为"`connect` 被拒 或 pid 不存在" | 现写法只有两态，A4/A8 的状态没地方落 |
| AC-4 | **改**：把证据从"真机两次点击"改为**脚本化时序 + 具体 pid 断言**（贴 §2 AC-15 的命令），并把"用户手起"的构造写死为 `HOME=$H hr serve $H/a.html --port 8300 &`；断言 `kill -0 <P_u>` 与 `daemon.json.pid == P_u` | "真机证据"若不点名 pid，杀错也看不出来（本卡最关键的一条） |
| AC-5 | **改**：删"`token=…` `/healthz` 之外的 URL 不得出现明文 token"（口径含糊、且 `/healthz` 本来就不带 token）。改为"任何 ≥16 字符的 base64url 串不得出现在壳的 stdout/stderr 与 argv 中"+ 要求脱敏是**纯函数**并有单测（AC-3/AC-17） | "除 X 之外"式负断言无法穷举 |
| AC-6 | **改 + 降级**：改为 ①`--open` 参数 → 动作映射（Rust 单测，AC-6）②一次真进程 argv 证据；明确"Finder 双击注册不在本卡范围"（A5），并把"既有导入路径"点名 | 现写法把"LaunchServices 注册"这件本机不可回滚的事混进了 AC |
| AC-7 | **改**：机制化为"默认 accelerator 必含修饰键 且 ≠ `Escape`"+ `packages/desktop/accels.json` 单一真源 + 与 `keys.ts` 的对齐检查（需授权改 `packages/app/tests/**`，A6）；"注册失败"用"同进程重复注册"造，断言 warn 且不崩 | "不冲突"不可判，规则可判 |
| AC-8 | **改（收窄）**：删可选 `.dmg`（A10）；"能双击起"拆成三条可执行断言（产物存在 / 产物内二进制 `env -i PATH=/usr/bin:/bin --smoke` 的**两种**结果：有 `HREADER_HR` 时 exit 0、无时 exit 非 0 且一行错误 / `plutil -p` 见 `CFBundleDocumentTypes`）；Win/Linux 部分保留但加"CI matrix 必须有一次真跑的 run 链接，或明写未执行" | "双击能起"不可机检；"就位"要防"文本存在即绿" |
| AC-9 | **改**：保留"不进 verify"，但必须同时授权 `.prettierignore`/`eslint.config.mjs` ignores/`.gitignore` 三处新增（A7），否则不可达成 | 现 §6 清单缺它们 |
| AC-10 | **改**：`knip`/`depcruise` 的忽略项**窄**到 `src-tauri/target`、`src-tauri/gen`，禁止整包忽略 `packages/desktop`，且每条忽略带一行理由注释（人读条款） | 整包忽略 = 把将来的检查一起关掉 |
| 新 AC-25 | **加**：`git diff 02f2649 -- packages/core packages/app/src packages/cli/src packages/renderer-html docs` 为空 | 防 A1 被"偷偷改 core"绕过（协议变更必须显式记录） |

## 5. 变异清单（12 条；每条写"预期变红"）

| # | 偷懒/坏实现 | 改动落点 | 预期变红 |
|---|---|---|---|
| M1 | 不收拾子进程（只管窗口关闭） | 去掉 `Child::kill()`/`wait()`，只处理 window close | AC-14（SIGTERM 后端口仍 LISTEN）；AC-9（smoke 退出后 daemon 仍活） |
| M2 | 连用户手起的 daemon 一起杀 | `pkill -f "hr serve"` 或 kill `daemon.json.pid` 无条件 | AC-15（`P_u` 死）、AC-13②（外部 daemon 的 `daemon.json` 被改/删） |
| M3 | `daemon.json` 端口读错（读 `workspace` 长度？用默认 8123？） | `daemon_file.rs` 里 `info.port` → 常量 `DEFAULT_PORT` | AC-12（两次启动端口不一致）、AC-16（打到 `nc` 端口） |
| M4 | token 缺失仍导航 | 拼 URL 时 `token` 取 `unwrap_or("")` | AC-10 不会红（不失败）；**AC-20②** 的导航 URL 里 `t` 为空 → 人工层发现 401；故 **AC-2**（往返相等）与 **AC-17**（日志无 token 但 URL 里也无 token）要能抓 → AC-2 必须断言 token 段非空 |
| M5 | `.html` 参数被忽略 | `open_arg.rs` 恒返回 `NoAction` | AC-6（带参数的映射用例红） |
| M6 | `--smoke` 恒 exit 0 | `if smoke { exit(0) }` 或错误分支 `return Ok(())` | AC-10（`PATH=/nonexistent`、`nc` 占端口两例） |
| M7 | 快捷键注册失败静默 | `let _ = register(...)` 或 `?` 吞成 `unwrap_or_default()` | AC-7（注册失败 behave 用例：无 warn/或直接崩） |
| M8 | 重复拉起 daemon（不查残留） | `decide()` 恒 `Spawn`（跳过读文件/探活） | AC-12（第二次端口变）、AC-15（用户 daemon 被绕过 → 可观察到两个 daemon） |
| M9 | 日志脱敏只挡一种形态 | `replace(&format!("t={token}"), "t=***")` | AC-3（`#t=`/`&t=`/JSON/Debug 四形态全红）、AC-17（argv 泄漏另算） |
| M10 | 端口"活"就当复用（不核 pid） | `decide()` 只看 `probe == Open` → `Reuse` | AC-16（复用 `nc` → `/healthz` 非 200）、AC-4（第四态单测红） |
| M11 | 把 `packages/desktop` 整包塞进忽略清单 | `.prettierignore`/`knip.ignore` 加 `packages/desktop` | AC-23（"忽略项窄"人读条款 + `tauri.conf.json` 拼错不报）；CI 层无自动红 → **须人读**，故 AC-23 需同时贴出忽略清单的 diff |
| M12 | smoke 用真 HOME（污染用户环境） | 去掉 `--home` 注入，直接用 `$HOME` | AC-11（临时 HOME 检查红：`daemon.json` 出现在真 HOME / 与 `P_u` 冲突） |

## 6. 结论

**不能开工。** 缺 1 个协议裁定（**A1** bootstrap 认证链）、1 个打包运行时裁定（**A3** node/`hr` 解析）、3 处 lint/gitignore 写权限（**A7**：`.prettierignore`、`eslint.config.mjs` ignores、`.gitignore`）、1 处点名（**A5** "既有导入路径"），以及 **A2** 的"壳能起来"证据口径（`--smoke` 不够，需 + 导航 URL + 一次人工）。A1/A3 未裁定前，写者要么卡在 webview 401，要么越权改 `packages/core/src/server/routes.ts:66`。
