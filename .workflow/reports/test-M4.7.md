# test-M4.7 — G3 独立验证（测试员 R1：只读主树 + /tmp 变异）

> 依据：`.workflow/cards/M4.7.md` §6（D1–D9）、`.workflow/reports/spec-M4.7.md`、`.workflow/reports/impl-M4.7.md`。
> 纪律：**未改主树任何文件、未 `git add`**；所有变异在 `/tmp` 副本 `/tmp/m47c`（`rsync` 复制 + `node_modules` 符号链接，排除 `packages/desktop/target|dist`、`.git`、`coverage`）进行，每次 `cp` 备份 → 改 → 跑 → `cp` 回 → `cmp -s` = `RESTORED_SAME`。**未用管道吞退出码**（`>log` 后 `echo $?`）。
> 主树上只跑了只读命令 + 门禁（`pnpm verify` 会写 `coverage/`，`desktop:check` 写 `dist`，均为已忽略产物）。唯一新增文件 = 本报告。

## 1 AC 复核表（自己跑，不采信作者）

| AC | 命令（节选） | 结果 | 判定 |
| --- | --- | --- | --- |
| AC-1 | `npx vitest run .../sse-v4.test.ts -t "should broadcast an error frame" --reporter=verbose` | `EXIT=0`，`✓ … 15ms`，`1 passed \| 3 skipped` | **通过** |
| AC-2 | `grep -n "waitFor(3)" …/sse-v4.test.ts \|\| echo NONE`；`grep -n 'event === "error"' …` | `NONE`；`118: const errorFrames = sse.frames.filter((frame) => frame.event === "error");` | **通过** |
| AC-3 | 同上 verbose 行尾 | `15ms`（远 < 500ms；作者报 13ms，同量级） | **通过** |
| AC-4 | `grep -n "SSE_DEADLINE_MS = " …/sse-client.ts` | `13:export const SSE_DEADLINE_MS = 3000;`；`openSse` 默认值 = 该常量（`sse-client.ts:186`） | **通过**（残留：`harness.ts:95` `rawExchange` 仍 `timeoutMs = 5000`，见 §5-R1） |
| AC-5 | `for i in $(seq 20); do npx vitest run .../sse-v4.test.ts; done` | 20/20 `EXIT=0`，`Tests 4 passed (4)`，`TOTAL_FAIL=0` | **通过** |
| AC-7 | `/tmp` 探针 `waitFor(99)`（默认 5000 vitest 预算，未加 per-test timeout） | `AC7 elapsed=3003`；harness 抛：`SSE 等待超时：第 99 帧未出现（deadline 3000ms，订阅建立于 …，已收到 1 帧）` + `#1 +3ms event=ready id=0 …` + `但曾收到 event=ready`；**无 `Test timed out`** | **通过** |
| AC-8 | 探针 `waitForEvent("errors")`（chmod 触发 5xx 后） | 文本含 `event=errors未出现`、逐帧清单（`#2 +5ms event=error … "io_failure"`、`#3 +109ms event=library.changed`、`#4 +109ms event=doc.error`）、`但曾收到 event=error` | **通过** |
| AC-9 | `grep -rn "setTimeout(resolve, 10)" packages/core/tests/server/` | `harness.ts`/`sse-client.ts` 内 **NONE**；命中仅 `sse.test.ts:34`/`g311.test.ts:60`/`unit-branches.test.ts:234`（三个**其它文件的旧轮询 helper**，不在 AC-9 指定面内） | **通过（面内）** |
| AC-10 | 探针 `openSse` → 立刻 `close()` → `waitFor(1)` | `AC10 elapsed=0`，`连接已关闭：第 1 帧未出现（已收到 0 帧）` | **通过** |
| AC-11 | `grep -n clearTimeout …/sse-client.ts` | `40: clearTimeout(destroyTimer);`（+`123:` deadline 清理）；`openSse.close()` 调 `disarm()` | **通过（grep 级）**，但**无断言覆盖**，见 §3 MV-F |
| AC-16 | `node -e 'require("./package.json").scripts.verify.split("&&").length'` | `10` | **通过** |
| AC-17 | `ls scripts/check-test-timers.mjs` | `No such file or directory`（EXIT=1） | **通过** |
| AC-12 | `grep -rnE "setTimeout\|sleep\(" packages/*/tests --include=*.ts \| wc -l`；impl 表行数 | `45` = `45` | **通过** |
| AC-13 | 三选一判定计数 | `必须改` 5 次命中（含"D4 行 + 统计句 + 2 条『本卡已修』"）、`可接受` 37、`确定性` 10；表内每行均带判定+理由 | **通过** |
| AC-14 | `grep -rn "thread::sleep" packages/desktop/src-tauri/src \| wc -l` | `5`（均在产品函数体，`#[test]` 无） | **通过** |
| AC-15 | `grep -rn "retry:" packages/*/tests --include=*.test.ts`；`git diff --stat pnpm-lock.yaml \| wc -l` | 只命中 `retry: 2000` 帧字面量/注释；lockfile `0` | **通过** |
| AC-18 | `grep -n "升级触发条件" impl-M4.7.md` | `70:` 命中，"≥5 处 / 第二次偶发红"二选一 | **通过** |
| AC-19 | `grep -n "harness.ts:18[0-9]\|harness.ts:23[0-9]" impl-M4.7.md` | 第 111/112 行两条均标「本卡已修」并给新位置 `sse-client.ts:29`/`:140` | **通过** |
| AC-20 | — | 按 D5 未启用 | N/A |

