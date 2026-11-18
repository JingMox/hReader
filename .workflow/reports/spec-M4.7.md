# spec-M4.7 — G0：AC 矩阵冻结 / 帧数真相 / G-4 可行性 / 歧义点名（测试员，只出规格）

> 依据：`.workflow/cards/M4.7.md`、`docs/03-collaboration-workflow.md` §11.51–§11.53、`packages/core/tests/server/harness.ts`、`packages/core/tests/server/sse-v4.test.ts:104-126`、`packages/core/src/server/{hub,event-ring,runtime,server,watcher}.ts`。
> 本文件**只读**仓库：未改 `src`/`tests`/`package.json`/`ci.yml`；未 `git add`；未跑 `pnpm verify`（会写 `coverage/`）。
> 跑过的命令：`npx vitest run packages/core/tests/server/sse-v4.test.ts`（无 coverage）、`grep`、`sed -n`，以及一个**放在 `/tmp` 的探针**（`/tmp/probe-m47.test.ts` + `/tmp/vitest-probe.config.mts`，root 指向 `/tmp`，仅临时目录写盘）。仓库内 `git status --porcelain` 的唯一新增就是本报告。

---

## 0 三条会直接改变施工的结论（协调者先看）

| # | 结论 | 证据 |
| --- | --- | --- |
| **B1** | **`waitFor(1)` + `waitFor(3)` 在语义上不自洽，在数值上只是"碰巧对上"**。首帧注释 `: ready` **不计帧**（`pumpSse` 只吃含 `data:` 的块）；计数的第 1 帧是 `READY_FRAME`（`id: 0`），第 2 帧是 5xx 的 `error`，**第 3 帧不是 `error`，是 watcher 的 `doc.error`**（`chmod 000` 的副作用）。实测：`[0ms:ready, 82ms:error, 193ms:doc.error]` | `harness.ts:198-204`、`event-ring.ts:74`、`hub.ts:47-56`、`server.ts:157-165`、`runtime.ts:99-127`、探针输出（§2.3） |
| **B2** | **"产品竞态"可以排除，"墙钟"可以确认，但真正的根因比"等固定时长"更具体：`openSse` 的 deadline（5000ms，`harness.ts:224`）与 vitest 默认 `testTimeout`（5000ms，`vitest.config.ts` 未覆盖）**同值**。第 3 帧一迟到，harness 想等满 5s 再返回，而 vitest 在同一个 5s 上先开枪 ⇒ 人看到的是 `Test timed out in 5000ms`，harness 永远没机会说"我收到了 2 帧"。这是"诊断被截获"的结构性缺陷，不是随机 | `harness.ts:221-243`、`vitest.config.ts`（全文无 `testTimeout`） |
| **B3** | **G-4 建议降级为审计清单，不进 `verify`**。全仓符合"可靠墙钟"模式的候选点 **31 处**（§3），其中 20+ 处是**合法的轮询/deadline helper**；判定"这条 setTimeout 是等事件还是等固定时长"不是正则能判的。allowlist 会退化成"每次加/改轮询 helper 都要改 JSON"，且新脚本还要同时过 knip（`scripts/**/*.mjs` 不在 entry，见 M4.6 B2）与 eslint（`max-lines 300`/`complexity 10`）。 | §3 表；`knip.json`；`eslint.config.mjs` |

---

## 1 命令库（cwd = 仓库根，均可复制）

