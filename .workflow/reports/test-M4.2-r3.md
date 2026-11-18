# M4.2 G3‴ 终测报告（R3 后）

- 角色：测试员（只读主树；全部变异在副本 `/private/tmp/m42r3`）
- 主树快照：`main` @ `02f2649`，被测定文件于 09:26 与本报告逐字 diff 过；测试期间主树仍有并行改稿（见 §6「漂移」）
- 沙箱：`/private/tmp/m42r3`（`rsync -a --exclude src-tauri/target`，`node_modules`/`target` 软链），所有用例跑在沙箱 `HOME`/`TMPDIR` 下
- 开工/收工主树 `git status --porcelain`：**我自己零改动**；条目数 44 → 48，增量全部是并行 writer/auditor 的（`docs/02`、`docs/05`、`audit-M4.2-r3.md`、`audit-M4.2-r4.md`）。本报告是唯一由我落盘的文件。

## 0. 两条铁律的执行证据

- **§11.46（先设沙箱 HOME，再变异）**：`/tmp/run-mut.sh` 前 6 行就是 `mktemp -d` + `export HOME=... TMPDIR=... XDG_CACHE_HOME=...`，第 7 行才 `cd /tmp/m42r3`；`scripts/gui/m4.2/r3-ga.sh` / `r3-gd.sh` / `r3-gg.sh` 的 `export HOME=...` 均在任何被测进程之前（`r3-ga.sh:7` 在第 19 行 `cd`、第 20 行 `exec node` 之前）。全程结束后核对真机 `~/.hreader/` 仍为空目录、无写入。
- **§11.45（要退出方式，不只要 `daemon_alive=no`）**：所有"应自己退出"的档位都记 `wait_status` + `gone_ms` + 端口 + `daemon.json`；"未退出"的档位记 `alive=yes gone_ms=-1` 并补 `kill -9` 后的 `wait_status=137` 作对照。
- 上一轮"harness 把不退出变成自己挂死"的坑已修：`r3-ga.sh` 在 `gone_ms=-1` 分支**不再** `wait`，直接记 `alive=yes`，`wait_status=none`，再 `kill -9` 记录 `137`。

## 1. 结论摘要

| 组 | 结论 | 一句话 |
| --- | --- | --- |
| G-A 真机退出方式 | **PASS** | 原树两档 16ms 自退（`wait_status=0`）；"只删 disposer"、"只删 unref"都仍能自退；"两道都删 + `--exit-with-parent`"**真的不退出**（`gone_ms=-1`，`kill -9` 才 `137`），而端口已关、json 已删 → 典型的"看起来退了其实没退" |
| G-B 泄漏回归 | **PASS** | 全套 `vitest run packages/cli` **645 passed / EXIT=0**，无 "hanging process / open handle" 告警；单跑 `units-parent-guard.test.ts` 18 passed × 2 次均 EXIT=0；残留 daemon 计数 0→0 |
| G-C 变异矩阵 | **PASS（6 红 1 幸存 1 假门禁已修）** | 见 §4 表；`launchParentPid` 退化成可选是**真幸存者**（tests + `tsc` 双绿） |
| G-D 真机 GUI | **PASS** | `kill -9` 壳 → daemon 916ms 自退（无人收尸）；`osascript quit` → 213ms 自退；用户自己的 daemon（无旗标）**未被误伤**（healthz 200、json 仍在） |
| G-E 反向变异 | **PASS** | 4 个新用例全部红在"该红的点上"，`stop 撤回看门狗` 的 spy 断言的是**同一只定时器句柄**（不是"任意 clearInterval"） |
| G-F 门禁可信度 | **PASS（当前版）** | 当前 `lint:sh` 打语法错/空 glob/目录缺失**全部 exit 1**；但测试早段主树还是旧版，旧版空 glob 是**静默通过**的假门禁（时间线见 §5.6） |
| G-G 边界 | **PASS（1 项部分）** | SIGINT 与 SIGTERM 同路径（172ms vs 193ms，均 `app_rc=0`）；pty 里一次 Ctrl-C 即退；`--hold` 超时/信号两路都能退；"信号没装上"只做了等价替代验证（§5.7） |

## 2. G-A 真机复现：谁在给谁兜底

脚本 `scripts/gui/m4.2/r3-ga.sh`（第 1 段设沙箱，第 2 段起 `node packages/cli/src/main.ts serve …`），`kill -TERM <daemon>` 后 5ms 采样：

