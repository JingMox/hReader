# 已知缺陷登记表（KD）

> 存在的唯一理由：仓库里有一批**已确认、尚未修**的缺陷。它们的测试用 `it.fails` 钉住（断言"坏行为确实发生"），所以套件是绿的、但缺陷是真的。
> 没有登记就会变成"绿得可疑"——这是 M2.2 栽过的跟头。本表就是防它复活的那把锁。

## 规则（从 M2.2 起生效）

1. **新功能卡内禁止新增 `it.fails`。** 发现缺陷 → 写进审计报告 → 要么当轮修，要么登记本表并由协调者排期。
2. 每条 `it.fails` 必须带行内标记 `// KD-nn`，且本表有同号行。**没有标记的 `it.fails` 就是违规**。
3. `packages/core/tests/known-defects-registry.test.ts`（测试员维护）做三件事：
   - 扫全仓 `it.fails`，每条必须解析出 `KD-nn`；
   - 每个 `KD-nn` 必须在本表出现；
   - **总数不得超过表头 `CAP`**（只减不增）。要加就必须先经协调者批准并下调别的条目。
4. 修掉一条：删 `it.fails` 的用例 → 改成 `it` 的**正向断言** → 从本表删行 → 下调 `CAP`。**不许**只是删行。

**CAP = 10**（M2.2 冻结基线）

## 登记

| ID | 缺陷（一句话） | 钉住的测试 | 归属卡 | 状态 |
| --- | --- | --- | --- | --- |
| KD-01 | 模型派生丢 NBSP / D2 折叠 | `packages/core/tests/model.test.ts:132` | M2.4 债清卡 | 待修 |
| KD-02 | 模型派生 D1 边界 | `packages/core/tests/model-derive.test.ts:79` | M2.4 | 待修 |
| KD-03 | latin run 计数偏差 | `packages/core/tests/outline-text.test.ts:81` | M2.4 | 待修 |
| KD-04 | 多 `<article>` 只取首个 | `packages/core/tests/outline-structure.test.ts:230` | M2.4 | 待修 |
| KD-05 | 截断切坏孤悬组合符 / ZWJ 家族 | `packages/core/tests/read-node-truncate.test.ts:131`、`:168` | M2.4 | 待修 |
| KD-06 | `\0` 在路径里应 400 而非 404 | `packages/core/tests/server/paths.test.ts:78` | M2.4 | 待修 |
| KD-07 | EOF 截断时应"应用关闭"却挂住 | `packages/core/tests/server/wire-http.test.ts:65` | M2.4 | 待修 |
| KD-08 | 鉴权边界（见测试注释） | `packages/core/tests/server/auth.test.ts:68` | M2.4 | 待修 |
| KD-09 | `--json` 下 usage 信封形状不一致 | `packages/cli/tests/units-run.test.ts:103` | M2.4 | 待修 |
| KD-10 | 空 `--html-stdin` 未报错 | `packages/cli/tests/units-run.test.ts:114` | M2.4 | 待修 |

> `CAP` 与表行数必须一致（同一条目若有多处 `it.fails`，只算 1 条，其余用 `// KD-nn` 指向同一行）。

## M2.3 · 设计边界与已排期项（2026-11-14；**不是 KD 行**，无 `it.fails`）

> 为什么另立一节而不是加进登记表：本表的一条 = **有 `it.fails` 钉住的已确认缺陷**，而规则 1 明确禁止新功能卡内新增 `it.fails`。下面三条是"已接受的设计边界/已排期的改进"，它们的性质是**声明**而非**缺陷证据**，混进表里既会把 `CAP` 挤爆（10 → 13），也会让"表的行数 = 当前欠的债"这个语义失效。编号用 `L-`（Limit），与 `KD-` 分开数。