```bash
# C1 v4#1b 单例 + 耗时（-t 精确匹配本次事故用例）
npx vitest run packages/core/tests/server/sse-v4.test.ts -t "should broadcast an error frame" --reporter=verbose; echo "EXIT=$?"
# C2 该文件 20 连跑（偶发红的最小复现器）
for i in $(seq 20); do npx vitest run packages/core/tests/server/sse-v4.test.ts >/tmp/sse.$i.log 2>&1; echo "run=$i EXIT=$?"; done
# C3 全量门禁（唯一执行者：协调者；本卡专属"连跑 3 次"）
pnpm verify >/tmp/verify.$i.log 2>&1; echo "EXIT=$?"     # ×3
# C4 Sse 帧计数口径（pumpSse 只吃 data: 块）
grep -n 'block.includes("data:")' packages/core/tests/server/harness.ts
# C5 deadline 与 testTimeout 的同值证据
grep -n "timeoutMs = 5000" packages/core/tests/server/harness.ts; grep -n "testTimeout" vitest.config.ts || echo "NO_TEST_TIMEOUT(默认 5000)"
# C6 5xx 只发一帧 error
sed -n '155,166p' packages/core/src/server/server.ts
# C7 watcher 在 startServer 时就挂在 workspace 根（chmod 会走它）
grep -n "watcher.add(workspace" packages/core/src/server/runtime.ts; grep -n "DEBOUNCE_MS = " packages/core/src/server/watcher.ts
# C8 靠墙钟候选点全量（G-3/G-4 的源数据）
grep -rnE "setTimeout|sleep\(" packages/*/tests --include=*.ts | wc -l
# C9 变异回滚校验（§11.51-3）
cmp -s /tmp/x.bak <file> && echo SAME
```

---

## 2 帧数真相（先算清，再谈超时）

### 2.1 计数口径

- `pumpSse`（`harness.ts:198-204`）：`if (block.includes("data:")) frames.push(...)`。**`": ready\n\n"` 不含 `data:` ⇒ 注释帧不计数**。
- `openStream`（`hub.ts:47-56`）写两块：`CONNECT_COMMENT`（不计）+ `READY_FRAME`（`retry: 2000\nid: 0\ndata: {"type":"ready"}\n\n`，`event-ring.ts:74`，**计 1 帧**，`event="ready"`, `id=0`）。
- `hub.publish`（`hub.ts:127-131`）：每个事件 1 帧。

### 2.2 `v4#1b` 的应有帧数（`sse-v4.test.ts:104-126`）

| 时刻 | 动作 | 累计计数帧 | event |
| --- | --- | --- | --- |
| 连接 | `openStream` | 1 | `ready`（`: ready` 不计） |
| `waitFor(1)` 返回 | — | 1 | — |
| `chmodSync(...,0o000)` | `fs.watch` change → `DEBOUNCE_MS=100` → `onFileChange` | 2 → 3 | `library.changed`（`active` 未定）**或** `doc.error`（`modelOfPath` 读到 EACCES） |
| `httpCall("/s/doc.html")` 500 | `server.ts:159` `publish("error")` | +1 | `error` |
| 合计 | | **3 或 4** | |

**`waitFor(3)` 等到的第 3 帧是 watcher 帧，不是 5xx 的 `error` 帧。** 断言本身（`event === "error"` 且 `data` 含 `io_failure`）只依赖第 2 帧；`waitFor(3)` 的多余等待把"watcher 的 100ms 去抖 + 一次读失败的 EACCES"绑进了这条用例。

### 2.3 直接证据（`/tmp` 探针，10 次独立 server）

```
run0 status=500 events=[0ms:ready, 83ms:error, 95ms:library.changed, 193ms:doc.error]
run1 status=500 events=[0ms:ready, 82ms:error, 109ms:library.changed, 193ms:doc.error]
run2 status=500 events=[0ms:ready, 83ms:error, 184ms:doc.error]                     ← 无 library.changed
run6 status=500 events=[0ms:ready, 83ms:error, 194ms:doc.error]
run9 status=500 events=[0ms:ready, 83ms:error, 111ms:library.changed, 193ms:doc.error]
```