## 2 变异矩阵（**自己独立设计 + 复核作者 3 条**）

全部在 `/tmp/m47c` 内执行。`KILLED` = 设计用的断言/用例真的红了（且红在对的位置）。

| # | 变异 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| **MV-A**（复核作者 MV-1） | `waitUntil` 的 deadline 只 `done()` 不 `reject` | vitest 抢答 | `EXIT=1`，`→ Test timed out in 5000ms`，无 harness 文本 | **KILLED**（作者结论复现） |
| **MV-B**（复核作者 MV-2） | `server.ts:159` `publish("error"` → `publish("errors"` | 红在 `waitForEvent` 诊断 | `EXIT=1`，`但曾收到 event=errors` + `FAIL … v4#1b`，`1 failed \| 3 passed` | **KILLED**（作者结论复现，红在换名提示上） |
| **MV-C**（复核作者 MV-5，阴性对照） | 断言退化为 `waitFor(2)` + `frames.length >= 2`，在 MV-B 状态下跑 | 仍绿 | `EXIT=0`，`MV5 frames=["ready","errors"]` | **SURVIVED（正确）**——数帧式断言抓不住事件名错误，D7/AC-2 必要 |
| **MV-D**（新） | `SSE_DEADLINE_MS = 3000` → `5000`（与 vitest 同值），跑 `waitFor(99)` 探针（默认预算） | 复现"vitest 抢答、诊断被吞" | `EXIT=1`，`AC7 elapsed=5001`，`→ Test timed out in 5000ms`；harness 文本只落到 stdout 不作为失败原因 | **KILLED**——3000 这个常量是承重的；原事故形态可**确定性复现** |
| **MV-E**（新） | `describeTimeout` 的 `seen` 改为无条件前置 `但曾收到 event=error`（重言） | 负向探针（连上后只等到 `ready`，再等 `event="nope"`）应拒收假阳性 | 基线 `EXIT=0`（只报 `event=ready`、不含 `event=error`）；变异后 `EXIT=1`，`expected … not to contain 'event=error'` | **KILLED**——当前换名提示确实是**据实**从 `frames` 推导，不是无条件打印 |
| **MV-F**（新） | `openSse.close()` 只置 `closed=true`，不 `disarm()`、不叫醒 waiter、不 `destroy()` | 出现泄漏/挂死 | `EXIT=0`，`Duration 325ms`，wall `0.65s`（基线 `EXIT=0` / `322ms` / `0.66s`），`--no-file-parallelism` 下同样绿 | **SURVIVED**——见 §5-R2（重要残留） |
| **MV-G1**（新） | `server.ts` 5xx 分支**发两次** `error` 帧（`env.hub.publish` ×2），保留严格断言 | 严格断言抓住 | `EXIT=1`，`AssertionError: expected [ …(2) ] to have a length of 1 but got 2` | **KILLED**——D7 的"恰 1 帧"承重 |
| **MV-G2**（新） | 同 MV-G1 + 断言放宽为 `toBeGreaterThanOrEqual(1)` | 放宽后漏检 | `EXIT=0`，`4 passed` | **SURVIVED（符合预期）**——证明放宽会真的丢掉这条能力，D7 的"恰 1"不是装饰 |

> 变异统计：**KILLED 6 / SURVIVED 2**（其中 MV-C、MV-G2 是**设计为存活**的对照；真正未被杀的只有 **MV-F**）。
> 反例自证可信度：作者 §5 的三件套（命令/`EXIT`/命中行）我逐条核过，**自洽**；其中 MV-1、MV-2、MV-5 三条**我亲自重跑**，结果与作者报告一致（含 `但曾收到 event=errors`、`MV5 frames=["ready","errors"]`、`Test timed out in 5000ms`）。未发现"改完没复原"的迹象（副本内每次 `cmp -s` = `RESTORED_SAME`）。

## 3 压力面（自创）

`sse-v4.test.ts` 与 `packages/core/tests/server/sse.test.ts` 两个 vitest 进程并发，10 轮：

```
round=1..10  v4=0 sse=0     ← 20/20 EXIT=0
```

未重现原 flake。**这不构成"偶发已消除"的证据**（D6）：两者都不含 `doc.error` 等待，且机器负载远低于 `maxWorkers: 2` 的全量跑；本卡的正确结论是**机制级**的：`v4#1b` 不再等非确定帧数（`waitFor(3)` 已不存在，帧证据见 AC-8 探针中 `library.changed`/`doc.error` 出现与否随负载浮动），且一旦某个 deadline 真被拖满，失败文本自带帧清单/订阅时刻/换名提示，不必再靠"重跑到绿"消化。

## 4 收口门禁

| 项 | 命令 | 退出码 | 关键行 |
| --- | --- | --- | --- |
| 全量 | `pnpm verify` | **`EXIT=0`** | `Test Files 265 passed (265)` / `Tests 2971 passed (2971)` / `All files 100 \| 100 \| 100 \| 100`；`Duration 81.55s` |
| 桌面 | `rm -rf packages/desktop/dist && pnpm desktop:check` | **`EXIT=0`** | `test result: ok.`（`Doc-tests hreader_desktop … 0 failed`） |

