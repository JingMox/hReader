# M4.2 G2‴ 终审报告（R3 返工后）

> 审计对象：工作区未提交改动（`watchdog_diff --stat` 24 文件 +44 处 untracked，含 `packages/cli/src/parent-guard.ts`、`packages/cli/src/run-serve.ts`、`packages/desktop/src-tauri/src/*`）。只读；未改、未 commit。**本环境无 write 工具，本报告整篇在回复中，请协作者落盘到 `.workflow/reports/audit-M4.2-r3.md`。**

---

## 一、逐项判定

### 1. P1-A 修复的完整性（`packages/cli/src/commands/serve.ts`）—— PASS（附两条保留）

`watchParent` 共 3 条出口，逐条查：

| 出口 | 位置 | 清定时器 | 备注 |
| --- | --- | --- | --- |
| `watch === undefined`（默认路径/无 `--exit-with-parent`） | `serve.ts:92`（`return nothingToDispose`，`serve.ts:71-72` 定义） | 无定时器可清 | 正确：默认一个 timer 都不建 |
| parentGone 分支 | `serve.ts:85-88`：`clearInterval(timer); void running.close();` | ✅ 先清再 close | 自清，无需 disposer 也能停 |
| disposer（stop 路径） | `serve.ts:91-93` 返回闭包；调用点 `serve.ts:61-64` `disposeWatch(); await running.close();` | ✅ | 顺序对：先撤再关 |

- **异常路径**：`disposeWatch()` 只是 `clearInterval`（`serve.ts:92`），不可能抛；`running.close()` 抛错时 disposer **已经执行完毕**（`serve.ts:62` 在 `:63` 之前），所以"close 失败→定时器残留→进程赖着"这条不成立。
- 启动期孤儿闸 `serve.ts:36-41`（`orphanedAtLaunch(launchParentPid)`，`parent-guard.ts:20`）在 `startServer` 之前抛 `HrError("invalid_input")` → 不建服务、不写 `daemon.json`。✅

**两道防线各自守什么（分开判，这是本题的核心）：**

- **删 disposer（保留 `unref`）**：仍能退出。① 父进程已死场景，下一秒 parentGone 分支自己 `clearInterval`（`serve.ts:86`）；② 父进程仍活但 daemon 收 SIGTERM 场景，定时器永不自清，但 `unref()` 让它不吊住事件循环 → 也能退。代价：关闭后最多多跑一次 `running.close()`（`serve.ts:87`），产生重复关闭/噪音。**所以 disposer 对"能不能退"不是必要条件，它对"关完之后不再触发第二次 close、以及在 close 进行中不再有 tick"是必要条件。**
- **删 `unref`（保留 disposer）**：正常路径（stop 兑现、或 parentGone 触发）仍能退；但一旦某条路径既没走到 disposer 也没让 parentGone 变真（例如将来有调用点忘了 `disposeWatch`），事件循环就永久有活干。`unref` 是**不依赖任何调用点自觉**的那道保险。
- 结论：两者**互为兜底且互补**，不是"unref 兜着、disposer 是装饰"——反过来也不是。删任一条，**没有任何** TS 用例会红（见 Finding 3，这是真实的断言缺口，而非代码缺陷）。

### 2. `run-serve.ts` 拆分是否丢接线 —— PASS

`serveCommandOf`（`run-serve.ts:24-44`）逐字段对照旧 `run.ts` serve 分支：

| 字段 | 来源 | 覆盖 |
| --- | --- | --- |
| `file` / `workspace` | 形参 `paths`（`run-serve.ts:27`、`:37-38`），上游 `run.ts:226` 用 `withinWorkspace(...)` 真路径化 | ✅ |
| `port` | `intent.port`（`:39`） | ✅ |
| `home` | `wiring.home`（`:40`）；`run.ts:232` 已把它归一为 `intent.home === undefined ? io.home : homeRealpathOf(intent.home)` | ✅ |
| `appDir` | `:41` 条件展开（`undefined` 时不传键） | ✅ |
| `json` | `:42` | ✅ |
| `allowHosts` | `:43` | ✅ |
| `stop` | `:44`（`wiring.stop`） | ✅ |
| `exitWithParent` | `:45` | ✅ |
| `launchParentPid` | `:46`（`wiring.launchParentPid`，无兜底，注释 `run-serve.ts:16` 明确禁止晚读 `process.ppid`） | ✅ |