- `error` 帧 **10/10 稳定在 ~82ms**（产品路径确定性 ⇒ 机制①"error 在订阅完成前发布 / event-ring 丢帧"**排除**；`ring` 在广播路径上根本没被读）。
- `doc.error` **10/10 在 ~193ms**（100ms 去抖 + 读失败），`library.changed` **8/10**（同一次 `chmod` 触发的两次 `fs.watch` 事件被合并/丢失的程度在变）——**帧数本身就非确定**，`waitFor(3)` 是拿一个非确定量当"帧数契约"。
- 事故形态因此是：`doc.error` 那一路在 `maxWorkers: 2` 全量负载下（事件循环被打满）迟到 >5s 或被丢掉 → `waitFor` 轮询到 `timeoutMs`（5000）→ 与 `testTimeout`（5000）同值竞速 → vitest 先报 `Test timed out in 5000ms`，harness 的诊断（现在根本没有）无处输出。单文件跑时 `doc.error` 只需 193ms，且 CPU 空闲，**10/10 绿是必然**。

### 2.4 附带缺陷（G-2 的施工清单里请一并收）

- `connectSse`（`harness.ts:182`）`setTimeout(() => socket.destroy(), timeoutMs)` **从不 clear**：每条连接留一个 5s 定时器，且 5s 后无差别销毁 socket。`v4#1c` 里 65 条连接 = 65 个未清定时器。
- `waitFor`（`harness.ts:233-241`）超时后**静默 return 现有帧**，既不 throw 也不带任何诊断 ⇒ G-2 的"可诊断"目前是 0。
- `waitFor` 用 10ms 轮询（墙钟）+ `Date.now()` 差值；不是事件驱动。G-1 的处置口径"等事件 + deadline"要求改成 socket `data` 回调里 resolve 的 waiter 表。

---

## 3 G-3 扫描底表（31 处候选，判定列由编写员逐条给理由）

口径：`grep -rnE "setTimeout|sleep\(" packages/*/tests --include=*.ts` = **31 行**（含 helper；`.test.ts` 之外单列）。**不含** `packages/*/src` 里的产品计时器（`daemon.ts:126`、`http-io.ts:126`、`watcher.ts:51`、`app/src/main.ts:114`、`cli/src/chrome/*` 是产品代码，不是测试）。