## 5 残留风险 / 我的判定依据

- **R1（已知，作者已披露）**：`harness.ts:95` `rawExchange(…, timeoutMs = 5000)` 仍与 vitest 默认 5000 同值。非 SSE 等待路径（到点 resolve 已收文本），但同属 B2 的结构性同值问题，D8 只覆盖了 `openSse`。**建议**下卡把它降到 3000，或至少给个"必须 < 5000"的注释断言。
- **R2（新，重要）**：`clearTimeout(destroyTimer)`（AC-11）**只被 grep 覆盖，没有任何用例能抓**。MV-F 把 `close()` 整个清空（不 disarm、不叫醒 waiter、不 destroy）后，`sse-v4` 4/4 全绿、`--no-file-parallelism` 下耗时无变化（0.65s vs 0.66s）——因为 `v4#1b` 的等待在 `close()` 之前已 resolve，`waiter` 集合已空；`v4#1c` 的 65 条连接也没观察 open handle。**结论**：AC-11 目前是"文本门禁"而非"行为门禁"，与 M4.6 的教训同形（门禁要能红）。属本卡范围外的补强项，但审计员不应据此判 AC-11 为"已被证明"。
- **R3**：AC-9 的面只到 `harness`/`sse-client`；`sse.test.ts:34`、`g311.test.ts:60`、`unit-branches.test.ts:234` 仍是 10ms 轮询（各有 deadline + throw，属 impl §4 表内"可接受"）。若未来把它们也纳入"必须改为事件驱动"，就是 D5 说的"候选点涨到 ≥5 处"的升级信号之一。
- **R4**：AC-18 的两次 `allowlist` 命中是"成本论证"而非"存在 allowlist"；与 AC-18 期望（命中 + 写清触发条件）一致，无误。

## 6 判定

**通过。**

理由（只基于本报告内可复跑的证据）：
1. D1–D9 的每一处落点都能在源码里定位到（`SSE_DEADLINE_MS=3000`、`waitForEvent`、事件驱动 waiter、超时 `throw`+帧清单+换名提示、`close()` reject、"恰 1 个 error 帧"）。
2. 承重常量与断言**都能被变异杀死**：deadline 去掉（MV-A）、deadline 抬回 5000（MV-D）、事件名错（MV-B）、换名提示被写成重言（MV-E）、`error` 帧数放宽（MV-G1）——五条各自红在预期位置。
3. 两条对照（MV-C 数帧式断言、MV-G2 放宽断言）**如设计存活**，说明 D7 的强断言与 AC-2 的 grep 是必要门禁。
4. 门禁：`pnpm verify` `EXIT=0`（265/2971、四维 100%、81.55s）+ `desktop:check` `EXIT=0`；单文件 20 连跑 20/20 绿。
5. 不宣称"偶发已消除"（D6）：压力面 10 轮未重现，但结论立在机制上——不再等待非确定量（`waitFor(3)` 已消失、帧证据随负载浮动），且下次偶发时诊断自证。

**不阻塞但须记账**：R2（AC-11 无断言覆盖）。若审计员按"门禁必须能红"的口径要求，它应作为 M4.7 的 follow-up 而不是本轮的 fail 项——因为 D5/D8 的裁定只要求 `clearTimeout` 存在，未要求一条能红的用例。

---

## G3′（独立验证 R2）

> 输入：`.workflow/reports/impl-M4.7.md` 的 `## R2` 段；口径：`.workflow/cards/M4.7.md` §6 D1–D9。
> 纪律：**主树只跑不改**（唯一写入 = 本段）；变异全部在 `cp -a` 副本 `/tmp/m47d` 内（`rsync` 复制 + `node_modules` 符号链接，排除 `.git`/`node_modules`/`coverage`/`dist`/`target`），每次 `cp` 备份 → 改 → 跑 → `cp` 回 → `cmp -s` = 0，跑完 `rm -rf /tmp/m47d`。**未用管道吞退出码**（`>log` 后 `echo $?` / `EXIT=$?`）。未读 `audit-M4.7-R2.md`（`it.fails` 定性独立作出）。

### G3′-1 复核写者的两对变异自证（亲手复现，不采信报告数字）

**① `SOCKET_LIFE_MS` 3000 vs 30_000（`v4#1c` 插 `sleep(3500)`）**

- 变异 A（`sse-client.ts:25` → `const SOCKET_LIFE_MS = 3000;` + `sse-v4.test.ts:86` 在 64 条 `waitFor(1)` 之后插 `await new Promise((resolve) => setTimeout(resolve, 3500));`）：
  `npx vitest run packages/core/tests/server/sse-v4.test.ts -t "should answer 429"` → **`EXIT=1`**，命中 `× v4#1c · 第 65 个连接 > should answer 429 … 7530ms` / `→ HTTP 请求超时` / `Tests 1 failed | 6 skipped (7)`。**复现成功**：活过 3s 的连接被兜底销毁、hub 名额释放，第 65 条不再 429。
