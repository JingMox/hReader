# audit-M4.7-R2 — 审计员 G2′（审 R2 产物）

> 审计会话无写工具，本文由协调者按会话产物落盘（原文未改）。口径：`.workflow/cards/M4.7.md` §6 D1–D9 + 上一轮 `.workflow/reports/audit-M4.7.md`。

---

## 判决：CHANGES-NEEDED（P0=0 / P1=1 / P2=4）

> 我无写入工具，产物即本回复，请协调者落 `/tmp/audit-M4.7-R2.md` 或 `.workflow/reports/audit-M4.7-R2.md`。本轮只读：未改仓库、未 `git add`、未跑任何命令。
> 改动面（`watchdog_diff --stat`）：`harness.ts`(+/-)、`sse-v4.test.ts`(+)、`wire-http.test.ts`(4 行) + untracked `sse-client.ts` + 5 份 `.workflow` 报告。`docs/**`、`src/**`、`package.json`、`knip.json`、`pnpm-lock.yaml` **零改动**。

### R2-1 两个时钟 —— PASS
- 语义分离成立：`sse-client.ts:22` `SSE_DEADLINE_MS = 3000`（等帧上限，`openSse` 默认值 `:252` 只喂给 `waitersOf`）；`sse-client.ts:25` `SOCKET_LIFE_MS = 30_000`（唯一用途 `:40` `setTimeout(() => socket.destroy(), SOCKET_LIFE_MS)`）。两者不再互相污染。
- 「30s 是不是泄漏」——**不是**。逐路径核过：显式 `close()`（`:259-262`）先 `link.shutdown("")`（`:237-243`，内部 `disarm()` → `:51 clearTimeout`）再 `socket.destroy()`；socket `error`/`close`（`:197-202`）同样走 `shutdown` ⇒ `disarm()`。**没有任何路径在 `close()` 之后还活着 30s**，定时器只是后到的 no-op/被 clear。反比 R1 更强：现在连「服务端先断连」也会 disarm（R1 只在 `close()` 里清）。
- 文件头 `sse-client.ts:9-15` 把「两个时钟，别混」写清（各自动机 + 3000 < 5000 的理由 + 「`close()` 里 clear」），`:15` 明写 `Date.now()` 仅用于诊断时间戳、不参与断言。D8 的「超时由 harness 抛」未被削弱（`:139-142`）。

### R2-4 方案 B（假定时器 delta）—— PASS（含变异，待实跑复核）
- 计数式自证删干净：`grep -rn "activeSocketTimers|activeTimers"` → **仅 `impl-M4.7.md:262` 的叙述文字**，代码零命中。
- `toFake` 只两项：`sse-v4.test.ts:197` `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })`——**只这两项**，`Date` 仍真实（诊断时间戳不被冻结），socket 真实事件不受影响。
- `finally` 复原：`:209` `vi.useRealTimers()`，在 `try` 外、`await boot.close()` 之前 `:208-210`。
- 基线时序正确：`:199` 取 `baseline` 在 `:197` 之后，`:204` 断言 delta（开 3 条 ⇒ +3），`:207` 断言回到基线 ⇒ **两侧都能红**（少建定时器 → `:204` 红；不 clear → `:207` 红）。
- **变异判读（我给结论，实跑仍待补）**：注释 `sse-client.ts:51` 的 `clearTimeout` ⇒ 三条 30s 定时器留在 `vi` 队列 ⇒ `:207` `expect(3).toBe(0)` 必红；机制上成立（写者与终测给出的红都长这样）。此条不进 P，只进「待实跑」。

### R2-3 断连自证 —— PASS
- `shutdown`（`:237-243`）以 `if (closed) return` 幂等；`close()` 与两个监听共用它，`closed`/`reason` 只经此改。
- `error` → `shutdown("socket 错误：…")`（`:197-199`）、`close` → `shutdown("socket 已关闭")`（`:200-202`），两者都 `wake()`；reject 文本经 `:150-153` 拼成 `连接已关闭（socket 错误：…）` / `连接已关闭（socket 已关闭）` / 显式关闭为 `连接已关闭：…`——**可区分**。
- `ECONNRESET` 不再是 unhandled：`wireSse` 在 `openSse`（`:248-257`）同 tick 内同步注册 `error` 监听，早于任何 I/O 事件 ⇒ 任何 socket 错误都被接住并按原因 reject，`Test timed out` 不再冒充。**注**：用例实际打的是 `ECONNREFUSED`（`sse-v4.test.ts:217`），路径与 `ECONNRESET` 同一条 `error` 分支，为 P2 级观察（见下 P2-4）。

