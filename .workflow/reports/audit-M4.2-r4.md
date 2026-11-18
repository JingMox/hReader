# M4.2 G2⁗ 结卡终审（R4 后）

**结论：CHANGES-NEEDED**（3 项 P1，均为小改；3 项 P2 报备）

---

## 一、逐项判定

### 1. `lint:sh` 终形态 —— 每文件一次 ✓，空集假绿 ✗（P2）

`package.json:18`：`find scripts/gui -name '*.sh' -print0 | xargs -0 -n1 bash -n`

- **每文件独立调用：成立**。`-print0` + `xargs -0 -n1` ⇒ 每个 NUL 分隔项各起一个 `bash -n <file>`；当前目标 = `scripts/gui/m4.2/{lib.sh,w1-signal-exit.sh,w2-launch-window.sh,w2-parent-death.sh,w7-default-home.sh}`（5 个，`find` 实测清单一致），即 R3 的 `-exec … +` 只验 1 个的缺陷已真修好。
- **反例自证：成立**（协调者已跑：塞 `if then fi` → EXIT=1，删 → 0）。写者对 `\;` 的反驳我也确认正确：`find` 的退出码只反映遍历错误，`-exec` 失败只是谓词为假；本仓 `docs/03-collaboration-workflow.md:813` §11.47 记录与实测一致。
- **空集：静默 0 ⇒ 假绿（未覆盖）**。GNU xargs 无输入时默认仍执行一次命令（要 `-r`/`--no-run-if-empty` 才抑制；本机 macOS BSD xargs 无 `-r`，行为同样是"执行一次"）。子进程拿到的是 `/dev/null`（GNU/BSD 都把子进程 stdin 重定向到 `/dev/null`），于是 `bash -n` 无 operand、读 stdin 到 EOF ⇒ **exit 0**。macOS 与 CI 上结论相同。
- **`find` 遍历失败：门禁层面非 0 不成立**。`find` 自身返回 1，但**管道的退出码取最后一个命令**，`pnpm` 用 `sh -c` 执行、没有 `pipefail`（dash 也不支持），所以 `find: scripts/gui: No such file` 会变成 xargs 的"零输入 → `bash -n` → 0" ⇒ 绿。
- **还有哪种情况会假绿**：① `scripts/gui` 被改名/移走（= 上面两条的合流）；② 新增脚本放在 `scripts/gui` 之外（`scripts/` 根、`packages/*/scripts/`）——`find` 起点写死，**静默不覆盖**；③ `bash -n` 只查语法，`set -u` 下的未定义变量、`$root/home` 拼成 `/home` 这类语义问题一概不查（这一点写者没有声称，仅作能力边界报备）。

**最小修法**（`pipefail` 不可用，故用前置非空断言）：

```json
"lint:sh": "test -n \"$(find scripts/gui -name '*.sh' -print -quit)\" && find scripts/gui -name '*.sh' -print0 | xargs -0 -n1 bash -n"
```

`find` 失败 → `$()` 为空 → `test -n` 失败 → 非 0；空目录同理。仍保留"每文件一次"。

### 2. ICO 测试 —— 结构断言真钉死 ✓，但"贵过真图"这句不真（P2）

`packages/desktop/src-tauri/src/lib.rs:371-411`：
- `entries == 4`（:377）；逐档 `entry[0]/[1] == (16,16),(32,32),(48,48),(0,0)`（:391-392）；`size > 0`（:398）；`offset >= previous_end`（:400-403，起点从 `dir_end = 6+16*4` 起**不回头**）；`end <= bytes.len()`（:405）；payload 头是 8 字节 PNG 签名或 `28 00 00 00`（:406）。**70 字节空目录（size/offset 全 0）确实过不了**，R3 的恒真判据已修好。
- **伪造代价**：不必是真图。6+64 + 4×8 = **102 字节**即可：四档各给 8 字节 `89 50 4E 47 0D 0A 1A 0A`、`size=8`、offset 递推 —— 全过。所以 `:373` 注释"判据必须贵过真图"不成立（现判据便宜于真图）。
- 风险量级：`tauri-build` 在 Windows 上才会读坏，本机无法验证，此测试是唯一守门人。**最小补强**：PNG 档要求 payload 以 IEND 收尾（`49 45 4e 44 ae 42 60 82`）；DIB 档要求 `entry[9] == 32`（32bpp）且 payload 前 4 字节 `biSize == 40` 与 `size` 一致。
- 附注：`packages/desktop/src-tauri/icons/icon.ico` 目前**未被 git 跟踪**（整个 `packages/desktop/**` 都还在未跟踪列表里）。结卡 commit 时务必带上，否则 `include_bytes!` 在新克隆上直接编译失败（失败方向是安全的，但会挡住 `desktop:check`）。

