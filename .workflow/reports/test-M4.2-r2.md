# M4.2 G3″ · 打洞复测（R1 返工后）

基线 `02f2649`（工作树未提交）。隔离：`rsync -a --exclude node_modules --exclude 'src-tauri/target'` → `/tmp/m42c-mut`，`node_modules` 逐包软链回主树，`src-tauri/target` 软链回主树（cargo 全程无锁冲突）。**所有变异只在副本里做**；真机案输出一律先落文件再读，不用管道判存活。

## 0. 结论摘要

| 组 | 验证内容 | 判定 |
|---|---|---|
| G-A1 | M2 复跑：`signals::watch()` 挪到 `connect()` 之后 | **PASS**（编译失败，token 不可伪造） |
| G-A2 | M6b 复跑：无条件 `watchParent` + `timer.unref()` | **PASS**（R 层红 1 条，指名） |
| G-B | 启动窗口 0.03/0.3/0.6s + 稳态 2s | **PASS**（无孤儿、无 stale json、端口不占） |
| G-C | 4 条新用例反向变异 | **PASS（3 条完整、1 条有覆盖缺口，见 §4）** |
| G-D | `packages/cli` 全绿 + e2e + 脚本空环境 | **PASS**（640 例；e2e OK；4 脚本 env -i 全 OK） |
| G-E | 用户 daemon 不被误伤 | **PASS**（壳退出后用户 daemon 活、healthz 200） |
| G-F | `daemon.json` 删除语义复述 | **PASS（事实复述）** |
| G-G | ppid=1 但 init 活着的启动 | **PASS（行为符合设计，代价已钉住）** |

总体：**R1 打出的两个洞（M2、M6b）与 B5 启动窗口都已堵上；本轮未发现新的功能缺陷，只发现 4 条测试/记录层面的风险（§8）。**

---

## 1. G-A 两个洞是否真被堵住

### G-A1 M2（安装点）—— **KILLED-BY-COMPILER**

变异（副本 `packages/desktop/src-tauri/src/lib.rs`）：删掉 `connect()` 之前的 `let _before_connect = signals::watch();`，把它插到 `Ok(session) => {` 之后，模拟"先 connect 后 watch"。

```
error[E0425]: cannot find value `_before_connect` in this scope
   --> src/lib.rs:154:35
error: could not compile `hreader-desktop` (lib) due to 1 previous error
```

再验"能不能绕开 token"：直接在 `lib.rs` 里伪造

```rust
let _before_connect = signals::SignalSubscription { _private: () };
```

```
error[E0451]: field `_private` of struct `SignalSubscription` is private
   --> src/lib.rs:151:57
```

读码佐证：`SignalSubscription` 无 `derive(Copy/Clone)`、字段私有、`fn new()` 私有且仅在 `signals` 模块内；`mod platform` 本身不是 `pub`，外部拿不到第二处构造点。**判定 PASS**：该顺序现在由编译器强制，不是靠人记得。

（变异后恢复，`diff -q` 与主树一致。）

### G-A2 M6b（`unref` 变体）—— **KILLED-R**

变异（副本 `packages/cli/src/commands/serve.ts`）：接线改成无条件 `watchParent(parentWatchOf(input.launchParentPid), running);`，并在 `setInterval` 后加 `timer.unref?.();`。

```
 FAIL  packages/cli/tests/units-parent-guard.test.ts > serveCommand · 父进程看门狗的开关 > should not install a poll timer without --exit-with-parent
AssertionError: expected 1 to be +0 // Object.is equality
 Test Files  1 failed | 57 passed (58)
      Tests  1 failed | 639 passed (640)
```

红的原因是"旗标为 false 时仍建了定时器"（语义断言），与事件循环是否被拖住无关。**判定 PASS**。恢复后基线 `packages/cli`：`58 passed / 640 passed`。

---

## 2. G-B 启动窗口真机复验（B5）

环境：副本内自写等价脚本（模型同 `scripts/gui/m4.2/w2-launch-window.sh`，每档多记 `pgrep` 与 `ps -o ppid`，全部写 `/tmp/m42c-b/w2-results.txt` 后再读）。父进程 = spawn `hr serve … --exit-with-parent` 的 shell，`kill -9` 落在 0.03/0.3/0.6s。