- `--app-dir` 存在性校验唯一一份：`run-serve.ts:27-29`（`existsSync`），`commands/serve.ts` 里没有第二份 ✅。
- **没有新造重复**：`run.ts` 只剩分发（`runServe`，`run.ts:226-236`）+ 与 patch/pdf/png 共用的 `withinWorkspace`/`homeRealpathOf`；`ServeInput` 组装只在 `run-serve.ts` 一处。✅

### 3. P2 类型闸 —— PASS

- `launchParentPid` 在 `CliIo` 上**必填**（`packages/cli/src/run.ts:41-46`，字段无 `?`），所以每个构造点都必须显式给值；`ResolvedIo`（`run.ts:184-189`）只补 `env/stop/home`，不碰它 —— 正确，它不该有默认值。
- `grep -rn "process.ppid" packages/cli/src` 结果：`src/run.ts:44`（注释）、`src/run-serve.ts:16`（注释）、`src/parent-guard.ts:6`/`:17`（注释）、**`src/main.ts:12`（唯一的生产读点，在任何 `await` 之前）**、**`src/parent-guard.ts:27`（`readParentPid: () => process.ppid`，这是"轮询读当前 ppid"，语义正确）**。`?? process.ppid` 兜底**已彻底消失** ✅。
- 测试侧 14 处构造点全部显式 `launchParentPid: process.ppid`（如 `tests/serve-helpers.ts:70`、`units-serve-parent.test.ts:69`、`units-undo.test.ts:31` …）。`grep -rn "as unknown as\|as CliIo" packages/cli/tests` **零命中** —— 没有靠断言硬过。✅

### 4. `signals.rs` 的 FAILED / ANNOUNCED / `installed()` —— PASS（1 条 API 面备注）

- 不重试：短路在 `signals.rs:76-78`（`if FAILED.load { return Err("信号处理器此前已注册失败，不再重试") }`），位置在 `watch_with` 内、`WATCHED.swap` **之前**（`:79`），所以失败态压过"已装"态；置位在 `:85`，并且 `WATCHED.store(false)` 回滚在 `:84`。用例 `r3_register_failure_rolls_back_and_is_not_retried`（`signals.rs:172-196`）第二次传入的是 `panic!` 的 registrar → 真会红。✅
- stderr 只一行：`ANNOUNCED.swap(true, SeqCst)` 一次判定（`signals.rs:63`），`eprintln!` 在 `:64-66`。4 个调用点全部经由 `watch()`：`lib.rs:149`（`run()` 之前）、`lib.rs:167`（`hold` 的 `connect` 实参）、`lib.rs:174`（`hold` 内），外加 `window.rs:37`（任务书给的 `:151/:169/:176` 是 R3 前的行号，现漂到 `:149/:167/:174`；第 4 个调用点在 `window.rs:37`）。四处都走 `platform::watch()` → 同一把 `ANNOUNCED`，最多一行。✅
- `installed()` 被真断言用到：`signals.rs:200`（`assert!(watch().installed(), …)`）与 `:205`（`watch_with(failing)` 断言 false）。**不是死 API**，但生产代码从不读它（`lib.rs:149` 拿 `_before_connect` 只为消费 token）—— 它是"只为测试的 API"。knip 不管 Rust 属实，但 `cargo test` 会因它缺失而编译失败（`:200` 引用），所以不会静默腐烂。P3-A 备注成立但不阻塞。

### 5. ICO 测试强度 —— **不足**（见 Finding 1）

`lib.rs:367-386`：`assert_eq!(&bytes[..4], &[0,0,1,0])`（`:370`）、`assert_eq!(entries, 4)`（`:372`）、逐项 `[(16,16),(32,32),(48,48),(0,0)]`（`:374-381`）、`end = offset+size <= bytes.len()`（`:382-385`）。三样齐全 ✅，但整体**可被伪造**。

**伪造需要什么**：`bytes[..4]=00 00 01 00`、`bytes[4..6]=04 00`、4 条目录项各 16 字节（宽高按 16/32/48/0/0、`size=0`、`offset=0`）→ **总共 70 字节即可全过**（`end = 0+0 = 0 <= 70`）。伪造代价（70 字节手写）**远小于**真文件，因此**不满足"代价 ≥ 真文件"的 PASS 条件**。真实 `icons/icon.ico` 现在是对的（`cargo`/`tauri-build` 都在用），所以是**判据强度**问题，不是产物问题。

