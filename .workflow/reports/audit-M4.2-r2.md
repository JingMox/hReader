I have no `write` tool available (read-only access), so the full artifact follows here for the runtime/coordinator to persist as `.workflow/reports/audit-M4.2-r2.md`.

---

```markdown
# M4.2 G2″ 定点复审（R1 返工后）· audit-M4.2-r2

审计员只读轮。范围：R1 的 diff 与新增物（卡 §7 七条），不重审 G1 已过部分。
判决：**CHANGES-NEEDED**（R1 七条本身 7/7 PASS；CHANGES-NEEDED 只因 P1-A —— 那是本卡 G1 遗留、非 R1 引入，见 Finding 1 的出处标注）。

---

## 1. 逐项判定（文件:行）

### ① W2 启动窗口（R1-P1）—— **PASS**

- `packages/cli/src/main.ts:12` `const launchParentPid = process.ppid;` 位于 `registerHooks`（`:8`）之后、唯一一个顶层 `await`（`:14 const { run } = await import("./run");`）之前，其上是类型导入与常量，**没有任何 await 在它前面**。注释 `:10-11` 与实现一致。
- 注入链：`main.ts:50 launchParentPid` → `run.ts:43 readonly launchParentPid?: number` → `run.ts:244 launchParentPid: io.launchParentPid ?? process.ppid` → `serve.ts:66` 只把该值交给 `parentWatchOf(...)`／`serve.ts:38-43` 的 `orphanedAtLaunch(input.launchParentPid)`。
- `packages/cli/src/parent-guard.ts:19 orphanedAtLaunch` 判 `ppid === 1`；`parent-gone` 侧 `parent-gone` 读活 ppid 的唯一实现在 `parent-guard.ts:27 readParentPid: () => process.ppid`，且只经 `parentWatchOf` 注入，符合"启动值只采集一次、活值每次重读"的设计。
- 失败退出：`serve.ts:38-43` 抛 `HrError("invalid_input", … ppid=${launchParentPid} …)`，**在 `startServer`（`:45`）之前**。
- **反例追问 1（第二条读 ppid 的路径）**：`grep -rn "process.ppid" packages/cli/src` 只有 `main.ts:12`、`run.ts:244`、`parent-guard.ts:27`（+ 两处注释 `parent-guard.ts:6,17`）。`run.ts:244` 的 `??` 兜底是第二条路 —— 见 Finding 2（P2）。
- **反例追问 2（Rust 侧第二次 spawn）**：`packages/desktop/src-tauri/src/window.rs` 内 `spawn|Command|serve` 零命中（只匹配到 `Modifier::` 行），`window::run` 不拉进程；唯一 spawn 点是 `supervisor.rs:107-123 Daemon::spawn`（参数表 `serve_args`，`supervisor.rs:232-240`），`--smoke` 走 `smoke.rs:55` 的同一条。**没有绕过注入值去另起 daemon 的第二条路。**（`Daemon::spawn` 是 `pub`，见 Finding 12 的 P3。）

### ② 失败退出不落 json —— **PASS**

- 写入点唯一：`packages/core/src/server/server.ts:291 await writeDaemonOf(info, options.home, deps.patch);`，在 `startServer` 体内、`armOf` 之后最后一步；`daemon.ts:66-87` 是"写 tmp → chmod 0600 → rename"的原子写，**没有"写了再删"的结构**。
- `serve.ts:38-43` 的拒绝发生在 `startServer` 调用（`serve.ts:45`）之前 ⇒ **抛错 ⇒ 根本没写过文件**，成立（不是先写后删）。
- 用例 `packages/cli/tests/units-parent-guard.test.ts:107-120` 断言 `existsSync(join(dir.home,".hreader","daemon.json")) === false` —— 真断言，非"文件存在"级。

### ③ M2 类型强制 —— **PASS**

- `signals.rs:15-17 pub struct SignalSubscription { _private: () }`，字段私有；构造器 `signals.rs:20 fn new()` **无 `pub`**（模块私有），`Default`/`Clone` 均未派发 ⇒ 模块外无法伪造，`grep -rn "SignalSubscription" packages/desktop/src-tauri/src` 的全部构造点都在 `signals.rs`（`:20`）自身。
- `lib.rs:196-201 connect_with(…, signals: signals::SignalSubscription)` **按值收**；`lib.rs:189 connect(…, subscription: signals::SignalSubscription)` 同上；`lib.rs:63 _signals: signals::SignalSubscription` 只持有（`:243 _signals: signals`）。
- **判定标准**：把 `signals::watch()` 挪到 `connect*` 之后 ⇒ 必须传一个 `SignalSubscription` 实参，而唯一来源是 `signals::watch()`；"先拿到 token 再 connect"与"connect 之后再 watch"互斥，**必然编译失败**。这条不 FAIL。

### ④ M6 R 层可观测 —— **PASS**

- 实现：`serve.ts:68-69 shouldWatchParent = (exitWithParent) => exitWithParent === true`；`serve.ts:62-65` 用三元把 `parentWatchOf(...)`／`undefined` 传给 `watchParent`；`serve.ts:74-84 watchParent` 在 `watch === undefined` 时**一个定时器都不建**（`:77`）。
- 变异（`shouldWatchParent` 恒 `true` + 定时器 `.unref()`）由**两条独立用例**杀：
  1. `units-parent-guard.test.ts:52-58 "should only be true for an explicit --exit-with-parent"` —— 恒 `true` 直接红（`expect(shouldWatchParent(undefined)).toBe(false)` 失败）；
  2. `units-parent-guard.test.ts:65-75 "should not install a poll timer without --exit-with-parent"` —— 只数"`call[1] === PARENT_POLL_MS` 的那只定时器"（`:60-61`），恒装 ⇒ `expect(pollTimers(spy)).toBe(0)` 红。这条**不受 `.unref()` 影响**（数的是 `setInterval` 调用次数，不是句柄存活），正是 G3′ M6b 缺的那条。
- 结论：G3′ §3.7 的洞已被补上；变异只会红在语义断言上，不再靠"进程被拖住"兜。（未真跑变异，见 §4。）

### ⑤ ICO 守门测试 —— **PASS（测试强度不足，见 Finding 4）**

- 文件存在：`packages/desktop/src-tauri/icons/icon.ico`（`git status` 未跟踪新增，`watchdog_diff` 列在 untracked）。
- 断言的是**字节结构**不是"文件存在"：`packages/desktop/src-tauri/src/lib.rs:345-352`，`include_bytes!("../icons/icon.ico")` → `assert_eq!(&bytes[..4], &[0,0,1,0])`（`:349`）+ `u16::from_le_bytes([bytes[4],bytes[5]])` 目录项数 `assert!(entries >= 4)`（`:350-351`）。是真守门人，不是假测试。
- `tauri.conf.json:18 "icon": ["icons/icon.icns","icons/icon.png","icons/icon.ico"]` ✅ 含 `.ico`。
- 不足：只断 `entries >= 4`，未钉四档尺寸/偏移（Finding 4，P3）。

### ⑥ GUI 脚本入库（G2′ P2）—— **PASS WITH NOTES**

- 仓根从脚本自身位置推：`scripts/gui/m4.2/lib.sh:7 REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)`，四个脚本都 `. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"`（`w1-signal-exit.sh:4`、`w2-parent-death.sh:4`、`w2-launch-window.sh:8`、`w7-default-home.sh:4`）。
- **零 `/Users/`**：`grep -rn "/tmp\|/Users/" scripts/gui` 无 `/Users/` 命中。
- token/pid **现读 daemon.json**：`lib.sh:33 field_of` 运行时 `python3 -c "json.load(...)"`，`w1-signal-exit.sh:20 daemon=$(field_of "$json" pid)`；`lib.sh:2` 注明"不打印 token"。
- `/tmp` 仍是**固定 scratch 根**（`w2-parent-death.sh:6 root=/tmp/hr-w2-parent`、`w2-launch-window.sh:14`、`w7-default-home.sh:7`、`w1-signal-exit.sh:7`），`lib.sh:17-21 make_dirs` 里 `rm -rf "$root"`；**这与 `impl-M4.2.md:212` "无 `/tmp` 硬编码（临时目录是运行时 `mktemp` 风格常量）"的说法不符** → Finding 5（P3，报告措辞）。
- verify 覆盖：`package.json:25 "verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm depcruise && pnpm knip"`；`.prettierignore` 全文只有 `node_modules/dist/coverage/pnpm-lock.yaml/.stryker-tmp/docs/.workflow/bad-json.json`，**没有排除 `scripts/gui`**；但 prettier 无 `.sh` parser、eslint 不认 shell、仓内无 shellcheck ⇒ `.sh` 事实上**不被任何门禁覆盖**（与 impl:212 自述一致，只是"覆盖"=0）→ Finding 7（P3）。
- 报告路径：R1 段（`impl-M4.2.md:127,146,162,212`）已用仓内路径；但 G1 段 `:22,27,32,37,63,112` 仍写 `/tmp/hr-gui/*.sh` → Finding 6（P3）。