### R2-5 报告修正 —— 部分 PASS（P2-1）
- G-3 两行已降级：`impl-M4.7.md:92`、`:93` 均写「可接受（**未证实的假设，另立卡核实**）」+ 理由段「是推论、无断言证据」⇒ 改到位。
- 行号误引：`:213`/`:214` 现在声明 R1 基线 `:177`、R2 后 `:263`——但**实际是 `:252`**（`sse-client.ts:252` `timeoutMs = SSE_DEADLINE_MS,`）。旧误引换成了新误引，见 P2-1。

### 底线复核 —— PASS
- `verify` 仍 10 步（`package.json:28`：format:check / check-ci-parity / lint / lint:sh / lint-sh-selftest / typecheck / build / test:coverage / depcruise / knip）。
- 野脚本：`find scripts/*` 无 `check-test-timers.mjs`；`knip.json`、`package.json` 未改。
- 新增 3 条用例（`sse-v4.test.ts:194,216,225`）与报告 2971→2974 自洽；`sse-client.ts` 264 行 < 300、`openSse` 17 行 < 40（lint 仍需实跑复核）。
- `grep openSse(` 22 个调用点**无一**传第 4 参 ⇒ `timeoutMs` 语义变更（不再连带 socket 寿命）无调用方受影响；`sse.test.ts` 全部有 `close()` ⇒ 30s 定时器不会在 teardown 悬空。

---

## Finding

**P1 — `wire-http.test.ts:65-76` 的 `it.fails` 现在是「用 4s 静默超时冒充预期失败」**
- 证据链：`wire-http.test.ts:69` 发 `Content-Length: 100` 但只写 9 字节；KD-07 的产品 bug 是服务端**永不回**；`harness.ts:93` 默认 `timeoutMs = HTTP_DEADLINE_MS(4000)`，`:106` `setTimeout(finish, timeoutMs)` 到点走 `:104` `resolve(Buffer.concat(chunks)...)` = **`""`（静默 resolve，不 reject）**；`wire-http.test.ts:74` `expect(raw).toMatch(/^HTTP\/1\.[01] 4/u)` 因 `raw === ""` 失败 ⇒ `it.fails` 绿。写者自报「稳定红在 4012ms」，12ms 就是 `finish` 的指纹——**绿的依据是 4000ms 定时器，不是任何「服务端行为差异」**。
- 为什么这不是可接受的 `it.fails`：①`""` 是两义的（关连接 / 超时），`:72-73` 的注释自己承认了，所以红文本 `expected '' to match …` 说不出「服务端挂住了」——正撞 D8/G-2 的反面；②4000 与 vitest 5000 只差 1000ms，`maxWorkers: 2` 负载下单次 stall >1s 并非不可想象（本卡自己记录 ~1/5 偶发率），届时 vitest 先报 `Test timed out in 5000ms`，**断言根本没执行**，`it.fails` 仍绿 ⇒ 纯计时器绿；③R2-2 只改了常量，`rawExchange` 的「超时静默 resolve」这一根因（我 R1 的 P2）未修，本条实际上**让 verify 转绿的方式是依赖静默超时**，与本卡「不靠墙钟」的主题相反。
- 最小修法（1 行 + 1 常量，不动其它 15 个调用点）：
  ```ts
  // 半截请求：KD-07 现状是服务端一直不回，harness 到 deadline 用空串收尾——失败必须自述机制。
  const raw = await rawExchange(ctx.port, `<截断请求>`, "HTTP/1.1", 1500);
  expect(raw, `半截请求 1500ms 内没有任何响应字节（服务端挂住 = KD-07）；raw=${JSON.stringify(raw)}`).toMatch(/^HTTP\/1\.[01] 4/u);
  ```
  这样：失败文本自述「1500ms 无任何字节」；1500 远离 5000 无双时钟抢答；修好 KD-07 后 `toMatch(4xx)` 成立 ⇒ `it.fails` 转红（转正判据仍有效）。更彻底（建议进 follow-up 卡）：给 `rawExchange` 加 `rejectOnTimeout` 并在本用例 `await expect(...).rejects.toThrow(/在 \d+ms 内没有任何字节/u)`。
- 我给的替代判据（若协调者要「转正」）：该用例本质是 KD 记账，不宜转正；若转正，必须先修 KD-07（监听 `aborted`/`close` 并以 `invalid_request` 结束），再断言 `status === 400` + `code === "invalid_request"`。