| 变体 | flag | wait_status | gone_ms | alive | port_after | json_after |
| --- | --- | --- | --- | --- | --- | --- |
| v0 原树 | 无 | 0 | 16.1 | no | no | none |
| v0 原树 | `--exit-with-parent` | 0 | 16.3 | no | no | none |
| vd 只删 disposer（保留 unref） | 无 | 0 | 15.9 | no | no | none |
| vd 只删 disposer | `--exit-with-parent` | 0 | 15.3 | no | no | none |
| vu 只删 unref（保留 disposer） | 无 | 0 | 15.8 | no | no | none |
| vu 只删 unref | `--exit-with-parent` | 0 | 15.3 | no | no | none |
| vb 两道都删 | 无 | 0 | 15.7 | no | no | none |
| vb 两道都删 | `--exit-with-parent` | **none** | **-1** | **yes** | no | none |
| vb 收尾 | — | `kill -9 → 137` | — | — | — | — |

判定：

1. **两道防线互相兜底，且各自都必需**——不是"冗余摆设"，而是"任意一道即可覆盖 `stop` 路径"：
   - 只删 disposer（vd）：`timer.unref()` 让 1s 定时器不再是事件循环唯一活干 → 16ms 自退。
   - 只删 unref（vu）：disposer 在 `stop` 路径先 `clearInterval` 再 `close()` → 15ms 自退。
   - 两道都删（vb + `--exit-with-parent`）：**测到真不退**（`alive=yes gone_ms=-1`）。
2. 还有**第三道防线**：`parentGone` 分支自己的 `clearInterval(timer)`（`packages/cli/src/commands/serve.ts:86`），只在"父进程真的没了"时触发；`SIGTERM` 路径走不到它，所以上表 vd/vu 的绿不是它给的。
3. vb 档最值得记：`port_after=no`、`listeners_after=0`、`daemon_json=none`，但进程还活着——**只看端口/json/`alive` 抓不到它，必须看 `wait`**。这正是 §11.45 的现场。
4. `--exit-with-parent` 关闭时（vb 第 1 行）15.7ms 自退：因为路径里根本不建定时器，`disposeWatch` 是 `nothingToDispose`。删防线对默认路径无影响。

## 3. G-B 泄漏回归

```
=== MUT gb2-full : npx vitest run packages/cli
EXIT=0
 Test Files  59 passed (59)
      Tests  645 passed (645)
stray before=0 after=0            # pgrep -f "m42r3/packages/cli/src/main.ts" 前后一致
grep -icE "hanging|did not exit|open handle" → 0
```
单文件连跑两次：
```
=== r3-gb-single  npx vitest run packages/cli/tests/units-parent-guard.test.ts
EXIT=0   Tests  18 passed (18)
（第二次同样 EXIT=0 / 18 passed）
```
`--detectOpenHandles`：vitest 3.2.4 **不支持**（CAC 直接抛 `Unknown option '--detectOpenHandles'`），故用"跑完无悬挂告警 + 残留进程 0→0 + 每档都拿到 `wait_status`"三条替代证据。daemon 层面的句柄泄漏已由 G-A 的 `wait_status=0` 与 G-D 的 `gone_ms` 直接证否（进程真退，不只是 `kill -0` 看不到）。

附带核查：跑前 `pgrep` 里出现的 1 个 `main.ts serve` 是我自己 G-D userdaemon 档遗留的（`ppid=1`，无旗标 → 按设计本就不自退），`kill -TERM` 后 `json` 清空、进程消失；这不是用例泄漏。

## 4. G-C + G-E 变异矩阵（副本内，当前源码）

