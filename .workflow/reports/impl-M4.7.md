# impl-M4.7 — 编写员施工报告（G-1 定位修法 / G-2 诊断 / G-3 扫描 / G-4 审计结论）

> 依据：`.workflow/cards/M4.7.md` §6（D1–D9）、`.workflow/reports/spec-M4.7.md` §2/§3/§4/§6。
> **引号约定（R4 起）：本报告引号内为符号名，行号仅为当时的近似值，以符号为准**（代码拆分会漂行号，`:` 后缀形如 `sse-client.ts:252` 的历史行号只作考古）。
> 本卡只改测试侧（`packages/core/tests/server/**`）；未动 `src` 业务行为、未动 `docs/**`、未 `git add`、未 `push`、未改 `pnpm-lock.yaml`。
> 变异全部按 §11.51-1/-3 执行：`cp` 备份 → 改 → 跑 → `cp` 回 → `cmp -s` 校验（结果见 §5）。

---

## 1 施工对照 D 裁定（逐条落点）

| 裁定 | 落点 | 证据 |
| --- | --- | --- |
| **D1** 契约帧 = `ready`(1) + `error`(2)，第 3 帧是 watcher 的非确定量 | `sse-v4.test.ts:104-126` 只等 `error` 事件，不数帧、不断言总帧数 | `grep -n "waitFor(3)" …` → `NONE` |
| **D2** 两个 API 并存，新代码只用 `waitForEvent` | `sse-client.ts`：`waitFor(n)` 保留（20+ 调用点不动）+ 新增 `waitForEvent(name, deadlineMs?)`；`harness.ts` 头注释写明两者分工 | §2；`harness.ts:1-12` 头注释 |
| **D3** 不动触发器，记已知耦合 | `sse-v4.test.ts:115` 行内注释 + 本文件 §6 | 见 §6 |
| **D4** helper 计入扫描面并单列；`harness.ts:182`/`:238` 本卡修完 | 扫描表第 28/29 行标「本卡已修」 | §4 表 |
| **D5** G-4 降级为审计清单，不进 `verify` | 未新建 `scripts/check-test-timers.mjs`，未动 `verify`（10 步）、未动 `knip.json` | §3；AC-16/AC-17 |
| **D6** 证据强度 + 实话 | 20 连跑 + 全量 ×1（协调者再 ×3）；§7 写明"不宣称偶发已消除" | §7 |
| **D7** 只强在正确的地方 | `failed.status === 500` + `errorFrames` 恰 1 帧 + `data` 含 `io_failure`；**禁止**总帧数、**禁止** `doc.error` | `sse-v4.test.ts:112-121` |
| **D8** deadline < vitest 预算，且由 harness 抛 | `SSE_DEADLINE_MS = 3000`（`sse-client.ts:13`），`waitFor`/`waitForEvent` 都用它；超时 `throw` 带帧清单 | §5 MV-1/MV-4 |
| **D9** 教训入 `docs/03` | 写者是协调者，本卡不碰 `docs/` | 未改 `docs/**` |

### 1.1 一处结构性偏离（需审计确认，不是口径变更）

`packages/core/tests/server/harness.ts` 已到 `max-lines: 300` 门禁边缘，把 G-1/G-2 的新代码（waiter 表 + 诊断 + `waitForEvent`）继续塞进去会直接把 lint 打红。按仓库既有做法（`rawExchangeUntil` 已拆到 `./raw-until`），把**整个 SSE 客户端**拆到新文件 `packages/core/tests/server/sse-client.ts`，`harness.ts` 只做再导出：

```ts
export { openSse, SSE_DEADLINE_MS, type SseFrame } from "./sse-client";
```

后果：**AC-11 的 `clearTimeout` 落在 `sse-client.ts:40`，不在 `harness.ts`**；AC-4 的 `"timeoutMs = 5000"` grep 在 `harness.ts:95` 仍有一处命中，但那是 `rawExchange` 的硬超时（另一函数，命中后 resolve 部分文本，不参与 SSE 等待），`openSse` 默认值已是 `SSE_DEADLINE_MS`。两处都在 §7 风险里点名，供审计判定；口径（D1–D9）未改。

---

## 2 G-1 / G-2 修法与实现要点

`packages/core/tests/server/sse-client.ts`：

| 位置 | 内容 | 对应 |
| --- | --- | --- |
| `sse-client.ts:13` | `export const SSE_DEADLINE_MS = 3000;` + 注释"必须严格小于 5000" | AC-4、D8 |
| `sse-client.ts:29-43` | `connectSse` 返回 `{ socket, disarm }`，`disarm` 里 `clearTimeout(destroyTimer)`；`openSse.close()` 调用它 | AC-11 |
| `sse-client.ts:113-147` | `waitUntil(context, accept, subject, deadlineMs)`：`socket.on("data")` 里唤醒 waiter 表；deadline 到 `reject(new Error(describeTimeout(...)))`；`settle` 里先查 `accept()` 再查 `isClosed()` → reject「连接已关闭」 | AC-7/AC-9/AC-10 |
| `sse-client.ts:88-110` | `describeTimeout`：`SSE 等待超时：<subject>未出现（deadline Xms，订阅建立于 ISO，已收到 N 帧）` + 每帧 `#i +Δms event=<e> id=<id> data=<d>` + `但曾收到 event=<x>` 去重清单 | AC-7/AC-8 |
| `sse-client.ts:150-168` | `waitersOf`：`waitFor(count)` 等"至少 n 帧"；`waitForEvent(event, deadlineMs = timeoutMs)` 等事件名 | D2 |

死代码/遗留检查：轮询 `await new Promise((resolve) => setTimeout(resolve, 10))` 已从 SSE 等待路径删除（`grep "setTimeout(resolve, 10)"` 在 `harness.ts`/`sse-client.ts` → `NONE`）。

`sse-v4.test.ts:104-126` 现在：

```ts
// 5xx 由 fs.chmod 触发，watcher 可能额外插 `doc.error` / `library.changed`：只等 `error` 事件，不数帧。
const errorFrame = await sse.waitForEvent("error");
const errorFrames = sse.frames.filter((frame) => frame.event === "error");

expect(failed.status).toBe(500);
expect(errorFrames).toHaveLength(1);
expect(errorFrame.data).toContain('"io_failure"');
```

单例耗时：**13ms**（基线 122ms；`AC1` 证据见 §7）。

---