### ⑦ `default_home()` 回退（G2′ P3）—— **PASS**

- `lib.rs:292-295 default_home()` → `user_home(HOME, USERPROFILE)`；`lib.rs:297-304 user_home`：`home.or(userprofile)`，`Some(dir) if !dir.is_empty()` 才用，否则 `Err("找不到用户目录：HOME 与 USERPROFILE 都没设…")`。**无 `PathBuf::from(".")`**（只有 `lib.rs:129` 的 cwd 兜底 `.`，那是 workspace，不是 home）。
- 单测注入 `USERPROFILE`：`lib.rs:329-336 r1_default_home_falls_back_to_userprofile_when_home_is_missing`（`user_home(None, Some(OsString::from("C:/Users/win")))`）；另 `lib.rs:338-343` 断 `Err` 且错误文本含 `USERPROFILE`。
- `run()` 处置：`lib.rs:130-135 match default_home() { Ok(home) => home, Err(reason) => { eprintln!("{reason}"); return 1; } }` —— **没被 `unwrap_or_default()` 吃掉**，失败即退出码 1。

### ⑧ 信号注册失败回滚（G2′ P3）—— **PASS（两处 P3，见 Finding 3）**

- `signals.rs:60-71 watch_with`：`WATCHED.swap(true)`（`:61`）先占位；循环内**每条 `Err` 路径**都先 `WATCHED.store(false)`（`:66`）再 `return Err(reason)` —— 包括"SIGTERM 成功、SIGINT 失败"的部分成功（`for signal in [SIGTERM, SIGINT]` 的第二轮走同一分支），**回滚无遗漏**。
- 幂等：`WATCHED.swap(true)` 为真时直接 `Ok(new())`（`:61-63`），不重复注册。
- `eprintln!` 只打一次？**否**：`signals.rs:53` 在 `watch()` 的 `Err` 分支里，每次失败调用各打一遍；`hold()` 路径 `watch()` 被调 3 次（`lib.rs:151`、`:169`、`:176`），注册持续失败时会打 3 行 → Finding 3（P3）。
- 失败返回的 token 与成功时**行为完全一致**（同一个 `SignalSubscription::new()`，`:54`）：这是有意设计（注释 `:51-52` "不阻断启动"），但它意味着 `connect_with` 的类型保证只覆盖**调用顺序**，不覆盖**真装上了**（`lib.rs:184-185,195-196` 的措辞"拿到它的唯一办法是先 watch()"是准确的，但"已装"不可证）→ 同 Finding 3。