**P2-1**：`impl-M4.7.md:213,214` 称 `openSse` 默认值在 `sse-client.ts:263`，实际 `sse-client.ts:252`（`:263` 是 `openSse` 之后的行）。旧误引 `:145`→`:177` 确实改了，但新号又错一处；`grep -n "timeoutMs = SSE_DEADLINE_MS" sse-client.ts` ⇒ `252`。改一个数字。

**P2-2**：`sse-client.ts:25` `SOCKET_LIFE_MS = 30_000` 与 `sse-v4.test.ts:102` `}, 30_000);`（v4#1c 用例预算）**同值**——正是本卡要消灭的「两个时钟同值抢答」形态：若该用例真被拖到 30s，谁先到谁说话（`finish` 型红 vs `Test timed out`）。最小修法：`SOCKET_LIFE_MS = 60_000`（兜底只需「长于任何 per-test 预算」），并让注释写明「必须严格大于任一用例预算」。

**P2-3**：`harness.ts:100-106` 超时静默 resolve（R2-2 只改常量、未改行为）——它是 P1 的根因，且占全仓 ~15 个 `rawExchange/httpCall` 调用点的失败可解释性。本卡不必修，但请把「超时静默 resolve 部分文本」立成 follow-up 卡（D8 原则对 HTTP 路径的延伸），别在 impl R2 里当作「已修」。

**P2-4**：`sse-v4.test.ts:217` 的 `ECONNREFUSED` 用例用「bind 后立刻 close 再连」的端口复用技巧，理论上有窗口期被内核重新分配（低概率偶发红）。若想消掉，改成连 `127.0.0.1:1`（保留端口）或断言 `rejects.toThrow(/连接已关闭（socket 错误：/)` 而不锚死 `ECONNREFUSED`。另外 R2 报告称「`ECONNRESET` 已被捕获」，用例实际打的是 `ECONNREFUSED`（同一条 `error` 分支，机制等价）——报告措辞宜改为「所有 socket 错误」以免读者以为有 RESET 专项覆盖。

## 待实跑（我无 shell，必须由测试员/协调者补证）
| # | 跑什么 | 期望 |
| --- | --- | --- |
| 1 | `npx vitest run packages/core/tests/server/sse-v4.test.ts --reporter=verbose` | EXIT=0，`7 passed`，`v4#1b` < 200ms |
| 2 | `/tmp` 副本：注释 `sse-client.ts:51` 的 `clearTimeout(destroyTimer)` → 跑 `-t "socket life timer"` | EXIT=1，红在 `sse-v4.test.ts:207`（`expected 3 to be 0`）；`cmp -s` 复原 |
| 3 | `/tmp` 副本：删 `connectSse` 的 `setTimeout`（`:40`）→ 同用例 | EXIT=1，红在 `:204`（反向变异，证明断言非单侧） |
| 4 | `/tmp` 副本：`SOCKET_LIFE_MS` 临时改 3000 + 在 `sse-v4.test.ts:84` 后插 `await sleep(3500)` | EXIT=1（复现 R1 P1；写者已报，独立复核） |
| 5 | `npx vitest run packages/core/tests/server/wire-http.test.ts -t "truncated"` 并看 verbose 耗时与失败文本 | 确认当前「绿」耗时 ≈4012ms 且红文本是 `expected '' to match`（= P1 的实跑证据） |
| 6 | `pnpm verify` ×3（D6） | 3×EXIT=0，265 文件 / 2974 例 / perFile 100% 含 `sse-client.ts` |
| 7 | `pnpm lint`（`sse-client.ts` 已 264 行） | `max-lines 300`/`max-lines-per-function 40`/`max-params 4` 全过 |
| 8 | `rm -rf packages/desktop/dist && pnpm desktop:check` | EXIT=0 |

**200 字摘要**：判决 CHANGES-NEEDED（P0=0，P1=1，P2=4）。R2-1/2-3/2-4/2-5 均成立：两时钟语义分离（`sse-client.ts:22/:25`，30s 只作兜底且 `close()`→`shutdown`→`disarm` 必清，非泄漏）；计数式自证已删净、假定时器只 fake 两项、基线在 `useFakeTimers` 后取、`finally` 复原。P1 是 `wire-http.test.ts:65-76`：`it.fails` 的绿靠 `harness.ts:106` 的 4000ms 静默 resolve 出空串，4012ms 即指纹，红文本说不出「挂住」；建议 1500ms + 断言消息自述机制。P2：`impl:213` 的 `:263` 应为 `:252`；`SOCKET_LIFE_MS=30_000` 与 v4#1c 的 30_000 同值抢答；`rawExchange` 静默超时应立卡；ECONNREFUSED 用例措辞。底线：verify 仍 10 步、无野脚本、docs/src/配置零改动。