## 3 G-4：审计清单结论（按 D5，不进 `verify`）

- **不做门禁**：不新建 `scripts/check-test-timers.mjs`，`pnpm verify` 保持 **10** 步，`knip.json` 零改动。
- **为什么正则化不可行**：`packages/*/tests` 里 45 处 `setTimeout`/`sleep(` 命中中，绝大多数是**合法轮询/deadline helper**（轮询等待 + 超时 throw / 硬超时兜底），与"等固定时长后断言"在文本上完全同形；脚本判别必须做 AST + 数据流（"sleep 后是否无条件 expect"），会同时撞 `max-lines 300` / `complexity 10`，并自己制造假红假绿。
- **allowlist 的成本**：候选点 45 处（且会随新 helper 增长），每次新增轮询 helper 都要改带理由的 JSON —— 正是卡面 §2 G-4 明确排除的"人肉记忆方案"。
- **升级触发条件（二选一，满足任一再议）**：
  1. 扫描表里 `必须改` 类候选点 ≥ **5** 处（当前 2 处，且已在本卡修完，剩 0）；
  2. 出现**第二次**由"靠墙钟"引起的偶发红（第一次 = 卡面 §1 `v4#1b`，2026-11-18）。
  升级时优先方案②（eslint `no-restricted-syntax` 禁 `tests/**` 裸 `setTimeout`，例外走注释豁免）：规则面比 allowlist 窄得多。

---

## 4 G-3 扫描表（`grep -rnE "setTimeout|sleep\(" packages/*/tests --include=*.ts` = 45 行，逐行判定）

> 与 G0 §3 的 31 行的差异解释：G0 把 6 处兜底点合并成 1 行（表内实际 36 条），且未展开 `packages/app/tests/support/**`（3 行）、`packages/mcp-server/tests/probe.ts`（3 行）、`packages/cli/tests/harness.ts`（3 行）。36 + 9 = 45，与本卡 `C8` 输出一致；本卡只把 `harness.ts:182`/`:238` 迁到 `sse-client.ts:29`/`:140`，不增不减。
> 判定口径：`确定性` = 等的是产品常量窗口/事件循环拍子，不是"猜多久够"；`可接受` = 有 deadline 且超时**能说话**（throw/诊断）或纯兜底、断言不依赖具体时长；`必须改` = 无 deadline 的固定时长等待且断言依赖它。

