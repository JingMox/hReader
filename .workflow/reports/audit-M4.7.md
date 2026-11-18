由于没有写入工具（本会话只有只读工具），完整审计产物如下，请协调者落到 `.workflow/reports/audit-M4.7.md`。

---

# audit-M4.7 — 审计员 G2（审 R1 产物）

> 口径：`.workflow/cards/M4.7.md` §6 D1–D9（冻结）。只读审计，未改仓库、未跑修改性命令。**本会话无 shell，所有"需实跑"项见文末清单。**
> 改动面经 `watchdog_diff` 核对：`harness.ts`（-93/+14）、`sse-v4.test.ts`（+8/-2）、新增 `sse-client.ts`（untracked）。`pnpm-lock.yaml`、`package.json`、`knip.json`、`docs/**`、`src/**` **零改动**（diff stat 只有 2 文件 + 1 新文件）。

## Review

### 1. D8 实质（PASS + P2）
- **PASS**：`SSE_DEADLINE_MS = 3000`（`packages/core/tests/server/sse-client.ts:13`），严格 < 5000；`openSse` 默认值 `timeoutMs = SSE_DEADLINE_MS`（`sse-client.ts:173-177`）；`waitFor` 与 `waitForEvent` **都**经 `waitersOf(context, timeoutMs)` 传入同一 deadline（`sse-client.ts:149-168`），无第三条等帧路径（`grep "setTimeout(resolve|while (frames.length"` 在 `harness.ts`/`sse-client.ts` → 仅剩 `sse-client.ts:140` 的 deadline timer）。
- **P2（残留，非同一函数族）**：`packages/core/tests/server/harness.ts:95` 的 `timeoutMs = 5000` 属 `rawExchange`，`harness.ts:108` `const timer = setTimeout(finish, timeoutMs)` 命中即 `resolve(Buffer.concat(chunks)...)` —— **超时是静默 resolve 部分文本**，且 5000 与 vitest 默认 5000 同值 ⇒ 与 B2 同构的"vitest 抢答"风险仍然存在。`harness.ts:127` `httpCall` 的 `timeout: options.listen ?? 5000` 同理。它们**不是** `openSse` 的等帧路径（不影响 `v4#1b`），但全仓 ~15 处调用（`wire-http.test.ts:10,107`、`auth.test.ts:85`、`unit-gaps.test.ts:60,73,88`、`g39-gaps.test.ts:98`、`unit-gaps2.test.ts:52,114`、`static-app.test.ts:42`、`timeouts.test.ts:113`）都在同一风险面。**最小修法**：把两处默认值改成 `4000`（或抽 `HTTP_DEADLINE_MS = 4000` 共用），一行一处；这样断言文本先于 vitest 出现。

### 2. AC-7 / AC-8 诊断质量（PASS）
代码级证据 `packages/core/tests/server/sse-client.ts:80-97`：
- 头行：`` `SSE 等待超时：${subject}未出现（deadline ${deadlineMs}ms，订阅建立于 ${new Date(subscriptionAt).toISOString()}，已收到 ${frames.length} 帧）` ``（`sse-client.ts:87`）→ 帧数 + 订阅时刻齐备；
- 逐帧：`` `  #${i+1} +${at - subscriptionAt}ms event=${frame.event} id=${...} data=${frame.data}` ``（`sse-client.ts:90-93`）→ event + 相对到达偏移（锚在订阅时刻上，等价于绝对时刻）；
- 换名提示：`` [...new Set(frames.map(f => f.event))].map(e => `但曾收到 event=${e}`) ``（`sse-client.ts:94-96`）。

编写员记录的实际输出（引用 `impl-M4.7.md` §5/§7，非我编造）：
```
SSE 等待超时：第 99 帧未出现（deadline 3000ms，订阅建立于 …, 已收到 3 帧）
  #1 +0ms event=ready id=0 data={"type":"ready"}
  #2 +5ms event=error id=1 data={"code":"io_failure",…,"status":500,…}
但曾收到 event=ready
AC7 elapsed=3002
```
判：**不看源码可知差在哪**（差在第 99 帧 / 只来了 3 帧 / 来的名字是 ready、error）。AC-8（换名）同样有 `event=errors未出现 … 但曾收到 event=error`。