- 变异 B（`SOCKET_LIFE_MS` 回 `30_000`，sleep 保留）：同命令 → **`EXIT=0`**，`✓ … 3530ms` / `Tests 1 passed | 6 skipped (7)`。
- 回滚：`cp` 回 → `cmp -s` = `0`（`CMP_V4=0`），`grep -c 3500` = `0`。

**② 注释 `clearTimeout` ⇒ 假定时器 delta 用例红**

- 变异（`sse-client.ts` 的 `disarm()` 里 `clearTimeout(destroyTimer);` 注释掉）：`npx vitest run … -t "should clear one socket life timer"` → **`EXIT=1`**，`× R2 · 兜底定时器与断连自证 > should clear one socket life timer per connection on close 11ms` / `→ expected 3 to be +0 // Object.is equality`。
- 回滚 → `cmp -s` = `0`，同命令 **`EXIT=0`**（`1 passed | 6 skipped`，10ms）。

**复核结论**：两对都如实复现；R2-1 的 `SOCKET_LIFE_MS` 与 R2-4 的 `vi.getTimerCount()` delta 都是**承重**的，不是装饰。

### G3′-2 我另设计的 8 条变异（重点打 R2 新增面）

| # | 变异（`/tmp/m47d` 内） | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| **M-1** | 删 `sse-client.ts` 的 `socket.on("close", …)` | `vitest run …/sse-v4.test.ts` | **`EXIT=1`**，`× R2 · 断连自证 > should reject when the server ends the stream 3012ms` / `→ expected … '连接已关闭（socket 已关闭）' but got 'SSE 等待超时：第 1 帧未出现（deadline 3000ms…'`；`Tests 1 failed \| 6 passed` | **KILLED** |
| **M-2** | 删 `socket.on("error", …)` | 同上 | **`EXIT=1`**，`× … should reject with the socket error … 3ms` / `→ …but got '连接已关闭（socket 已关闭）…'` + `Unhandled Errors: connect ECONNREFUSED 127.0.0.1:53060` | **KILLED** |
| **M-3a** | `shutdown` 去掉幂等守卫（`if (closed) return;`） | 同上 | **`EXIT=0`**，`7 passed`，32ms | **SURVIVED（缺断言）**：`close()` 之后的 `close` 事件会二次 `shutdown`，但没用例观察"reason 不被覆盖 / 不重复 wake / 不重复 disarm"；单连接路径无可观测差异 |
| **M-3b** | 幂等守卫改为 `if (closed) throw new Error("shutdown 被调用两次")` | 同上 | **`EXIT=1`**，两条断连用例各抛 `shutdown 被调用两次`（共 5 处栈） | **KILLED**——证明两条断连用例确实走过"二次 shutdown"路径，幂等是有用的 |
| **M-4** | `harness.ts:86` `HTTP_DEADLINE_MS` 改回 `5000` | `vitest run …/wire-http.test.ts` | **`EXIT=0`**，`13 passed`，`it.fails` 用 `5011ms` | **SURVIVED（缺断言）**：4000 这个常量当前**没有任何断言锚定**；它只改变 `it.fails` 绿在哪条超时上（见 G3′-3） |
| **M-5** | delta 用例 `vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout"] })` → `vi.useFakeTimers()`（全 fake） | `-t "should clear one socket life timer"` | **`EXIT=0`**，`1 passed`，10ms | **SURVIVED**：该用例不等真实定时器，收窄 `toFake` 是卫生而非门禁；全 fake 也没造成假红/挂死 |
| **M-6** | delta 基线挪到 `useFakeTimers` 之前（`baseline = vi.getTimerCount()` 先于装假定时器） | 同上 | **`EXIT=1`**，`→ Timers are not mocked. Try calling "vi.useFakeTimers()" first.` | **KILLED**——`baseline` 与装 fake 的先后是承重顺序 |
| **M-7** | `SOCKET_LIFE_MS` → `1`（兜底立即杀） | `vitest run …/sse-v4.test.ts` | **`EXIT=1`**，3 条红（`v4#1a`/`v4#1c`/`v4#1b`），全为 `连接已关闭（socket 已关闭）：第 1 帧未出现（已收到 0 帧）` | **KILLED**（顺带证明 R2-3 的断连诊断文本在真实断连路径上可读） |

> 自设统计：**KILLED 5 / SURVIVED 3**（M-1、M-2、M-3b、M-6、M-7 杀；M-3a、M-4、M-5 存活）。
> 3 条 SURVIVED 的定性：**M-4 属"缺断言"且与 G3′-3 的假绿同源**（4000 未被任何断言咬住）；M-3a 属"缺断言"（幂等性只有'不炸'这一半被覆盖）；M-5 属"设计如此"（收窄 `toFake` 是降低耦合的卫生措施，本就没有对应断言）。

### G3′-3 `wire-http.test.ts` 的 `it.fails` 定性：**假绿（用超时冒充预期失败）**

`packages/core/tests/server/wire-http.test.ts:64` `it.fails("should answer a truncated (EOF) request close, not hang")` 的现状是：用例体里 `rawExchange(..., "HTTP/1.1")` 在 `HTTP_DEADLINE_MS` 到点时**静默 resolve 出空串**，`expect(raw).toMatch(/^HTTP\/1\.[01] 4/u)` 对空串必失败 ⇒ `it.fails` 把它当"预期失败"收下 ⇒ **绿**。