| 文件:行 | 用法 | 判定 | 理由 |
| --- | --- | --- | --- |
| `packages/app/tests/support/main-stubs.ts:218` | `flush(ms)` 默认 0 | 确定性 | 等的是微任务/渲染拍子，`ms` 默认 0，不猜时长 |
| `packages/app/tests/support/boot-harness.ts:174` | `setTimeout(resolve, 0)` | 确定性 | 事件循环一拍 |
| `packages/app/tests/support/boot-harness.ts:175` | 第二拍 | 确定性 | 同上，连两拍让 `await import` 后的副作用跑完 |
| `packages/cli/tests/units-run-home.test.ts:49` | 500×10ms 轮询 + 上限 | 可接受 | 条件驱动，次数上限即 deadline，失败返回 false 由断言说 |
| `packages/cli/tests/chrome-process.test.ts:17` | `sleepOf(ms)` 轮询间隔 | 可接受 | 配 200 次上限 + `throw 等待条件超时` |
| `packages/cli/tests/serve.test.ts:81` | 10s 硬超时 reject | 可接受 | 挂住即红，红在「未打印启动行」 |
| `packages/cli/tests/serve-helpers.ts:53` | `settle()` 50ms 后断言文件已删 | 可接受 | 负断言：等更久只会更稳；50ms 是"`await stop` 后微任务冲刷"的上限 |
| `packages/cli/tests/serve-sse-contract.test.ts:103` | 读帧硬超时 3000 | 可接受 | 到点 abort，断言看内容 |
| `packages/cli/tests/serve-sse-contract.test.ts:170` | `sleep(100)` 后 `patchOnce` | 可接受（**未证实的假设，另立卡核实**） | 「`openEvents` 的 `fetch` resolve 时首帧注释已 flush ⇒ 订阅已建立」是推论、无断言证据；100ms 是否足够属未证。判定仅依据「短了会红在内容断言而非静默绿」 |
| `packages/cli/tests/serve-sse-contract.test.ts:229` | `sleep(100)` 后 `writeFileSync` | 可接受（**未证实的假设，另立卡核实**） | 「同上」即沿用同一未证前提（watcher 路径，断言只看 `library.changed` 内容与路径泄漏） |
| `packages/cli/tests/chrome-session.test.ts:29` | `sleepOf(ms)` | 可接受 | 作为 `timeoutMs` 相关用例的时间入参，不是断言等待 |
| `packages/cli/tests/skill-shell.test.ts:27` | 10s 硬超时 + `clearTimeout` | 可接受 | 挂住即红（`SIGKILL` + 明确文本） |
| `packages/cli/tests/units-run.test.ts:246` | 50ms 后 `release()` 收尸 | 可接受 | 只给 `serve` 一个"起着"的窗口，断言是退出码与输出 |
| `packages/cli/tests/harness.ts:41` | 子进程 `TIMEOUT_MS` 硬超时 | 可接受 | 超时 `reject` 带命令文本 |
| `packages/cli/tests/harness.ts:104` | `let timer: ReturnType<typeof setTimeout>` | 确定性 | 只是类型声明，不是等待 |
| `packages/cli/tests/harness.ts:109` | `withTempDir` race 硬超时 + `finally clearTimeout` | 可接受 | deadline 明确、可清理 |
| `packages/cli/tests/chrome-cdp.test.ts:54` | 200×1ms 轮询 | 可接受 | 条件驱动 + 上限 throw |
| `packages/core/tests/html-inject.test.ts:227` | `sleep(0)` | 确定性 | 等微任务，不是等产品时间 |
| `packages/core/tests/io/node-fs.test.ts:40` | `nodePatchDeps.sleep(1)` | 可接受 | 睡的是**被测 API 的入参**，不是测试在等 |
| `packages/core/tests/io/spawn.ts:41` | 子进程硬超时 + `clearTimeout` | 可接受 | 挂住即红 |
| `packages/core/tests/server/unit-gaps2.test.ts:145` | 3s resolve 兜底 | 可接受 | 兜底 resolve(`close` 通常先到)，不产生静默绿：断言在内容 |
| `packages/core/tests/server/unit-gaps2.test.ts:182` | 3s deadline 轮询 `library.changed` | 可接受 | 条件驱动；**建议**将来改 `waitForEvent`（不在本卡范围） |
| `packages/core/tests/server/raw-until.ts:29` | 硬超时兜底 | 可接受 | 到点 resolve 已收字节，断言立刻说话 |
| `packages/core/tests/server/g3r-branches.test.ts:134` | 2s 兜底 resolve 原始响应 | 可接受 | 断言只看首行 200，2s 兜底只影响慢机器 |
| `packages/core/tests/server/g3r-branches.test.ts:185` | 1s 兜底等 close | 可接受 | 等"连接关掉"这个异步完成信号，兜底不静默绿 |
| `packages/core/tests/server/g39-gaps.test.ts:71` | 3s 兜底 destroy + resolve | 可接受 | 等半开连接的行为，兜底后断言仍执行 |
| `packages/core/tests/server/g39-gaps.test.ts:146` | 30ms 后 `socket.destroy()` | 可接受 | 等"请求已抵达"，无断言绑该时长（随后关服务器） |
| `packages/core/tests/server/sse-client.ts:29` | `destroyTimer` + `disarm`（原 `harness.ts:182`） | **本卡已修** | 原来 5s 后无差别 `destroy()` 且从不 clear（65 连接=65 个泄漏定时器）；现在 `close()` 里 `clearTimeout` |
| `packages/core/tests/server/sse-client.ts:140` | `waitUntil` deadline（原 `harness.ts:238`） | **本卡已修** | 原来 10ms 轮询 + 超时静默 `return frames`；现在事件驱动 + `throw` 带帧清单/订阅时刻/换名提示 |
| `packages/core/tests/server/watcher.test.ts:29` | `sleepOf(ms)` 等去抖窗口 | 确定性 | 等的是产品常量 `DEBOUNCE_MS=100` 窗口，不是猜 |
| `packages/core/tests/server/timeouts.test.ts:32` | `setTimeout(finish, budgetMs)` | 可接受 | 硬超时兜底，budget 是入参 |
| `packages/core/tests/server/g311.test.ts:60` | `waitFor(check, 3000)` 轮询 | 可接受 | 谓词驱动 + deadline |
| `packages/core/tests/server/g311.test.ts:227` | `sleep(250)` 越过 `ECHO_MS=200` | 确定性 | 等产品常量窗口（自写回声），注释已写明依据 |
| `packages/core/tests/server/unit-watcher-daemon.test.ts:34` | `sleepOf(ms)` | 确定性 | 同上，等 `DEBOUNCE_MS` 窗口；断言是"没有/有变化" |
| `packages/core/tests/server/unit-branches.test.ts:99` | 1.5s deadline + 20ms 轮询 | 可接受 | 谓词驱动，超时 `stderr` 打帧清单 |
| `packages/core/tests/server/unit-branches.test.ts:234` | 2s deadline + 10ms 轮询 | 可接受 | 谓词驱动（去抖后的 `changes`），到期由 `expect` 说 |
| `packages/core/tests/server/sse.test.ts:34` | 10ms 轮询 + deadline + `throw` 文本 | 可接受 | 与 harness 同形但是**自带 deadline 与文本**；未合并是因为它测的是 `sse.test.ts` 自己的 helper（跨文件合并不属于本卡范围） |
| `packages/core/tests/server/sse.test.ts:135` | 20ms 轮询 + `throw` | 可接受 | 同上 |
| `packages/core/tests/server/harness.ts:108` | `rawExchange` 硬超时 5000 | 可接受 | 到点 resolve 已收文本，断言立刻说话；**但与 vitest 5000 同值**（残留风险，见 §7） |
| `packages/core/tests/server/lifecycle.test.ts:19` | `socket.setTimeout(1000)` | 可接受 | 硬超时 |
| `packages/mcp-server/tests/probe.ts:91` | 硬超时 | 可接受 | 探针脚本（非门禁用例），超时 reject |
| `packages/mcp-server/tests/probe.ts:171` | `sleep(ms)` helper | 可接受 | 探针脚本的礼让 |
| `packages/mcp-server/tests/probe.ts:276` | 硬超时 | 可接受 | 同 91 |
| `packages/pi-extension/tests/style-guards.test.ts:57` | `sleepOf(ms)` | 可接受 | 注入的假 harness 等调用，断言是调用记录 |
| `packages/pi-extension/tests/sse-fakes.ts:66` | 假 fetch 的 `waitMs` 延迟 | 可接受 | **注入被测行为**（模拟慢流），不是测试在等时间 |

统计：45 行 = `确定性` 6 + `可接受` 37 + `必须改` 0（历史上 2 条「必须改」= 原 `harness.ts:182`/`:238`，本卡已修，故剩 0）。

Rust 侧：`thread::sleep` 仅出现在产品函数体（`supervisor.rs:172`/`:255`、`signals.rs:142`/`:152`/`:210`），`#[test]` 内无命中 ⇒ Rust 侧「必须改」为空（与 G0 AC-14 一致）。

---

## 5 变异自证（MV-1…MV-5，三件套 = 命令 + `EXIT=` + 命中行）

每次：`cp <file> /tmp/<file>.mvN.bak` → 改 → 跑 → `cp /tmp/...bak <file>` → `cmp -s` → `RESTORED_SAME`。**未用管道吞退出码**（用 `>log` 再 `grep`，退出码另取）。

### MV-1 删 deadline（`waitUntil` 的 timer 不再 reject）

- 命令：`python3` 把 `reject(new Error(describeTimeout(...)))` 换成 `setTimeout(() => undefined, deadlineMs)`，再 `npx vitest run packages/core/tests/server/zz-probe-m47.test.ts -t "AC-7"`。
- `EXIT=1`，命中行：

```
7:     → Test timed out in 5000ms.
16:Error: Test timed out in 5000ms.
```

- 结论：deadline 是唯一挡住"永久等"的东西；没有它，人看到的又回到 vitest 的 `Test timed out`（AC-7 的文本来源确实是 harness）。回滚：`RESTORED_SAME`。

### MV-2 `server.ts` 的 `publish("error"` → `publish("errors"`

- 命令：`python3` 替换 `env.hub.publish("error", {` → `env.hub.publish("errors", {`（第 1 处），`grep -n 'publish("errors"' src/server/server.ts` → `159:        env.hub.publish("errors", {`；跑 `npx vitest run packages/core/tests/server/sse-v4.test.ts`。
- `EXIT=1`，命中行：