### 6. `lint:sh` 是否真能抓错 —— **不能**（P1，见 Finding 2）

- 脚本：`package.json:19` `"lint:sh": "find scripts/gui -name '*.sh' -exec bash -n {} +"`。
- **不是"通配展开成空集"那个漏洞**（`find` 自己展开，空集也不会静默——`scripts/gui` 不存在时 `find` 退出非 0）。真漏洞是 `-exec … +`：`bash -n f1 f2 f3 …` 里 `bash` 只把**第一个 operand 当脚本**解析，其余作为该脚本的**位置参数**（POSIX `sh` 的 `command_file [argument...]` 语义）。`scripts/gui/m4.2/` 现有 5 个 `.sh`（`lib.sh`、`w1-signal-exit.sh`、`w2-parent-death.sh`、`w2-launch-window.sh`、`w7-default-home.sh`），**只有 `find` 命中的那一个真被语法检查**，其余 4 个是赤裸的。
- 全覆盖：❌。位置：✅（`verify` = `package.json:20`，位在 `format:check && lint` 之后、`typecheck` 之前，位置合适）。
- 复现（交协调者跑）：给 `scripts/gui/m4.2/w1-signal-exit.sh` 末尾加一行 `if then fi`，`pnpm lint:sh` 仍 **EXIT=0**。

### 7. `mktemp_root` —— PASS（1 条 P3）

`lib.sh:19`：`mktemp_root() { mktemp -d "${TMPDIR:-/tmp}/$1.XXXXXX"; }` —— **真 `mktemp -d`**，带唯一后缀（并发安全，修掉了 R2 的固定目录碰撞）。清理：**故意不清理**，`lib.sh:20` 就写着"每次跑完由调用方自己留着看，脚本不清理" —— 自述与实现一致。失败留垃圾：`mktemp` 失败时返回空串，`mkdir` 也没建成，**不产生垃圾目录**（但会产生别的危害，见 Finding 5）。`impl-M4.2.md` 关于"无 `/tmp` 硬编码"的措辞略有出入（`lib.sh:19` 里 `/tmp` 作为 `${TMPDIR:-/tmp}` 的兜底默认值存在），属可接受的自述精度问题，归入 Finding 4。

### 8. R3 新增/改动用例质量（逐条判真/假）

| 用例 | 位置 | 判据：删掉对应实现行会不会红 | 判 |
| --- | --- | --- | --- |
| `watchParent · disposer > should leave no timer behind` | `units-parent-guard.test.ts:209-225`，`vi.getTimerCount()` `1`（`:218`）→`0`（`:223`） | 删 `serve.ts:92` 的 `clearInterval(timer)` → 仍是 1 → **红** ✅ | 真 |
| 同上 `> should hand back a no-op when the flag is off` | `units-parent-guard.test.ts:227-232` | 删 `serve.ts:92` 的 `return nothingToDispose` 分支（改成无条件建 timer）→ 1≠0 → **红** ✅ | 真 |
| `serveCommand · stop 撤回看门狗` | 实际落在 `units-serve-parent.test.ts:36-51`，经 `serve-helpers.ts:89-94` 的 `clearSpy` + `pollTimerOf`（`serve-helpers.ts:80-86` 按 `PARENT_POLL_MS` 认 id），断言 `clearSpy.mock.calls.some(call => call[0] === timer)`（`:49`） | 删 `serve.ts:62` 的 `disposeWatch()` → 没有任何 `clearInterval(看门狗 id)` → **红** ✅。`units-serve.test.ts` 里没有 `clearInterval`/该 describe 名（`grep` 零命中），任务书描述的用例实际在 `units-serve-parent.test.ts` | 真（位置需在报告/清单里对齐） |
| `units-serve-parent.test.ts:36 > should clean up on stop exactly like the default path` | `:41-49` | 它**不是**"只加定时器断言"：`daemon.json` 消失（`:44-46`，`existsSync` 轮询）**仍在**，新断言是**追加**的第二条。删 `running.close()`（`serve.ts:63`）→ 文件不消失 → 红；删 `disposeWatch()` → `clearSpy` 断言红。两条各自独立可红 ✅ | 真 |
| `units-run-home.test.ts:44-62 > should write daemon.json under the injected home` | 注入 `home`（`units-run-home.test.ts:28-31`、`:45`），断言"出现在注入 home 下"（`:52-55`）+"stop 后消失"（`:57`） | 把 `run.ts:189` 的 `home: io.home ?? homedir()` 改回 `homedir()` → 文件落进真实 `~/.hreader`，`appeared` 为 false → **红** ✅（但失败模式有破坏性，见 Finding 6） | 真 |
| `smoke.rs` 在 `Daemon::spawn` 收 `pub(crate)` 后是否还能调 | `smoke.rs:15` `use crate::supervisor::{Daemon, …}`；`smoke.rs:55` `Daemon::spawn(` | 静态判断：`pub(crate)` 对**整个 crate** 可见，`smoke` 是 crate 根的子模块（`lib.rs` 内 `mod smoke`），**可见性足够，能编译** ✅（`pub struct Daemon` 本身未被收窄） | 真（静态） |