我做的四个对照（`/tmp/m47d`，每次 `cmp -s` 回滚）：

| 配置 | 命令 | 结果 | 读数 |
| --- | --- | --- | --- |
| 现状（4000） | `vitest run …/wire-http.test.ts -t truncated`（主树，只读） | **`EXIT=0`** | `✓ … 4020ms` |
| `HTTP_DEADLINE_MS=6000`（> vitest 5000） | 同上 | **`EXIT=0`** | `✓ … 5008ms`——**vitest 的 `Test timed out in 5000ms` 被 `it.fails` 当成"预期失败"吞掉**，绿的理由变成了 vitest 超时 |
| `HTTP_DEADLINE_MS=2000` | 同上 | **`EXIT=0`** | `✓ … 2026ms`——绿的理由是 harness 2s 超时 |
| `HTTP_DEADLINE_MS=12_000` + 用例预算 `15_000` | 同上 | **`EXIT=1`** | `× … 10023ms` / `→ Expect test to fail` |

第四行是关键：把预算放到 15s 后，**产品其实回了 4xx**。独立探针（`/tmp/m47d` 临时 `zz-probe-trunc.test.ts`，跑完已删）：

```
PROBE elapsed=10010 rawLen=277 raw="HTTP/1.1 408 Request Timeout\r\ncontent-type: application/json; charset=utf-8…"
CONTROL elapsed=1 rawLen=202            ← 正常 404 路径 1ms 回
```

即：**半截请求在客户端 FIN 后约 10s 由产品回 `408 Request Timeout`**，正是断言要求的 4xx；`it.fails` 之所以绿，是因为 4000ms（或 5000ms vitest）**先到**。另核对源码：`packages/core/src/server/http-io.ts:122-151 chunksOf` 现已监听 `aborted`/`error` 并有 `timeoutMs` 定时器（`reject(new HttpFault(408, "请求体读取超时"))`，`packages/core/src/server/http-io.ts:127`），`limits.ts:8` `DEFAULT_TIMEOUTS.bodyMs = 10_000`——用例注释里 KD-07 说的"只监听 data/end，Promise 永不落地"**已过时**，真实现状是"10s 后 408"。

**结论**：这条用例不是在验证"未实现的语义差"，而是**用超时冒充预期失败**。它无法区分"服务器挂死"与"服务器慢 / 测试预算过紧"：任何超时（harness 4000、vitest 5000）都能让它保持绿，只有"产品在 4s 内回 4xx"才会让它红——而产品真实行为是 10s 回 4xx。R2 把断言从 `raw === "" || 4xx` 收成 `4xx` 只改变了"绿在哪条超时上"，没有改变"绿靠超时"这个事实；impl 报告 §R2「语义更严（不再让 harness 的超时替被测行为背书）」与实测相反。

**建议判据（不改代码，交协调者裁定）**：

- (A) 若意图是「半截请求必须**立刻**回 4xx」：改成普通 `it`，`rawExchange` 预算 `1500`，断言 `raw` 匹配 `^HTTP/1\.1 4` **且** `elapsed < 1000`——当前必然红（实测 10s），红在语义上；这是唯一能表达"语义差"的写法。
- (B) 若意图只是「永不挂死」：改成普通 `it` + 用例预算 `15_000`，断言 `raw` 匹配 4xx——当前绿（408@10s），并且把"10s"这个数字写进期望范围内可被审阅。
- (C) 根因处置：在 `chunksOf` 里对 `req.on("close")` 且 `req.complete === false` 直接 `reject(new HttpFault(408, "连接在请求体读完前断开"))`（与既有 `aborted` 分支同形），再把用例改成 (A)/(B) 的普通 `it`。
- 无论选哪条，`wire-http.test.ts:64` 的 KD-07 注释需同步改写（现状是"10s 后 408"而非"永不落地"），否则下一个人会继续按过期前提判读。

### G3′-4 压力面（记录耗时分布，不只记"没复现"）

**(a) `sse-v4.test.ts` 单文件 20 连跑**（主树，只读）：`for i in $(seq 20); do npx vitest run …/sse-v4.test.ts > /tmp/stress-v4.$i.log 2>&1; echo "run=$i EXIT=$?"; done`

- **20/20 `EXIT=0`**，`TOTAL_FAIL=0`，`Tests 7 passed (7)` 每轮一致。
- Duration 分布：**341–368ms**，中位 **349ms**（min 341 run=2，max 368 run=14）；无 `Test timed out` 日志（`grep -l "Test timed out"` → `NO_TIMEOUT_LOGS`）。

**(b) `sse-v4.test.ts` + `sse.test.ts` 两进程并发 ×10 轮**（每轮两个 vitest 同时起，`wait $P1;E1=$?; wait $P2;E2=$?`）：

- **20/20 进程 `EXIT=0`**，无 `Test timed out`。
- `v4` Duration：**401–425ms**（并发下比单跑 +~55ms）；`sse.test.ts` Duration：**4.76–4.91s**。
- 慢项定位：`sse.test.ts > Last-Event-ID 过期 > should send reset(events_expired)…` **4067ms**（并发）vs **4043ms**（单独跑，`EXIT=0`，`Duration 4.82s`）——**不是并发放大，是预存的长等待**，占 vitest 5000ms 预算的 ~80%。