| # | 改了什么 | 红的是哪条 | 结论 |
| --- | --- | --- | --- |
| 1 | `serve.ts` stop 路径删 `disposeWatch();` | `units-parent-guard … serveCommand · stop 撤回看门狗`；`units-serve-parent … should clean up on stop exactly like the default path` | 红 2，命中 |
| 2 | `serve.ts:86` parentGone 分支删 `clearInterval(timer)` | `watchParent · 父进程消失 > should close once the parent disappears, and stop polling after that` | 红 1，命中 |
| 3 | `serve.ts:90` 删 `timer.unref()` | `watchParent · disposer > should unref the poll timer so it can never be what holds the daemon alive` | 红 1，**R3 新增用例已把这颗旧幸存者杀掉** |
| 4 | `run.ts:233` `io.home` 退化成 `homedir()` | `units-run-home … should write daemon.json under the injected home when --home is absent`（`units-serve` 的 `--home` 用例仍绿） | 红 1，命中；且**没碰真机 `~/.hreader`**（模块顶层已把 `HOME` 重定向到沙箱，事后核对真目录仍空） |
| 5 | `ResolvedIo.launchParentPid` 退回可选 + `?? process.ppid` | **无红**：`vitest run packages/cli` 643 passed（旧快照）/ `tsc --noEmit` EXIT=0 | **真幸存者**（见 §7 风险 R1） |
| 6 | `signals.rs:76` 删 `FAILED` 短路 | `signals::tests::r3_register_failure_rolls_back_and_is_not_retried` → `panicked at src/signals.rs:186: 失败之后不该再给出订阅`（`4 passed; 1 failed`） | 红 1，命中（"只打一行/不再重试"的用例） |
| 7 | `icons/icon.ico` 第 2 档目录项宽度 48→47 | `assertion left == right failed: 第 2 档宽度  left: 47  right: 48` | 红，命中 |
| 8 | `lint:sh` glob 改空集 / 目录改名 | **旧版（`find … \| xargs -0 -n1 bash -n`）：EXIT=0 静默通过**；**当前版（带 `test -n "$(find … -print -quit)"`）：EXIT=1** | 假门禁形态确认，且已在主树修掉（见 §5.6） |
| E-1 | `watchParent` 的 disposer 变成 `() => undefined` | `watchParent · disposer > should leave no timer behind once the caller disposes it` + `serveCommand · stop 撤回看门狗` | 红 2，`vi.getTimerCount()` 1→0 判据有效 |
| E-2 | 伪造 6 字节 ico（头 `00 00 01 00` + entries=4） | `panicked at src/lib.rs:381: 目录区越界：70 > 6` | 红，**且是友好断言不是越界 panic**（旧快照曾在此处 raw panic，R3 硬化后已修） |
| E-3 | 70 字节全零假目录（注释里点名的假图） | `assertion failed: 第 0 档宽度  left: 0  right: 16` | 红，注释里"判据必须贵过真图"成立 |

`stop 撤回看门狗` 的 spy 强度核查（`packages/cli/tests/serve-helpers.ts:74-81` + `units-parent-guard.test.ts:98-103`）：断言是 `clearSpy.mock.calls.some(call => call[0] === timer)`，其中 `timer = pollTimerOf(setSpy)` 取的是 `setInterval` 返回的**同一个句柄**，且 `clearSpy` 是 `vi.spyOn`（默认透传）。所以：

- 不是"任意 `clearInterval` 都算过"——换清别的定时器会红（已由 #1 变异反向确认它只在真撤时变绿）。
- 仍有两个弱点（不阻塞，供后续收）：①`pollTimerOf` 靠 `call[1] === PARENT_POLL_MS` 选句柄，若将来出现第二只 1000ms 定时器且先注册，会选错对象；②断言不覆盖"`dispose` 之后回调仍可能被调度"的竞态（`clearInterval` 已调用但已入队的 tick 仍会跑一次）。

## 5. 其余各组

### 5.1 G-D 真机 GUI（`env -i`，干净 PATH/HOME/TMPDIR）

| 档 | 证据原文 |
| --- | --- |
| 壳 `kill -9` | `CASE=kill9 after-kill9(app_rc=137) daemon=71197 gone_ms=916 daemon_json=none port_open=no app_alive=no sampled=10ms`；`daemon_ppid=71194`（=壳） |
| 壳 `osascript quit` | `CASE=quit after-quit(osa_rc=0,app_rc=0) daemon=71300 gone_ms=213 daemon_json=none port_open=no app_alive=no` |
| 用户自己的 daemon（AC-4） | `user_daemon=71368 alive=yes healthz=200` → 壳退出后 `user_after user_daemon=71368 alive=yes healthz=200 user_json=present`（壳自己的 daemon 210ms 退掉） |
| `setsid --fork` | 本机 **没有 `setsid` 二进制**（`command -v setsid` 空）。"拒启"是 Linux 上的已知取舍，macOS 无法复述现场；同族能力（壳被 SIGKILL 后 daemon 自退）由上面第 1 行覆盖 |