---

## 2. R1 测试质量逐条判定

| 用例 | 文件:行 | 判定 |
|---|---|---|
| should stay alive while the parent pid is unchanged | `units-parent-guard.test.ts:21-23` | 真（纯函数正控） |
| should notice a re-parented process / any other ppid change | `units-parent-guard.test.ts:25-31` | 真 |
| should read ppid on every poll, not cache it | `units-parent-guard.test.ts:33-38` | **弱**：只调一次 `parentGone`、断 `toHaveBeenCalledTimes(1)`；在 `parentGone` 内部缓存的实现照样绿 → Finding 8 |
| should call a ppid of 1 an orphan | `units-parent-guard.test.ts:41-46` | 真 |
| parentWatchOf carries injected pid + live ppid | `units-parent-guard.test.ts:49-55` | 真（`readParentPid() === process.ppid` 钉住注入口） |
| should only be true for an explicit --exit-with-parent | `units-parent-guard.test.ts:52-58` | 真（M6 变异的口） |
| **不装定时器**（`exitWithParent` 关） | `units-parent-guard.test.ts:65-75` | **真接线测试**：`vi.spyOn(globalThis,"setInterval")` + 只数 `PARENT_POLL_MS` 那只，断 0 |
| **装定时器一次**（`exitWithParent` 开） | `units-parent-guard.test.ts:81-95` | 真，但**泄漏**：真定时器、无 fake timer、永不 `clearInterval` → 1s 间隔跑完整个 worker → Finding 11 |
| 拒绝启动 + home 里无 daemon.json | `units-parent-guard.test.ts:107-120` | 真（断 `rejects.toThrow(/ppid=1/)` + 文件不存在） |
| 旗标关时 ppid=1 仍启动 | `units-parent-guard.test.ts:122-…` | 真 |
| should report its real pid | `units-serve-parent.test.ts:17-29` | **弱/重言**：断 `"pid":${process.pid}`，那是 core 在 `server.ts:288` 回显 `process.pid`，与看门狗无关 → Finding 9 |
| should leave the daemon running while the parent is unchanged | `units-serve-parent.test.ts:35-45` | **半重言**：`parentGone(parentWatchOf(process.ppid))` 已在 `units-parent-guard.test.ts:21` 断过；此条真正有信息量的是 `daemon.json` 存在 → Finding 10 |
| should clean up on stop exactly like the default path | `units-serve-parent.test.ts:47-58` | 真但**重复** `units-serve.test.ts:46-58`；且**看不见"定时器没被回收"**（vitest worker 不会因残留 interval 而挂）→ 正是 P1-A 的盲区 |
| run · 从 argv 到看门狗 | `units-serve-parent.test.ts:61-96` | 真（走 `run()` 全链，断 `code===0`、`"port":`、json 已删） |
| `--home` 写到 `--home` 不写 `$HOME` / 不存在的 `--home` 报 usage | `units-serve.test.ts:207-260`（新增 `runServeHome`） | 真（两条都断文件落点差异 + `EXIT_USAGE` + 错误文本） |
| `--home` 解析 | `units-args-serve.test.ts:75-92` | 真（`parse` 全量 `toEqual`） |
| accels.json × keys.ts 交叉 | `packages/app/tests/accels-cross.test.ts:92-152` | 真：走真 `intentOf`/真 `accels.json`，且末尾 `:145-151` 有**谓词正控**（`Shift+K` 必红、`CmdOrCtrl+Shift+H` 必绿）。自述局限（`:15-17` 只证短路不证碰撞）诚实。 |