### G3′-5 反向探针（防假绿）：`SSE_DEADLINE_MS` 抬回 5000 仍确定性复现

`/tmp/m47d` 内临时探针（`zz-probe-deadline.test.ts`，`waitFor(99)`，默认 5000 预算，跑完已删）：

| `SSE_DEADLINE_MS` | 命令 | 结果 | 读数 |
| --- | --- | --- | --- |
| 3000（现状） | `vitest run …/zz-probe-deadline.test.ts` | **`EXIT=0`** | `PROBE elapsed=3003 text=SSE 等待超时：第 99 帧未出现（deadline 3000ms，订阅建立于 …，已收到 1 帧）` |
| 5000（反向） | 同上 | **`EXIT=1`** | `× … 5006ms` / `→ Test timed out in 5000ms.`；harness 文本只作 stdout 出现：`PROBE elapsed=5000 text=SSE 等待超时：…（deadline 5000ms…）` |

**结论**：R2 之后 D8 的性质**未被别的改动顺手掩盖**——`SSE_DEADLINE_MS = 3000` 仍是"诊断能当失败原因说话"的唯一支点，抬回 5000 即回到"vitest 抢答、诊断被吞"，可确定性复现。

### G3′-6 收口门禁（主树只跑不改）

| 项 | 命令 | 退出码 | 关键行 |
| --- | --- | --- | --- |
| 全量 | `pnpm verify` | **`EXIT=0`** | `Test Files 265 passed (265)` / `Tests 2974 passed (2974)` / `All files 100 \| 100 \| 100 \| 100` / `Duration 76.80s` |
| 桌面 | `rm -rf packages/desktop/dist && pnpm desktop:check` | **`EXIT=0`** | `test result: ok. 81 passed; 0 failed` / `Doc-tests hreader_desktop … 0 failed` |
| 洁净 | `git diff --cached --name-only \| wc -l` | `0` | 未 `git add`；主树仅测试员本段报告一处写入（`git status` 的 `M` 三文件均为写者 R2 改动，非本轮） |

### G3′-7 判定与残留

**R2 机制面通过，但 `it.fails` 一条判为假绿（不阻塞 R2 本身的机制结论，须记账）。**

- 通过部分：写者两对变异自证**亲手复现**（3s 兜底杀连接 / `clearTimeout` delta）；R2-3 的两条断连用例被 M-1、M-2、M-3b **杀死**（删 close / 删 error / 二次 shutdown 抛错），证明新增监听与幂等不是装饰；`vi.getTimerCount()` 的 baseline 顺序（M-6）、兜底时长（M-7）均承重；反向探针确认 D8 性质仍在；20 连跑 + 并发 10 轮全绿且耗时可解释。
- 假绿部分：`wire-http.test.ts:64 it.fails` 靠 4000ms/5000ms 超时变绿（G3′-3），且其前提（KD-07 永不落地）已过期——真实行为是 10s 回 408。建议按 (A)/(B)/(C) 之一收敛，**本轮不改代码**。
- 残留风险：R-新1 `HTTP_DEADLINE_MS = 4000` 无断言锚定（M-4 SURVIVED），只是卫生值；R-新2 `shutdown` 幂等只有"不炸"被覆盖（M-3a SURVIVED）；R-新3 `sse.test.ts` 单例 4043ms / 5000ms 预算（预存，非 R2 引入），高负载 CI 下有超时风险；R-新4 全 `toFake` 未造成假红（M-5），但收窄 `toFake` 的收益仍无断言表达。

**KILLED/SURVIVED 汇总**：写者两对变异 **2/2 复现**（含 KILLED 2）；我自设 **8 条 → KILLED 5 / SURVIVED 3**（SURVIVED 中 2 条"缺断言"、1 条"设计如此"）。

---

## G3″（独立验证 R3，终测）

> 输入：`.workflow/reports/impl-M4.7.md` 的 `## R3`；口径：`.workflow/cards/M4.7.md` §6 D1–D9。
> 纪律：**主树只跑不改**（唯一写入 = 本段）；变异/探针全部在 `cp` 副本 `/tmp/m47e`（`rsync` + `node_modules` 符号链接，排除 `.git`/`coverage`/`dist`/`target`），每次 `cp` 备份 → 改 → 跑 → `cp` 回 → `cmp -s` = `SAME`，结束 `rm -rf /tmp/m47e`。退出码均直取（`>log` 后 `echo $?`），未用管道吞码。

### G3″-1 复核 R3-1 定性：**写者说得对，「线上裸 400、408 不可达」成立**

我上一轮 R2 的结论（“KD-07 已由 `aborted`→408 实现”）**是错的**，且**是我自己误判**，不是被写者误导：我当时只读了 `packages/core/src/server/http-io.ts` 里 `req.on("aborted") ⇒ reject(new HttpFault(408, "连接在请求体读完前断开"))` 分支，就断定“已实现”，**没有在 wire 上观测**。写者用日志序列推翻它是正确的。