退出方式判读（§11.45）：`kill -9` 档 916ms 且**没有任何收尸者**（壳的 `Drop` 不会跑），说明是 daemon 自己的 parent-death 看门狗退的；`quit` 档 213ms + `daemon_json=none`，走的是壳 `Drop` 的 `TERM → 2s → SIGKILL` 但**第一枪就退了**（远小于 2s），不是被 `SIGKILL` 掩盖。两档都 `<2s`，满足 AC-13。

### 5.2 G-G 边界

| 档 | 证据 |
| --- | --- |
| `--hold 60` + `SIGTERM` | `CASE=term hold60+SIGTERM app=70225 app_rc=0 daemon=70228 gone_ms=193 daemon_json=none port_open=no` |
| `--hold 60` + `SIGINT`（`kill -INT`） | `CASE=int hold60+SIGINT app=70294 app_rc=0 daemon=70297 gone_ms=172 daemon_json=none port_open=no` → **与 SIGTERM 同路径**（同 `app_rc=0`，耗时同量级） |
| `--hold 2` 不发信号（超时） | `CASE=timeout app_rc=0 daemon_json=none port_open=no daemon_alive_at_3s=no` |
| pty 里一次 Ctrl-C | 用 `script -q /dev/null` 建真 pty（`/dev/null` 作 stdin 的 python-pty 方案不行：`preexec_fn=os.setsid` 后 pty 不是控制终端，`^C` 变成普通字节 → 首轮误报 `gone_ms=-1`，已废弃该 harness）：`CASE=pty-ctrlc-via-script script_rc=0 daemon=71090 daemon_alive=no daemon_json=none port_open=no`，`script.out` 首行就是 `^C` |

### 5.3 G-E `units-run-home.test.ts` 的沙箱守卫

变异 #4 红了以后核对真机：`~/.hreader/` 仍为空、mtime 未变；文件里 `const sandbox = realpathSync(mkdtempSync(...)); process.env.HOME = sandbox;` + `it("should have redirected HOME …")` 两道闸都在。R2 的事故形态（变异体落回真 `homedir()` 删用户 daemon.json）**已不可复现**。

### 5.4 G-C #5 幸存者细节（重要）

`launchParentPid` 改成 `?: number | undefined` + 调用点 `?? process.ppid` 之后：
- 单测全绿（没有用例断言"父 pid 只能在 `main.ts` 首个 `await` 前采集 `process.ppid`"这一契约）；
- `npx tsc --noEmit -p tsconfig.json` **EXIT=0**（类型收窄不产生错误）；
- 真机行为不变（默认路径仍不建定时器，因为开关是 `shouldWatchParent`），所以 S 层也抓不到。

即：`packages/cli/src/main.ts:12 const launchParentPid = process.ppid;` 的"采集时机"契约目前**只有注释守着**。这是本轮唯一无门禁的语义点。

### 5.5 G-F `pnpm verify` 八步顺序

`verify = pnpm format:check && pnpm lint && pnpm lint:sh && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm depcruise && pnpm knip`：`lint:sh` 在第 3 位，**在 `build` 之前** ✓（越早越便宜）。

### 5.6 `lint:sh` 时间线（本轮主树动了）

1. 我测的开始版本：`find scripts/gui -name '*.sh' -print0 | xargs -0 -n1 bash -n`
   - 语法错 → `EXIT=1`（`zz-broken.sh: line 4: syntax error: unexpected end of file`）✓
   - **空 glob / 目录不存在 → `EXIT=0` 静默通过** ✗（`printf '' | xargs -0 -n1 bash -n` → 0；BSD xargs 无输入仍执行一次，`bash -n` 无参读空 stdin 返回 0；`find` 的 "No such file" 也被 `xargs` 的退出码吞掉）
   - 旁证：`find … -exec bash -n {} +` 这种写法同样是假门禁（`find` 不看 `-exec` 的失败），副本里误留过这条变异，实测语法错仍 EXIT=0。
2. 报告写完前主树已被并行 writer 改成：`test -n "$(find scripts/gui -name '*.sh' -print -quit)" && find … | xargs -0 -n1 bash -n`
   - 空 glob → **EXIT=1** ✓；目录缺失 → **EXIT=1** ✓；语法错 → **EXIT=1** ✓；正常树 → **EXIT=0** ✓

结论：**当前版本可信**；§4 #8 这条变异对应的历史缺口已关闭。

## 6. 主树漂移（测试期间并行改稿）

被测定文件在我 sync 之后又被改了两处，均已复核、不影响结论：

