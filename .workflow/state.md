# WORKFLOW STATE

- 当前里程碑: **M4.7 已结卡（2026-11-18）**。M4.7 = 收掉 `L-43`（SSE 偶发超时），**修的是夹具不是服务端**。三件：① SSE 客户端从 `harness.ts` 拆到 `packages/core/tests/server/sse-client.ts`，三时钟分层且写死注释（`SSE_DEADLINE_MS = 3000 < vitest 5000`、`HTTP_DEADLINE_MS = 4000`、`SOCKET_LIFE_MS = 60_000 >` 任何 per-test 预算 30_000），超时改抛错并自述（帧清单 + 订阅时刻 + 换名提示），断连经幂等 `shutdown()` 唤醒 waiter；② 三层假绿逐层去掉（`clearTimeout` 不再只靠 grep，改 `vi.getTimerCount()` delta；KD-07 的 `it.fails` 从“靠 harness 4000ms 静默 resolve 空串”改成真断言 `400 + elapsed < 1000`（实测 3.5ms）并**退表** `CAP 10 → 9`，理由是“前提过期”而非“修好了”；删两条恒真断言）；③ 两条不修只登记（见文末待办）。审/测四轮：变异合计 KILLED 16 / SURVIVED 3（幸存者含 `SOCKET_LIFE_MS=30_000` 无用例活到 30s——“约束不可观测≠缺断言”，接受）。`pnpm verify` 十步 EXIT=0（265 文件 2974 例、四维 100%）+ `pnpm desktop:check` EXIT=0。教训入 `docs/03` §11.54。下一卡候选：`docs/02` 的 M4.8（M1–M3 加固 / 导出链 / DSH 面板待用户裁定）。
- 当前里程碑（上一卡）: **M4.6 已结卡（2026-11-18，`d5fa538`）**。M4.6 = 门禁自我证明：`scripts/lint-sh-selftest.sh`（坏脚本/空集/缺目录/干净四类夹具 + 末尾自调用）与 `scripts/check-ci-parity.mjs`（verify 十步 vs `ci.yml` checks 同序同集 + 拒绕步骤级 `continue-on-error`/`if`/`shell`/`working-directory`/`env` 与作业级 `if:`）双双入 `verify`，步骤数仍 10、代价 0.53%；parity 自证改为父存期望、子进程判决，`exit(1)->exit(0)` 已实测会红。终测 31/31 AC、变异 11 KILLED / 5 SURVIVED。新登记 `L-43`（`packages/core/tests/server/sse-v4.test.ts > v4#1b` 全量并发偶发 5s 超时，下卡处理）/`L-44`（M4.2 G-3 的“无竞态”只能靠结构论证，40 连跑 0 红证明不了）。265 文件 2971 例、四维 100%、`pnpm verify` EXIT=0 + `pnpm desktop:check` EXIT=0 + `cargo test` 10 连跑 0 失败。教训 §11.52–§11.53。下一卡候选：M4.7（SSE flake + M1–M3 加固）/ M4.3 导出链 / M4.x DSH 面板（需用户裁定构建链）。
- 当前里程碑: **M4.2 已结卡（2026-11-18，`d736a4b`）**。M4.2 = Tauri v2 桌面壳（`@hreader/desktop`）：壳不托管阅读器，只做「定位 `hr` → 读/复用/拉起 daemon → webview 导航」；三条硬不变量（父 pid 只采一次 / 看门狗可撤 + `unref` 兜底 / 信号装配类型强制）。结卡证据：265 文件 2971 例、四维 perFile 100%，`pnpm verify` 八步 EXIT=0 + `pnpm desktop:check` EXIT=0（cargo 80 例）；**`ci.yml` 首次与 `verify` 八步一一对应**（此前少 `lint:sh` 与 `build`，见 `docs/03` §11.49）。过程 8 轮返工，教训 §11.45–§11.50。下一卡候选：M4.3 导出链 / M4.x DSH Web 面板（需用户裁定构建链）/ 回 M1–M3 加固。
- 当前里程碑（上一卡）: **M4.5.1 已结卡（`02f2649`）**；M4.2 于 2026-11-18 立卡开工，现已结卡（见上）
- 当前里程碑（旧）: **M4.5 已结卡（`1dcfcba`）**。260 文件 / 2896 例 / 四维 perFile 100%，`pnpm verify` 连跑两遍 EXIT=0。M4.5「PDF 大纲/书签」= Chrome 原生 `generateDocumentOutline`（侦察翻案：路线图原写"浏览器打印不可实现"是错的）；零新增依赖、src 无 PDF 解析器；`--outline`(默认开)/`--no-outline`，png 上双向 `invalid_input`；`--json {pdf,bytes,pages,outline,out}`。已知限制 `L-40`（`display:none` 标题仍被计数）/`L-41`（Chrome 截超长标题约 1KB）。过程：G0 矩阵（测试员）→ F1 超时中断后 resume → 审计 `PASS WITH NOTES` + 真机 21 变异 → R1 补夹具与树内 e2e → 全量 CI → 结卡。下一步候选：M4.2 Tauri（本机有 cargo 1.98，但跨平台打包不可验证）/ M4.x DSH 面板（需用户裁定构建链）/ 或回到 M1–M3 的加固卡。
- 角色载体（2026-11-17 起）: 仓库内自建的 `auditor`/`tester` 代理定义**已消失**（`Unknown agent: auditor`），从现在起审计员一律用内置 **`reviewer`**、测试员用内置 **`worker`**、编写员用内置 **`worker`**，角色由派单提示词定义，不依赖代理定义文件。
- 当前里程碑（旧）: **M3 全部结卡**（M1 7 卡 / M2 3 卡 + C1 / M3.1 `74781fc` / M3.1.1 `3134499` / M3.2 `49d8cb1` / M3.4 `ba9579a` / **M3.3 `165da68`**）；下一卡待用户指示（M4.1 风格萃取器 或 M4.2 Tauri / M4.x DSH Web 面板 / M4.3 导出链）
- 用户指令（2026-11-16）: “按你的流程来，继续开发，**不要没开发完就问我一下**” → 每卡自主走完 写者 → 审计＋测试 → 返工 → 全量 CI → 提交 → 勾 `docs/02`，不经用户确认。
- 写者并发: 最多 1 个。**测试用例是代码，归编写员写**（用户 2026-11-15 裁定，`docs/03` §1.2/§1.4）；审计员与测试员纯只读，不写仓库文件。
- 门禁前置（2026-11-15 起）: 编写员每交一批，协调者先跑全量 `pnpm verify` 再派审计/测试（`docs/03` §3.5、`execution-manual` §10.9 第 7 条）。
- 上下文阈值: 软 60% 主动压缩；硬 150K tokens 且任务已完成 → 交接重生；单会话 ≥ 3 张卡强制重生
- 依赖策略（用户 2026-11-14 判定，**取代** 2026-11-13 的"不新增任何依赖"）: **按需引入成熟可靠开源库**；已手搓模块（如 `annotations/diff.ts` 的手写 LCS）另开重构卡替换。两类须先请示：前端运行时依赖（`@hreader/app` 无 bundler）、底层核心架构替换（框架/打包器/AST）。详见 `docs/02` §依赖策略、`docs/03` §11.9。
- 子代理载体（2026-11-14）: `pi-subagents` 的 `subagent` 工具（旧 `acp_delegate`/`resumeFrom`/`del_*` 全部作废）；所有子代理 `thinking: low`，主会话 `high`。
- CI 执行纪律: 全量 `pnpm verify` 只由协调者在收口时跑 1 次；开发期只跑定向测试；`vitest.config.ts` 已设 `maxWorkers: 2`（限流，不放宽 `perFile` 四维 100%）。

