## 判决：**ACCEPT**（P0=0 / P1=0 / P2=5）

本轮只读：未改仓库、未 `git add`、未跑命令。改动面（`watchdog_diff --stat`）：`harness.ts`、`sse-v4.test.ts`、`wire-http.test.ts` + untracked `sse-client.ts`（=4 个测试文件）+ `.workflow/known-defects.md` + 6 份 `.workflow` 报告；`docs/**`、`src/**`、`package.json`、`knip.json` 零改动。

### 1. R3-1 定性成立（终审重点）—— PASS
- ① `packages/core/src/server/http-io.ts:147-151` 的 `aborted ⇒ HttpFault(408, "连接在请求体读完前断开")` **确实存在**（`grep -n "aborted|408"` ⇒ `:127`、`:147`、`:149`）。抢不到响应这一点我独立复核到两条互不依赖的证据：(a) `grep -rn "clientError" packages/core/src/server/` ⇒ **零命中**，仓内不可能产出那条裸 400，故 400 是 Node parser 自己的；若 408 分支赢，客户端拿到的是 `HttpFault` 序列化的 JSON + `Content-Type: application/json`，与探针原文 `HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n`（空体）互斥。结论与「谁先 fire」的时序叙述无关 ⇒ 定性成立。
- ② `clientError` 零命中 ✓（同上命令）。**并且**这条零命中被我用来反证 ①，而不是只当叙述。
- ③ 断言只有 `wire-http.test.ts:104`（`statusLineOf(raw)` 匹 `^HTTP/1\.1 400`）+ `:106`（`elapsed < 1000`），**不绑 body 形状、不绑 code** ⇒ 将来把 `clientError` 映射成 `{code:"invalid_request"}` JSON 时仍应绿，不会「因为变对了而红」。✓
- ④ `wire-http.test.ts:24` 是 `socket.end(text, "latin1")`（半关，非 `destroy()`）✓；`:21-23` 有 1500ms 兜底（<5000，不与 vitest 抢答）✓，且兜底文本自述：`半截请求 1500ms 内没有任何响应字节；raw=…` ✓。定时器未 `unref()` 但三条出口（`end`/`error`/定时器）都会 `clearTimeout`（`:18`），不悬空，**不算问题**。

### 2. KD-07 退表 —— 合规（规则 4 四条逐条满足）
- 删 `it.fails`：`grep -n "it.fails" packages/core/tests/server/wire-http.test.ts` ⇒ 无 ✓；转正向断言：`wire-http.test.ts:102-106` ✓；删行：`.workflow/known-defects.md` 表内已无 `KD-07` 行 ✓；下调 CAP：`CAP = 9` ✓。
- **行数我数过**：`KD-01,02,03,04,05,06,08,09,10 = 9` 行，与 `CAP = 9` 一致 ✓（`known-defects-registry.test.ts:105` 的 `expect(rows).toHaveLength(cap)` 会卡）。
- 退表说明（`known-defects.md` 表下）写清了证据：「缺陷不再成立——半截请求 3ms 内回 `HTTP/1.1 400`（Node 内置 `clientError` 的 Parse Error 抢先，`chunksOf` 的 408 线上不可达）」✓。诚实：这是「前提过期」而非「修好了」，措辞没有冒充修复。

### 3. R3-2 —— PASS
`sse-client.ts:27 SOCKET_LIFE_MS = 60_000` 严格大于 `sse-v4.test.ts:102` 的 `30_000` ✓；约束写在两处注释（`:13-14`「必须严格大于任何 per-test 预算（现为 30_000）」、`:25-26`）✓，且 `:11-12` 仍保留 3000 < 5000 的等帧约束。

### 4. R3-3 —— PASS（机制判读）
- `sse-v4.test.ts:220-228` 改连保留端口 `1`，锚点放宽为 `/连接已关闭（socket 错误：/u`，不锚 errno ✓。
- 幂等用例的**可红性成立**：`sse-client.ts:240 if (closed) return;` 一旦删掉，第二次 `close()`（`:262-265` → `shutdown("")`）会把 `reason` 覆盖成 `""`，`waitFor` 走 `:148-157` 抛 `连接已关闭：第 1 帧未出现（已收到 0 帧）`，与 `sse-v4.test.ts:243` 期望的 `连接已关闭（socket 已关闭）` 不符 ⇒ 必红。与报告变异 B 的红文本逐字吻合 ✓。
- 措辞：「`ECONNRESET` 已被捕获」已改为「所有 socket 错误（实测打的是 `ECONNREFUSED`，同一 `error` 分支）」（`impl-M4.7.md:261`）✓。

### 5. R3-4
- M-4/M-5 写成「**不修**（不是 PASS）」并各带理由（`impl-M4.7.md:331-333`）✓；变异 A 明确标注「**对本用例无鉴别力，故不采用** …不留一对假装跑过的变异」（`:319`）✓。
- 但行号订正**又错了一格**，见 P2-1。

### 6. 底線 —— PASS
`verify` 仍 10 步（`package.json:29`：format:check / check-ci-parity / lint / lint:sh / lint-sh-selftest / typecheck / build / test:coverage / depcruise / knip）✓；`scripts/` 无 `check-test-timers.mjs` 等野脚本 ✓；`sse-client.ts` 267 行 <300 ✓；`openSse`（`:250-267`）18 行 <40 ✓；`waitFor`（`:175-181`）等均 <40 ✓。

## Finding