**没有任何一条是"断言等于实现"的纯镜像测试**；扣分项集中在"测了纯函数没测接线"（上表 2 条）与"泄漏"（1 条）。

---

## 3. Findings

### P1

**Finding 1（P1）· 父进程看门狗定时器永不回收 ⇒ `--exit-with-parent` 的 daemon 收到 SIGTERM 后不会自己退出**
- 位置：`packages/cli/src/commands/serve.ts:74-84`（`watchParent`，`clearInterval` 只在 `:80` 的 parentGone 分支里），配合 `:58-60 void input.stop.then(async () => { await running.close(); })` —— stop 路径**从不碰定时器**。
- 证据链：① `serve.ts:73` 的注释自述"关完服务就清掉定时器——事件循环随即排空，进程自己退出"，实现与之矛盾（契约矛盾，可静态判定）；② `packages/core/src/server/server.ts:233-241 closerOf` 只 `close`+`removeDaemonOf`，**无 `process.exit`**；③ 1s interval 无 `.unref()`（对照仓内约定：`core/src/server/hub.ts:120-123` 的心跳就 `unref()`），故 stop 后事件循环非空 ⇒ 进程存活；④ 桌面壳恰好掩盖了它：`supervisor.rs:150-174 Drop` 先 `kill -TERM`、等 2s、再 `child.kill()`（SIGKILL）⇒ W1 的 `daemon_alive=no` 是**被 SIGKILL**，不是自己退；⑤ 真实用户路径 `hr serve --exit-with-parent` 在终端里 Ctrl-C，父进程（终端 shell）还活着 ⇒ **永久挂住**；⑥ R 层看不见：`units-serve-parent.test.ts:47-58` 只断 json 删除；`scripts/gui/m4.2/w1-signal-exit.sh:28-30` 也区分不出"自己退"与"被 SIGKILL"。
- 出处标注：`watchParent` 的形状来自 G1（非 R1 引入），但 R1-P2/M6 把它变成了本轮主题且没给回收契约，故本轮带走。
- 最小修法：
  ```ts
  // serve.ts
  export const watchParent = (
    watch: ParentWatch | undefined,
    running: { readonly close: () => Promise<void> },
  ): (() => void) => {
    if (watch === undefined) return () => undefined;
    const timer = setInterval(() => { if (!parentGone(watch)) return; clearInterval(timer); void running.close(); }, PARENT_POLL_MS);
    return () => { clearInterval(timer); };
  };
  // serveCommand:
  const stopWatching = watchParent(shouldWatchParent(input.exitWithParent) ? parentWatchOf(input.launchParentPid) : undefined, running);
  void input.stop.then(async () => { stopWatching(); await running.close(); });
  ```
  附带（可选，与 `hub.ts:123` 同口径）给该定时器 `.unref()`；并补用例：`vi.useFakeTimers()`，装看门狗 → `stop()` → `await settle()` → `expect(vi.getTimerCount()).toBe(0)`（或 spy `clearInterval` 被调一次）。

