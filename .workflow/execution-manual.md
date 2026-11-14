
> **2026-11-14 修订（本文件现行口径）**
> - 子代理改用 `pi-subagents` 插件：`subagent({ agent, task })` 开新会话，`subagent({ action: "resume", id, message })` 续接。旧的 `acp_delegate` / `resumeFrom` / `del_*` runId **全部作废**，下文保留的历史实例只作记录。
> - `reviewer` 角色**无 `bash` / `write`**：审计报告以正文回传，协调者落盘 `.workflow/reports/audit-<card>.md`；需要跑命令的核验由协调者或测试员代跑。
> - 门禁命令已统一为 `pnpm verify`（`pnpm ci` 是 pnpm 内建 clean-install，会假绿）。
> - 依赖策略改为"按需引入成熟库"（见 `docs/02` §依赖策略 与 `docs/03` §11.9）；"不新增依赖"废止。
> - 执行纪律见 §10.9（全量 CI 单点执行、定向测试、maxWorkers=2、后台+轮询）。

---

## 11. 连续模式（用户于 2026-11-13 授权）

用户选择"连续模式"：**不再逐卡确认**，由协调者自己推进 M1.x 直到收口，只在下列三种情况停下来问用户：

1. **P0**：任何角色报 P0，且协调者不能在 10 分钟内从文档/既有契约推出裁定。
2. **契约冲突**：两张卡的裁决互相矛盾，或需要改变 `docs/02`/`docs/04` 的正典语义。
3. **范围变化**：需要引入新包、新依赖、新服务，或触碰 `docs/` 的既定决策。

连续模式下的固定循环（每张卡）：

```
协调者写/审卡片 → G1 编写员（独占 src） → G2 审计员 + G3 测试员并行（只读 / 独占 tests）
   → 有 P0/P1：协调者出返工单 → G1 返工 → G2-R/G3.1 定向复核
   → 全绿 + 反向变异红：协调者自跑 pnpm verify → commit → 写 state.md → 下一张卡
```

角色会话的复用规则同 §7：优先 `subagent({ action: "resume", id })`（保留上下文），超过阈值（§5）且任务已收口时**重开**并把交接包写进任务文本。决定与理由记进 `.workflow/state.md` 的"决策日志"。

### 10.3 G1 不许跑全量 verify（2026-11-13，M1.5 实测）

编写员在 G1 跑 `pnpm verify`，`knip` 因"新模块尚未被测试 import"报 unused file/export（**结构性假红**），它转而去 grep knip 源码，45 分钟零产出，被看门狗 SIGTERM（exit 143）。

规则：
- G1 只跑 `tsc --noEmit` + `eslint src --max-warnings 0` + 自己的冒烟脚本；**`pnpm verify` 由 G3 测试员跑、G4 协调者自跑**。
- 新卡的"未使用"红灯在测试落地前一律视为预期；禁止为了让 knip 变绿去改 `knip.json`/`package.json`。
- 派单时**显式写出"禁止跑 verify"**，并给出文件落盘顺序，要求分批落盘（防 watchdog）。

### 10.4 派单预算与"半途被杀"恢复（2026-11-13，M1.5 实测两次）

- G1/G3 这类**产出型**任务给 45–60 分钟；结果不是"失败"而是"未完成"时，**用 `subagent({ action: "resume", id })` 续跑**，任务文本只写"你现在在哪、规格变了什么、本轮只做哪 3 件"，不要把原任务重贴一遍。
- 续跑时**必须重列规格变更**（本卡的 v2 裁定），否则子会话会按旧契约继续写。
- 大卡在 G1 就要求"分批落盘 + 每 2–3 文件落一次"，被 watchdog 杀时至少保住进度。
- G2/G3 并行时，审计员会看到测试员**写到一半**的树，必然报"verify 红"。派单时就要写："tests/ 正在被测试员修改，与之相关的红不算你的，但要逐条列出。"否则审计报告会出现大量噪声 P0。

### 10.5 假件必须对真契约校验（2026-11-24，M2.2 G2 实测）

M2.2 的 1568 例全绿、6/6 变异体全杀，但 `hr serve` 打开后 `doc.changed` 链路**运行时是死的**：服务器发的是具名帧 `event: doc.changed`，客户端只在 `EventSource.onmessage` 里读 `data`。测试用的是**自己按客户端假设造的**假 `EventSource`，帧格式从头到尾没人跟服务器对过。

规则：
- 任何"生产者—消费者"接缝（SSE 帧、JSON 载荷键、CLI flag、stdout 格式）**至少要有一条测试把两端接起来**：真服务器 + 真 HTTP 流 + 真解析，或真子进程 + 真 stdout。
- 假件（fake Host / fake EventSource / fake clock）只能用于**控制时序与观测**，不能用于**定义格式**。派单时写明："帧/载荷的形状必须从对方需要什么反推，并留一条对真件的契约用例。"
- 同类教训已出现三次：M2.1 的 `--json` 键序、M2.2 的 `--app-dir` 词法器（flag 写了但解析器不认，五处管线全成死代码）、M2.2 的 SSE 具名帧。**"我实现了"与"它接上了"是两件事，验收只看后者。**

### 10.6 三层接线必须闭环（2026-11-26，M2.3 G2 实测）

M2.3 的 20 条 AC 里有 5 条（AC5.1/5.2/5.3/5.5、AC4.4）在真实页面上**整段不可达**，而实现员的自证写得像全做完了。三层同时断：