| 文件:行 | 用法 | G0 初判 |
| --- | --- | --- |
| `packages/core/tests/server/harness.ts:238` | `waitFor` 轮询 10ms，**无事件驱动、超时静默** | **必须改**（本卡 G-1/G-2 正靶） |
| `packages/core/tests/server/sse.test.ts:34` | 同款 10ms 轮询 + 超时 throw（比 harness 好，有文本） | 可接受（deadline+文本），建议与 harness 合并 |
| `packages/core/tests/server/sse.test.ts:135` | 20ms 轮询等 `ird.html` 帧，超时 throw | 可接受 |
| `packages/core/tests/server/g311.test.ts:60` | `waitFor(ready, 3000)` 轮询 | 可接受 |
| `packages/core/tests/server/g311.test.ts:227` | `await sleep(250)` 越过 `ECHO_MS=200` 回声窗口后 `emit("doc.html")` | **确定性**（等的是产品常量窗口，非事件） |
| `packages/core/tests/server/g3r-branches.test.ts:134` | 2s `setTimeout(resolve)` 兜底（socket 结束/错误已能 resolve） | 可接受（兜底），但 2s 与用例 5s 预算偏近 |
| `packages/core/tests/server/g3r-branches.test.ts:185` | 1s 兜底等 close | 可接受 |
| `packages/core/tests/server/g39-gaps.test.ts:71` | `setTimeout(() => …)` | 待编写员逐条判 |
| `packages/core/tests/server/g39-gaps.test.ts:146` | `sleep(30)` | 待判 |
| `packages/core/tests/server/watcher.test.ts:29` | `sleep(ms)` helper 等去抖（等产品 100ms 窗口） | **确定性** |
| `packages/core/tests/server/unit-watcher-daemon.test.ts:34` | 同款 `sleep(ms)` | **确定性** |
| `packages/core/tests/server/unit-branches.test.ts:99` | `sleep(20)` | 待判 |
| `packages/core/tests/server/unit-branches.test.ts:234` | `sleep(10)` | 待判 |
| `packages/core/tests/server/unit-gaps2.test.ts:145` | `setTimeout(() => …)` | 待判 |
| `packages/core/tests/server/unit-gaps2.test.ts:182` | `sleep(25)` | 待判 |
| `packages/core/tests/server/timeouts.test.ts:32` | `setTimeout(finish, budgetMs)` = 硬超时兜底 | 可接受 |
| `packages/core/tests/server/lifecycle.test.ts:19` | `socket.setTimeout(1000)` | 可接受（硬超时） |
| `packages/core/tests/server/harness.ts:101` | `rawExchange` 硬超时 `finish` | 可接受 |
| `packages/core/tests/server/harness.ts:182` | `socket.destroy()` 延迟 5s，**未 clear** | **必须改**（泄漏 + 与 deadline 同值） |
| `packages/core/tests/server/raw-until.ts:29` | 硬超时兜底 | 可接受 |
| `packages/core/tests/io/spawn.ts:41` | 子进程硬超时 | 可接受 |
| `packages/core/tests/html-inject.test.ts:227` | `sleep(0)` 让微任务跑完 | 可接受（等事件循环，不是等产品） |
| `packages/core/tests/io/node-fs.test.ts:40` | `sleep(1)` 作为被测 API 的入参 | 可接受（不是在等时间） |
| `packages/cli/tests/serve-helpers.ts:53` | `sleep(50)` | 待判 |
| `packages/cli/tests/serve-sse-contract.test.ts:103` | 读帧硬超时 | 可接受 |
| `packages/cli/tests/serve-sse-contract.test.ts:170` | `sleep(100)` 后 `patchOnce` | 可疑（要的是"订阅已生效"，可用事件替代） |
| `packages/cli/tests/serve-sse-contract.test.ts:229` | `sleep(100)` 后 `writeFileSync` | 可疑（同上） |
| `packages/cli/tests/serve.test.ts:81` | 硬超时 | 可接受 |
| `packages/cli/tests/skill-shell.test.ts:27` | 硬超时 | 可接受 |
| `packages/cli/tests/units-run.test.ts:246` | 50ms 兜底 | 可接受 |
| `packages/cli/tests/units-run-home.test.ts:49` / `chrome-process.test.ts:17` / `chrome-session.test.ts:29` / `chrome-cdp.test.ts:54` / `pi-extension/tests/style-guards.test.ts:57` / `pi-extension/tests/sse-fakes.ts:66` | 轮询/兜底/注入计时器 | 待判 |

**Rust 侧 `thread::sleep`（4 处，均为产品代码里的轮询间隔，不是 `#[test]` 内墙钟）**：`packages/desktop/src-tauri/src/supervisor.rs:172`、`:255`、`src/signals.rs:142`、`:152`、`:210`。`#[test]` 内无 `thread::sleep` ⇒ Rust 侧"必须改"为空，合理。

**"必须改"目前只有 2 处**（`harness.ts:238`、`harness.ts:182`），二者都在本卡 G-1/G-2 的施工面内 —— 卡面允许"必须改"为空，本卡是 2 条，且不需要为了本卡去改别的文件。

### G-4 可行性裁定：**建议只做成审计清单（§3 表进 `impl-M4.7.md`），不进 `verify`**

理由（按成本排序）：