### P2

**Finding 2（P2）· `run.ts:244` 的 `io.launchParentPid ?? process.ppid` 是绕过 R1-P1 采集时机的第二条路**
- 位置：`packages/cli/src/run.ts:43`（`readonly launchParentPid?: number`）+ `packages/cli/src/run.ts:244`。
- 证据：生产入口唯一（`packages/cli/package.json:7-9 "bin": { "hr": "./src/main.ts" }`），所以今天这条兜底是惰性的；但任何**新的 io 构造点**（测试已经在用：`units-serve-parent.test.ts:84-95` 的 `run(...)` 就没传 `launchParentPid`）都会在 `await` 之后才读 `process.ppid`，把 R1-P1 刚堵上的 W2 洞原样重开，且**无任何测试会红**。
- 最小修法：把 `ResolvedIo.launchParentPid` 改成**必填** `readonly launchParentPid: number`，删掉 `?? process.ppid`（`run.ts:244` 直接 `launchParentPid: io.launchParentPid`）；测试里显式 `launchParentPid: process.ppid`（`serveInputOf` 已有先例，`serve-helpers.ts:64`）。这样"晚读"在类型层不可写。

### P3

**Finding 3（P3）· 注册失败的告警会重复打、且 token 无法区分"装上了"与"没装上"**
- 位置：`packages/desktop/src-tauri/src/signals.rs:48-57`（`eprintln!` 在 `:53`，失败仍返回 `new()` 在 `:54`）；调用点 `lib.rs:151`、`:169`、`:176`（`hold()` 路径共 3 次）。
- 证据：`watch_with` 失败时 `WATCHED` 被回滚成 `false`（`signals.rs:66`）⇒ 下一次 `watch()` 会**重新尝试注册并再打一行**：`--hold` 下注册持续失败 ⇒ 3 行 stderr，且 SIGTERM 处理器可能被装两遍（`mark_stopped` 幂等，故无害，但与"只打一次"的卡面要求不符；`:51-52` 的注释只承诺"不阻断启动"）。
- 最小修法：加 `static ANNOUNCED: AtomicBool`（或 `FAILED`）：失败时 `if !ANNOUNCED.swap(true, SeqCst) { eprintln!(...) }`，并在 `watch()` 开头 `if FAILED.load() { return new() }`（不再重试、不再重复注册）；同时给 `SignalSubscription` 加 `pub fn installed(&self) -> bool`（失败时 `false`），让 W1 的证据行能断言"信号真装上了"，而不只靠注释。

**Finding 4（P3）· ICO 守门测试强度不够（`entries >= 4` 无法证明"真四档"）**
- 位置：`packages/desktop/src-tauri/src/lib.rs:349-351`。
- 证据：只校验 6 字节头 + 目录项计数 `>= 4`；一个 6 字节文件写个假计数也能过；卡 §7 要求的是 **16/32/48/256 四档**，并未被钉；也未校验每个目录项的 `bytesInRes/offset` 落在文件内。
- 最小修法：`assert_eq!(entries, 4)`；再取 `bytes[6..6+16*4]` 逐项断 `width/height == [16,32,48,0]`（ICO 里 0 表示 256）与 `offset + size <= bytes.len()`。