```
killpoint=0.03 elapsed+=0.05 daemon=none daemon_alive=none daemon_ppid=[] pgrep_count=0 port=49603 port_open=no daemon_json=none
killpoint=0.03 elapsed+=4.0  daemon=none daemon_alive=none daemon_ppid=[] pgrep_count=0 port=49603 port_open=no daemon_json=none
killpoint=0.3  elapsed+=0.05 daemon=none daemon_alive=none daemon_ppid=[] pgrep_count=0 port=49603 port_open=no daemon_json=none
killpoint=0.3  elapsed+=4.0  daemon=none daemon_alive=none daemon_ppid=[] pgrep_count=0 port=49603 port_open=no daemon_json=none
killpoint=0.6  elapsed+=0.05 daemon=15766 daemon_alive=yes daemon_ppid=[1] pgrep_count=1 port=49606 port_open=no daemon_json=none
killpoint=0.6  elapsed+=0.50 daemon=15766 daemon_alive=no  daemon_ppid=[]  pgrep_count=0 port=49606 port_open=no daemon_json=none
killpoint=0.6  serve.err: --exit-with-parent 但启动时父进程已是 init（ppid=1）：父进程在启动窗口期就退了
```

稳态对照（ready 后 2s 再 `kill -9` 父）：

```
steady ready parent=15874 daemon=15883 daemon_ppid=15874 port_open=yes daemon_json=present
steady after kill+2s(deadline 2s) daemon=15883 daemon_alive=no port_open=no daemon_json=none
```

判定：三档都**没有** G3′ §3.5 的 `ORPHAN`（daemon 活 4s+ / 端口不还 / json 残留）；0.6s 这一档 daemon 起来了、但立刻认出 `ppid=1`，错误退出、不写 json、不占端口；稳态 ≤0.5s 内收尸并清 json。**PASS**。

另：仓内 `scripts/gui/m4.2/w2-launch-window.sh` 也在副本里、`env -i` 下原样跑通（见 §5）。

---

## 3. G-C 新用例反向变异（假测试猎杀）

| # | 改了什么 | 红的是哪条 | 判定 |
|---|---|---|---|
| C1 | `parent-guard.ts`：`orphanedAtLaunch = (parentPid) => parentPid === 1` → `=> false` | `units-parent-guard.test.ts > orphanedAtLaunch > should call a ppid of 1 an orphan, not a normal parent`；`units-parent-guard.test.ts > serveCommand · 启动时父进程已死 > should refuse to start when the parent was already gone at launch`（`2 failed | 16 passed`） | 真测试 |
| C2 | `serve.ts`：整段删掉"`shouldWatchParent && orphanedAtLaunch` → `HrError`"的启动前检查 | `units-parent-guard.test.ts > serveCommand · 启动时父进程已死 > should refuse to start when the parent was already gone at launch`（`1 failed | 639 passed`）。**`units-serve-parent.test.ts` / `units-serve.test.ts` 全部仍绿** | 真测试（但守门用例挂在 `units-parent-guard.test.ts`，不在按文件名预期的两个文件里） |
| C3 | `lib.rs`：`user_home` 的 `match home.or(userprofile)` → `match home`（回退链只读 `HOME`） | `tests::r1_default_home_falls_back_to_userprofile_when_home_is_missing`（`1 failed; 1 passed`） | 真测试 |
| C4 | `icons/icon.ico` 第 3 个字节（`00 00 01 00` 的 `01`）改成 `00` | `tests::r1_bundle_icon_ico_is_a_valid_ico_with_four_sizes`（`assertion left == right failed: ICO 头必须是 00 00 01 00`） | 真测试 |

C3 的**覆盖缺口**（新发现，非本轮返工项）：把 `default_home()` 这个环境变量接线改成只读 `HOME`（`user_home(var_os("HOME"), None)`）后，两条 `r1_default_home_*` 用例**仍全绿**（`2 passed`）——单测只经注入参数测 `user_home`，没测"`default_home()` 真的把 `USERPROFILE` 传进去"。变异仍被 `user_home` 层的用例挡住，但"环境变量接线"本身无守门（§8-R1）。

所有变异跑完即从 `/tmp/m42c-*.orig*` 还原并逐文件 `diff -q` 比对主树（无输出）。

---

## 4. G-D 回归面

- `npx vitest run packages/cli`（副本）：`Test Files 58 passed (58) / Tests 640 passed (640)`，EXIT=0。
- `pnpm test:e2e`（主树，只读执行）：`OK: 分页 / A4 / 白底 / 无外链（7 页；抽掉分页规则后 3 页）｜长图 2400×5074、裁剪 2400×4000`，EXIT=0。
  - 附注：在**副本**里直接 `pnpm test:e2e` 会因根 `node_modules` 是软链而触发 pnpm 的 modules purge（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。这是副本隔离方式的副作用，不是仓库缺陷；改用 `node scripts/print-e2e.ts` 在同一副本得到 EXIT=0。
- `scripts/gui/m4.2/*` 空环境（`env -i PATH=<node bin>:/usr/bin:/bin:/usr/sbin:/sbin HOME=/tmp/m42c-empty-home bash <script>`，不继承其它变量）：