```
15:但曾收到 event=errors
22: FAIL  packages/core/tests/server/sse-v4.test.ts > v4#1b · 5xx 广播成 error 事件 > should broadcast an error frame instead of silently dropping the stream
29:但曾收到 event=errors
44:      Tests  1 failed | 3 passed (4)
```

- 结论：红在 `waitForEvent("error")` 的 harness 诊断（`但曾收到 event=errors`）+ 随后的 `errorFrames` 断言，正是 D7 要的位置。回滚：`RESTORED_SAME`，`159:        env.hub.publish("error", {` 复原。

### MV-3 `waitFor` 首行直接 return

- 命令：把 `waitersOf.waitFor` 换成 `waitFor: () => Promise.resolve(context.frames)`，跑 `npx vitest run packages/core/tests/server/sse-v4.test.ts packages/core/tests/server/sse.test.ts`，再跑整个 `packages/core/tests/server`。
- `EXIT=1`，命中行（整个目录）：

```
 FAIL  packages/core/tests/server/sse.test.ts > sse · ready 与事件 > should emit the byte-exact ready frame first
 FAIL  packages/core/tests/server/sse.test.ts > sse · Last-Event-ID 过期 > should send reset(events_expired) when the id fell out of the ring
 FAIL  packages/core/tests/server/sse.test.ts > sse · 连接上限 > should keep the client table clean after streams close
 FAIL  packages/core/tests/server/unit-branches.test.ts > runtime · 注入 watch 的广播分支 > should broadcast library.changed for an unrelated file and doc.error for a vanished doc
 FAIL  packages/core/tests/server/unit-branches.test.ts > runtime · 注入 watch 的广播分支（续） > should stay silent when the file is rewritten with identical content
      Tests  8 failed | 409 passed (417)
```

- 结论：≥4 条红（实际 8 条，含探针自身 3 条）⇒ `waitFor` 不是装饰。回滚：`RESTORED_SAME`。

### MV-4 超时 `throw` → `return frames`（删诊断）

- 命令：timer 回调改为 `resolve(context.frames as unknown as T)`；跑 `npx vitest run packages/core/tests/server/zz-probe-m47.test.ts -t "AC-7"`。
- `EXIT=1`，命中行：

```
6:<未抛错>
9:     → expected '<未抛错>' to contain '第 99 帧未出现'
```

- 结论：没有 `throw` 时 `waitFor(99)` 静默返回帧，AC-7 的帧清单/事件名**完全拿不到** ⇒ G-2 是独立能力，不被 G-1 顺带满足。回滚后 4 条探针全绿（`EXIT=0`）：`Tests  4 passed (4)`。

### MV-5 阴性对照：数帧式弱断言

- 命令：探针里把 `event === "error"` 换成 `frames.length >= 2`（`await sse.waitFor(2)` + `expect(frames.length >= 2)`），在 MV-2（`publish("errors")`）状态下跑。
- `EXIT=0`，命中行：

```
5:MV5 frames=["ready","errors"]
9:      Tests  1 passed | 3 skipped (4)
```

- 结论：**数帧式断言在事件名错时仍绿** ⇒ AC-2 的 `grep 'event === "error"'` 是必要门禁，D7 的强断言不是形式主义。回滚：`RESTORED_SAME`（`cmp -s` 已验）。

探针文件 `packages/core/tests/server/zz-probe-m47.test.ts` 跑完即 `rm` 删除，不留在仓库（`git status` 无该文件）。

---

## 6 已知耦合与残留风险（D3 要求写清）

- **`v4#1b` 的 5xx 由 `fs.chmod(0o000)` 触发**，会经 `fs.watch` → `DEBOUNCE_MS=100` 额外产生 `library.changed` / `doc.error`（后者 10/10 在 ~193ms，前者会丢 2/10）。因此本用例**只看 `error` 事件的存在与内容**（恰 1 帧 `error` + `data` 含 `io_failure`），**不看总帧数**、不断言 `doc.error`。将来若把触发器换成"不动 workspace"的方式，属于换产品路径，另立卡。
- **AC-4 的 grep 在 `harness.ts` 曾命中 `timeoutMs = 5000`**：那是 `rawExchange` 的硬超时（另一函数，超时 resolve 已收文本，不参与 SSE 等待），原与 vitest 5000 同值；**R2 已改为共用 `HTTP_DEADLINE_MS = 4000`（`harness.ts:86`），见 §R2-2**。`openSse` 的 `timeoutMs` 默认参数（`SSE_DEADLINE_MS`）。
- **行号误引已改符号引用**（审计 P2-f → R4-4）：不再引用 `openSse` 默认参数的行号（旧称 `:145`/`:177`/`:252`/`:263` 全部作废），一律写「`openSse` 的 `timeoutMs` 默认参数（`SSE_DEADLINE_MS`）」与「`openSse` 返回的 `close()`」。
- **AC-11 的 `clearTimeout` 落在 `sse-client.ts:40`**（结构拆分所致，见 §1.1）。

---

## 7 验收证据（命令 / 退出码 / 关键行）