1. **判定不可正则化**：31 处里 20+ 处是 `await new Promise(r => setTimeout(r, N))` 用作**轮询**（`sse.test.ts:34` 自己带 deadline + throw），与"等固定时长再断言"文本上一模一样。脚本要区分只能做 AST + 数据流（"sleep 后是否无条件 `expect`"），复杂度直接顶到 eslint 的 `complexity 10`/`max-lines 300`，还会自己产生假红/假绿——正是 §11.52 说的"门禁在位但靠不住"。
2. **allowlist 会变成每次改测试都动 JSON**：候选点 31 处，`harness.ts` 的两处（G-1/G-2 要改的）就在名单里；以后每个新轮询 helper（`g311.test.ts:60` 这种模式会被复制）都要新增一条带理由的条目。这是**人肉记忆 + JSON 同步**，卡面 §2 G-4 明确"不选任何需要人肉记忆的方案"。
3. **落地的连带成本**：新 `scripts/*.mjs` 不在 knip 的 entry（M4.6 B2 同款）⇒ `verify` 第 9 步红；要改 `knip.json` 就得协调者授权；改 `.ts` 则被 `tsconfig` 的 strictTypeChecked + `scripts/**/*.ts` 管，`node` 22 不能直接跑 `.ts`。
4. **收益已被 §3 表吃掉**：本卡的处置对象只有 2 处，且都在同一文件；审计表 + 审计员逐条查表，能以 1/10 的成本拿到同样效果。**若未来候选点涨到"必须改"≥5 处，再考虑方案②（`no-restricted-syntax` 禁 `tests/**` 里的裸 `setTimeout`，例外走注释豁免）**，那时规则面已收窄、误报可控。

---

## 4 AC 矩阵（20 条，逐条可判定）

记号：**P**=正向必绿；**N**=反向必红（红在对的位置）。"当前值"来自本轮实测，用于给编写员对基线。

### G-1 定位 + 修掉 `v4#1b` 的偶发超时（6 条）

| 编号 | 判据（一句话） | 命令 | 期望退出码/输出子串 | 失败长什么样 |
| --- | --- | --- | --- | --- |
| AC-1 | P：`v4#1b` 单例仍绿 | C1 | `EXIT=0`；`1 passed`；`✓ … should broadcast an error frame` | 任一 `failed` / `EXIT≠0` |
| AC-2 | P：该用例不再等"第 3 帧"，且**仍认事件名** | `grep -n "waitFor(3)" packages/core/tests/server/sse-v4.test.ts \|\| echo NONE`；`grep -n 'event === "error"' packages/core/tests/server/sse-v4.test.ts` | 前者 `NONE`；后者命中 1 行 | `waitFor(3)` 仍在 ⇒ 仍绑 watcher；`event === "error"` 消失 ⇒ 断言被弱化成数帧 |
| AC-3 | P：单例耗时回到"毫秒级"，不再吃满 deadline | C1，看 verbose 行尾耗时 | `should broadcast an error frame … < 500ms`（基线 122ms） | `≈4900ms` 或 `Test timed out in 5000ms` ⇒ 仍有固定时长等待 |
| AC-4 | P：harness deadline **严格小于** vitest 预算（诊断才出得来） | C5 | `timeoutMs = 5000` 不再出现在 `openSse` 默认值里；`NO_TEST_TIMEOUT(默认 5000)`；新常量（如 `SSE_DEADLINE_MS`）≤ 4000 | 两个 5000 同值 ⇒ 检查失败（B2 原样保留） |
| AC-5 | P：`error` 帧的产品确定性（机制①排除） | C2（20 连跑） | 20/20 `EXIT=0`，无 `Test timed out` | 任一轮超时 ⇒ 要么 watcher 帧仍被等，要么真有产品竞态 |
| AC-6 | P/N：全量门禁 3 连绿（本卡专属） | C3 ×3 | 3 次都 `EXIT=0`；265 文件 / 2971+ 例 / perFile 100% | 任一次非 0 ⇒ 本卡未收口（**不许用单次绿替代**） |

### G-2 harness 诊断（5 条）