独立探针（`/tmp/m47e`，临时改 `http-io.ts`/`server.ts` 打 `[PROBE]` 日志 + 临时用例做半关连接；`Content-Length: 100` 只写 `{"docId"` 9 字节后 `socket.end()`）：

```
[PROBE] clientError fired: code=HPE_INVALID_EOF_STATE msg=Parse Error   ← 临时监听仅用于观测
[PROBE] req aborted fired
[PROBE] req error fired: aborted
[PROBE] serve catch status=408
[PROBE] client raw="HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n" elapsed=4
```

关键对照：**删掉我加的临时 `clientError` 监听**（回到主树真实状态）再跑，客户端拿到的仍是同一份裸 400：

```
[PROBE] req aborted fired
[PROBE] req error fired: aborted
[PROBE] serve catch status=408
[PROBE] client raw="HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n" elapsed=4
```

`grep -rn "clientError" packages/core/src/` ⇒ `EXIT=1`（零命中），`server.ts` 只挂 `request`。结论：①半关 → Node parser 判 `HPE_INVALID_EOF_STATE`，**默认 `clientError` 处理先写死裸 400 并 destroy**；②`chunksOf` 的 408 分支确实 fire（`serve catch status=408` 有日志），但响应早已由默认处理发出，**抢不到**；③那条 10s `408 请求体读取超时` 只对「客户端保持连接不发 FIN」成立（另一条路径）。故「**线上是裸 400、408 不可达**」**成立**，`wire-http.test.ts` 的无 `Content-Type` 裸 400 断言与注释三段与实测一致；用例锚「400 + 快」是正确靶子。**收回 R2 的 `it.fails` 假绿之外那条“408 已实现”的判断**——R2 时我把“可达性”当成了“分支存在”。

### G3″-2 变异矩阵（5 条，全部在 `/tmp/m47e`）

| # | 变异 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| **①** | `wire-http.test.ts:108` `expect(elapsed).toBeLessThan(1000)` → `< 5000` | `vitest run …/wire-http.test.ts -t "truncated"` | 真实行为下 **`EXIT=0`**（`✓ … 12ms`）。再加“慢 400”模拟（`/tmp` 副本给 `clientError` 加 1200ms 延迟后写 400）：基线 `EXIT=1`（`→ expected 1208 to be less than 1000`），变异 `EXIT=0`（`✓ … 1220ms`） | **KILLED（需 1200ms 慢服务模拟；真实行为下与基线等价）**。阈值只对 1–1.5s 区间的回归敏感，>1.5s 由助手自身 1500ms 兜底先拒（不可能被 `<5000` 放过） |
| **②** | 状态断言 `^HTTP\/1\.1 400` → `^HTTP\/1\.1 4` | 同上 | 真实行为下 **`EXIT=0`**（产品恒 400）。再加“快速 408”模拟（`clientError` 立即写 `HTTP/1.1 408 Request Timeout`）：基线 `EXIT=1`（`expected 'HTTP/1.1 408 Request Timeout' to match /^HTTP\/1\.1 400/`），变异 `EXIT=0` | **KILLED（需 fast-408 模拟；真实行为下等价）**——**“变松到能吞 408”成立**，但只在服务端真回 408 时显现；产品当前恒 400，故默认套件抓不到 |
| **③** | `sse-client.ts` `shutdown()` 删 `if (closed) return;` | `vitest run …/sse-v4.test.ts -t "idempotent"` | **`EXIT=1`**：`× … then stay idempotent on repeated close 6ms` / `→ expected [Function] to throw error including '连接已关闭（socket 已关闭）' but got '连接已关闭：第 1 帧未出现（已收到 0 帧）'` | **KILLED**——与写者变异 B 一手复现，幂等守卫承重 |
| **④** | `SOCKET_LIFE_MS` `60_000` → `30_000` | `vitest run …/sse-v4.test.ts` ×3 | 3/3 **`EXIT=0`**，`7 passed`，33–34ms | **SURVIVED（缺断言）**：无用例活到 30s，故“又和用例预算撞”在本套件**不可观测**；但 `v4#1c` 的 per-test 预算恰是 `30_000`，真挂住时两个时钟同值、诊断会互相盖住——属潜在卫生问题而非当前假绿 |
| **⑤** | `halfClosedExchange` 的 `socket.end(text)` → `socket.write(text); socket.destroy()` | `vitest run …/wire-http.test.ts -t "truncated"` | **`EXIT=1`**：`× … 1516ms` / `→ 半截请求 1500ms 内没有任何响应字节；raw=""` | **KILLED**——RST 让客户端零字节；红在助手 1500ms 兜底（**有界、未 hang**），并证明该助手自带失败诊断 |

> 统计：**KILLED 4 / SURVIVED 1**；其中 ①② 只在模拟场景被杀、默认套件内与基线等价（产品恒 400 且 ~3–12ms）；真正无区分力的只有 ④。⑤顺带证明助手在“零字节”路径上 1.5s 内自杀，不会挂死 vitest。

### G3″-3 慢测试账（`pnpm verify` 同口径：`vitest run --coverage`，JSON 逐条 duration）