| 编号 | 命令 | 退出码 | 关键行 |
| --- | --- | --- | --- |
| AC-1 | `npx vitest run packages/core/tests/server/sse-v4.test.ts -t "should broadcast an error frame" --reporter=verbose` | `EXIT=0` | `✓ … should broadcast an error frame … 13ms`；`Tests  1 passed | 3 skipped (4)` |
| AC-3 | 同上（耗时行） | `EXIT=0` | `13ms`（基线 122ms） |
| AC-2 | `grep -n "waitFor(3)" packages/core/tests/server/sse-v4.test.ts \|\| echo NONE`；`grep -n 'event === "error"' …` | — | `NONE`；`118:      const errorFrames = sse.frames.filter((frame) => frame.event === "error");` |
| AC-4 | `grep -n "SSE_DEADLINE_MS = " packages/core/tests/server/sse-client.ts`；`grep -n "timeoutMs = 5000" …` | — | `13:export const SSE_DEADLINE_MS = 3000;`；`sse-client.ts` 无命中（`harness.ts:95` 是 `rawExchange`，见 §6） |
| AC-5 | `for i in $(seq 20); do npx vitest run packages/core/tests/server/sse-v4.test.ts >/tmp/sse.$i.log 2>&1; echo "run=$i EXIT=$?"; done` | 20×`EXIT=0` | `TOTAL_FAIL=0`；末轮 `Tests  4 passed (4)` / `Duration 349ms` |
| AC-7 | 探针 `waitFor(99)`（见 §5，已删） | `EXIT=0` | `AC7 elapsed=3002` + `SSE 等待超时：第 99 帧未出现（deadline 3000ms，订阅建立于 …，已收到 3 帧）` + 逐帧清单 + `但曾收到 event=ready` |
| AC-8 | 探针 `waitForEvent("errors")` | `EXIT=0` | `event=errors未出现` + `#2 +5ms event=error id=1 data={"code":"io_failure",…,"status":500,…}` + `但曾收到 event=error` |
| AC-9 | `grep -rn "setTimeout(resolve, 10)" harness.ts sse-client.ts \|\| echo NONE` | — | `NONE` |
| AC-10 | 探针 `close()` 后 `waitFor(1)` | `EXIT=0` | `AC10 elapsed=0` / `连接已关闭：第 1 帧未出现（已收到 0 帧）` |
| AC-11 | `grep -n "clearTimeout" sse-client.ts` | — | `40:      clearTimeout(destroyTimer);`（+ `123:` deadline 清理） |
| AC-12/13 | `grep -rnE "setTimeout\|sleep\(" packages/*/tests --include=*.ts \| wc -l` | — | `45`；§4 表 45 行逐条判定，`必须改` 剩 0 |
| AC-14 | `grep -rn "thread::sleep" packages/desktop/src-tauri/src` | — | 5 处，全在产品函数体内，`#[test]` 无 |
| AC-15 | `grep -rn "retry:" packages/*/tests --include=*.test.ts`；`git diff --stat pnpm-lock.yaml \| wc -l` | — | 只命中帧文本/`expect` 字符串（`sse-frames.test.ts:107`、`protocol-pins.test.ts:116-117`）；lockfile `0` |
| AC-16 | `node -e 'console.log(require("./package.json").scripts.verify.split("&&").length)'` | `0` | `10` |
| AC-17 | `ls scripts/check-test-timers.mjs` | `1` | `No such file or directory` |
| AC-19 | `grep -n "harness.ts:18[0-9]\|harness.ts:23[0-9]" .workflow/reports/impl-M4.7.md` | — | §4 第 28/29 行均标「本卡已修」，并给出新位置 `sse-client.ts:29`/`:140` |
| 全量 | `pnpm verify` | `EXIT=0` | `Test Files  265 passed (265)` / `Tests  2971 passed (2971)` / `All files` 四维全 `100` |
| 桌面 | `rm -rf packages/desktop/dist && pnpm desktop:check` | `EXIT=0` | `test result: ok.`（含 `Doc-tests hreader_desktop … 0 passed; 0 failed`） |

**D6 的实话**：观测到的偶发率约 1/5 次全量跑（卡面 §1）。本卡**不宣称"偶发已消除"**——不可证伪；本卡给的是两条可检验的机制结论：①用例不再等待非确定量（`doc.error`/`library.changed` 不再进入期望，`waitFor(3)` 已不存在）；②下次再偶发时，失败文本自带帧清单、订阅时刻与"是否换了 event 名"，不必靠重跑到绿来消化。

---

## 8 变更文件

- `packages/core/tests/server/sse-client.ts`（新增）：SSE 客户端 + 事件驱动 waiter + deadline 诊断 + `waitForEvent`。
- `packages/core/tests/server/harness.ts`（改）：删掉旧 SSE 实现与 10ms 轮询；改为从 `./sse-client` 再导出；头注释写清两个 API 的分工。
- `packages/core/tests/server/sse-v4.test.ts`（改）：`v4#1b` 改 `waitForEvent("error")` + D7 强断言 + D3 耦合注释。

## R2

> 依据：`.workflow/reports/audit-M4.7.md`（P1×1 + P2×5）与 `.workflow/reports/test-M4.7.md`（R2×1 真 SURVIVED）。
> 未 `git add` / 未 `push` / 未动 `docs/**` / 未改 `src` 行为。

| 项 | 做法 | 与审计/终测的关系 |
| --- | --- | --- |
| **R2-1**（P1）| 新增 `SOCKET_LIFE_MS = 30_000`（模块内 const，不导出），`connectSse` 的 `destroyTimer` 改用它；等帧上限仍是 `SSE_DEADLINE_MS = 3000`，两者在文件头写成「两个时钟，别混」 | 照做：P1 的「3s 无差别销毁」消除 |
| **R2-2**（P2）| `harness.ts` 抽 `HTTP_DEADLINE_MS = 4000`，`rawExchange` 默认参数与 `httpCall` 的 `listen ?? …` 共用；注释写「必须 < vitest 5000，否则断言文本出不来」 | 照做，**只有时钟变**，`rawExchange` 静默 resolve 部分文本的行为未动 |
| **R2-3**（P2）| `sse-client.ts` 加 `wireSse()`：`data` 喂帧；`error` → `shutdown("socket 错误：…")`；`close` → `shutdown("socket 已关闭")`。`shutdown` 是唯一关停入口（幂等，与 `close()` 共用），reject 文本带原因 | 照做：所有 socket 错误（实测打的是 `ECONNREFUSED`，与 `ECONNRESET` 同一条 `error` 分支）不再成 unhandled 'error'，也不再等满 deadline |
| **R2-4**（终测 R2）| **改做法（方案 B，已向主管报备并获批）**：不保留 `activeSocketTimers()` 计数——实测把 `close()` 里 `clearTimeout` 注释掉，计数仍 3→0，那是装饰性自证。改为用例装 `vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout"] })`，断言 `vi.getTimerCount()` 的 delta：开 3 条 ⇒ 基线 +3；`close()` 后 ⇒ 回到基线；`finally` 里 `vi.useRealTimers()` | 改做法理由：终测判据是「注释 `clearTimeout` ⇒ 红」，计数式做不到；`vi.getTimerCount()` 是真实待执行定时器数，变异必红 |
| **R2-5**（P2，文档）| ①`harness.ts:5` 分工注释压成一行指向 `./sse-client`（不再与 `sse-client.ts:3-9` 逐字重复）；②`sse-client.ts` 头加「`Date.now()` 仅用于诊断时间戳，不参与断言（`docs/04` 的例外）」；③G-3 表 `serve-sse-contract.test.ts:170/229` 判定理由降级为「**未证实的假设，另立卡核实**」；④行号误引 `sse-client.ts:145` → 声明为 `:177`（R1 基线，R2 后已拆到别处）；⑤§6 里「`harness.ts:95` 仍是 5000」那条残留风险改标为 R2 已修 | 照做 |