### 3. AC-10 关闭语义（PASS + P2）
- **PASS**：`close()` 置 `closed=true`、`disarm()`、唤醒全部 waiter、`socket.destroy()`（`sse-client.ts:200-206`）；`settle()` 在 `accept()` 未命中时查 `isClosed()` → `reject(new Error("连接已关闭：…未出现（已收到 N 帧）"))`（`sse-client.ts:130-140`）；waiter 在 `done()` 里 `clearTimeout` + `waiters.delete`（`sse-client.ts:121-124`）⇒ **不挂死、不泄漏 listener**。二次 `close()` 由 `if (closed) return`（`sse-client.ts:201`）挡住，幂等。
- **P2**：`socket` 只挂了 `"data"`（`sse-client.ts:186-189`），**没有 `"error"` / `"close"` / `"end"` 监听**，且 `closed` 只由显式 `close()` 置位 ⇒ ①服务端先断连时 waiter 不会立刻 reject「连接已关闭」，而是等满 3s 抛"等待超时"（措辞误导）；②客户端 socket 若发出 `ECONNRESET`，Node 会抛 unhandled `'error'`，直接炸 worker，**恰好绕开 G-2 的"要自己说话"**。此缺陷旧 `harness.ts` 同样存在（非本 diff 引入），但新文件是诊断的唯一居所，**最小修法**：加 `socket.on("error", …)` 与 `socket.on("close", () => { closed = true; for (const w of [...waiters]) w(); })`（3 行）。

### 4. AC-11 定时器清理（PASS + **P1**）
- **PASS**：`clearTimeout` 正文在 `packages/core/tests/server/sse-client.ts:40`（`disarm: () => { clearTimeout(destroyTimer); }`），`openSse.close()` 调 `disarm()`（`sse-client.ts:203`）。`connectSse`（`:22-44`）唯一调用者是 `openSse`（`:185`）⇒ **`openSse`/`connectSse` 两条路径是同一根**，清理覆盖成立；`v4#1c` 的 64 条连接在 `finally` 里 `close()` 即清零（`sse-v4.test.ts:99-100`）。
- **P1（同一行为的一半没修，且被 diff 收紧）**：`sse-client.ts:29` `const destroyTimer = setTimeout(() => socket.destroy(), timeoutMs)` ——「5s 后**无差别销毁 socket**」这一半仍在（spec §2.4 原文点名的两半：从不 clear / 无差别 destroy；本次只修了前半）。`disarm()` **只在 `close()` 里调用**，等帧成功后并不 disarm，于是任何 SSE 连接活过 deadline 就被硬杀；而 diff 把 deadline 从 5000 降到 3000（`sse-client.ts:13`），**把这条墙钟从 5s 前提到了 3s**。可达位置：`sse-v4.test.ts:76-101`（v4#1c，自报预算 `{ timeout: 30_000 }`，64 条活连接 + 429 探测）。在 `maxWorkers: 2` 下该块若超过 3s，链接触发 `destroy()` → 客户端表被清 → `expect(overflow.status).toBe(429)` 变 200 ⇒ **一条新的、正好由"靠墙钟"制造的偶发红**，与本卡目标相反。
  **最小修法**（二选一，均 1 行）：① `connectSse` 的安全销毁用独立预算 `SOCKET_LIFE_MS = 30_000`，不与 `SSE_DEADLINE_MS` 共用（语义也对：一个是"等帧上限"，一个是"连接寿命兜底"）；② 在 `socket.on("data")` 里首次收到帧后调 `disarm()`（连接已经证明活着，无需墙钟兜底）。

### 5. 拆分得当性（`sse-client.ts`，PASS + P2）
- 职责单一：整文件只有"SSE 测试连接"（切帧 `pumpSse`/`frameOfRaw`/`eventOf`、等待 `waitUntil`/`waitersOf`、诊断 `describeTimeout`、构造 `openSse`），无 HTTP/服务器装置混杂（那些留在 `harness.ts`）——与目录既有拆分（`raw-until.ts`、`casts.ts`）同构。
- **无循环依赖**：`sse-client.ts:11` 只 `import { connect, type Socket } from "node:net"`，**不 import `./harness`**；`harness.ts:177` 只单向再导出，且带注释说明动机（文件长度门禁）。再导出**不掩盖**任何环。
- 命名：`tests/server/sse-client.ts` 与产品模块不冲突（`src/server/` 侧是 `hub/event-ring/server`，无同名），首位注释"这层管：SSE 测试连接"已消除"产品客户端"歧义。
- **P2-a**：`harness.ts:5-11` 与 `sse-client.ts:3-9` 的"两个入口分工"注释**逐字重复两份**，违反 `docs/04-engineering-standards.md:20`「同一种事只用一种写法」，将来改 API 会漏改一侧；建议 `harness.ts` 只留一行"见 `./sse-client`"。
- **P2-b**：新文件直读 `Date.now()`（`sse-client.ts:177` 订阅时刻、`pumpSse` 的 `arrivals`），`docs/04:250` 对测试禁 `Date.now()` 直读；此处的时钟只用于**诊断输出**（不参与判定），属可接受的例外，但按 `docs/04:23` 的"例外要写明"，建议在文件头加一句"`Date.now()` 仅用于诊断时间戳，不参与断言"。
- 规模门禁自查：文件 208 行（<300）；`max-lines-per-function 40` 下最长的 `openSse:173-208`=36 行、`connectSse:22-44`、`waitUntil:115-147`；`max-params 4` 三处均为 4 —— 均未越线（仍需 `pnpm lint` 复核，见待实跑）。