**Finding 5（P3）· `impl-M4.2.md:212` 关于 `/tmp` 的自述与实际不符**
- 证据：报告写"无 `/tmp` 硬编码（临时目录是运行时 `mktemp` 风格常量）"，实际 `scripts/gui/m4.2/w2-parent-death.sh:6 root=/tmp/hr-w2-parent`、`w2-launch-window.sh:14 root="/tmp/hr-w2-launch-$delay"`、`w7-default-home.sh:7`、`w1-signal-exit.sh:7` 都是**固定常量**，并由 `lib.sh:17-21 make_dirs` 里 `rm -rf "$root"` 重建。
- 最小修法（二选一）：脚本改 `root=$(mktemp -d "${TMPDIR:-/tmp}/hr-w1-term.XXXXXX")` 并 echo 路径；或把报告改成"固定的 `/tmp/<name>` scratch 根，脚本开头 `rm -rf` 重建；仓根由 `BASH_SOURCE` 上溯三级推出，无机器相关绝对路径"。顺带消除同名 root 的并发/重跑互踩。

**Finding 6（P3）· 报告 G1 段仍引用 `/tmp/hr-gui/*.sh`**
- 位置：`impl-M4.2.md:22,27,32,37,63,112`（R1 段 `:127,146,162,212` 已是仓内路径）。
- 最小修法：在 `:22` 处加一句"（脚本现址：`scripts/gui/m4.2/w1-signal-exit.sh` 等；下文 `/tmp/hr-gui/*` 为 G1 当轮执行位置）"，其余不动。

**Finding 7（P3）· `scripts/gui/**/*.sh` 不被任何门禁覆盖**
- 证据：`package.json:25` 的 `verify` 七步里没有 shell 检查；prettier 无 `.sh` parser；仓内无 shellcheck；`.prettierignore` 未排除（也没用）。
- 最小修法：`verify` 前置一步 `bash -n` 逐个脚本语法检查（零依赖），或加 `shellcheck scripts/gui/**/*.sh` 到 `lint`。

**Finding 8（P3）· `units-parent-guard.test.ts:33-38` 名不副实**
- 证据：用例名"read ppid on every poll"，实际只调 `parentGone` 一次、断调用次数 1；把 ppid 缓存进 `parentGone` 内部的实现照样绿。
- 最小修法：`const read = vi.fn().mockReturnValueOnce(4321).mockReturnValueOnce(4321).mockReturnValueOnce(1);`，调 `parentGone` 三次，断 `toHaveBeenCalledTimes(3)` 且第三次结果翻转。

**Finding 9（P3）· `units-serve-parent.test.ts:17-29` 断的是 core 的回显**
- 证据：`"pid":${process.pid}` 来自 `packages/core/src/server/server.ts:288 pid: process.pid`，与看门狗无关。
- 最小修法：改成断"看门狗用的 pid 就是真 pid"：spy `setInterval` 后取 `parentWatchOf` 的 `parentPid === process.ppid`（或直接删掉，`units-parent-guard.test.ts:81-95` 已覆盖安装）。

**Finding 10（P3）· `units-serve-parent.test.ts:35-45` 半重言**
- 证据：`expect(parentGone(parentWatchOf(process.ppid))).toBe(false)` 与 `units-parent-guard.test.ts:21` 同义；真正有信息量的只有 `daemon.json` 存在这条。
- 最小修法：把第一条断言换成"看门狗已装且推进 3 个周期后 `running.close` 未被调用"（fake timers + spy close），这才钉住"父没变就不关"。

**Finding 11（P3）· `units-parent-guard.test.ts:81-95` 泄漏一个永不回收的 1s 定时器**
- 证据：真定时器、`process.ppid` 真活着 ⇒ `parentGone` 永假 ⇒ `clearInterval`（`serve.ts:80`）永不执行；该 interval 陪跑整个 vitest worker，污染后续用例。
- 最小修法：`vi.useFakeTimers()` + 末尾 `vi.clearAllTimers()/vi.useRealTimers()`；P1-A 修好后用返回的 disposer 显式关掉。

**Finding 12（P3）· M2 的类型闸只盖住 `connect_with`，`Daemon::spawn` 仍是 `pub`**
- 位置：`packages/desktop/src-tauri/src/supervisor.rs:107-123`（`pub fn spawn(…)`），`smoke.rs:55` 直接调。
- 最小修法：给 `Daemon::spawn` 加一个 `#[cfg(test)]`/`pub(crate)` 约束，或让它也收一个 `&SignalSubscription`；至少注释说明"绕过 connect 的 spawn 不受 M2 保护"。