**P2-1 — 行号订正第三次错位：报告写 `sse-client.ts:252`，实际 `:254`**
证据：`grep -n "timeoutMs = SSE_DEADLINE_MS" packages/core/tests/server/sse-client.ts` ⇒ **`:254`**；`:252` 是 `path: string,`；`openSse` 从 `:250` 起。`impl-M4.7.md:213`、`:214`、`:305` 三处都写 `:252`。顺带 `:305` 说「`:263` 是 `openSse` 之后的 `close` 行」也不准：`:263` 是 `link.shutdown("")`（`close` 箭头在 `:262-265`）。最小修法：三处 `:252` → `:254`，把 `:263` 描述改成「`:262-265` 的 `close()`」。

**P2-2 — `halfClosedExchange` 的 `error` 分支不自述，且会把「已拿到完整 400」误判成失败**
`wire-http.test.ts:31-34`：`socket.on("error", (error) => settle(() => { reject(error); }))` 无条件 reject 裸 `Error`（`read ECONNRESET` 这类），失败文本里既无「半截请求」也无 `raw`。R3-1④ 要求「失败文本自述」，只对定时器分支（`:22`）做到了。更实的一点：服务端写 400 后 `destroy()`，其接收缓冲里那 91 字节未读 body 在 Linux/macOS 上可能触发 RST，客户端可能「先收全 400 再收 RST」，此时代码会红成 `Error: read ECONNRESET`——正是本卡要消灭的「说不出机制的红」。最小修法（3 行）：error 分支里若 `raw()` 已含状态行则 `resolve(raw())`，否则 `reject(new Error(\`半截请求：socket 错误 ${error.message}；raw=${JSON.stringify(raw())}\`))`。

**P2-3 — `sse-v4.test.ts:193` 注释仍写「三条 30s 兜底定时器」**，与 `SOCKET_LIFE_MS = 60_000`（`sse-client.ts:27`）矛盾。改一个数字。

**P2-4 — 「三条幂等断言」里两条无鉴别力**
`sse-v4.test.ts:238-241 not.toThrow()` 恒真：`close()` 只有 `link.shutdown("")` 与 `socket.destroy()`（`sse-client.ts:262-265`），两者都不抛，删掉 `if (closed) return` 也照样通过；`:242 expect(sse.frames).toHaveLength(0)` 在「服务端收首包即 `end()`、从不下发帧」的场景里恒 0，同样对幂等无鉴别力。真正能红的只有 `:243` 那条（变异 B 已证）。修法：把 `:238-241` 换成观察点（如 `sse.close()` 后 `expect(sse.frames).toBe(sse.frames)` 无意义——建议直接删这两条，或改成 `expect(() => sse.close()).not.toThrow()` 之外**看状态**：`waitFor` 文案已足够，删掉更像诚实断言）。

**P2-5 — `rawExchange` 超时静默 resolve 空串仍在，且未立 follow-up 卡**
`harness.ts:96-110`：`setTimeout(finish, timeoutMs)` 到点走 `resolve(Buffer.concat(chunks)...)`（可能 `""`），~15 个 `rawExchange/httpCall` 调用点的失败文本仍是「空串无解释」。R3-1 只是让本用例不再走这条路（正确），但 R2 审计的 P2-3 仍悬着，`impl-M4.7.md:260` 只写「行为未动」，没登记为下一卡。最小处置：在 `## R3 新产品发现` 节加一行「`rawExchange` 超时静默 resolve → 立卡（D8 原则对 HTTP 路径的延伸）」。

## 待实跑（我无 shell）
| # | 跑什么 | 期望 |
| --- | --- | --- |
| 1 | `npx vitest run packages/core/tests/server/wire-http.test.ts -t "truncated" --reporter=verbose` | EXIT=0，verbose 耗时 <100ms（非 ~4012ms）；同时逐字确认失败文本形态（临时把 `:104` 期望改 `500` 跑一次，红文本应含状态行） |
| 2 | `/tmp` 副本：注释 `sse-client.ts:240 if (closed) return;` → `-t "idempotent"` | EXIT=1，红在 `sse-v4.test.ts:243`；`cmp -s` 复原=0（复核变异 B） |
| 3 | `/tmp` 副本：删 `http-io.ts:147-151` 的 `aborted` 块 → `-t "truncated"` | EXIT=0（复核变异 A「无鉴别力」，不是 PASS） |
| 4 | `grep -rn "408" packages/core/tests` | 确认「`aborted` 线上不可达」不被别的用例反证（无用例断言 aborted 得 408） |
| 5 | `npx vitest run packages/core/tests/known-defects-registry.test.ts` | 6 passed（`CAP=9` = 9 行） |
| 6 | `pnpm verify` ×3（D6） | 3×EXIT=0，265 文件 / 2974 例 / 四维 perFile 100% |
| 7 | `pnpm lint`（`sse-client.ts` 267 行） | `max-lines 300` / `max-lines-per-function 40` 全过 |
| 8 | `rm -rf packages/desktop/dist && pnpm desktop:check` | EXIT=0 |

**摘要（≤200 字）**：ACCEPT（P0=0，P1=0，P2=5）。终审重点 R3-1 定性成立且我另给了独立证据：`http-io.ts:147-151` 的 `aborted⇒408` 存在，但 `grep clientError packages/core/src/server/` 零命中，仓内产不出那条空体 400，而 408 必带 JSON 体——两者互斥，故 408 抢不到响应，与时序叙述无关。断言只锚 400 + <1000ms，不绑 body，不为「变对了」红；`halfClosedExchange` 真半关、1500ms 兜底自述。KD-07 退表四条合规，CAP=9 与 9 行一致。R3-2 60_000 严格大于 30_000。R3-3 端口 1 + 放宽锚点，变异 B 机制成立。P2：`:252` 实为 `:254`（第三次行号错位）；error 分支不自述；`sse-v4:193` 残留 30s；两条幂等断言恒真；`rawExchange` 静默 resolve 未立卡。底线全过。