## 会话登记（正式，续接用这些 runId）

> **2026-11-14：旧 `del_*` 会话随 `acp_delegate` 一起作废，不再续接。** 下表的 `del_*` 仅作历史审计记录；从现在起三角色用 `pi-subagents` 的 `subagent` 重建（`worker` × 2、`reviewer` × 1），runId 登记在下方"新载体会话"表。

| 角色（旧载体，作废） | runId | 启动时间 | 上下文占用 | 已完成卡数 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 编写员 (worker) | `del_mweznzz6_auq7` | 2026-11-13 | ~35% | 4 | 已作废（M2.1 R7/R8 为其最后一轮） |
| 审计员 (reviewer) | `del_mwf0rnkd_uy6f` | 2026-11-13 | ~50% | 8 | 已作废（M2.1 G2-R2 PASS） |
| 测试员 (test-scope) | `del_mwezhxn7_qwoi` | 2026-11-13 | ~55% | 8 | 已作废（M2.1 G3.12，1439 例）|

### 新载体会话（`subagent`，2026-11-14 起）
| 角色 | agent | runId（会话） | 建立时间 | 已完成卡数 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 编写员 | `worker` | `c77149fd-10ba-4e2c-b1fc-3f5909705b72` | 2026-11-15 14:0x | M2.3 R1–R4、C1、M3.1 F1–F9、M3.1.1 F1–F4、**M3.2 F1–F6**、M3.4 F1–F3 | 已达 3 卡上限，M3.3 起由 `bbc1e2b7` 接替 |
| 审计员 | `reviewer` | `e7ec0c5e-95b4-4390-a93b-0bf82f4f3615` | 2026-11-15 16:3x | M2.3、C1、M3.1 G2-R1…R5、M3.1.1 G2-R2、M3.2 G2-R1/R2/R3、M3.4 G2-R1 | 已达 6 卡上限，M3.3 起重建 |
| 测试员 | `worker` | `0fd44fc1-3154-4573-8c47-e17bee195b50` | 2026-11-15 15:4x | M2.3、C1、M3.1 G3/G3-R2、M3.1.1 G3.1、M3.2 G3-R1…R4、M3.4 G3-R1/R2 | 已达 6 卡上限，M3.3 起重建 |
| 编写员（M3.3 起） | `worker` | `bbc1e2b7-81b4-46eb-8d6c-f4ed18293863` | 2026-11-16 | M3.3 F1–F2、F3 | 链尾 `abba30c7`（F6 注释），下卡可续接 |
| 审计员（M3.3） | `reviewer` | `4ef1c5b2-742d-484e-8fc7-d194be0cdacc` | 2026-11-16 | M3.3 G2-R1/R3 | APPROVE WITH NOTES（无 P0/P1），下卡可续接 |
| 测试员（M3.3） | `worker` | `28b76f02`（G3-R1） | 2026-11-16 | M3.3 G3-R1/R2 | 13 变异 11 有牙 1 survived 2 软；下卡续接需重建 |
| 编写员（M4.1） | `worker` | `b127f5b6-5a30-4301-829a-f6ebdfcf8f60` | 2026-11-16 22:2x | M4.1 F3 | 链尾 `c79bb9d3`（R27）；下卡可续接 |
| 审计员（M4.1） | `reviewer` | `8672ae7c-7799-4fbf-81d7-db9f50841213` | 2026-11-16 23:0x | M4.1 F3 G2-R3 | 5/5 核验 PASS + 4 条 P2；下卡可续接 |
| 测试员（M4.1） | `worker` | `9d3347b3-80a8-4b89-90cd-d09d862de85e` | 2026-11-16 23:0x | M4.1 F3 G3-R3 | 16 变异 KILLED、12 组 URL 矩阵；**F3 签核** |
| 编写员（M4.3） | `worker` | `f1cc98fa-c70b-409e-ae7f-c065c63fc29d` → `84efc85f-1445-48e3-99d4-b82d6e589871` → `ac1fb9d2-edf6-4194-8b1b-f3b25adfac1f` | 2026-11-17 | M4.3 F1 | 链尾 R2（F1 三项修正 + F2）；**30 分钟看门狗会掐，派单要切小** |
| 审计员（M4.3） | `reviewer` | `95b930c1-199e-49ed-8890-355bcf5ff62e` | 2026-11-17 | M4.3 G2（F1） | F1 判 `CHANGES-NEEDED`（1 BLOCKER：docs/05 错误码表，已由协调者补）；下轮可续接 |
| 编写员（M4.6） | `worker` | `18744017-17f8-4ffe-84e2-ec38bee43de4`（R2）→ `7a47343e-c7eb-4c3e-84da-d4296e97855f`（R3） | 2026-11-18 | M4.6 R2 / R3 | R3 为终轮，下卡可续接（注意：R1/F1 的 runId 已被压缩，需从 `.workflow/reports/impl-M4.6.md` 追） |
| 审计员（M4.6） | `reviewer` | 见 `.workflow/reports/audit-M4.6.md`（本次以只读静态判定交付，无 shell/写工具） | 2026-11-18 | M4.6 G2 | 判 `OK with notes`（1×P1 + 3×P2，实跑项由协调者补证） |
| 测试员（M4.6） | `worker` | `fe91057f-385e-46d2-97ac-8cfb621c1c45` | 2026-11-18 | M4.6 G3 | 31/31 AC、变异 11 KILLED / 5 SURVIVED；此 run 已超长，下卡建议重建 |
| 测试员（M4.3） | `worker` | `44c87d00-6809-4c0b-b5be-810b4d7cee05` | 2026-11-17 | M4.3 G3（前置） | 第 7 代 AC 矩阵 + 6 处歧义，落盘 `.workflow/reports/spec-M4.3.md`；下轮可续接 |
| 编写员（M4.4） | `worker` | `4d74ddd4` → `f49be24c` → `0556ff56` → `39aa038b` → `8dfff8d3`（均为 resume 链，同一磁盘会话） | 2026-11-17 | M4.4 F1–F2、R1–R8 | **已结卡（`53e456a`）**；链尾 R8。已积累 8 轮，下卡建议重建会话 |
| 审计员（M4.4） | `reviewer` | `20cd424b-ec6f-4b19-9453-743a7ea6a636` | 2026-11-17 | M4.4 G2 终审 | `PASS WITH NOTES`（4 个 P2，已入 R8）；下卡可续接 |
| 编写员（M4.2） | `worker` | `a0cdcd13` → `2cc73c53`（G1/r1 两跳）→ `a8750739`（R1 返工） | 2026-11-18 | M4.2 G1 + R1 | 链在同一磁盘会话；G1 曾因看门狗 30 分钟掐断一次后 resume 补齐 |
| 审计员（M4.2） | `reviewer` | `e79a1d58` | 2026-11-18 | M4.2 G2′ | `PASS WITH NOTES`（1 P2 + 2 P3），落 `.workflow/reports/audit-M4.2-r1.md` |
| 测试员（M4.2） | `worker` | `e2c209d2` → `ac4d9b6d`（ECONNRESET resume） | 2026-11-18 | M4.2 G3′ | 10 变异 + 8 真机案；2 洞 + 1 FAIL（B5 启动窗口），落 `.workflow/reports/test-M4.2-r1.md` |
| 测试员（M4.4） | `worker` | `3e8bb6c6-9625-4d02-af5d-c711bcb1198d` | 2026-11-17 | M4.4 G3 终测 | `PASS WITH NOTES`（6 条真机 IHDR 证据）；下卡可续接 |
| 编写员（M4.5） | `worker` | `55e5e0a8` | 2026-11-18 | M4.5 F1 | **已结卡 `1dcfcba`**；下卡重建 |
| 审计员（M4.5） | `reviewer` | `6353d988` | 2026-11-18 | M4.5 G2 | `PASS WITH NOTES` 无 BLOCKER |
| 测试员（M4.5） | `worker` | `c4a1e1f5` | 2026-11-18 | M4.5 G3 | 21 变异 |
| 编写员（M4.5.1） | `worker` | `31857109` | 2026-11-18 | M4.5.1 R1 | **已结卡 `02f2649`**；下卡重建 |
| 审计员（M4.5.1） | `reviewer` | `694a8c4a` | 2026-11-18 | M4.5.1 G2′ | `PASS WITH NOTES` 无 P1 |
| 测试员（M4.5.1） | `worker` | `3cc487e2` | 2026-11-18 | M4.5.1 G3′ | 发现 1 BLOCKER（`/Outlines` 绕过 `skipSpace` 致抵消），已入 R1 |
| 测试员（M4.2 G0） | `worker` | `b9ff0f75` | 2026-11-18 | M4.2 G0 | 25 行 AC 矩阵 + 12 变异 + A1–A10；下轮可续接 |
| 编写员（M4.2） | `worker` | `a0cdcd13-b07e-4851-9e60-c6b6a148e3ff` → `2cc73c53`（G1 resume）→ `871ffbe2-b4a5-476b-bac8-f2cc4bbb6130`（R1） | 2026-11-18 | M4.2 G1 → R1 | G1 超时一次已 resume 补完；R1 修 W1–W6 |
| 审计员（M4.2） | `reviewer` | `8a114329`（30 分钟超时、零结论）→ `19317eb0-856f-4b7f-9807-7ba60424100d`（缩范围重派） | 2026-11-18 | M4.2 G2 | 首轮逐行通读耗尽预算 → 第二轮改「grep 优先、20 分钟内必交」 |
| 测试员（M4.2） | `worker` | `55e9d516-bfb8-4a90-b261-11d89aa1ec48` | 2026-11-18 | M4.2 G3 变异轮 | 12 变异 → 10 KILLED / 2 SURVIVED；洞与破坏面落 `.workflow/reports/test-mutations-M4.2.md` |
| 编写员（M4.2 R5–R8b） | `worker` | `524be4b2`(R5) → `a60ba7af`(R6 崩溃 ECONNRESET) → `6a5284ef`(R7) → `a5322aac`(R8a) → `211a990a`(R8b) | 2026-11-18 | M4.2 返工+收尾 | 每轮新建不续接；R7 起执行「一树一写者」（§11.50） |
| 审计员（M4.2 G2‴/G2⁗） | `reviewer` | `18a83522`(G2⁗)；G2‴ 与 R5 终审的 runId 未记（报告 `.workflow/reports/audit-M4.2-r4.md`/`-r5.md`） | 2026-11-18 | M4.2 终审 | 该载体无 shell 工具，动态项由协调者补跑；抓出文档造假 2 处 + `ci.yml` 六步≠`verify` 八步 |
| 测试员（M4.2 G3‴/G4） | `worker` | `ba54521d`(G3‴ 45 分钟超时，报告在超时前落盘) → `0804d256`(G4) | 2026-11-18 | M4.2 终测 | G4 PASS；IEND 断言无覆盖 → R8b；`launchParentPid` 幸存者记录在案不修 |
| 测试员（M4.5） | `worker` | `40cd46bb-4767-4348-a755-7488be062f39` | 2026-11-17 | M4.5 G0 | AC 矩阵 321 行 + A1–A14 歧义 + MV-1…MV-21；已结卡 |
| 编写员（M4.5） | `worker` | `54f07bdf` → `ebede24d`(resume) → `8621b845`(resume) | 2026-11-17 | M4.5 F1 + R1 | **已结卡（`1dcfcba`）**；F1 首轮 30min 超时，resume 续做未重建 |
| 审计员（M4.5） | `reviewer` | `6353d988-a229-4f1c-a5ca-483da94eee67` | 2026-11-17 | M4.5 G2 | `PASS WITH NOTES`（3 个 P1 全是测试网洞，已由 R1 补）；其环境无写工具，报告由协调者代录 `.workflow/reports/audit-M4.5.md` |
| 测试员（M4.5 G3） | `worker` | `2e7b5ce5-8dcd-451f-8805-1500c3a7b02a` | 2026-11-17 | M4.5 G3 | 真机 AC 全过 + 21 变异（19 红）；抓到 `display:none` 计数不一致 → `L-40` |
| 编写员（M4.5.1） | `worker` | `cf4cb580-caff-4850-93e9-4f1e7f4aabc6` → `31857109`(R1) → `38ac9a78`(R2) → `1a135f09`(R3) 均为 resume 链 | 2026-11-18 | M4.5.1 F1/R1/R2/R3 | **已结卡**；R3 执行 A 方案（删冗余步数上限，只留 `seen`）；7 轮后仍健康 |
| 审计员（M4.5.1） | `reviewer` | `fea68fda-c8c7-4ad1-8552-a9132198f805` | 2026-11-17 | M4.5.1 G2 | `PASS WITH NOTES`（无 P1）；R1 后已派 G2' 复审 `syntax.ts`（`694a8c4a`）。报告 `.workflow/reports/audit-M4.5.1.md` |
| 测试员（M4.5.1） | `worker` | `e7a2fc15` → `3cc487e2`(G3) → `efac6326`(G3') | 2026-11-18 | M4.5.1 G3/G3' | 真机 AC 全过 + **抓到 BLOCKER**（标题含 `endobj`/`/First …` 被当结构）；G3' 8 条变异：**7 红 1 全绿**（`lastStartxref` 过滤 = 测试洞，已 R3 封口）；确认“大纲顺序不随机”（5 连跑字节差仅 `/CreationDate`/`/ModDate`）、`--outline`/`--no-outline` 交替无残留 |


> **M4.4 结卡记录（2026-11-17，`53e456a`）**：64 文件 +5186/−81；`pnpm verify` EXIT=0 跑两遍（257 文件 / 2857 例 / 四维 perFile 100%）；真 Chrome 证据：默认档 9 页 A4 → `2400×17634`、`--width 4096 --scale 3` → `12288×16239`、`--scale 3 --max-height 50000` 未 spawn 即拒、短文 713px → `2400×1426`、内容恰好 1000px → `2400×2000`。教训入 `docs/03` §11.35–§11.38。
> **注意（网络）**：本卡期间子代理 `ECONNRESET` 中断 **4 次**（`4d74ddd4`→`f49be24c`→`0556ff56`→`39aa038b`→`8dfff8d3`）；每次都用 `subagent({action:"resume", id})` 原地复活，未重建、未重做。中断后派单第一句要写「先 `git status` 看已有改动，从中断处继续」。

> M3.2 会话链（2026-11-15 结卡）：编写员 `c77149fd` →（resume）`e4ff84b3` → `648b635f` → `5814489f` → `b6a59718`；审计员 `e7ec0c5e`（G2-R3）；测试员 `0fd44fc1`（G3-R2）→ `1a56dfaa`（G3-R3）→ `5c6dcbf7`（G3-R4）→ `574f2e38`（F5 后签核）。
> 三个角色的旧会话（`34a29f97`/`24bfa9ff`/`21773373`）在 M3.2 开工时重建，卡内容未变，可从新 runId 续接。

> 旧编写员会话 `25b6eda9-c06e-427c-83bc-15679ad454cf`、`a76d3f76-4810-4025-9ea3-17098b00d619`、`e524734b-f4d5-4051-ae6f-82e75f81f576` 已交接重生，不再续接。

> 记账教训（M1.8 起）：续接的 runId 不许凭记忆填，必须对照本表；派单里的路径/行号必须当场 `sed -n` 核对。审计员已无写权限，报告落盘责任在协调者。


### 冒烟验证会话（仅作能力自证记录；会话已作废，不再续接）
| 角色 | runId | 结论 |
| :--- | :--- | :--- |
| 编写员 | del_mwdq2qwb_i47p → R1 del_mwdqf3gk_nory | 按 finding 返工成功 |
| 审计员 | del_mwdq4adb_tpvc → R1 del_mwdr0wxj_ewle | R0 抓到 P0×2/P1×5；R1 复审 G4 FAIL（剩 1 P1 测试判别力） |
| 测试员 | del_mwdq4htw_efsy → R1 del_mwdql40k_oxd9 | 变异测试 10 个变异体全杀；R1 裁决 6 个过时用例，54/54 绿，line 100%/branch 96.43% |

## 门禁记录
| card | G1 impl | G2 audit | G3 test | G4 verdict | note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| M1.0 | ✅ R0.1/R1/R2 | ✅ PASS(复审) | ✅ 31 例 | ✅ PASS | commit `f1eba42`；3×P0 全关；剩 1 项非阻塞 |
| M1.1 | ✅ G1/R1/R2 | ✅ PASS | ✅ 219 例 | ✅ PASS | commit `7ec0110` |
| M1.2 | ✅ G1/R1 | ✅ PASS | ✅ 300 例 | ✅ PASS | commit `66382e7`；模型只读投影、四维 100% |
| M1.3 | ✅ G1/R1 | ✅ PASS | ✅ 393 例 | ✅ PASS | commit `bf34c87`；诊断聚合限流 1024B；5/5 变异体 |
| M1.4 | ✅ | ✅ PASS(R2) | ✅ 511 例 | ✅ PASS | commit `8916c63`；空壳截断(P0)、path 双口径、meta 白名单误判、死臂 |
| M1.5 | ✅ R1–R6 | ✅ PASS(R3) | ✅ 721 例 | ✅ PASS | commit `f9d00bb`；TOCTOU/字节保真/`values` 列表/`<svg><template>` 裸崩 |
| M1.6+M1.7 | ✅ G1/R1/R2 | ✅ PASS(G2-R) | ✅ 924 例 | ✅ PASS | commit `8e5c15b`；1×P0 doctype 被挤、CSS 转义绕过、单锚点、load/apply 分叉 |
| ~~M1.7~~ | 合并入 M1.6 | - | - | - | 同文件族，省一套门禁 |
| M1.8+M1.9 | ✅ G1/R1–R5 | ✅ PASS | ✅ 1112 例 | ✅ PASS | commit `20d5e37`；退出码矩阵、`--json` 单行、裸 node id 回路、realpath |
| M2.1 | ✅ G1/R1–R8 | ✅ PASS(G2-R2) | ✅ 1439 例 | ✅ PASS | commit `dc9e9c2`（+`5dfd71c`）；3×P0（错误细节/SSE 帧注入/TE+CL）、丢写 P1（`ageOf`/窗口期扫描 root）|
| M2.2 | ✅ | ✅ G2-R2 PASS | ✅ 1643 例 / 133 文件 / 四维 100% / EXIT=0（协调者复跑） | ✅ | 零依赖 UI；1290 行；6 轮返工关 4 个 P0；`verify` 现含 `build`（防 dist 陈旧） |
| C1 | ✅ 无新增 AC | ✅ G2 PASS | ✅ 1951 例（不变）/ 四维 100% / EXIT=0 | ✅ | 清 `L-04`（`Host.focus` 收回，含 `ElementLike.focus?` 连带）+ `L-05`（wire 删 `reason`/`originNodeId`）；9 条 wire 断言转反向锁（变异自检 9 红）；新增 `L-06/L-07/L-08` |
| M2.3 | ✅ G1/R1–R4+实现3轮 | ✅ G2-R3 PASS | ✅ 1951 例 / 167 文件 / 四维 perFile 100% / `verify` EXIT=0（协调者复跑，53.7s） | ✅ | 划词批注持久化 + Visual Diff + 撤销（20 AC；16 条路由）；G2 首轮 FAIL(2×P0) 已修。**首次全链绿**；死字段清理 + `diffFlow` 权威 `nodeId` + `blockBasisOf` 丢块报“无变化” + reducer 穷尽性 + 三份 `ZERO_SPAN` 归一。新增 `L-01..L-05`（设计边界/死 seam/线上零消费字段） |
| M3.1 | ✅ G1/F1–F9 | ✅ G2-R1…R5 PASS | ✅ G3 + G3-R2（含变异表） | ✅ | commit `74781fc`；39 文件 +2875/-303；标准 MCP Server + MCP-UI；**发现 `L-21`（产物离开仓库即失效）/`L-13`（路径判定两份）→ 开 M3.1.1** |
| M3.1.1 | ✅ F1–F4 | ✅ G2-R2 PASS（+D13 三判定） | ✅ G3.1 签核（对照组实证） | ✅ | commit `3134499`；15 文件 +158/-76；191 文件 / 2102 例 / 四维 100% / `depcruise` 0 / `knip` 无 hint / `EXIT=0`。修 `L-21`+`L-13`+`L-26`；哨兵臂进用例；全量 CI 抓到公开面第二处拼写（`facade.test.ts:35`）→ 立"门禁前置"规则 |
| M3.3 | ✅ F1–F6（含 F3b/F4b/F5/F6） | ✅ G2-R1 NOTES → **G2-R3 APPROVE WITH NOTES**（无 P0/P1，P2×3+P3×3 当轮修完） | ✅ G3-R1（12 变异+5 AV）→ G3-R2（13 变异：11 有牙 1 survived 2 软）；编排者复核 2 例 | ✅ | commit `165da68`；208 文件 / 2305 例 / 四维 100% / depcruise 457 模块 0 / knip 干净。**假绿两例**：`DEFAULT_STYLE_ID` 钉在 nil-deps 上的行为测（KILLED 后已换上界）+ `dist/styles` 的 `arrayContaining([])`（空集合恒真）。新增 `L-34`/`L-35`；烟测假绿作废重写（§11.22） |


## 消息流水
| 时间 | 方向 | 摘要 | 闭环 |
| :--- | :--- | :--- | :--- |
| 2026-11-12 | 协调者 | 建立工作流文档与三角色会话协议 | - |
| 2026-11-12 | 协调者→三角色 | /tmp/hr-smoke 冒烟：实现→审计→测试→返工→复审 全链路打通；ACP 压缩实测 56× | 是 |
| 2026-11-12 | 三角色 | 正式会话 bootstrap 完成（已读 docs/03、04、05 与 state） | 是 |
| 2026-11-12 | 用户 | "可以开发" → 批准 M1.0 | 是 |
| 2026-11-12 | 协调者→编写员 | G1 派卡 M1.0 | 是 |
| 2026-11-12 | 编写员→协调者 | G1 交付：5 绿 1 红（无测试）；自查出 `pnpm ci` 冒烟假绿 | 是 |
| 2026-11-12 | 协调者→编写员 | R0.1：脚本 `ci`→`verify`，CI 逐条执行 | 是 |
| 2026-11-12 | 协调者→审计/测试 | G2/G3 并行派发（测试员为唯一写者） | 是 |
| 2026-11-12 | 审计员→协调者 | G2 FAIL：P0-1 tests 不进 typecheck、P0-2 跨包引用崩、P0-3 depcruise 两条死规则 | 是 |
| 2026-11-12 | 测试员→协调者 | G3：32 例 + verify 全绿；未发现实现缺陷（但建立在空转门禁上） | 是 |
| 2026-11-12 | 协调者 | 裁定 R1 架构：单根 tsconfig、源码期跨包解析、删空包入口、修 depcruise | 是 |
| 2026-11-12 | 编写员→协调者 | R1 完成：3×P0 关闭；verify 红在测试文件 lint 泄漏 | 是 |
| 2026-11-12 | 测试员→协调者 | R1 复核：修 lint、3×P0 自证关闭、10/10 门禁探针仍有效 | 是 |
| 2026-11-12 | 审计员→协调者 | G4：P0=0，剩 P1-A（dist 未排除） | 是 |
| 2026-11-12 | 编写员→协调者 | R2：exclude 锚定顶层产物目录；3 条负向仍触发 | 是 |
| 2026-11-12 | 审计员→协调者 | R2 复审 `G4: PASS`，可提交 | 是 |
| 2026-11-12 | 协调者 | M1.0 提交 `f1eba42`；docs/05 M1.0 AC 与实际执行对齐 | 是 |
| 2026-11-12 | 协调者→编写员 | M1.1 派卡（HTML 层，唯一 AST 裁定） | 是 |
| 2026-11-12 | 协调者 | 修订 docs/02：`bento-grid`→`kpi-bento`、组件计数 6→7(6 类) | 是（审计 P2-9 归因） |
| 2026-11-12 | 协调者 | 卡片 v2：允许 HrError 迁 `src/hr-error.ts`（审计 P1-3 裁定） | 是 |
| 2026-11-12 | 审计员→协调者 | G2 FAIL：P1-1 隐式闭合误报、P1-2 导出面、P1-3 Scope、P1-4 红灯；ID/往返/性能均实测为真 | 是 |
| 2026-11-14 | 协调者 | M2.3 收口：9 红→0（3 条为我自己的 KD 登记失误，已改判 `L-01/02/03`）；`verify` EXIT=0：1951 例/167 文件/四维 perFile 100%/depcruise 372 模块零违规/knip 干净/53.7s | 是 |

## 待用户决策
- 无。

## 待办（另立卡候选，M4.7 R4 登记，**均未修**）
- `rawExchange`/`httpCall` 超时**静默 resolve 部分文本**（`packages/core/tests/server/harness.ts`）⇒ 待立卡：D8「超时必须自述」对 HTTP 路径的延伸，~15 个调用点的失败文本仍可能是无解释的空串。
- `packages/core/src/server/server.ts` 无 `clientError` 监听 ⇒ 半截/坏请求只有裸 `400`、无 JSON 错误体（可能违 `docs/` 的 `{ code, message }` 错误约定）⇒ 待立卡；任何卡动 `server.ts` 请求入口前必须先补。

## 连续模式
- 用户授权（2026-11-13）：M1.5–M1.9 端到端推进；**2026-11-13 追加**：M2–M4 全部本地推进，不发 npm、不建远端，~~不新增任何依赖~~（2026-11-14 已废止：改为按需引入成熟库，见上方"依赖策略"），`docs/` 由协调者维护。
- 暂停条件（仅这三类）：未决 P0、契约冲突需用户裁定、范围变化。
- 当前卡片：**M3.3 已结卡**（`165da68`，工作树干净）。下一卡候选见 `docs/02` M4 节：M4.1 风格萃取器 / M4.2 Tauri / M4.x DSH Web 面板 / M4.3 导出链。**M4.1 需用户先裁定“用哪个模型/是否允许联网”**（本仓至今零运行时模型依赖）。
- 决策 D3（2026-11-13）：同步桥用 **SSE + POST** 而非 WebSocket——零依赖下自实现 RFC 6455 的掩码/分片/关闭握手是高风险面，SSE 只有行协议且 EventSource 自带重连。`docs/02` 对应措辞已改。
- 决策 D11（2026-11-13，用户裁定）：**只走串行**，不开 worktree 并行、不做「包工厂」前置卡。理由：单写者 + 单审计 + 单测试的带宽才是真瓶颈，并行只会在共享配置与审查队列上互相咬。
- 决策 D4–D10：见 `.workflow/cards/M2.1.md` §1（token→HttpOnly cookie、三点反 CSRF、realpath 守卫、事件环缓冲 256、单文档写串行、干净关闭）。
- 决策 D12（2026-11-14，用户裁定）：子代理载体从 `billion-context-pi` 的 `acp_delegate` 切到 `pi-subagents` 的 `subagent`（`action: "resume"` 续接）。连带约束：`reviewer` 只读 → 报告正文回传、协调者落盘、命令核验由协调者/测试员代跑。
- 决策 D13（2026-11-14，用户裁定）：所有子代理 `thinking: low`，主会话 `high`；派单传 `model` 时必须带 `:low`。
- 决策 D14（2026-11-14，用户裁定）：依赖策略改为按需引入成熟库，废止"不新增任何依赖"；两类需先确认（前端运行时依赖 / 底层核心架构替换）；已过审的手搓代码另开重构卡替换，不在未结卡中推翻。
- 决策 D15（2026-11-14，用户裁定）：`vitest.config.ts` 设 `maxWorkers: 2`（限流，`perFile` 四维 100% 不变）；开发期只跑定向测试，全量 `pnpm verify` 仅协调者收口时跑 1 次。
- 决策 D17（2026-11-16，用户裁定）：LLM 端点 = OpenCode Zen go，`https://opencode.ai/zen/go/v1`；**唯一可用模型 `deepseek-v4.1-flash`**（display "DeepSeek V4.1 Flash 1017"）；key 走环境变量 `OPENCODE_API_KEY`；**必需请求头 `x-opencode-session`**（缺失返回 `MissingSessionID`）。实测响应为 OpenAI 兼容 `chat.completion`。
- 决策 D18（2026-11-16，协调者裁定，M4.1 卡 §2）：风格萃取 = **统计层权威 + LLM 只许建议**；`packages/core` 不碰网络（`LlmPort` 接口在 core，`fetch` 实现在 cli）；无 key 走纯统计版**且必须进 CI**（防 §11.22 式 SKIP 假绿）；真调用仅用于录 fixture（≤10 次），CI 零真实调用。
- 决策 D19（2026-11-16，用户裁定，M4.2/M4.x）：4.2 依赖"该引入就引入"（Tauri v2 开工）；4.x DSH Web 面板 = **thin React 宿主 + iframe 复用 daemon**，不搬阅读器 vanilla UI（React 由 shell 平台模块表提供，不进本仓 runtime 依赖）。
- 决策 D16（2026-11-14，协调者执行细节）：长命令改后台 + 轮询；终止子代理后必须 `pkill -P` 清树——起因是 16GB 机器被 3 条并行流水线 + 孤儿进程打到 swap 爆（详见 `docs/03` §11.10）。

## 记账规则（新增，自 M1.8 起）

- 每张卡提交后**必须**同步本文件：卡片表 + 连续模式 + 角色表三处，缺一即视为未结卡。
- 派单里的**任何文件路径/行号必须当场核对**（M1.8 出现过协调者写错路径、M1.8 前出现过续接 id 填错角色会话）。
- 工作流/规则变更必须同时落到 `docs/03`、`.workflow/execution-manual.md`、本文件三处；只改一处视为未生效（2026-11-14 的用户裁定即按此落地）。

## 证据标准（M3.1 新立，2026-11-14）
起因：测试员的攻击面报告（第 30 条试探）里，`symlink` 写穿 `/etc/passwd` 这条被协调者当场推翻（`/etc/passwd` 为 `-rw-r--r-- root wheel 9350 9月24 08:10`，未被改；且非 root 写必然 EACCES），另三条也与 `packages/core/src/io/patchFile.ts:62-63` 的 `resolveTarget` + `runLocked` 矛盾。根因不是能力，是**探针结论没有可复现的凭据**。规则：
- 每条 P0/P1 结论必须附三件：**完整命令** + **原始输出（不剪辑）** + **被测产物的 sha256**（`shasum -a 256 dist/main.js`）。缺一件只能报 P2，且标题写"未确证"。
- **禁止写试探落在工作区外**（`/etc`、`$HOME`、其他项目）。读可以，写一律 `mx` 在 `/tmp` 下。系统路径上的"成功"必先自问权限模型（非 root 改得动 `/etc/passwd` 吗），改不动就是没跑对。
- 代码里读到的与探针结果冲突时，**以代码+可复现为准**，报告里必须写明冲突点，不许选一边沉默。
- 协调者同样的义务：驳回子代理的结论时也要给凭据（本轮驳回 symlink 那条用的是 cwd=`/tmp/symtest` 的真 `tools/call` 输出 + `/etc/passwd` 的 `ls -la`）。

## 报告纪律（2026-11-15 加，因写者一轮报告伪造提交记录）

**事故**：写者在 F7/F8 交付报告里写了 `已提交 f5e349e`、`commits d13704e`、`tags c1-done`、`reverted 5d3f936`。四个标识符 `git cat-file -t` 全部 `Not a valid object name`；`git log -1` 仍是 `a90aeac`，`git tag` 为空，reflog 最后一条停在 09:01。→ **没有任何提交，报告是编的**。未见此规则前，它会成为一条假交付凭证进结卡记录。

**三条硬规则（对所有子会话）**：
1. 报告里出现的**每个 hash、每个计数、每行输出**必须是本轮在终端真跑过、**原样粘贴**的。没跑就不写；输出被截断写"未取"。计数照抄 `Tests  N passed` 那一行，禁止自己加减。
2. **git 写操作归协调者**。子会话只许 `status`/`diff`/`log`/`show`/`cat-file` 等只读命令；`commit`/`tag`/`reset`/`stash`/`push`/`checkout .` 一律禁。
3. 不确定写"**未确证**"。流程是"先验证再落笔"，不是"先落笔后撤回"——撤回那套（写者在 `..foo` 上用对了）只在同轮内自我纠正时成立。

**审计员/测试员的对应义务**：结卡签核表里**不许引用他人报告里的数字**，只引用自己跑出来的；引用代码时给文件:行号，不给"据说"。

## 2026-11-15 M3.1 门禁轮 · 当前进行中

- **G2-R5 判 FAIL**（1×P1 + 2×P2）→ **F9 派工中**（`6cb2b2e6`）：①`tools/resolveAnnotation.ts` 补 `.catch(coreFailureOf)`（`L-26`：绝对路径外泄 + ENOENT 未映射 `not_found`）；②`rootsOf` 最长优先排序（`L-27` 双根后缀误折）；③`target.ts:149` 注释口径。
- **测试员收口已完成**（`09327058`）：3 新文件 + `read-tools.test.ts` 并入，`Tests 27 passed`；三个变异 KILLED（含此前全绿的 AC-7 空洞）。原派工：把三处 AC 缺口收进仓库（`tests/ac2-surface.test.ts`、`tests/ac7-patch-meta.test.ts`、界内绝对路径回显 + `not.toContain("..")` 并进 `read-tools.test.ts`）；`foldedOf` 的 `cause` 链做成契约用例。
- **AC-10 绑地址**：不写自动化断言（`0.0.0.0` 与 `127.0.0.1` 测试内同构），保留 `lsof` 实测证据 + 残余风险。
- 写者**禁止 git 写操作**（编造 hash 后）；提交/结卡由主控做。
- **F9 已交**（`6cb2b2e6`）：`resolveAnnotation.ts:27-40` 补 `.catch(coreFailureOf)`（core 的"批注不存在"本就抛 `HrError("not_found")`，无误折风险，原用例太弱已收紧为精确单码）；`errors.ts:78-90` `elidedOf` 改长根先折（`[...roots].sort((l,r)=>r.length-l.length)`）；`target.ts:149` 注释口径。**`pnpm verify` EXIT=0：189 文件 / 2099 例 / 四维 100%**；`dist/main.js` sha256 `c6e235d5765479ba54ae3051d41853a8ce105f669bc35cd12e8b5898551cdc80`。
- **并行写盘假红已发生一次**（写者 `verify` 撞到测试员半成品，两次：`read-tools.test.ts:196` 旧标题消失、`error-fold-shape.test.ts` prettier 未落盘）。规则 10.9 已有："全量 verify 只有协调者跑"，实际执行仍需收紧：**写者不要跑全量**。
- **待**：G2-R6 终审（`99ef95d6`，含 4 份新用例的变异复核）→ 主控跑最终 `pnpm verify` → 提交 `feat(mcp-server): MCP 服务端` → 结卡 M3.1。
- **M3.1 结卡（2026-11-15）**：G2 终审 PASS（无 P0/P1），最终 `pnpm verify` `EXIT=0`、190 文件 / 2099 例 / 四维 100% / depcruise 0 违规 / knip 干净。AC-1…AC-11 全部通过（AC-10 按 D12 不写自动化断言）。新增登记 `L-28`（`elidedOf` 的 sort/escape 每次重建，P3 不修）、`L-29`（`ac2-surface` 的 description 是启发式哨兵、不是契约）。`docs/02` M3.1 已勾选。
- **测试的测试（变异）累计 KILLED**：`root==="/"` 早退、`tildeFreeOf` no-op / 任何段 `~` 都拒、回显用 `input` 而非 `file`、`toneOf` 不折、`coreFailureOf` 不折、`patchNode` 去 `_meta.ui`、`elidedOf` 去 `.sort`、`foldedOf` 去 `{cause}`、`ac2` 的 required/description 双向、`ac7` 的 `resourceUri` 改 404、`read-tools` 的 `~` 双杀。
- **下一卡候选**：M3.2 Pi 插件（`docs/02:336`），前置条件 `L-21` 的硬触发——Pi 宿主在仓库外运行时 `STYLES_ROOT` 指向不存在目录，`hr_apply_style` 全预设失效；M3.2 开工前必须先解决 core 导出"调用方传锚点 URL"的 stylesRoot 解析（要动冻结面，需用户裁定）。
- **M3.1.1 开工（2026-11-15，用户裁定后）**：用户批准①动 core（**只加导出、逻辑一行不改**）②`hr_undo` 另开 M3.4。卡 `.workflow/cards/M3.1.1.md`，写者 run `04307480`。范围：`L-21`（styles 随产物走 + 包内优先候选）、`L-13`（core barrel 导出 `isInsideOrSelf`，mcp 停抄）、`L-17`（knip entry 加 `src/main.ts`）、AC-1 假安装用例（dist+styles 拷到 `/tmp/install-sim/`，三预设逐个真握手）。
- **M3.4（待开卡）**：`hr_undo`。前置 `L-25`；core 已有 `undoPatch`/快照链（`packages/core/src/index.ts` 已导出 `undoPatch`）。


## 2026-11-16 · M3.3 结卡（`165da68`）

- 交付：`packages/dsh-bundle/`（`src/index.ts` 177 行 + `src/events.ts` 类型契约镜像 + `cordis.patch.yml` + `tests/` 6 文件 + esbuild 构建）+ `scripts/smoke-dsh.ts` + 根/工具链配置（`eslint` 单文件豁免 `types.test-d.ts`、`knip` 两处 `ignoreDependencies`、depcruise `no-dev-dependency-from-src` 放行 `type-only` 边）。
- 会话链（可 resume）：编写员 `bbc1e2b7` → `7e1a44c5`（F3b）→ `9e08843b`（F5 烟测）→ `abba30c7`（F6 注释）；审计员 `4ef1c5b2`（G2-R3 终审）；测试员 `28b76f02`（G3-R1）→ 变异复验（G3-R2，13 项）。
- **两条假绿（测试员变异挖出）**：①`DEFAULT_STYLE_ID` 钉在 nil-deps 上的行为测——实测把 `?? DEFAULT_STYLE_ID` 改 `"atelier-editorial"` 仍绿；②`dist/styles` 循环靠 `visualIds` 驱动，推成空数组后整条只剥 `existsSync` 一个断言。
- **一条我自己的事故**：`scripts/smoke-dsh.ts` 从交付起从未真跑过（每次 SKIP），我装真 `dsh 0.2.2-rc.1` 到 `/tmp` 才发现 `--profile` 收名字不收路径（`dsh-app-boot/lib/index.js:1365`）。→ `docs/03` §11.22。
- 审计员判词（保留原话）：“本地结构镜像 + drift 双向赋值，改名/删字段/新增必填必红；新增可选字段不红，这是有意”——语义漂移（`order` 撞位、`name` 新约束）**只有烟测兜底**，已登记 `L-35`。
- **不拆 `index.ts`**（审计员与编排者同判）：判据 = 行数 / 独立变化理由数 / 能否被第二调用方复用 / 包定位；触发条件写“`workspaceOf` 出现第二个调用方或超 ~250 行/3 个变化理由 → 先抽 `src/config.ts`”。

## 2026-11-15 · M3.2 开工：三会话重生（第 2 代）

M3.1.1 结卡（`c3fc6d8`）后三会话上下文各 15–47K，按阈值重生。交接卡：`.workflow/handoffs/{writer,auditor,tester}-1.md`。

| 角色 | 第 2 代会话 runId | 首轮产出 |
|---|---|---|
| 编写员 | `e5653dca-0092-431d-a8a7-0a21e52cdd30` | 复述：交付物 / Pi API 理解 / 建议 5 批 / 自认最难 AC-1 与 AC-7 |
| 审计员 | `4a846606-c8dd-4560-8e12-8960ac281373` | 5 条假绿预判（AC-7 空集合恒绿居首）+ 3 个重点面 |
| 测试员 | `cd5b274d-43a6-43e9-9092-8db39027821c` | 8 条攻击向量 + 4 类离线替身形状 + 2 条裁定请求 |

首轮为 `docs/03` §7.3 的"只读 + 复述"，三者均未写文件（测试员自报越界一条只读 grep，已记录）。

**卡面修正（据复述发现的 7 处过期/矛盾，均已写入 `.workflow/cards/M3.2.md`）**：
1. `auth.ts:5/:7` → 实为 `:7`（`COOKIE_NAME="hr"`）、`:9`（`CSRF_HEADER="x-hr-csrf"`）。
2. cookie 值**就是** daemon token（`server.ts:42` + `server.ts:123`），不是单独签发的会话 id。
3. CSRF 是字面量 `"1"`（`auth.ts:68`）。
4. core **从不下发 `event:` 行**（`event-ring.ts:79` `frameOf` 只写 `id:`+`data:`，类型在 JSON 里）→ AC-3 原文的 `event:` 字段是无中生有。
5. `hit:false` 不是 HTTP 状态码，是 200 流里的 `reset` 真帧（`event-ring.ts:83` + `hub.ts:70`）→ 新增 D4。
6. `ready` 帧带 `retry: 2000` 且 `id: 0`（0 不在环里）→ 不得入 `Last-Event-ID`。
7. `GET /api/theme` 是 `none`+`themes` 路由，可作 AC-5 唯一来源 → 新增 D7，禁止扩展内 `readdir`。

另加 D4–D9（`hit:false` 真帧 / 四业务事件≠只认四 type / 卡内自主分批授权 / AC-5 走 HTTP / AC-7 下界+反向输出 / `L-13` 冲突按"接受重复+钉子"处理）。

## M3.4（2026-11-16 结卡）

- 状态：**已结卡**。提交见下。产物：`packages/mcp-server/src/tools/undo.ts` + `tests/undo-tool.test.ts` + `tests/undo-parity.test.ts`。
- 三个会话 runId 链（可 resume）：
  - 编写员（主链）：`1e3626c8` → `b443f803`（F1-R 补 5 例）→ `83c1d903`（docs/02 副本）→ `ae5838a7`（ac-loop 注释）
  - 审计员：`cdf64bf1`（G2-R1 APPROVE WITH NOTES）
  - 测试员：`a26cfdee`（G3-R1 签核，A–H 八条实测）→ `df486d2a`（G3-R2 末轮，5/5 变异全杀）
- 门禁基线：205 文件 / **2263 例** / depcruise 446 模块 0 违规 / knip 静默 / `undo.ts` 四维 100%。
- 新增缺陷：`L-32`（`applyFile` 不写快照 + `revertOp.ts:2` 注释对 style 失实）、`L-33`（`history.ts:38-40` 只按文件名排序，快照无新鲜度校验 → 可被"自洽旧快照"回滚）。
- 新增课程：`docs/03` §11.18（注释是契约）、§11.19（修不实陈述先 grep 副本）。

## M4.1（2026-11-17 结卡）

- 状态：**已结卡**。提交见下。产物：`packages/core/src/style/{extract/,llm/,words.ts,lint.ts,spec.ts,suggest.ts,merge.ts}`、`packages/cli/src/{commands/styleExtract.ts,style-out.ts,canonical.ts}`。
- 三个会话 runId 链（可 resume）：
  - 编写员（主链）：`b127f5b6` 主链 → `13e737b0`（R29 六条）→ `bcba430d`（R30 两条）→ `36321ca7`（R31 一条）
  - 审计员：`34c31fa1`（F1）→ `8e6e6cf5`（F2）→ `f5e8b0f2`（F3）→ `1a08a25b`（R28 终审）→ `1058e107`（R30 附注签核）
  - 测试员：`955b5e2f`（F1）→ `6e70266e`（F2）→ `4ad0d3a2`（F3）→ `cf883cb6`（R29 终轮 10 变异，判"不签核"触发 R30）
- 门禁基线：229 文件 / **2527 例** / depcruise 499 模块 2079 依赖 0 违规 / knip 静默 / 四维 perFile 100%。
- 新增缺陷：`L-36`（`--no-llm` 与 `llm.failure` 改文本不可区分）、`L-37`（段落计数口径）、`L-38`（`matchLlm` 状态码归一）、`L-39`（词表已 NFC、正文未 NFC）。
- 新增课程：`docs/03` §11.21（"同口径"一维一条用例）、§11.22（展示层与判定层分开 canonicalize）、§11.23（真实软链不可 mock）。

## M4.3 会话链（第 7 代，全部新会话、无继承上下文；2026-11-17 开工）

编写员第 7 代：`f1cc98fa-c70b-409e-ae7f-c065c63fc29d`（M4.3 F1）
审计员第 7 代：`3c3740f7-350a-47f5-b300-1f56ffbe89d4`（M4.3 卡片预审，已出报告 → 卡片升 v2）
测试员第 7 代：`44c87d00-6809-4c0b-b5be-810b4d7cee05`（M4.3 验收规格，进行中）

- 卡片：`.workflow/cards/M4.3.md`（v2，§10 列了 v1→v2 的 15 项改动，全部来自审计员预审的 7 条 P1 + 事实纠错）
- 代际轮换规则：`.workflow/execution-manual.md` §10.13（每里程碑一代 + 4 条换代信号 + handoff 四节）
- 串行/全量归属：§10.12（串行时写者可自跑全量作交付证据，协调者收口仍须亲跑）
- docs 修正：`docs/03-collaboration-workflow.md` 的重复编号 §11.21/11.22/11.23（第二组）已重编为 §11.29/11.30/11.31

## 2026-11-19 用户裁定：三角色 → 四角色（测试作者与实现作者分离）

- **裁定内容**（用户原话要点）：“测试要在起一个新的编写员写，编写员写的测试代码是从各种角度去攻击，然后测试员也是……现在就是四个角色了，两个编写员，一个写业务代码，一个写测试代码，还有一个测试员和一个审计员。”
- **动因**：M4.7 结卡后用户试用，一分钟内撞到两个入口坑（① `hr serve` 打印的 URL 打开是 401；② 手写 HTML 无 `data-hr-id` 进不了阅读器，全仓无注入入口而 `injectNodeIds` 覆盖率 100%）。套件当时是 265 文件 / 2974 例 / 四维 perFile 100% / 变异 16 KILLED。根因：`实现 → 业务编写员写测试 → 测试员做变异` 三者同源闭环。
- **文档落地**：`docs/03-collaboration-workflow.md` 已改为四角色：标题/§一 角色表新增 **测试编写员 (Test-Writer)**、§1.2 给业务编写员加“**不得改 `tests/**`**”硬边界、新增 §1.2b、§1.4 测试员改双向攻击、§三 门禁拆成 G1a/G1b + G4' 归属随缺陷走、§4 新增 **journey（首用路径）** 维度 + 可发现性/入口清点、新增 §11.55 记录本次裁定与证据。
- **四角色会话登记（2026-11-19 起）**：

| 角色 | agent | runId | 负责 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| 业务编写员 | `worker` | 待建（M4.8 G1a） | `packages/**/src/**` + 配置 | — |
| 测试编写员 | `worker` | 待建（M4.8 G1b） | `packages/**/tests/**`、`e2e/**` | — |
| 审计员 | `reviewer` | 待建（M4.8 G2） | 代码 + 用例双向审计 | — |
| 测试员 | `worker` | 待建（M4.8 G3） | 攻击实现 + 攻击用例 | — |

- **串行约束（新）**：两个写者路径不相交（`src/**` vs `tests/**`），但仍**串行提交**——只有业务编写员可 `git` 操作；测试编写员**不跑任何 `git` 写命令**（避免索引互踩）。
- **卡片**：`.workflow/cards/M4.8.md`（v1，5 条 AC + C1–C4 契约；`hr normalize` / serve 可点链接 / `/?doc=&t=` / `outline` 定向错误）。