### R2 连带修复（R2-2 的必然后果，未知会即 EXIT≠0）

`packages/core/tests/server/wire-http.test.ts:64` 的 `it.fails("should answer a truncated (EOF) request close, not hang")` 原先隐含依赖「`rawExchange` 的 5000 恰好不早于 vitest 的 5000」：超时静默 resolve 出空串 → 旧断言 `raw === "" || /^… 4/` 判空串为合格 → 用例体意外通过 → `it.fails` 报错。时钟收到 4000 后这条必然暴露（首次 `pnpm verify` 即 `Test Files 1 failed`，`× … 4006ms`）。改为只认 4xx：

```ts
// 半截体不能变成 200，必须有明确 4xx；空串是两义的（关连接 / `rawExchange` 超时信号），不认。
expect(raw).toMatch(/^HTTP\/1\.[01] 4/u);
```

语义更严（不再让 harness 的超时替被测行为背书），且 `it.fails` 现在稳定红在 4012ms 而不是卡在 vitest 5000 的竞速上。

### R2 验收证据

| # | 命令 | 结果 | 关键行 |
| --- | --- | --- | --- |
| R2-1① | `cp` 备份 → `sse-v4.test.ts:86` 插 `await new Promise((resolve) => setTimeout(resolve, 3500))`（在 64 条 `waitFor(1)` 之后、`httpCall` 之前）+ `SOCKET_LIFE_MS` 临时 `30_000`→`3000` → `npx vitest run … -t "should answer 429"` | `EXIT=1` | `× v4#1c · 第 65 个连接 > should answer 429 … 7533ms` / `→ HTTP 请求超时`（`harness.ts:165`）。复现审计 P1：活过 3s 的连接被兜底销毁，hub 名额被释放，第 65 条不再 429 |
| R2-1② | 同上，`SOCKET_LIFE_MS` 改回 `30_000` | `EXIT=0` | `✓ … should answer 429 … 3533ms`（含 3500ms 睡眠，仍在用例 30s 预算内） |
| R2-1③ | `cp` 回原 `sse-v4.test.ts` → `cmp -s` | `0` | `cmp_v4_back=0`；`grep -n "3500"` ⇒ `no_sleep_left` |
| R2-4① | `cp` 备份 → `sse-client.ts` `disarm()` 里 `clearTimeout(destroyTimer)` 注释掉 → `npx vitest run … -t "socket life timer"` | `EXIT=1` | `× R2 · 兜底定时器与断连自证 > should clear one socket life timer per connection on close` / `→ expected 3 to be +0` |
| R2-4② | `cp` 回 → `cmp -s` ⇒ `0`，再跑同用例 | `EXIT=0` | `✓ … 10ms` |
| 20 连跑 | `for i in $(seq 20); do npx vitest run packages/core/tests/server/sse-v4.test.ts …` | 20×`EXIT=0` | `TOTAL_FAIL=0`；末轮 `Tests  7 passed (7)` |
| v4#1c 单跑 | `npx vitest run … -t "should answer 429"` | `EXIT=0` | `Tests  1 passed, 6 skipped (7)` |
| 全量 | `pnpm verify` | `EXIT=0` | `Test Files  265 passed (265)` / `Tests  2974 passed (2974)` / `All files` 四维全 `100` |
| 桌面 | `rm -rf packages/desktop/dist && pnpm desktop:check` | `EXIT=0` | `test result: ok. 81 passed; 0 failed; …`（多 target 全 ok） |

R2 期间另有一条真实失败被这条链路抓住并修好：`wire-http.test.ts` 的 `it.fails`（见上「连带修复」）——首次 `pnpm verify` `EXIT=1`，修复后 `EXIT=0`。

### R2 变更文件（增补）

- `packages/core/tests/server/wire-http.test.ts`（改）：`it.fails` 的半截请求断言只认 4xx，去掉「空串也算合格」的两义判定。

## R3

审计 R2 的 P1（`silentResolve`）+ 4 条 P2 + 终测 G3′，逐条落：

| 项 | 改法 | 证据 |
| --- | --- | --- |
| **R3-1**（P1，假绿 + 过期前提） | `wire-http.test.ts` 的半截请求用例从 `it.fails` 转成**普通 `it`**：不再借 `rawExchange` 的 4000ms 静默空串，改用新助手 `halfClosedExchange()`（`node:net` 的 `connect`，写完半截请求体后 `socket.end()` **半关**写端——只发 FIN，仍能读响应；自带 1500ms 兜底并把已收字节打进错误文本）。断言 `^HTTP/1.1 400` + 耗时 < 1000ms | `npx vitest run … -t "truncated" --reporter=verbose` ⇒ `✓ … fast instead of hanging 12ms`，`EXIT=0` |
| **R3-2**（P2-2，同值抢答） | `sse-client.ts:25` 的 `SOCKET_LIFE_MS`：`30_000` → `60_000`，注释写明「必须严格大于任何 per-test 预算」 | 20 连跑无 `Test timed out` |
| **R3-3**（P2-4 + M-3a） | ①`ECONNREFUSED` 用例改连保留端口 `127.0.0.1:1`（删掉 `freePort()`：`bind` 后立刻 `close` 有被内核复用的窗口）；断言放宽到 `rejects.toThrow(/连接已关闭（socket 错误：/u)`，不锚死 errno。②M-3a：给 `sse-v4.test.ts` 的「服务端先断连」用例补三条幂等断言（`close()` 连调两次不抛、`frames` 在 `close()` 后仍可读、重复 `waitFor` 仍报第一次的关闭原因「socket 已关闭」而不是被覆盖成显式关闭） | 见下「变异 B」 |
| **R3-4**（文档） | `impl-M4.7.md:213,214` 与 `R2-5` 行里的行号订正（后由 R4-4 统改为符号引用：「`openSse` 的 `timeoutMs` 默认参数（`SSE_DEADLINE_MS`）」、「`openSse` 返回的 `close()`」）；`R2-3` 行把「`ECONNRESET` 已被捕获」改成「所有 socket 错误（实测打的是 `ECONNREFUSED`，同一 `error` 分支）」 | 本文件 |
| **KD-07 退表** | 半截请求不再挂住 ⇒ 按 `.workflow/known-defects.md` 规则 4（删 `it.fails` → 转正向断言 → 删行 → 下调 CAP）退掉 KD-07 行，`CAP` 10 → 9，并在表下留一行退表说明 | `known-defects-registry.test.ts` 6 passed；`pnpm verify` 265 files / **2974** tests / 四维 100% |