唯一需要点名的弱项：**`timer.unref()`（`serve.ts:90`）零覆盖**——`units-parent-guard.test.ts:211` 用 `withFakeTimers`，fake timer 下 `unref` 是空操作，`getTimerCount()` 也看不见 ref 状态。见 Finding 3。

### 9. 回归风险面 —— PASS

- stop 顺序：`serve.ts:61-64` 由 `await running.close()` 改为 `disposeWatch(); await running.close();`。`daemon.json` 的删除发生在 `running.close()` 内部（core 的 `closerOf`），`disposeWatch` 只做 `clearInterval`，**不触碰文件、不改时序**——顺序变化对删除时机无影响 ✅。
- `SIGINT` 与 `SIGTERM`：`main.ts:31-40` 两个 `process.once` 解同一个 promise，`stop` 单一，`serve.ts:61` 只有一个 `.then` → **同一路径** ✅；`once` 保证不会二次兑现。
- 潜在语义差异：原来"最多 1s 内 parentGone 还能补一次 close"，现在 stop 一到就撤 timer —— 但这正是要的（不再有 close 之后的 tick），且 parentGone 分支自身仍会先清再 close（`serve.ts:85-86`）✅。

---

## 二、Findings

### P0
无。

### P1

**F2 · `lint:sh` 对 5 个 GUI 脚本只校验了 1 个（假门禁，且实现报告声称已全覆盖）**
- 位置：`package.json:19`；被守对象 `scripts/gui/m4.2/{lib,w1-signal-exit,w2-parent-death,w2-launch-window,w7-default-home}.sh`。
- 证据：`-exec bash -n {} +` ⇒ `bash -n <file1> <file2> …`，`bash` 只解析 `command_file`（首个 operand），其余为位置参数。`.sh` 不被 prettier/eslint 覆盖（`impl-M4.2.md` 自己也这么说），因此 `bash -n` 是**唯一**静态门禁——现在它 80% 空转。`impl-M4.2.md` 的 R3 段落还声称"GUI 脚本…全部过了 `bash -n`"，与此不符（另见 F4）。
- 修法（1 个字符）：`"lint:sh": "find scripts/gui -name '*.sh' -exec bash -n {} \\;"`（或 `-print0 | xargs -0 -n1 bash -n`）。改完用"往 `w1-signal-exit.sh` 加一行 `if then fi` 必须红"自检一次。

### P2
无。

### P3（report-only；按影响排序）

**F1 · ICO 用例可被 70 字节伪造**
- 位置：`packages/desktop/src-tauri/src/lib.rs:367-386`。
- 证据：`size`/`offset` 全 0 时 `end=0 <= bytes.len()` 恒真（`lib.rs:383-384`），`read_dir`/像素内容完全不查；`icon.ico` 目录项之外的数据无人验证。
- 修法（小改）：在循环里加两条 —— `assert!(size > 0, "第 {index} 档没有数据")` 且 `assert_eq!(bytes[offset..offset+3], [0x28,0x00,0x00] as [u8;3], "第 {index} 档不是 32bpp DIB/BMP 头")`（PNG 档则校验 `\x89PNG`），并 `assert!(entries as usize * 16 + 6 < bytes.len())`。加这三行后，伪造成本要真造 4 张图 ≥ 真文件，判据才成立。