| 排名 | 耗时 | 用例 | 文件 |
| --- | --- | --- | --- |
| 1 | **10983ms** | `hr_outline · 1MB 性能门` should outline a 1MB document within budget (calibrated to the same process) | `outline-perf.test.ts` |
| 2 | **6836ms** | `exportPrintCommand · 4 MiB 三档` should accept limit-1 / limit and reject limit+1 | `units-export-print.test.ts` |
| 3 | **5302ms** | `AC-5 / AC-6 · 真 Chrome 的大纲不变量` should keep outline count, heading pages and repeat runs in step with | `pdf-outline-e2e.test.ts` |
| 4 | **5029ms** | `concurrency · 锁` should answer 503 busy when another live process holds the doc lock | `concurrency.test.ts` |
| 5 | **3898ms** | `sse · Last-Event-ID 过期` should send reset(events_expired) when the id fell out of the ring | `sse.test.ts` |

（第 6/7/8 名：`png-cli` 3151ms、`pdf-cli` 3144ms、`pdf-outline` 2664ms；全量 ≥1000ms 共 28 条，全部为**预存**的 perf/e2e/CLI/锁用例。）

**R3 新增/改动用例无一进入慢榜、也无 ≥1s 用例入默认套件**（同一次全量跑的逐条读数）：

- `wire-http.test.ts` 13 条：最慢 `should handle two pipelined requests on one socket` **20.3ms**（预存）；**新用例 `should answer a truncated (EOF) request close fast instead of hanging` 仅 3.5ms**（远 < 1000ms 判据）。
- `sse-v4.test.ts` 7 条：最慢 `should answer 429 …` **14.8ms**（预存）；幂等用例 0.6ms，delta 用例 3.2ms。
- 结论：R3 未把 10s 级用例塞进套件；半截请求的真实耗时（~3ms）与判据（<1000ms）之间留了 300 倍余量。

### G3″-4 收口门禁（主树只跑不改）

| 项 | 命令 | 退出码 | 关键行 |
| --- | --- | --- | --- |
| `wire-http.test.ts` ×5 | `for i in $(seq 5); do npx vitest run …/wire-http.test.ts; done` | **5/5 `EXIT=0`** | 每轮 `Tests 13 passed (13)`，`WIRE_FAIL=0` |
| `sse-v4.test.ts` ×20 | `for i in $(seq 20); do npx vitest run …/sse-v4.test.ts; done` | **20/20 `EXIT=0`** | `V4_FAIL=0`；`grep -l "Test timed out"` ⇒ `NO_TIMEOUT_LOGS`；Duration 343–368ms，tests 段 33–34ms |
| 全量 | `pnpm verify` | **`EXIT=0`** | `Test Files 265 passed (265)` / `Tests 2974 passed (2974)` / `All files 100 \| 100 \| 100 \| 100` / `Duration 76.68s` |
| 桌面 | `pnpm desktop:check` | **`EXIT=0`** | `test result: ok. 81 passed; 0 failed` / `Doc-tests hreader_desktop … 0 failed` |
| 洁净 | `git diff --cached --name-only \| wc -l`；`git status --porcelain` | `0` | 未 `git add`；`M` 三文件（`harness.ts`/`sse-v4.test.ts`/`wire-http.test.ts`）+ 未跟踪 `sse-client.ts` 均为**写者**改动，非本轮；本轮唯一写入 = 本报告 |

### G3″-5 判定与残留

**R3 通过。**

- **定性复核**：写者对 R3-1 的推翻**成立**——线上裸 400（3–4ms），`chunksOf` 408 分支真的 fire 但抢不到响应；我 R2 的判断源于“读源码未做 wire 观测”，已收回。用例从 `it.fails` 转 `it` 且锚「400 + 快」是**正确化**，不是放宽。
- **承重面**：幂等守卫（③）、助手半关语义（⑤）都能被当场杀掉；`elapsed` 阈值（①）与 `400` 精确状态（②）在**模拟回归/408 场景**下也能杀，证明它们不是装饰——只是因为产品现状恒 400/3ms，默认套件里看不出差异。
- **预期内的无区分力**：④ `SOCKET_LIFE_MS=30_000` 在现有套件不可观测（无用例活到 30s），属常量卫生而非假绿；与 R3-2 的 60_000 选择相比，60_000 更安全（避免与 `v4#1c` 的 30_000 预算同值）。**建议保留 60_000，不必回改**。
- **残留风险**：
  - **新-R1**：`halfClosedExchange` 的 1500ms 兜底把「响应 1.5–5s」整段屏蔽；若将来产品变慢到 1.2s 回 400，用例会红（阈值 1000 抓得住），但若慢到 1.6s，红因会变成助手兜底而非断言——诊断仍清楚（错误文本带 `raw`），可接受。
  - **新-R2**：`elapsed < 1000` 与产品实测 3–12ms 余量 300×，看似宽松，但正是它把“用 10s/4s 墙钟冒充判据”的旧假绿杀掉；不改。
  - **新-R3**：`SSE_DEADLINE` 类常量仍无断言锚定的还有 `harness.ts` `HTTP_DEADLINE_MS = 4000`（R2 既记 M-4）；本轮未新增同类问题。
  - **新-R4**：写者所述「`server.ts` 无 `clientError` ⇒ 坏请求只有裸 400、违反 `{code,message}` 契约」我核实为真（`grep clientError` 零命中），同意**另立卡**，不在 M4.7 内改 `src/**`。