### 3. `unref()` 覆盖 —— 真定时器 + 真 `hasRef` 成立 ✓，helper 失败方向朝"假绿"（P2）

- `packages/cli/src/commands/serve.ts:90` `timer.unref()`；`docs/02:346`、`docs/05:391` 描述的"disposer 可撤 / stop 先撤再 close / `unref()` 兜底"与代码逐条相符：`watchParent` 返回 disposer（`serve.ts:93-96`），`serve.ts:61-64` 是 `disposeWatch(); await running.close();` 的顺序。
- helper `packages/cli/tests/serve-helpers.ts:92-95`：`Reflect.get(Object(timer), "hasRef")` — `timer` 是 `spy.mock.results[i].value`，即 Node 的 `Timeout` 实例，`hasRef()` 在 Node 18/20/22/24 上都存在（`Timeout.prototype.hasRef`，Node 11+）。**取法可靠**（`Object(undefined)` 也不会抛，返回 `{}` → false）。
- 用例在**真定时器**下跑：`packages/cli/tests/units-parent-guard.test.ts:232-246` 的 `should unref the poll timer…` 没有 `withFakeTimers`，并在末尾 `dispose()`（:245 后），无泄漏。
- **删 `serve.ts:90` 必然红**：`hasRef()` 回 true ⇒ `toBe(false)` 失败 ⇒ 该行确有此覆盖，门的有效性成立。
- 缺陷在**失败方向**：`typeof hasRef !== "function"` 时函数返回 `false`，`expect(...).toBe(false)` **照样绿**。即"取不到 `hasRef`"与"已 unref"不可区分；若将来 timer 换成非 Node `Timeout`（`pollTimerOf` 返回 `undefined` 时亦然）断言会恒真。**最小修法**：

```ts
if (typeof hasRef !== "function") throw new TypeError("timer 没有 hasRef()：无法证明 unref()");
return Reflect.apply(hasRef, timer, []) === true;
```

### 4. 两处守卫

**(a) `scripts/gui/m4.2/lib.sh` —— 结论对，理由不精确（P2，仅注释）**
- `lib.sh:20` `mktemp_root`、`lib.sh:23-30` `make_dirs`（`:26` 挡空串）、`:27` `mkdir -p … || exit 1`。四个调用点 `w1-signal-exit.sh:7`、`w2-launch-window.sh:14`、`w2-parent-death.sh:6`、`w7-default-home.sh:7` 全部是 `root=$(mktemp_root …) || exit 1` **且**紧接 `make_dirs "$root"` —— 双保险成立，`"$root/home"` 不会退化成 `/home`。
- 但 `lib.sh:25` 的理由"子 shell 的 `exit` 传不出去"不准确：`exit 1` 在 `$( )` 里**会把状态码传给赋值语句**（`root=$(mktemp_root …)` 的 `$?` 为 1），所以 `|| exit 1` 本来就生效。真正传不出的是"副作用"（如 `set -x` 的变量）。`make_dirs` 的空串断言是**冗余但无害**的第二道闸。最小修法：把注释改成"状态码会传出（调用点已 `|| exit 1`），这里再挡一次是为了不依赖调用点"。