```
### w2-parent-death.sh   EXIT=0
parent=17070 daemon=17075 daemon_ppid=17070 port_open=yes
AFTER kill -9 -> daemon_alive=no port_open=no daemon_json=none
### w2-launch-window.sh  EXIT=0
TIMELINE kill=0.6s daemon=17299 daemon_alive=no port_open=no daemon_json=none listener=no
serve.err: --exit-with-parent 但启动时父进程已是 init（ppid=1）：父进程在启动窗口期就退了
### w1-signal-exit.sh    EXIT=0
app=17336 daemon=17339
AFTER SIGTERM -> app_alive=no daemon_alive=no daemon_json=none
### w7-default-home.sh   EXIT=0
user_store_before=absent
app=17403 daemon=17406 shell_store=/tmp/m42c-empty-home/Library/Application Support/com.hreader.desktop/.hreader/daemon.json
user_store_untouched=yes
AFTER SIGTERM -> daemon_alive=no shell_daemon_json=none
```

判定：4 个脚本都不依赖调用者 shell 的变量，仓根由 `BASH_SOURCE` 推出，**PASS**。

---

## 5. G-E 用户 daemon 不被误伤（AC-4 复核）

隔离 `HOME=/tmp/m42c-b/ge/home`：先手动起用户 daemon（**不带** `--exit-with-parent`，不传 `--home`，落 `$HOME/.hreader`），再起 `.app`（壳用 app data 私有 home、spawn 自己的 daemon），`SIGTERM` 壳。原文（健康检查用 `curl`，存活用 `kill -0`，均落文件）：

```
USER before: pid=17724 port=51757
  pgrep=[17724 …/node /tmp/m42c-mut/packages/cli/src/main.ts serve doc.html --workspace /tmp/m42c-b/ge/ws --json --port 0;]
  healthz_code=200 body={"ok":true,"uptimeMs":101,"pid":17724}
SHELL after start: app=17739 shell_daemon=17742 user_daemon=17724
  pgrep=[17724 …serve doc.html … --json --port 0;17742 …serve doc.html … --home /tmp/m42c-b/ge/home/Library/Application Support/com.hreader.desktop --json --exit-with-parent --port 0;]
AFTER shell TERM: user_daemon_alive=yes shell_daemon_alive=no
USER healthz after: code=200 body={"ok":true,"uptimeMs":2798,"pid":17724}
pgrep after: [17724 …serve doc.html … --json --port 0;]
user daemon.json=present shell daemon.json=none
CLEANUP user daemon alive=no        ← 我只收了自己起的那个
```

判定：壳退出后用户 daemon 仍活、`/healthz` 200、`daemon.json` 仍在；壳自己那个死、json 清掉。**PASS**。

---

## 6. G-F `daemon.json` 删除语义（事实复述，不当缺陷）

实测（均为隔离 home）：

```
GF dead-pid record: serve exit=3 out={"ok":false,"code":"path_outside_workspace",…} json_after=GONE
GF live-pid record: serve exit=3 out={"ok":false,"code":"path_outside_workspace",…} json_after=present pid_alive=yes
补充：--app-dir /nonexistent（startServer 之前失败）→ json=present
```

**什么情况下会删**：只要 `hr serve` 真正进入 `startServer`，`ensureNoDaemon`（`packages/core/src/server/server.ts:178-182`）就会读 `<home>/.hreader/daemon.json`：

- 记录的 pid **已死**（`staleDaemonOf`）→ `removeDaemonOf` 删掉，再继续启动；**即使后续启动失败**（文档越界、端口冲突等）这条记录也已经被删；
- 记录的 pid **活着** → 保留（端口不通也只留记录继续启动；端口被健康的 hreader 占着才 `daemon_already_running` 拒绝）；
- 在 `startServer` 之前失败的路径（参数解析错误、`--app-dir` 显式不存在）→ **不删**（实测 `json=present`）。

这与上一轮判定一致：是 `ensureNoDaemon` 清理残尸的既定行为，不是缺陷；报告只需写清"启动失败也会删死 pid 记录"。

---

## 7. G-G 边界：`--exit-with-parent` + 启动时 ppid=1

macOS 没有 `setsid(1)`，用等价的"双 fork + `setsid` + 中间父退出"保证 exec 前 ppid 已是 1（同时保留 stdout/stderr 到文件；副本 `main.ts` 临时插桩把 `{launchParentPid, code}` 写文件，随后已还原）。