| 编号 | 判据 | 命令 | 期望 | 失败长什么样 |
| --- | --- | --- | --- | --- |
| AC-7 | N：`waitFor(99)` 的变异在**deadline 处抛出可诊断错误**，而不是被 vitest 截获 | 临时把用例的等待数改成 99（或加 `-t` 专用探针用例），C1 | 输出含：已收帧数（如 `已收到 2 帧`）、每帧 `event` 与到达时刻、订阅建立时刻、`第 99 帧未出现`；**且总耗时 ≈ deadline（≤4000ms），不是 5000ms** | 出现 `Test timed out in 5000ms` ⇒ 诊断仍未落地；只有 "timed out" 无帧清单 ⇒ 不满足"不看源码就知道差在哪" |
| AC-8 | P：错误里点名"被等待的 event 是否以别的名字来过" | 同上，把 `waitFor` 参数改成 `{ event: "errors" }` | 输出含 `但曾收到 event=error`（或等价措辞） | 只说"超时" ⇒ 缺"换名"这一栏 |
| AC-9 | P：`waitFor` 由 socket `data` 事件驱动，不再 10ms 轮询 | `grep -n "setTimeout(resolve, 10)" packages/core/tests/server/harness.ts \|\| echo NONE` | `NONE`（或只在非 waitFor 的兜底里出现并带注释） | 仍在循环里 ⇒ 仍是墙钟 |
| AC-10 | P：`close()` 后 `waitFor` 不挂死 | 变异：`openSse` 后立刻 `close()` 再 `waitFor(1)` | 在 deadline 内 reject，错误文本含"连接已关闭" | 挂到 5000ms ⇒ 与 vitest 同值竞速重演 |
| AC-11 | P：`connectSse` 的 destroy 定时器被 clear | `grep -n "clearTimeout" packages/core/tests/server/harness.ts`（`connectSse` 段） | 命中（`connectSse` 返回的 socket 或 `openSse.close` 里 clear） | 125 行内仍无 clear ⇒ 5s 后无差别销毁 socket（`v4#1c` 65 连接受影响） |

### G-3 同类扫描（4 条）

| 编号 | 判据 | 命令 | 期望 | 失败长什么样 |
| --- | --- | --- | --- | --- |
| AC-12 | P：扫描表存在且覆盖 §3 的 31 处 | `grep -cE "^\| \`packages/" .workflow/reports/impl-M4.7.md`；C8 | 表行数 = `C8` 的数（差异必须在报告里逐条解释） | 少行且无解释 ⇒ "没扫" |
| AC-13 | P：每行都有三选一判定 + 理由 | `grep -c "必须改" …`；`grep -c "可接受" …`；`grep -c "确定性" …` | 三者之和 ≥ 表行数；`必须改` 的条目均带一句话理由 | 有行无判定 ⇒ 判失败 |
| AC-14 | P：Rust 侧 `#[test]` 内无 `thread::sleep` | `grep -rn "thread::sleep" packages/desktop/src-tauri/src packages/desktop/src-tauri/tests` | 4-5 处，全部在产品函数体内（不在 `#[test]`） | 出现在 `#[test]` ⇒ 必须改 |
| AC-15 | P：无 `retry:` 兜底、无新增依赖 | `grep -rn "retry:" packages/*/tests --include=*.test.ts`（只应命中 SSE 帧文本）；`git diff --stat pnpm-lock.yaml \| wc -l` | 前者只命中 `retry: 2000` 字面量；后者 `0` | 出现 `{ retry: n }` 或 lockfile 变更 ⇒ 违卡面非目标 |

### G-4 门禁可行性（5 条，按 §3 建议走"审计清单"分支；括号里给"若要进 verify"的等价 AC）