**(b) `packages/cli/tests/units-run-home.test.ts:46-48` —— 守卫是重言的，挡不住（P1）**
```ts
it("should be handed a home under the temp dir, so a broken wiring cannot touch the real one", () => {
  expect(realpathSync(home).startsWith(realpathSync(tmpdir()))).toBe(true);
});
```
- `home` 在 `:12` 由 `mkdtempSync(join(tmpdir(), …))` 造出，断言只是"mkdtemp 返回的路径在 tmpdir 下"——**恒真，与被测代码零耦合**。`ioWith`（`:33-39` 附近）哪怕删掉 `...(homePath === undefined ? {} : { home: homePath })`，这条仍绿。
- 更关键：`packages/cli/src/run.ts:189` `home: io.home ?? homedir()` —— 接线断了的后果由**下一条** `it`（`:50-68`）承担，而它是"先真起服务、再断言"：`run([...])` 一旦回落到 `homedir()`，发散方向正是 **真实 `~/.hreader/daemon.json` 先被写、退出再被删**（R2 事故原样复现），红在事后。即"守卫自身失败时**确实会先跑被测代码**"。
- 同仓已有正确范式：`packages/mcp-server/tests/ui-resource.test.ts:28`、`packages/cli/tests/serve.test.ts:60/162` 都是把 `HOME` 指到临时目录。**最小修法**（3 行）：本文件模块顶层在任何 `run()` 之前 `process.env.HOME = home;`（POSIX 上 `os.homedir()` 优先读 `$HOME`），守卫改成断言"回落到 `homedir()` 也落在 tmpdir 下"——这样接线断了也只是写坏临时目录，且守卫真的会因 `homedir()` 未重定向而红。

### 5. 文档与代码一致性 —— 6 条真、2 条假（2 × P1）

| 事实 | 代码证据 | 判定 |
|---|---|---|
| `CliIo.launchParentPid` **必填** | `packages/cli/src/run.ts:46` 无可选标记，`run.ts:44` 注释明写禁 `?? process.ppid`；`run.ts:235` 透传 → `serve.ts:31` | ✓ |
| `main.ts:12` 在首个 `await` 前 | `main.ts:12` = `const launchParentPid = process.ppid;`，首个 `await` 在 `main.ts:14` | ✓ |
| `watchParent` 返回 disposer、stop 先撤再 close | `serve.ts:93-96`、`serve.ts:61-64`、`serve.ts:90` `unref()` | ✓ |
| `FAILED`/`ANNOUNCED`/`installed()` | `signals.rs:41`、`:43`、`:76`、`:63`、`:25`、Windows 侧 `:135-137` 如实报 false | ✓ |
| home 三平台路径 = `default_home_for` | `lib.rs:315-323`：macOS `Library/Application Support`、Windows `AppData/Roaming`、Linux `.local/share` + `APP_DATA_DIR="com.hreader.desktop"`（`lib.rs:308`） | ✓ |
| `pnpm verify` 八步顺序 | `package.json:20`：format:check → lint → lint:sh → typecheck → build → test:coverage → depcruise → knip | ✓ |
| `scripts/gui/m4.2/` 文件名清单 | 实际 5 个：`lib.sh`/`w1`/`w2-launch-window`/`w2-parent-death`/`w7`。**`ac20-gui-size.sh` 全仓不存在**（`grep -rn ac20` 只命中 `docs/05:400` 与报告正文） | ✗ **P1** |
| "一律 `mktemp -d` + **沙箱 `HOME`**" | 无任何脚本设 `HOME`；`w7-default-home.sh:11-12` 用**真实** `$HOME/Library/Application Support/com.hreader.desktop` 并 `rm -rf "$shell_store"` | ✗ **P1** |
| `L-42` 编号不冲突 | 全仓 `L-42` 仅 `docs/05:398` + 卡片 `.workflow/cards/M4.2.md:36`；已用至 `L-41`（`docs/05:460`），42 为空号 | ✓ |
| §11.45 / §11.47 内容如描述 | `docs/03-collaboration-workflow.md:792`（"进程没了"≠"自己退的"）、`:813`（`find -exec` 两种写法都是假绿，含 `find_semicolon_exit=0`） | ✓ |

附带核对（不在清单内、但文档有实名断言）：`docs/05:389` "`hr serve --home` 要求目录已存在" 与 `run.ts:61-64`（`--home 目录不存在：…`）一致 ✓；`docs/05:399` "`/healthz` pid 与 `daemon.json` 一致才复用" 与 `supervisor.rs:252`（`health_pid(port) == Some(info.pid)`）、`:97-99`（adopt 外部 daemon 不 kill）一致 ✓。

---

## 二、Findings