**Finding 13（P3）· `lib.rs:147-150` 同一段注释重复两遍**
- 证据：`:147-148` 与 `:149-150` 文字重复（`:150` 换了句尾"…类型上的说法是 `connect_with` 必须收下这个 token"）。
- 最小修法：删掉 `:147-148` 或 `:149-150` 其中一份，保留带类型说明的那份。

---

## 4. 未执行清单（我不做的，协调者自己复算）

- `cargo test` / `cargo fmt --check` / `cargo clippy` / `pnpm desktop:check` —— **一次都没跑**。本报告中所有 Rust 结论均为**静态读源**（`lib.rs`、`signals.rs`、`supervisor.rs`、`window.rs`、`tauri.conf.json`）。
- `cargo check --target x86_64-pc-windows-msvc` —— 未跑（本机无 windows target，G3′ 已证该路径曾被 `icon.ico` 挡住）。
- `pnpm verify` / `pnpm test` / `vitest` —— 未跑。impl 声称的 `264 files / 2966 tests`、两遍 `EXIT=0` 我**未复算**，不背书。
- 变异执行 —— 未做。④ 的判定是**静态推导**（指出 `units-parent-guard.test.ts:52-58` 与 `:65-75` 会红），不是实测；M2/M6b 的变异结果我未重跑。
- `icon.ico` 的字节级复算 —— **未做**：我只有只读文本工具，无法逐字节解析二进制；"四档"目前只有 (a) impl 的自述 `entries=4`、(b) `lib.rs:349-351` 会在 `cargo test` 时真实读到它。**这一项需要协调者用 `xxd -l 64` 或跑一次 `cargo test` 落实。**
- 真机 GUI（`scripts/gui/m4.2/*.sh` 实际执行、`tauri build` 打的 `.app`）—— 未跑；脚本只做了静态阅读。
- Finding 1 的"Ctrl-C 后进程挂住"未做真机复现（我给的是源码级推导 + core 无 `process.exit` 的反证）。
- `git diff`/`commit` 级检查 —— 只用 `watchdog_diff`（未提交改动 + untracked），**没有**审阅任何已提交区间。
```

---

## 结论摘要（判决 + P 级别清单）

**判决：CHANGES-NEEDED**（R1 七条 7/7 PASS；判 CHANGES 只因 P1-A）。

- ① W2 采集时机 `main.ts:12` 真在首个 `await` 前 ✅；Rust 侧无第二次 spawn ✅。
- ② 失败退出不落 json：写入点 `core/server.ts:291` 在 `startServer` 内，拒绝在 `serve.ts:38-43` 之前 ✅。
- ③ `SignalSubscription` 模块外不可伪造（`signals.rs:17,20`），`connect_with` 按值收 ✅ ⇒ "watch 放 connect 之后"必然编译失败。
- ④ 恒 `true`+`.unref()` 变异由 `units-parent-guard.test.ts:52-58` 与 `:65-75` 双杀 ✅。
- ⑤ ICO 守门测试断字节头+目录项（真测试），但 `>=4` 太松（P3-4）。
- ⑥ 脚本无 `/Users/`、仓根自推、pid 现读 ✅；但 `/tmp` 固定根与 `impl:212` 自述矛盾（P3-5），G1 段仍引 `/tmp`（P3-6），`.sh` 无门禁（P3-7）。
- ⑦ `HOME→USERPROFILE→Err`、无 `"."`、`run()` 不吃掉错误 ✅。
- ⑧ 回滚覆盖每条 `Err` 路径 ✅；`eprintln` 会重复、token 不区分装没装（P3-3）。

**P1**：父进程看门狗定时器永不回收 ⇒ `hr serve --exit-with-parent` 收到 SIGTERM 后不退出（`serve.ts:74-84` + `:58-60`，G1 遗留）。
**P2**：`run.ts:244` 的 `?? process.ppid` 是绕过 W2 采集时机的第二条路。
**P3**：3/4/5/6/7/8/9/10/11/12/13（共 11 条，每条含修法）。
**未执行**：所有 `cargo`/`pnpm`/变异/真机/Windows 构建，以及 `icon.ico` 字节级复算 —— 数字请协调者自己复算，我不为 impl 的数字背书。