### R3-1 的真相：`aborted` → 408 **线上不可达**（推翻审计/终测的共同前提）

三个人（协调者、审计、终测）都按「`chunksOf` 监听 `aborted` 后 `reject(new HttpFault(408, "连接在请求体读完前断开"))`，所以半截请求该回 408」推过。**实测不成立**。主树源码零改动，探针打原始响应：

```
HALF ms=3 raw="HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
```

在 `/tmp` 副本给 `chunksOf` 加日志后，服务端顺序是：

```
clientError Parse Error      ← Node 内置 parser：HPE_INVALID_EOF_STATE
req aborted
req error aborted
```

即 `aborted` **确实 fire**，但 Node 的 HTTP parser 把「Content-Length 未读满就收到 FIN」先判 Parse Error，默认 `clientError` 处理**已把 `HTTP/1.1 400 Bad Request` 写死并 destroy socket**；而 `grep clientError packages/core/src/server/` **零命中**（`server.ts` 没有 `clientError` 监听），于是 `chunksOf` 的 408 分支永远抢不到响应。用 `destroy()` 发 RST 更糟：客户端一个字节也读不到。

结论（写进用例注释，三段）：① 线上真行为是 3ms 裸 400，不是 408；② 那条 10s 的 `408 请求体读取超时` 只对「客户端保持连接不发 FIN」成立，与半关是两条路径；③ 用例只锚「400 + 快」，将来把 `clientError` 映射成 JSON 错误体时它仍应绿（不为「变对了」而红）。

### R3 新产品发现（不改 `src/**`，另立卡候选）

`packages/core/src/server/server.ts` **没有 `clientError` 监听** ⇒ 任何被 Node parser 判为坏请求（半截体、坏请求行、坏头）的连接只得到**裸 `HTTP/1.1 400 Bad Request`、无 `Content-Type`、无 JSON 错误体**，违反 `docs/` 的错误契约（错误响应应是 `{ code, message }` 的 `invalid_request`）。触发条件写死：任何卡要动 `server.ts` 的请求入口、或前端开始解析 400 响应体时，必须补 `server.on("clientError", (err, socket) => …)` 并按契约写 JSON。

### R3 变异证据

| # | 手法 | 结果 | 判定 |
| --- | --- | --- | --- |
| **A** | `/tmp` 副本里删 `http-io.ts` 的 `req.on("aborted", …)` 整块 → 跑 `-t "truncated"` → `cp` 回 → `cmp -s` ⇒ `0` | 仍 `EXIT=0`、`✓ … 12ms` | **对本用例无鉴别力，故不采用**：响应由 Node `clientError` 产生，删 `aborted` 分支不影响「400 + 快」。按协调者口径**不留一对假装跑过的变异**，此条只作「为什么不能拿它当转正判据」的记录 |
| **B** | `/tmp` 副本里删 `sse-client.ts` `shutdown()` 的 `if (closed) return;` → 跑 `-t "idempotent"` → `cp` 回 → `cmp -s` ⇒ `0`，再跑 ⇒ `EXIT=0` | 红：`× … should reject when the server ends the stream, then stay idempotent on repeated close 7ms` / `→ expected [Function] to throw error including '连接已关闭（socket 已关闭）' but got '连接已关闭：第 1 帧未出现（已收到 0 帧）'` | 采用：第二次 `close()` 没被守卫拦住，把「socket 已关闭」覆盖成显式关闭（`""`），断言立刻抓到 ⇒ **M-3a 被杀死** |

### R3 终测幸存变异：**M-4 / M-5 不修**（不是 PASS）

- **M-4**（`harness.ts` 的 `HTTP_DEADLINE_MS` 改回 5000 仍绿）：`4000` 是**默认值**，无行为可观察——没有任何用例在 4000–5000ms 区间里区分「deadline 到点」与「墙钟兜底」；要观察它必须造一条真等 4s 的用例（全量 `verify` 已 75–81s，不值得）。故不修，登记为「默认值，无断言覆盖」。
- **M-5**（`sse-v4.test.ts` 的 `vi.useFakeTimers({ toFake: [...] })` 改成全量 `toFake` 仍绿）：`toFake` 只影响**诊断时间戳**（`sse-client.ts` 的 `Date.now()` 仅进错误文本），而没有任何用例断言那个时间戳。故不修；若将来有人拿时间戳做判据，这条变异立刻会红——届时补一条断言即可。

### R3 验收命令与结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 新用例单跑 | `npx vitest run packages/core/tests/server/wire-http.test.ts -t "truncated" --reporter=verbose` | `EXIT=0`；`✓ wire · 半截请求（KD-07 记账） > should answer a truncated (EOF) request close fast instead of hanging 12ms` |
| 变异 A | 见上表 | `EXIT=0`（无鉴别力，记录在案） |
| 变异 B | 见上表 | `EXIT=1` → 恢复后 `EXIT=0`，`cmp -s` = `0` |
| `sse-v4.test.ts` 20 连跑 | `for i in $(seq 20); do npx vitest run …/sse-v4.test.ts; done` | 20/20 `EXIT=0`，`V4_FAIL=0`，无 `Test timed out` 日志 |
| `wire-http.test.ts` 5 连跑 | `for i in $(seq 5); do npx vitest run …/wire-http.test.ts; done` | 5/5 `EXIT=0`，每轮 `Tests  13 passed (13)` |
| 全量 | `pnpm verify` | `EXIT=0`；`Test Files  265 passed (265)` / `Tests  2974 passed (2974)` / `All files` 四维全 `100` |
| 桌面 | `pnpm desktop:check` | `EXIT=0` |

例数说明：R3 只把 `it.fails` 转成 `it`（例数不变）、在既有断连用例上**加断言**而非新增用例，并把两个膨胀的 `describe` 拆开（`wire · 半截请求（KD-07 记账）`、`R2 · 断连自证` 保持 ≤40 行以满足 `max-lines-per-function`），所以总数仍是 **2974**。