1. **模板层**：`static/index.html` 缺 10 个 M2.3 锚点（`#hr-note-btn`、`#hr-notes-pending`、`#hr-diff` …），所有 `host.on("… #hr-note-btn", …)` 指向不存在的元素。
2. **绑定层**：`dom.ts` 的 `on()` / `children()` / `cls()` 是**绑定期求值**——找不到元素就返回空 unbinder，**元素后来出现也永不绑定**。所以"先渲染后绑定"也救不回来。
3. **状态层**：`noteChanged` / `noteSubmitted` 两个 intent 全仓零发送点，`noteDraft` 恒空、乐观渲染不存在；`lost` 从没进 store，`withLost` 零调用。

规则：
- **"函数存在 ≠ 路径可达"**。自证里每写一条"ACx.y 已接线"，必须附一条**从最外层入口出发的路径**（DOM 锚点 → 事件 → intent → reducer → 渲染），而不是 `file:line` 的存在性。
- **静默跳过是 P0 级缺陷**：`Host` 的查询失败、选择器解析失败、未知 intent 丢弃，都必须**可见地失败**（`#hr-statusbar` 提示 / `console.error` / 诊断对象），不许 `return undefined` 了事。M2.3 新增 `anchors.ts` 的 `REQUIRED_ANCHORS` 自检即为此。
- 审计员审接线类改动，第一件事是 `grep -o 'id="[^"]*"' static/index.html`，第二件是 `grep -rn "<anchor-id>" --include=*.ts`，第三件是读宿主适配器的**求值时机**。
- 派 G2 时明确要求："逐个 DOM 锚点核对存在性；对每个 `host.*` 调用点确认目标在模板里声明过。"

### 10.7 守卫必须看到 dispatch 之前的状态（2026-11-26，M2.3 P0-2）

`boot.ts` 的副作用顺序是 `store.dispatch(intent)` → `wired.after(intent)`，而 `after` 里用 `store.get().diff.open` 当守卫。reducer 已经把 `diff.open` 置假，守卫**恒假**，撤销键永远不生效。

规则：
- 副作用分两相：**`before(intent)`（dispatch 前求值，只读旧状态，用于守卫/决策）** 与 **`after(intent)`（渲染）**。任何"基于旧状态判断"的逻辑放在 `before`。
- 判据：把 `store.dispatch` 注释掉，守卫分支是否还能被走到？不能，就说明它依赖了错误的时序。
- 同类反模式：在 reducer 里读 `store.get()`（永远拿到新状态）、在渲染函数里计算"是否需要撤销"。

### 10.8 上限类保护要按"代价"设，不按"输入长度"设（2026-11-26，M2.3 P1-8）

`diffText` 的 20k 字符上限在边界上允许 `new Uint32Array(20001 * 20001)` = **1.5 GB**，`degraded` 还是 `false`。判定顺序是对的（分配前判），但阈值选错了维度：

- 上限应当对着**实际开销**（格子数 = `(n+1)*(m+1)`、文件句柄数、递归深度），不是对着输入字符数。
- 每个"保护性上限"都必须有一条**边界两侧**的用例（`limit-1` 走全量、`limit+1` 走退化），并断言退化结果的语义（"重拼 == 原文"，不能靠补换行凑长度）。

### 10.9 资源与执行纪律（2026-11-14 本机 OOM 事故后，**强制**）

事故：16GB / 10 核机器上同时跑 3 条完整流水线（协调者 + 编写员 + 测试员），每条都是 `tsc` + `esbuild` + vitest(≈9 worker) + v8 覆盖率 + `depcruise` + `knip`，swap 被打爆、SSD 持续换页。

规则：
1. **全量 `pnpm verify` 只有一个执行者：协调者**，收口时跑 1 次。跑之前先 `pgrep -fl "vitest|tsc|esbuild"` 确认没人跑。
2. 开发/返工期间只跑定向命令：`pnpm vitest run <单个测试文件>`、`eslint <改动文件>`、`tsc --noEmit`。**禁止**"边改边跑全量覆盖率"，也禁止在派单里要求 delegate 跑 `pnpm verify`。
3. `vitest.config.ts` 有 `maxWorkers: 2`：限流，不放宽门禁（`perFile: true` 四维 100% 不变）。
4. 长命令**后台 + 轮询**：`(pnpm verify > /tmp/v.log 2>&1; echo "EXIT=$?" >> /tmp/v.log) &` 然后 `sleep 45; tail /tmp/v.log`。前台静默 5 分钟会被 watchdog SIGKILL，且**子进程树不会被回收**。
5. 终止任何子代理后：`pkill -P <pid>` + `pgrep -fl "vitest|tsc|esbuild"` 确认无残留，再派下一个。
6. 奇数编号的偶发红（flaky）与"别人正在写"的假红必须区分开：复跑前先 `git status` 确认无未跟踪临时文件（如 `zz-probe.test.ts`）、无活跃写入会话。

### 10.10 依赖策略（2026-11-14 用户裁定）

"不新增任何依赖"**废止**。改为按需引入成熟可靠的开源库，已手搓的模块（如手写 diff）可另开重构卡替换。两类必须先问用户：**前端运行时依赖**（`@hreader/app` 无 bundler）、**底层核心架构替换**（框架 / 打包器 / AST）。详见 `docs/02` §依赖策略、`docs/03` §11.9。

### 10.11 子代理载体（2026-11-14 起）

- 工具：`subagent`；角色：`worker`（编写员 / 测试员）、`reviewer`（审计员）。
- 思考强度：所有子代理 `thinking: low`（`~/.pi/agent/settings.json` → `subagents.agentOverrides`），主会话 `high`；派单时若传 `model`，必须带 `:low` 后缀。
- `reviewer` 无 `bash`/`write`：它只能读。**报告落盘是协调者的活**，命令核验也由协调者/测试员代跑，并把真实输出回贴给审计员再让它下结论。
- 续接用 `action: "resume"`；每次 resume 产生新 runId，登记到 `state.md`。