| 编号 | 判据 | 命令 | 期望 | 失败长什么样 |
| --- | --- | --- | --- | --- |
| AC-16 | P：`pnpm verify` **步骤数不变**（G-4 降级 ⇒ 不入门禁） | `node -e 'console.log(require("./package.json").scripts.verify.split("&&").length)'` | `10`（M4.6 后现值） | `11` ⇒ 实际入了门禁，与 G0 建议冲突，需 D 裁定 |
| AC-17 | P：不新增 `scripts/check-test-timers.mjs` | `ls scripts/check-test-timers.mjs 2>&1` | `No such file` | 文件存在而 verify 没挂 ⇒ 死代码（knip 会红） |
| AC-18 | P：审计表带"维护成本"结论句 | `grep -n "allowlist" .workflow/reports/impl-M4.7.md` | 命中，且写明"候选点增长到 X 处再升级为门禁"的触发条件 | 只写"建议审计"不给触发条件 ⇒ 下一个人无从判断何时升级 |
| AC-19 | P：§3 表已含 `harness.ts:182`/`:238` 两处"必须改"的修复状态 | `grep -n "harness.ts:18[0-9]\|harness.ts:23[0-9]" .workflow/reports/impl-M4.7.md` | 两行都标 `已修` 或 `本卡内修` | 仍标"必须改"未修 ⇒ G-3 与 G-1 脱节 |
| AC-20* | N（仅在 D 裁定"进 verify"时启用）：门禁必须自带四件反例 | `node scripts/check-test-timers.mjs >/tmp/a.log 2>&1; echo "EXIT=$?"`；分别注入"裸 sleep 后断言"、"删掉一条 allowlist"、"加一条过期 allowlist"、"改 selftest 的 `exit(1)→exit(0)`" | 基线 `EXIT=0`；四种注入均 `EXIT≠0` 且命中各自专属串（§11.53-2） | 任一注入仍 0 ⇒ 假绿，直接判 G-4 失败并降级 |

---

## 5 歧义清单（A-1…A-7，请协调者裁定）

| 编号 | 歧义 | 我的建议 |
| --- | --- | --- |
| **A-1** | 卡面 G-1 写"若实际只该来 2 帧（首帧注释 + error）"——**这个口径本身就数错了**：首帧注释不计帧，实际有 2 个"契约帧"（`ready` + `error`），第 3 帧是 `doc.error`（watcher）。是"卡面笔误按实测改口径"，还是"要求用例真的只依赖 2 帧"？ | 按实测改口径：契约帧 = `ready`(1) + `error`(2)；用例改成"等 `error` 事件"，不数帧 |
| **A-2** | `waitFor(n)` 的 API 形态：保留 `waitFor(n)` 但加诊断，还是新增 `waitForEvent(name, predicate)`？后者要动 `v4#1a`/`v4#1c`/`sse.test.ts` 的调用面 | 保留 `waitFor(n)`（兼容 20+ 调用点）+ 新增 `waitForEvent`；`v4#1b` 改用后者 |
| **A-3** | `chmod 000` 会经 watcher 产生**额外帧**（`doc.error` / `library.changed`，后者 2/10 丢失）。要不要把 `v4#1b` 的 5xx 触发器换成"不动 workspace"的方式（如请求一个不存在的 `/api/doc/x/model` 是否 404 而非 5xx？需先确认）？ | 不动触发器（改产品路径超出本卡），只改等待口径；但需在报告里记一条"该用例依赖 fs.watch"的已知耦合 |
| **A-4** | G-3 的扫描面：卡面写 `packages/**/tests/**` 与 `packages/**/*.test.ts`——helper（`harness.ts`/`serve-helpers.ts`/`sse-fakes.ts`）算不算？ | 算，且单列（§3 已列，`harness.ts:182/238` 就是 helper 里的"必须改"） |
| **A-5** | G-4 分支：我建议**降级审计清单**（§3 四条理由）。若协调者仍要进 `verify`，则**必须同时**授权改 `knip.json`（`scripts/**/*.mjs` entry）+ 接受 eslint 复杂度约束 | 降级；把"升级触发条件"写进审计表（候选点 `必须改`≥5 处时再议） |
| **A-6** | G-1 完成后"偶发红已消除"的证据强度：卡面只要求 `verify`×3；但 3 次无法统计偶发率 | 加 AC-5 的 20 连跑 + 1 次 `maxWorkers: 2` 全量（就是 C3），双口径都在报告里贴 |
| **A-7** | 是否允许把 `v4#1b` 的 `expect(failed.status).toBe(500)` 保留但同时断言"帧数恰为 2"（更强的契约）？ | 允许断言"恰有 1 个 `error` 帧"，**不要**断言总帧数（watcher 会加帧） |