### 6. D7 断言强度（PASS + P2）
`sse-v4.test.ts:117-122` 实际断言三条：`expect(failed.status).toBe(500)`、`expect(errorFrames).toHaveLength(1)`、`expect(errorFrame.data).toContain('"io_failure"')`。
- **没有**断言总帧数（无 `frames.toHaveLength(...)`、无 `waitFor(3)`，`waitFor(3)` 已在 diff 中删除）；**没有** `doc.error` 断言。`toHaveLength(1)` 作用在 `sse.frames.filter(f => f.event === "error")`（`:118`）上，正是 D7 允许的"恰 1 个 error 帧"。
- **P2**：`errorFrames` 的取样时刻是"第一个 `error` 帧到达即算"（`waitForEvent` 一命中就返回），若产品将来真的发两帧（间隔 >0ms）该断言仍会捕捉到，属正确；但 `errorFrame` 与 `errorFrames` 同源数组，`toHaveLength(1)` 实际等价于"此刻恰 1 帧"，语义没问题，只是别把它当"全程恰 1 帧"的强契约——建议补半句注释。

### 7. G-3 表（PASS + P2）
- 表共 **45 行**（`impl-M4.7.md:84-128`），每行都有三选一判定 + 一句话理由（`grep -c '^\| \`packages/'` = 45；统计行 `impl:130` 自洽：确定性 6 + 可接受 37 + 必须改 0）。
- 独立复核：`grep -rn "setTimeout|sleep\(" --glob **/tests/**/*.ts` 得到 **恰好 45 行**，与表行**一一对应**（我逐条比对文件:行，无遗漏、无多列）。AC-12/AC-13 PASS。
- **"必须改"确为 0 且是真修**：`waitFor` 的 10ms 轮询 / 超时静默 return（旧 `harness.ts:238`）→ 事件驱动 + `throw`（`sse-client.ts:115-147`）；`connectSse` 的未清定时器（旧 `harness.ts:182`）→ `clearTimeout`（`sse-client.ts:40`）。**不是把判定改成"可接受"**。但该行的"已修"只覆盖了泄漏一半，另一半（无差别 destroy）见第 4 条 P1 —— 建议表格该行理由补一句"destroy 语义待后续卡"，避免"已修"被读成"全部修完"。
- **P2（判定可质疑）**：`packages/cli/tests/serve-sse-contract.test.ts:170`/`:229`（G0 记"可疑"）被判 `可接受`，理由是"`openEvents` 的 `fetch` resolve 时首帧注释已 flush"——这是对 undici 缓冲行为的断言，**报告中未见证据**；按本卡"红要能说话"的精神，它仍是"靠 100ms 猜订阅已建立"。不改也行（不在本卡靶内），但应把理由降级为"未证实的假设，另立卡核实"。
- Rust：`thread::sleep` 5 处在产品函数体（`supervisor.rs:172`/`:255`、`signals.rs:142`/`:152`/`:210`），`#[test]` 内无 —— 与 G0 AC-14 一致（未复跑，见待实跑）。

### 8. G-4 降级（PASS）
- `pnpm verify` 仍 **10 步**：`package.json:28` = `format:check && check-ci-parity && lint && lint:sh && lint-sh-selftest && typecheck && build && test:coverage && depcruise && knip` ⇒ AC-16 PASS。
- 未新建被 knip 抓的野脚本：`scripts/` 下只有 `check-ci-parity.mjs`（`find scripts/*.mjs`），**无 `check-test-timers.mjs`** ⇒ AC-17 PASS；`knip.json` 零改动（diff stat 无）。
- 升级触发条件已写入（`impl:65-73`：`必须改`≥5 或第二次墙钟偶发红），符合 D5/AC-18。

