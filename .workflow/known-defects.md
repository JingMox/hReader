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