---

## 6 反例设计草案（证明 G-1/G-2 的修复真能红，5 条）

| 编号 | 变异 | 改哪里 | 期望 | 它证明什么 |
| --- | --- | --- | --- | --- |
| **MV-1** | 删掉 deadline | `harness.ts` 的 `waitFor`：`while (frames.length < count)` | `v4#1b` 出现 `Test timed out in 5000ms`（不是自定义诊断文本） | deadline 是唯一挡住"永久等"的东西；也说明 AC-7 的"错误文本"确实来自 harness 而非 vitest |
| **MV-2** | 事件名改错 | `server.ts:159`：`publish("error"` → `publish("errors"` | `v4#1b` 必须红在 `expect(errorFrame?.data).toContain('"io_failure"')`（`errorFrame` 为 `undefined`） | 断言认的是**事件名**，不是"帧数够了";若仍绿 ⇒ 断言已被弱化成数帧 |
| **MV-3** | `waitFor` 直接 return | `waitFor` 首行 `return frames;` | 至少 4 条红：`v4#1a`（`frames[0]?.event` 为 `undefined`）、`v4#1b`、`v4#1c`（`overflow.status` 断言前 65 连接未就绪 → 429 提前/行为漂移）、`serve-sse-contract` 依赖段 | `waitFor` 不是装饰，G-1 的改动没把它变成 no-op |
| **MV-4** | 删诊断 | `waitFor` 超时 `throw` → `return frames` | AC-7 的 `waitFor(99)` 变异**拿不到**帧清单/事件名，只能看到 `Test timed out` 或断言失败 | G-2 的诊断是独立能力，不被 G-1 的"改成事件驱动"顺带满足 |
| **MV-5** | 断言弱化（阴性对照） | 把 `event === "error"` 换成 `frames.length >= 2` | MV-2 下**仍绿** | 证明"数帧"式断言抓不住事件名错误 ⇒ AC-2 的 grep 是必要门禁而非形式主义 |

**执行纪律**（§11.51-1/-3）：每次变异用 `cp <file> /tmp/<file>.bak` → 改 → 跑 → `cp` 回 → **`cmp -s`** 校验；证据三件套（命令 + `EXIT=` + 命中的那行输出）贴进 `impl-M4.7.md`。**禁止**用管道吞退出码（`… | tail`）。

---

## 7 给编写员的最小施工顺序（建议，不含裁定）

1. `harness.ts`：`waitFor` 改成 waiter 表（socket `data` 里 resolve）+ `SSE_DEADLINE_MS = 3000` + 超时 `throw`（带帧清单/订阅时刻/换名提示）+ `connectSse` 定时器可 clear；新增 `waitForEvent(name)`。
2. `sse-v4.test.ts:104-126`：`waitFor(1)` 保留，`waitFor(3)` → `waitForEvent("error")`；断言 `failed.status === 500` + 恰 1 个 `error` 帧 + `io_failure`。
3. G-3 表：把 §3 的 31 行搬进 `impl-M4.7.md`，逐条补判定与理由（`必须改` 只允许剩 0 条）。
4. G-4：按 A-5 裁定落审计表结论（默认**不动 `verify`**）。
5. 收口：C3 ×3 + AC-5 的 20 连跑 + MV-1…MV-5 的三件套证据。