**F3 · `timer.unref()`（`serve.ts:90`）无任何断言**
- 证据：`grep -rn "unref|hasRef" packages/cli` → 仅 `src/commands/serve.ts:90`、`src/chrome/deadline.ts:16`，**tests 零命中**；`units-parent-guard.test.ts:211` 用 fake timers，`unref` 不可观测。
- 影响：它是不依赖调用点自觉的那道兜底（见第 1 项分析），却正是"删掉也不会红"的代码。要么补一条真定时器用例（spy `globalThis.setInterval`，断言返回对象 `hasRef() === false` 后 `clearInterval`），要么在 impl 报告里把它降级为"防御性、无断言"，别当作已验证的防线。

**F4 · 实现报告三处自述与代码不符（会误导后续审计）**
- `impl-M4.2.md` 的 R3 段落称 `lint:sh` = `shellcheck … && find …`，但 `package.json` 里**没有 shellcheck**；同段称 5 个脚本"全部过了 `bash -n`"（实际 1 个，见 F2）；GUI 脚本段落称"无 `/tmp` 硬编码"，而 `lib.sh:19` 有 `${TMPDIR:-/tmp}` 兜底。
- 修法：改报告三行文字（`lint:sh` 实际命令、"覆盖 5 个脚本"改成真实证据、`/tmp` 措辞改成"偏移到 `${TMPDIR}`，缺省 `/tmp`"）。不影响代码。

**F5 · GUI 脚本 `mktemp_root` 结果未校验，`set -u` 无 `set -e`**
- 位置：`scripts/gui/m4.2/w1-signal-exit.sh:3,7`、`w2-parent-death.sh:3,6`、`w7-default-home.sh:3,7`、`w2-launch-window.sh:7,14`（只有 `set -u`，无 `trap`、无 `set -e`）。
- 证据：`root=$(mktemp_root hr-w1-term)` 若不慎返回空串，后续 `make_dirs ""` ⇒ `mkdir -p "/home" "/ws"`、`--home /home`、`--open "/ws/doc.html"` —— 若以 root 运行，会在沙箱外**真建 `/home` `/ws` 并写盘**，正是 R2 那类"落到真实路径"的事故向量（另一条路）。
- 修法（每个脚本一行）：`root=$(mktemp_root hr-w1-term) || { echo "mktemp 失败"; exit 1; }`；`make_dirs` 里补 `mkdir -p "$root/home" "$root/ws" || exit 1`。

**F6 · `units-run-home.test.ts` 的失败模式会写/删真实 `~/.hreader/daemon.json`**
- 位置：`packages/cli/tests/units-run-home.test.ts:44-62`；对照 `units-serve-parent.test.ts:56-57` 已经做了 `process.env["HOME"] = dir.home`（并在 `:80` 恢复）。
- 证据：本用例注入 `io.home` 但**不改 `HOME`**；一旦有人把 `run.ts:189` 的 `home: io.home ?? homedir()` 退回 `homedir()`，用例红的同时会把开发者的真实 `~/.hreader/daemon.json` 覆盖再删除 —— "抓 R2 事故的用例自己会复现 R2 事故"。
- 修法（3 行）：按 `units-serve-parent.test.ts:56-57,80` 的写法在用例内把 `HOME` 指到 `dir.home`，`finally` 恢复。

**F7（pre-existing，非本轮引入）· stop 路径上的 `close()` 失败无归口**
- 位置：`serve.ts:61-64`（`void input.stop.then(async () => { disposeWatch(); await running.close(); })`）与 `serve.ts:87`（parentGone 分支的 `void running.close()`）。
- 证据：`void` + 无 `.catch` ⇒ `close()` reject 变成 unhandled rejection：退出码从 0 漂到 1，stderr 多一段栈；两处都不进 `run.ts` 的 `reportFailure`。R2 时形状相同（不是本轮回归），但本轮主题正是"进程退出"，故记录。
- 修法：`void input.stop.then(async () => { disposeWatch(); await running.close(); }).catch((error: unknown) => { io.stderr(...) })` —— 需要把 `stderr` 传进 `serveCommand`（已可由 `input` 用 `json`/`stderr` 组合），或先在 `close` 内拒收。