| ID | 内容 | 定级 | 处置 |
| --- | --- | --- | --- |
| L-01 | `annotation-basis.ts:163-167` 的同位置兜底用 `previousFlat.findIndex` + `currentFlat[index]`，且 `sameSlotAs`（`annotation-basis.ts:48`）只比 `tag` + `depth`、不比文本。在块**之前**插删同 tag 同深度的兄弟，会指向另一块却判"重识别成功" → 给用户看错误块的 diff（虽标 `degraded:true` + `reason:"block_reidentified"`）。 | P2（按卡片 D.4 字面合规） | 重构卡 R-5：兜底加文本相似度阈值（如首 64 字符共同前缀 ≥ 50%），不达标降为 `block_missing`。 |
| L-02 | `data-hr-id` 为**内容派生**（`inject.ts:111-112` 的 seed = tag + 同标签兄弟序 + 文本前 64 字符 + 子树 digest），编辑会让 id 漂移；而批注 `nodeId` **不做落盘迁移**（`annotationOps.ts:67` 的 `rewriteOf` 只重写 meta，原样保留 `nodeId`），全靠读时重识别兜底。 | P2（设计事实，非缺陷） | 已在 `docs/05` 与 `.workflow/cards/M2.3.md` 写成声明：M2 未发布，无迁移义务；发布前必须重新评估（R-6）。 |
| L-03 | `wiring-static.test.ts` 的 `isDeferred` 原正则 `\sdisabled(?:[\s=/>]|$)` 对 `type="hidden"` 的 `input` 误报（它在 `INTERACTIVE_TAGS` 里但用户看不见）。 | P2（测试规则误报） | **已于 2026-11-14 当轮修掉**：`type="hidden"` 排除出交互元素集合；`aria-disabled="true"` 与 `disabled` 同等待遇。保留此条仅作"静态规则会误报"的先例记录。 |
| L-04 | `Host.focus`（`packages/app/src/dom.ts:53,141,159-161`）在 src 里**零调用点**（仅 `dom.test.ts:71-75` 自测）：`/` 快捷键改成写 `#hr-hint` 提示后，焦点缝成了死 seam。 | P3（死 seam，不影响行为） | 下一卡二选一：收回接口（连带删 `dom.test.ts` 对应用例）或留给"搜索真正启用"时用。**不许无限期挂着**——每多挂一卡就多一处"看起来有用"的假接口。 |
| L-05 | diff 响应体里两个**线上零消费**字段：①`reason`（`contracts.ts:58`）——app 侧 `guard.ts:63-70` 的 `isDiffResponse` 连它都没列，用户看到的那句话实际来自 `degradedReason`；服务端只在 `annotation-replies.ts:162` 用它的**存在性**（`basis.reason !== undefined`）算 `degraded`。②`originNodeId`（`contracts.ts:53`）——`grep originNodeId packages/*/src` 只有 core 内部 + `annotation-replies.ts:158` 透传，app 零读取。 | P3（线上死字段，不造成错误行为） | 下一卡三选一：**真读**（app 用 `originNodeId` 做"原本属于哪块"）、**标注**"仅审计用"并写进 `contracts.ts` 注释、或**删掉**。禁止长期维持"传了没人用"——KD 的教训就是字段验了不用就等于没验。 |
| L-06 | `AnnotationDiffBody.revision`（`packages/core/src/server/contracts.ts`）app 侧**零读取**：`guard.ts:60-74` 的 `isDiffResponse` 连形状都不校验，`notes-wire.ts:42-52` 的 `fetchDiff` 返回类型与 `notes-state.ts:219` 的 `diffShown` 都不含它。 | P3（潜在竞态护栏未被使用） | **本卡不删**（删掉等于扔掉唯一的过期响应判据）。下一卡二选一：app 用 `revision` 丢弃"比 `doc.changed` 先到的过期 diff"，或删字段。**不许第三次记成"仅审计用"**。 |
| L-07 | `AnnotationDiffBody.before` / `.after` app 侧零读取（app 只渲染 `chunks`）。 | P3（契约自证输入，非死字段） | **保留**，理由已落 `contracts.ts` 注释：core 侧靠 `rebuild(chunks) === after` 证明 `chunks` 不丢字节，删了就是孤证。这条不算待办，算"已裁定保留"，除非将来出现真正消费方。 |
| L-08 | wire 契约**没有键集锁**：C1 之后仍可能悄悄新增第三个零消费字段（`reason`/`originNodeId` 就是这样一路漏过来的，靠人肉逐字段排查才抓到）。 | P2（整类回归的口子） | 下一卡：对每个 wire 响应体加 `expect(Object.keys(body).sort()).toStrictEqual([...])` 键集锁（或引入 zod schema 并让 `guard.ts` 用它解析）。**这是把"零消费字段"从人审变成机审的唯一办法。** |

## M3.1 · 残留风险与已裁定的设计边界（2026-11-14，写者交付时自报 + 协调者裁定）

| ID | 内容 | 定级 | 处置 |
| --- | --- | --- | --- |
| L-09 | `packages/mcp-server/src/tools/target.ts` 自己 `readFile` 文本做读侧路径校验（realpath + 拒绝 `..`）：core 只公开了写侧入口 `patchFile`，没有公开的"读文本"入口，于是同一类路径校验在两处（core 写侧 + 本包读侧）。 | P2（同一事实两处拼写） | 下一卡：core 导出读侧入口（如 `readFileText(deps, file)`，内部复用已有路径校验），本包改为引用。**在此之前不许再在适配层加第二处路径校验。** |
| L-10 | `packages/mcp-server/src/ui.ts` 复制了 `~/.hreader/daemon.json` 的落点约定：core 未导出该路径常量。这是 `readStyleSource`（M3.1 §5.1）刚以同一理由否掉的病在三小时后再现。 | P2（同一事实两处拼写） | 下一卡：core 导出 `daemonStatePath(deps)`；本包改为引用。当前本包内该拼写**已收敛为一处**，并用 `grep -rn "daemon.json" packages/` 自证。 |
| L-11 | `resources/read` 的错误码到不了宿主：MCP SDK 把 handler 抛出的异常统一成 JSON-RPC `-32603` + message，`HrError.code` 只能进服务端 stderr。故本包删掉了"`catch` → 重抛 `HrError`"这层（包了也传不出去，只多一条不可测分支）。 | P3（协议层限制，非本仓缺陷） | 接受现状，不做处理。若将来要求"资源错误也带 code"，只能改走 `contents` 里塞结构化错误文本——**那要用户拍板改协议语义，不算 bug 修复。** |
| L-12 | `hr_read_node` 把 `nodeId` 直接拼进 CSS 选择器 `[data-hr-id="…"]`，schema 未做字符白名单。当前成立依赖一个外部事实：core 生成的 id 恒为 `[a-z0-9-]`（`inject.ts` 的内容派生规则）。 | P3（信任 core 生成规则） | 下一卡：`nodeId` 入参加 `^[a-z0-9-]+$` 白名单并给用例——**适配层不该把"上游的生成规则"当作安全边界**，这条和 `L-09` 同源。 |