```
GG --exit-with-parent(explicit): launch+exit=[{"launchParentPid":1,"code":1,"nowPpid":1}]
  out=[{"ok":false,"code":"invalid_input","message":"--exit-with-parent 但启动时父进程已是 init（ppid=1）：父进程在启动窗口期就退了"}]
  err=[同上]  json=none  listeners=0  pgrep=[]
GG control no-flag: daemon_pid=18183 ppid=1 json=present out=[{"ok":true,"data":{…}}] exitfile=[{"launchParentPid":1,"code":0,"nowPpid":1}]
GG control cleanup: alive=no json=none
```

判定：**会被拒启**（退出码 1、`invalid_input`、不建服务/不写 json/不监听），不带旗标时 ppid=1 完全正常启动。这是 R1-P1 的**有意取舍**：`--exit-with-parent` 的语义是"父（壳）消失即自杀"，启动时就已失去父的进程无法再实现该语义，只能 fail-fast；壳路径永远在 spawn 时先采集父 pid，不受影响。副作用是 `nohup`/`setsid`/服务管理器（systemd 的服务 ppid 常为 1）都不能给这条命令加 `--exit-with-parent`。**按当前卡的目标（只服务 GUI 壳）不算缺陷，但必须在文档里写成限制**（§8-R2）。

---

## 8. 未执行清单

| 项 | 状态 | 原因 |
|---|---|---|
| `cargo check/test --target x86_64-pc-windows-msvc` | 未执行 | 本机只有 macOS target；`icon.ico` 的守门只到"仓内字节断言"层（本轮 C4 证明它确实会红） |
| 真 Windows/Linux 运行 | 未执行 | 无对应机器；报告不声称已验证 |
| 真 OOM / `panic=abort` | 未执行 | 只能造 `kill -9`；OOM 需 cgroup/内存压力 |
| AC-20③ 人工双击看正文 | 未重跑 | R1 未改 webview/导航路径；本轮脚本的 `documentBytes`/`w1` 只证进程与 daemon 侧 |
| `pnpm verify` 全量 | 未执行 | 本轮验收只要求 `packages/cli` + e2e；R1 报告已连跑两次 EXIT=0 |
| G-B 0.03/0.3 档的 daemon 生命周期 | 未覆盖 | 父死在 node 启动前，daemon 根本没 spawn（pgrep=0）；真正覆盖"spawn 后未 ready"的是 0.6s 档 |

## 9. 新风险 / 建议（不阻塞本轮 PASS）

1. **R1（测试缺口）**：`default_home()` 的 env 接线无守门——`user_home(var_os("HOME"), None)` 变异后 `r1_default_home_*` 仍绿（§3-C3）。建议加一条"注入 env 映射"的纯函数测试，或让 `default_home()` 接受 `home: Option<OsString>` 参数。
2. **R2（文档约束）**：`--exit-with-parent` 在 ppid=1 时 fail-fast，`nohup`/`setsid`/systemd 场景不可用；应写进 CLI help/README，并明确"本旗标只给 GUI 壳用"。
3. **R3（测试卫生，R1 遗留）**：`packages/cli/tests/units-run.test.ts` 仍写真用户 `~/.hreader/daemon.json`。本轮跑 CLI 套件时它把用户记录覆盖成 `hr-run-*` 残尸，我已用 `/tmp/m42b-b/user-store.before` 字节还原（`cmp` 通过）。建议下一卡给该测试注入 `HOME`/`--home`。
4. **R4（清洁度）**：`packages/desktop/src-tauri/src/lib.rs:147-150` 有两行**重复**的"必须在 `connect()` 之前装上"注释（R1 返工留下的副本），建议删一行。
5. **R5（覆盖说明）**：C2 的守门用例实际在 `units-parent-guard.test.ts`，按文件名找 `units-serve-parent.test.ts` 的人会以为没覆盖；可在文件头注释里互指。

---

## 10. 源树未被污染

```
$ diff /tmp/m42c-baseline-status.txt /tmp/m42c-end-status.txt   # 开工 vs 收尾
（无输出：逐字节一致）
$ git diff --cached --stat
（空：全程没有 git add）
$ diff -rq --exclude=.git --exclude=node_modules --exclude=target /tmp/m42c-mut /Users/liu/Documents/Project/hReader
（无输出：副本已全部还原）
$ pgrep -fl "main.ts serve|hreader-desktop"
（空：无幽灵进程）
```

用户 store：本轮 CLI 套件污染后已按 R1 快照还原（`cmp ~/.hreader/daemon.json /tmp/m42b-b/user-store.before` 通过）。副本 `/tmp/m42c-mut` 与本轮证据目录 `/tmp/m42c-b` 收尾已删除；主树 `packages/desktop/src-tauri/target` 仅被 cargo 增量写入（`gitignore` 内，`git status` 不受影响）。本文件是唯一新增的交付路径。
