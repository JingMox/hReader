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