- **P1-1（文档骗人）** `docs/05-feature-cards.md:400` 列了不存在的 `ac20-gui-size.sh`。证据：仓库内 `scripts/gui/m4.2/` 只有 5 个文件，`ac20` 全仓无此文件（仅本行 + 历史报告提及）。修法：删掉该项，或补建脚本（窗口尺寸真机证据）。
- **P1-2（文档骗人，有数据风险）** `docs/02-architecture-and-roadmap.md:346` 与 `docs/05-feature-cards.md:400` 均称真机脚本"一律 `mktemp -d` + **沙箱 `HOME`**，无机器相关绝对路径"。证据：四个脚本无一 `export HOME`；`scripts/gui/m4.2/w7-default-home.sh:11-12` 直接对真实 `$HOME/Library/Application Support/com.hreader.desktop` 执行 `rm -rf`（W7 语义上必须如此）。读者按文档以为是纯沙箱、放心连跑，就会丢壳的 app data。修法：改成"`--home` 指向 `mktemp -d` 沙箱目录；**W7 是例外**：故意使用真实 app data 目录并会 `rm -rf` 它（跑之前先备份/确认无在跑实例）"。同一句在两份文档，**必须同改**。
- **P1-3（守卫重言，失败方向是写真实 `~/.hreader`）** `packages/cli/tests/units-run-home.test.ts:46-48`。证据：断言只关于本文件 `:12` 造出的变量本身，与被测路径无耦合；`run.ts:189` 的 `io.home ?? homedir()` 使"接线断了"的后果落在下一条用例的真起服务里（先写后删真实 `~/.hreader/daemon.json`）。修法：模块顶层先把 `process.env.HOME` 指向临时目录，守卫改成断言 `homedir()` 已落在 tmpdir 下（并保留"注入 `home` 后落点跟着变"的主用例）。
- **P2-1** `package.json:18` 空集 / `find` 失败双假绿（管道退出码 + `bash -n` 无 operand 读 `/dev/null`）。修法见 §1。
- **P2-2** `packages/cli/tests/serve-helpers.ts:94` 在 `hasRef` 缺失时返回 `false`，断言"恒真"；改成缺失即 `throw`。
- **P2-3** `packages/desktop/src-tauri/src/lib.rs:373` 注释"判据必须贵过真图"不成立（102 字节伪造即可过）；补 IEND / `biSize+32bpp` 断言，或把注释改成"贵过空目录"。

---

## 三、判决

**CHANGES-NEEDED** —— 代码与本轮两处门禁（`lint:sh` 逐文件、ICO 结构断言、`unref()` 真定时器）**实质合格**，R3 的 BLOCK 已真修；但 P1-1/P1-2 是**文档对代码/脚本的错误陈述**（其中 P1-2 会让读者放心踩到真实 app data 的 `rm -rf`），P1-3 是本卡"防 R2 事故"的守卫**名存实亡**。三项都是一行到三行的改法，改完**无需再跑全量**：只改 docs 无需门禁；改 `units-run-home.test.ts` 与 `serve-helpers.ts` 需复跑 `pnpm test:coverage`（期望 265 文件 / 2971 例仍绿，coverage 四维 100% 不变）；改 `package.json` 的 `lint:sh` 需再跑一次 §1 的反例自检（塞坏脚本 → 非 0；`mv scripts/gui /tmp` → 非 0）。
修完这 3 项即可 **PASS / 本卡可结**。P2 三条**不阻塞结卡**，建议同期顺手改 P2-2、P2-1（各一行）。

---

### 摘要（≤300 字）
R4 的两处真门禁经复核成立：`package.json:18` 的 `-print0 | xargs -0 -n1` 确为每文件一次调用、反例可红；ICO 用例真钉死 `size>0` + offset 递增 + payload 签名；`unref()` 在真定时器下用真 `hasRef()` 断言，删 `serve.ts:90` 必红。写者对 `\;` 的反驳正确（`find` 退出码只反映遍历错误）。但有三项 P1：①`docs/05:400` 列出的 `ac20-gui-size.sh` 全仓不存在；②两份文档称 GUI 脚本"一律沙箱 `HOME`"，实际 `w7-default-home.sh:11` 对真实 app data 目录 `rm -rf`；③`units-run-home.test.ts:46-48` 的守卫是重言（只断言它自己造的变量），接线一断仍是"先写真实 `~/.hreader` 再报错"。P2：`lint:sh` 空集/`find` 失败假绿（`sh -c` 无 pipefail）、`timerStillHoldsProcess` 缺 `hasRef` 时恒真、ICO 判据 102 字节可伪造。判决 **CHANGES-NEEDED**，三项修完即可结卡。