### R3 变更文件

- `packages/core/tests/server/wire-http.test.ts`（改）：新增 `halfClosedExchange()` 助手；半截请求用例 `it.fails` → `it`，断言 `400` + 耗时 < 1000ms，注释改写为事实三段；用例拆到独立 `describe`。
- `packages/core/tests/server/sse-v4.test.ts`（改）：`ECONNREFUSED` 用例改连端口 1 + 放宽断言；「服务端先断连」用例补幂等三条断言；抽 `withEndingServer()` 助手（两条断连用例共用，避免重复 setup）。
- `packages/core/tests/server/sse-client.ts`（改）：`SOCKET_LIFE_MS` 30_000 → 60_000。
- `.workflow/known-defects.md`（改）：KD-07 退表，`CAP` 10 → 9。
- `.workflow/reports/impl-M4.7.md`（本文件）：R3 记录 + 行号/措辞订正。

## R4

终审（`audit-M4.7-R3.md`，**ACCEPT**，P0=0 / P1=0 / P2=5）与终测 `test-M4.7.md` 的 `## G3″` 之后的**不改行为**收尾。

| 项 | 改了什么 | 依据 | 证据方式 |
| --- | --- | --- | --- |
| **R4-1** | `sse-v4.test.ts`「服务端先断连」用例删掉两条恒真断言：`expect(() => { sse.close(); sse.close(); }).not.toThrow()` 与 `expect(sse.frames).toHaveLength(0)`；两次 `close()` 调用保留（是动作，不是断言），只留「重复 `waitFor` 仍报第一次原因」那条状态断言。新增两行注释说明「幂等由 `waitFor` 状态断言覆盖；`not.toThrow()` 恒真（`close()` 只做 `shutdown("")` + `socket.destroy()`，都不抛）、`frames` 长度也恒为 0（该场景服务端从不下发帧）」 | P2-4 | 变性复核：注释 `sse-client.ts` 的 `shutdown()` 里 `if (closed) return;` ⇒ 该用例仍红（见下表），证明删掉恒真断言后判据还在；`cmp -s` 复原 = `0` |
| **R4-2** | `wire-http.test.ts` 的 `halfClosedExchange()` 的 `error` 分支改自述：若 `raw()` 已含状态行（`/^HTTP\/1\.[01] /u`）则 `resolve(raw())`（服务端已写完 400，之后 `destroy()` 触发 RST 不该算失败）；否则 `reject(new Error(\`半截请求：socket 错误 ${error.message}；raw=${JSON.stringify(raw())}\`))`，不再把裸 `ECONNRESET` 当结果 | P2-2 | 该用例（`-t "truncated"`）仍绿 17ms；失败路径的文本已含机制 + 已收字节 |
| **R4-3** | `sse-v4.test.ts` 兜底定时器用例的注释：「三条 30s 兜底定时器」→「三条 60s 兜底定时器」，与 `SOCKET_LIFE_MS = 60_000`（`sse-client.ts`）一致 | P2-3 | `grep -n "60s 兜底定时器"` 命中；代码零改动 |
| **R4-4** | `§6` 两条行号条改**符号引用**：「`openSse` 的 `timeoutMs` 默认参数（`SSE_DEADLINE_MS`）」「`openSse` 返回的 `close()`」，旧引用 `:145`/`:177`/`:252`/`:263` 全部声明作废；`R2-5`/`R3-4` 两行同步；文件头加约定「本报告引号内为符号名，行号仅为当时的近似值，以符号为准」——**不再修成另一个会漂的行号** | P2-1 | `grep -n ":252\|:263"` ⇒ 只剩「作废」声明本身 |
| **R4-5** | 下方「R4 新产品发现」两条登记（`rawExchange` 超时静默 resolve / `server.ts` 无 `clientError`），并同步 `.workflow/state.md` 的「待办（另立卡候选）」 | P2-5 | 两处文本可 grep；**不**声称已修 |

### R4 新产品发现（不改 `src/**` / `harness` 行为，另立卡候选）

- **`rawExchange`/`httpCall` 超时静默 resolve 部分文本**（`packages/core/tests/server/harness.ts`）：deadline 到点走 `resolve(Buffer.concat(chunks))`，可能是 `""` ⇒ 失败文本「空串/半截」说不出是「服务端挂住」还是「超时」。D8「超时必须自述」对 HTTP 路径的延伸 ⇒ **待立卡，未修**。
- **`server.ts` 无 `clientError` 监听**：半截/坏请求只得到裸 `HTTP/1.1 400 Bad Request`，无 `Content-Type`、无 `{ code, message }` 错误体（可能违 `docs/` 的错误契约）。

### R4 验收命令与结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 单文件 20 连跑 | `for i in $(seq 20); do npx vitest run packages/core/tests/server/sse-v4.test.ts; done` | 20/20 `EXIT=0`，`Tests 7 passed (7)`，`V4_FAIL=0`；末三行 `Duration 349ms / 349ms / 349ms`（`tests 34ms`） |
| 变异（幂等判据仍在） | 注释 `sse-client.ts` 的 `shutdown()` 内 `if (closed) return;` → `npx vitest run … -t "idempotent"` → `cp` 回 → `cmp -s` | 红：`× … should reject when the server ends the stream, then stay idempotent on repeated close` / `→ expected [Function] to throw error including '连接已关闭（socket 已关闭）' but got '连接已关闭：第 1 帧未出现（已收到 0 帧）'`，`MUT_EXIT=1`；复原后 `CMP=0`、`EXIT=0` |
| 全量 | `pnpm verify` | `EXIT=0`；`Test Files 265 passed (265)` / `Tests 2974 passed (2974)` / `All files` 四维 `100`；depcruise 578 模块 2394 依赖 0 违规；knip 静默 |
| 桌面 | `pnpm desktop:check` | `EXIT=0` |

### R4 变更文件

- `packages/core/tests/server/sse-v4.test.ts`（改）：删 2 条恒真断言 + 说明注释；兜底定时器注释 30s → 60s。
- `packages/core/tests/server/wire-http.test.ts`（改）：`halfClosedExchange()` 的 `error` 分支按「有状态行就收尾、否则自述」分流。
- `.workflow/reports/impl-M4.7.md`（本文件）：R4 记录 + 行号改符号引用 + 引号约定。
- `.workflow/state.md`（改）：「待办（另立卡候选，M4.7 R4 登记）」两条。