---

## 三、未执行清单（透明声明）

1. **未执行任何命令**（本环境无 shell 权限）：`pnpm verify`、`pnpm lint:sh`、`cargo test`、`cargo clippy`、`pnpm desktop:check`、W1/W2/W7 真机脚本，全部**未跑**；采用协调者给出的 `265 文件 / 2969 例 / EXIT=0` 作为既成事实，未复核。
2. **F2 的结论来自 bash/POSIX 语义推导，非实跑**。请在落盘前用一次实跑钉死：给 `scripts/gui/m4.2/w1-signal-exit.sh` 加 `if then fi`，`pnpm lint:sh` 应仍 EXIT=0；改 `\;` 后应变红。
3. **未真造 70 字节假 ICO**（静态推导，构造法已在 F1 写明）。
4. **未做变异（mutation）实跑**：F3/F1/F6 的"会不会红"是静态因果分析；`## R3 返工` 里的 MU-A 结果（"删 `disposeWatch` 无测试变红"）与我的静态判断一致，但两点都需独立复核一次。
5. 未核对 `cargo` 侧是否真编译过（`smoke.rs` 可见性只做**静态**判断，按任务书要求）。
6. 未审 `units-serve.test.ts` 另外 163 行改动的非 R3 部分（超出本轮 9 项范围）。

---

## 四、判决

**BLOCK（唯一阻塞项：F2，一行一字符）**

- P1-A（进程退出）**真修好**：三条出口全部清定时器、`unref` + disposer 各守一个场景（父进程仍活时收 SIGTERM 靠 `unref`；父进程已死靠 disposer 与 parentGone 自清，disposer 额外保证不二次 close）。异常路径无残留。
- `run-serve.ts` 拆分**逐字段完整**（9 字段全对，校验无重复，`process.ppid` 兜底真消失，测试无 `as` 硬过），`signals.rs` 的 FAILED/ANNOUNCED/`installed()` 三处均成立，`mktemp_root` 真 `mktemp -d`，stop 顺序对 `daemon.json` 无影响，SIGINT/SIGTERM 同路径。
- R3 的 6 条 TS 用例**逐条为真**（删实现行会红），无"同义改写"混入；`smoke.rs` 静态可编译。
- 唯一阻塞项是**本轮的收尾修复自己没生效**：`lint:sh` 用 `-exec … +` 只校验了 5 个脚本中的 1 个（`package.json:19`），而 impl 报告还声称全覆盖 —— 改一个字符即可，改完请重跑 `pnpm lint:sh` 的反例自检。F1/F3/F4/F5/F6 建议同批处理，但可另立 P3 卡。

---

### 摘要（≤300 字）

R3 把 P1-A 真修好了：`watchParent` 三条出口都清定时器（`serve.ts:85-93`），`close()` 抛错时 disposer 已执行（`:62` 在 `:63` 前）。两道防线分开判：删 disposer 仍能退（parentGone 自清 + `unref`），桥守的是"不二次 close"；删 `unref` 在正常路径也能退，它守的是"不依赖调用点自觉"。二者互补，各自必要，但**删任一条都不会有用例红**。

`run-serve.ts` 9 字段全接、无重复装配；`process.ppid` 兜底彻底消失（只剩 `main.ts:12` 采集与 `parent-guard.ts:27` 轮询）；`signals.rs` 的 FAILED 短路在 `:76`、ANNOUNCED 在 `:63`、`installed()` 被 `:200/:205` 真断言；`mktemp_root` 真 `mktemp -d`；stop 顺序不影响 `daemon.json`，SIGINT/SIGTERM 同路径。6 条 TS 用例逐条经"删实现行会红"判定为真。

阻塞仅一项：`package.json:19` 的 `-exec bash -n {} +` 只语法校验 5 个脚本中的第一个（`bash -n f1 f2 …` 把后 4 个当位置参数），改 `+` 为 `\;` 即可；impl 报告"全部过了 bash -n / 有 shellcheck"与代码不符。另 P3 六条：ICO 可被 70 字节伪造、`unref` 零覆盖、脚本 `mktemp` 结果未校验（root 运行会在沙箱外建 `/home`）、`units-run-home` 失败会动真实 `~/.hreader`。