- `packages/cli/tests/units-run-home.test.ts`：`process.env.HOME` → `process.env["HOME"]`（lint 口径，零行为变化）。
- `packages/desktop/src-tauri/src/lib.rs`：ICO 断言追加 PNG `IEND` 收尾 / DIB `32bpp` 抽查（更严）。已用**最新** lib.rs 重跑 6 字节假 ico → 仍 `目录区越界：70 > 6`。

⚠️ 壳产物 `hReader.app` 是 **07:37** 构建的，而 `src/lib.rs` 09:07 才改。已 diff 确认 R3 那批改动**全部落在 `#[cfg(test)]` 区**（ICO 断言 + 注释），G-D/G-G 的真机结论对行为成立；但"R3 之后重新打包一次 .app"这件事本身**没做**（见 §7 R3）。

## 7. 未执行清单

1. **`setsid --fork hr serve --exit-with-parent` 拒启**：macOS 无 `setsid`，无法现场复述（§5.1）。
2. **"信号没装上仍能退"的直接真机档**：没有重建一个 `watch()` 恒失败的壳。等价证据两条——(a) 壳被 `kill -9`（同样没有 handler、没有 `Drop`）→ daemon 916ms 自退；(b) `--hold 2` 超时路径 → 到点自退并清 json。代码侧 `signals::wait_or_timeout` 只轮询 `stopped()`，不依赖信号是否装上；Windows 分支就是"`installed()` 恒 false"的长期形态。
3. **`pnpm verify` 全链路**（含 `test:coverage`/`depcruise`/`knip`）：只核了顺序，没整跑。
4. **R3 之后重打包 `.app`**：用的 07:37 产物（见 §6）。
5. **`--detectOpenHandles`**：vitest 不支持（§3）。

## 8. 新风险

- **R1（中）**：`launchParentPid` 的"只采集一次、且在首个 `await` 前"这条契约无任何门禁（单测/类型/S 层全放过）。建议加一条结构断言：`main.ts` 里 `process.ppid` 的读取次数为 1 且在任何 `await` 之前（可用 depcruise 规则或读源码的元测试）。变异 #5 就是它的证据。
- **R2（低）**：`stop 撤回看门狗` 的 spy 靠 1000ms 这个"魔法间隔"选句柄。若 `hub.ts` 心跳或将来任何定时器也用 1000ms 且更早注册，断言会选错对象而假绿。建议 `pollTimerOf` 改成按调用栈/文件名过滤，或让 `watchParent` 接受可注入的 `setInterval`。
- **R3（低）**：壳二进制与源码版本可以静默漂移（07:37 产物 vs 09:07 源码）。建议 `desktop:check` 里加"产物 mtime 必须新于 `src/**`"，否则真机证据可能测的是旧壳。
- **R4（低，测试卫生）**：`--exit-with-parent` 下"端口已关、json 已删、进程仍在"的组合（G-A vb 档）说明**任何以"端口/文件"为判据的验收都会漏判**；建议 AC-13 的脚本固定用 `wait` 取退出码，别用 `lsof`/`nc`。
- **R5（低，harness）**：副本与主树之间出现过三次陈旧（测试文件、`package.json` 的 `lint:sh`、`lib.rs`）。变异测试**开跑前必须重新 sync 一次**并 diff，否则会得出"门禁是假的"这种反向错误结论（本轮 §5.6 的旧结论就是这么差点被写成定论）。

## 9. 复现方式

```bash
# 沙箱副本
rsync -a --exclude src-tauri/target /Users/liu/Documents/Project/hReader/ /tmp/m42r3/
ln -s <主树>/packages/desktop/src-tauri/target /tmp/m42r3/packages/desktop/src-tauri/target
# 每组
bash /tmp/m42r3/scripts/gui/m4.2/r3-ga.sh none 49001 v0-none
bash /tmp/m42r3/scripts/gui/m4.2/r3-ga.sh --exit-with-parent 49002 v0-watch
env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin" HOME=$SBX/home TMPDIR=$SBX/tmp USER=liu \
  bash /tmp/m42r3/scripts/gui/m4.2/r3-gd.sh kill9     # quit / userdaemon 同
env -i PATH=… bash /tmp/m42r3/scripts/gui/m4.2/r3-gg.sh term   # int / timeout / pty-ctrlc 同
bash /tmp/run-mut.sh <标签> npx vitest run packages/cli/tests/<文件>   # 先隔离 HOME 再跑
```