### 报告引用精度（P2，两处）
- `impl:213` 与 AC-4 证据行称 `openSse` 默认值在 `sse-client.ts:145` —— **实际是 `:177`**（`:145` 在 `waitUntil` 内）。`impl:41` 的 `sse-client.ts:13`、`impl:111` 的 `sse-client.ts:29`、`impl:112` 的 `sse-client.ts:140` 均核对无误。建议改一处数字，免得后续审计以假位置为基线。

## 待实跑清单（我无 shell，必须由协调者/测试员补证）
| # | 谁跑 | 跑什么 | 期望 |
| --- | --- | --- | --- |
| 1 | 测试员 | `npx vitest run packages/core/tests/server/sse-v4.test.ts --reporter=verbose` | `EXIT=0`，`v4#1b` < 200ms（编写员称 13ms） |
| 2 | 测试员 | 重写临时探针（`sse-v4` 之外的 `zz-probe`，跑完删）复跑 AC-7 `waitFor(99)` / AC-8 `waitForEvent("errors")` / AC-10 `close()` 后 `waitFor(1)` | 分别在 ≈3000ms 抛出含"已收到 N 帧 / #i +Δms event=… / 但曾收到 event=…"与"连接已关闭"的文本；**不得**出现 `Test timed out in 5000ms` |
| 3 | 测试员 | **P1 反例**：在 `sse-v4.test.ts:84` 前后插 `await new Promise(r => setTimeout(r, 3500))` 再断言 429 | **期望红**（socket 已被 3s destroy）——这既复现 P1，也验证第 4 条的判据能红 |
| 4 | 协调者 | `pnpm verify` ×3 | 3 次 `EXIT=0`；`Test Files 265 passed`、`Tests 2971 passed`；**perFile 100% 里必须看到新增 `packages/core/tests/server/sse-client.ts`**（新文件任一分支未覆盖会直接红） |
| 5 | 协调者 | `pnpm lint && pnpm depcruise && pnpm knip`（可从 verify 单步取） | 新文件过 `max-lines 300`/`complexity 10`；无环；`SSE_DEADLINE_MS` 再导出不被报 unused（`knip.json:13` 把 `tests/**/*.ts` 当 entry，预期通过） |
| 6 | 协调者 | `rm -rf packages/desktop/dist && pnpm desktop:check` | `EXIT=0`（本卡声称绿，与本 diff 无交集） |
| 7 | 测试员 | `grep -rn "thread::sleep" packages/desktop/src-tauri` | 5 处且在函数体内、`#[test]` 零命中（AC-14） |

## 汇总
- **P0 = 0**
- **P1 = 1**：`sse-client.ts:29` 的无差别 `socket.destroy()` 未 disarm，且 deadline 5s→3s（`sse-client.ts:13`）把墙钟提前；可达 `sse-v4.test.ts:76-101`（30s 预算用例）。最小修法：把安全销毁换成独立 `SOCKET_LIFE_MS`（如 30_000），或首帧后 `disarm()`。
- **P2 = 5**：`rawExchange`/`httpCall` 的 5000 同值静默超时（`harness.ts:95,108,127`）；socket 无 `error`/`close` 监听（`sse-client.ts:186`）；分工注释双份（`harness.ts:5-11` / `sse-client.ts:3-9`）；`Date.now()` 例外未写明；`serve-sse-contract:170/229` 判定理由未证；impl 行号误引（`impl:213`→`:177`）。
- **判决：CHANGES-NEEDED**（唯一 P1 是一行修的墙钟缺陷，正落本卡靶心；修完 + 待实跑 1–4 回填后可转 PASS WITH NOTES）。

**200 字摘要**：判决 CHANGES-NEEDED（P0=0，P1=1，P2=5）。P1：`sse-client.ts:29` 的 `setTimeout(() => socket.destroy(), timeoutMs)` 仍是无差别销毁，只在 `close()` 里 disarm，且 deadline 从 5s 收紧到 3s——`sse-v4.test.ts:76-101`（30s 预算）在负载下会先被 3s 杀连接再断言 429，正是本卡要消灭的墙钟红。修法一行：用独立 `SOCKET_LIFE_MS=30_000` 或首帧后 disarm。其余：D8/AC-7/AC-8/AC-10/AC-11/D7/G-3（45 行全对，我独立 grep 复现）/G-4（verify 仍 10 步，无野脚本）均 PASS。拆出 `sse-client.ts` 得当：只依赖 `node:net`、无环、职责单一、再导出有注释；唯一的味道是"分工"注释抄了两份、`Date.now()` 例外未写明。