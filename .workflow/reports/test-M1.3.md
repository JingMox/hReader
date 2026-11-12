# 测试报告 · M1.3（`hr_outline`：字数 / 结构 / 体积 / meta / 批注 / 性能）

> 状态：**`pnpm verify` 全绿（EXIT=0）**；G3.1 对齐 v2 后 `Tests 393 passed (27 files)`（M1.3 本卡 85 → 对齐后 92），原基线 `385 passed (26 files)`，`All files 100 / 100 / 100 / 100`（行/分支/函数/语句），`depcruise 62 modules, 171 dependencies`，knip 静默。
> 白名单：本卡只写 `packages/core/tests/**` 与本报告；`src/**`、根配置、`vitest.config.ts`、卡片、impl 报告均未由我改动。

## 1. 交付物（85 条新用例，6 个文件）

| 文件 | 用例 | 覆盖的卡片义务 |
|---|---|---|
| `packages/core/tests/outline-text.test.ts` | 24 | 契约 1：12 例字数（纯中文/纯英文/中英混排/`state-of-the-art`/`1,234.56`/emoji 单码点与 ZWJ/CJK 扩展 B/全角/假名/希伯来/阿拉伯/纯标点/空串）+ `<code>`/`<pre>` 计入 + NFC/NFD + 组合附标 |
| `packages/core/tests/outline-structure.test.ts` | 18 | 契约 2/3：规格样例、嵌套无标题 section、section 内 h3、article 顶层 `header`、扁平 h1–h4、无标题文档、空文档、article 外标题、h5/h6、深度 4 裁剪、节点文案 120 码点截断 |
| `packages/core/tests/outline-meta.test.ts` | 26 | 契约 5：5 类畸形 meta、`</script>` 注入、`__proto__` 不污染、10MB、`pending_ai` 选择、大小写、文档外 targetId、重复 id、comment 200 码点截断（代理对） |
| `packages/core/tests/outline-surface.test.ts` | 6 | 公开面：必需项逐条 + 闭名禁止项 + 前缀闸 + `ops`/`meta` 门面 `Object.keys` 全等 |
| `packages/core/tests/outline-perf.test.ts` | 4 | 契约 3/4：1MB 预算（自校准）、10k 扁平标题、10k 深嵌套、两次调用 `JSON.stringify` 字节相等 |
| `packages/core/tests/outline-pressure.test.ts` | 7 | 诊断收敛：容器缺 id、注释节点、`3 条/code` 折叠、1 条/code 降级、三级收敛、报文里的省略规模、层级继承 |
| `packages/core/tests/entry-points.test.ts`（改） | +1 断言 | 公开面扩到 7 个运行时导出（新增 `buildOutline`） |

**为什么不把 `entry-points.test.ts:36` 从"恰好等于"改成"包含且不含禁止项"就是放水**：该文件从 M1.1 起用的是**双表**策略 —— `REQUIRED_RUNTIME_EXPORTS` 逐条点名（少一个即红，报错直指缺的名字），外加"多出的键必须为空"。本卡新增的 `outline-surface.test.ts` 再补一层**闭名禁止项**（`budgetOutline`/`deriveOutline`/`truncateOutline`/`wordCountOf`/`annotationsOf`/`firstArticleOf`/`sectionLevelOf`/`isRecord`/`stringFieldOf`/`findMetaScript`/`readMeta`/`parseMeta`/`OUTLINE_*`/`PENDING_ANNOTATION_STATUS` 等 16 个）+ 前缀闸（`OUTLINE_`/`annotations`/`budget`/`derive`/`word`），并对 `ops`/`meta` 门面做 `Object.keys(...).sort()` 全等断言。正因为有这张清单，M1.4 再加导出时不会静默通过。

## 2. 真实输出（最终一轮）

```
$ pnpm verify
Test Files  26 passed (26)
     Tests  385 passed (385)

File             | % Stmts | % Branch | % Funcs | % Lines
All files        |     100 |      100 |     100 |     100
 src/ops/outline |     100 |      100 |     100 |     100
  budget.ts      |     100 |      100 |     100 |     100
  diagnostics.ts |     100 |      100 |     100 |     100
  walk.ts        |     100 |      100 |     100 |     100

$ depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (62 modules, 171 dependencies cruised)
$ knip --strict
（静默）
EXIT=0
```

## 3. 变异测试（4 个变异体，4/4 有效）

在 `/tmp/m13` 的整仓副本里改一行、跑 5 个 outline 测试文件（基线 `81 passed`），改完即还原（副本内 81 绿）。

| 变异体 | 改动 | 结果 |
|---|---|---|
| M1 字数把 CJK 当 0 | `text.ts` 的 `CJK_CHARACTER` 换成永不匹配的 `/$^/u` | **11 red**（纯中文、混排、扩展 B、假名等逐字符用例 + `wordCount` 断言） |
| M2 去掉 `outline_truncated` 诊断 | `diagnostics.ts` 的 `withTruncation` 直接返回 `selected.list` | **8 red**（3 条/code 折叠、1 条/code 降级、三级收敛、报文省略规模、深度裁剪、文案截断、批注预算裁剪） |
| M3 `targetId` 校验改用 `id` 属性 | `annotations.ts` `!ids.has(annotation.targetId)` → `!ids.has(annotation.id)` | **3 red**（`pending_ai` 选择、文档外 targetId、重复 id） |
| M4 截断由字符改 UTF-16 单元 | `text.ts` `characterCount(text) > limit` → `text.length > limit` | **1 red**（199 CJK + 😀 = 200 时被切出半个代理对） |

灵敏度说明：M2 之所以能打红 8 条，是因为"超限必须**只有一条** `outline_truncated` 且报文里带省略规模"被三条用例从不同规模夹住（4 条同码 → 折叠；超字节 → 降级；单条超长 → 三级收敛）。

## 4. 每条关键断言"实现坏掉会怎么红"

| 断言 | 坏掉时的红法 |
|---|---|
| `expect(shapeOf(...)).toEqual([["sec-header","header",1,…]])` | 层级/继承/树形任一变化 → 结构数组不等，diff 直接指出是哪一层的 `level`/`text` |
| `expect(truncated.length).toBe(1)` + `toMatch(/另有 \d+ 条诊断省略（outline_node_without_id \d+ 条）$/)` | 去掉诊断、重复上报、报文丢掉规模 → 条数或正则不匹配 |
| `expect(idsOf(outline.nodes)).toEqual(["s1","h1","s2","h2","s3","h3","s4"])` | 深度上限改成 3/5 或裁剪位置错 → 数组长度/内容不符 |
| `expect(truncated.comment).toBe(\`${"字".repeat(200)}…\`)` 与 `includes("\uFFFD")===false` | 按 UTF-16 截断 → 半个代理对（M4 已实证 1 red） |
| `expect(ids.has(targetId))` 相关用例（存在/不存在/大小写/文档外） | 校验改成 `id`、改成小写比较、只扫 article → 对应用例红（M3 实证 3 red） |
| `expect(fresh["polluted"]).toBeUndefined()` + `Object.keys(Object.prototype)` | `Object.assign`/展开 meta → 原型被污染 |
| `expect(JSON.stringify(outlineOf(html))).toBe(first)` | 引入时间戳/随机 id/Map 迭代序 → 两次字节不等 |
| `expect(bigMs).toBeLessThan(Math.max(150, smallMs*12))` + `bigMs/smallMs < 14` | 退化成 O(n²) → 比值 ≈100 |
| `expect(Object.keys(opsEntry).sort()).toEqual(["buildOutline"])` | 门面多导出内部函数 → 全等失败并点名 |

## 5. 缺陷登记（只登记，不修）

- **D6（P2，规格 vs 实现口径冲突）** `packages/core/src/ops/outline/text.ts` 把"全角拉丁/希伯来/阿拉伯"按**非 CJK 连串 = 1 词**计数，而卡片 3 的字面把"全角字母"列入"每字符 1"。用例按实现钉住（`ＡＢＣ` → 1）并注明冲突；若协调者裁定按卡片，翻这条 + `text.ts` 的 `CJK_CHARACTER` 即可。
- **D7（P3）** `<title>` 不在 `NON_VISIBLE_TEXT_TAGS` 里，其文本会计入 `wordCount`（`<title>t</title><p>正文</p>` → 3）。article 内出现 `<title>` 罕见，故只钉现状。
- **D9（P2）** 无标题的内层 `<section>` 只继承父级 `level`，`text` 为空串（用例 `["inner", 2, ""]`）。卡片写"section 取首个标题"，未规定"一个标题都没有"时的文本继承。
- **D4（P1，环境相关）** 多 MB 的 raw text 会在 `packages/core/src/html/balance.ts:132` 的 `html.replaceAll(RAW_TEXT_PATTERN, …)` 处偶发 `RangeError: Maximum call stack size exceeded`：同一探针单独跑 10MB 全过，放在 `outline-meta.test.ts` 里 8MB 起就抛。因结果不稳定，**没有**用 `it.fails` 钉（会变成 flaky），改为"只容忍 RangeError、任何其它异常都红"的契约钉子，并另测 1MB 必须成功。
- **已撤回**：D1（"script 文本被计字"）复验不成立 —— `NON_VISIBLE_TEXT_TAGS` 已排除 script/style/template；`outline-text.test.ts` 里改成正面断言。
- **已由编写员修复（我未改 src）**：`budget.ts` 两处不可达的 `if (entry === undefined)` 守卫在 21:37:27 被改写成 `drainStack` + `for…of`，覆盖率由此闭合。

## 6. 并发改动观察（影响可复现性）

跑本卡期间 `src/**` 被**并行改动**，我记录到三次行为漂移：

| 时间 | 文件 | 现象 |
|---|---|---|
| 21:32:53 | `src/ops/outline/text.ts` | 全角/希伯来/阿拉伯的计数从"逐字符"变成"连串 1"，同一条用例两次运行结果不同 |
| 21:37:27 | `src/ops/outline/budget.ts` | 不可达守卫被移除，`budget.ts` 覆盖率 96.19% → 100% |
| 21:39 前后 | `src/ops/outline/diagnostics.ts` | 新增 `path` 字段与三级收敛，`Diagnostic` 从"无位置"变为可定位 |

终态哈希（`shasum -a 256 packages/core/src/ops/outline/*.ts packages/core/src/meta/*.ts`）已存 `/tmp/m13-hashes-final.txt`；报告内所有数字都取自**该哈希对应的一次 `pnpm verify`**。建议后续卡片约定：实现与测试并行时，编写员改动后重跑一次协调者侧的 `pnpm verify` 再翻牌。

## 7. 仍存裂缝

1. 性能门禁是**自校准**的：1MB ≤150ms 在无插桩时是真阈值；`--coverage` 下（实测 parse+inject+derive 慢 ~3.3x）改用"同流水线 1/4 体量 × 12"与 `big/small < 14` 兜底。它抓 O(n²) 有效（M4 之外另有 4x 体量比值门），但不抓"常数因子退化 2-3 倍"。
2. 10k 节点必然触发体积裁剪，所以"10k 节点不溢出"断言的是**不崩 + 只有一条 truncation + `JSON ≤ 8192`**，不是"10k 节点全保留"（与卡片体积上限自相矛盾）。
3. `Diagnostic` 现在有可选 `path`，但 `outline_node_without_id` 仍按 `code+message` 折叠成一条（文案里带 `同报文 N 条`）。若未来要求逐位置诊断，需要把 path 纳入折叠键。
4. `pendingAnnotations` 的 `truncate` 用码点计（与字数同口径），不是字节；若前端按字节预算渲染，需另加断言。

ACP: Estimate: 51.5k (7%) | Provider-reported: 59.9k (7%)

---

## §G3.1 与卡片 v2 对齐（2026-02-19 21:5x，当前树）

### 1. 真实验证输出

```
$ pnpm verify
Test Files  27 passed (27)
     Tests  393 passed (393)
File             | % Stmts | % Branch | % Funcs | % Lines
All files        |     100 |      100 |     100 |     100
 src/model/validate.ts |     100 |      100 |     100 |     100
 src/ops/outline/annotations.ts | 100 | 100 | 100 | 100
 src/ops/outline/text.ts        | 100 | 100 | 100 | 100
✔ no dependency violations found (62 modules, 171 dependencies cruised)
$ knip --strict
（静默）
EXIT=0
```

M1.3 本卡用例数：**92**（7 个文件）—— `outline-text` 26 / `outline-meta` 26 / `outline-structure` 18 / `outline-pressure` 7 / `outline-surface` 6 / `outline-budget-regression` 5 / `outline-perf` 4。

### 2. v2 对齐表

| v2 条 | 裁定 | 落点（用例） | 结果 |
|---|---|---|---|
| #11 诊断按码聚合 + ≤1024B + 只一条 `outline_truncated` + 报文含真实丢弃数 | 硬要求 | **`outline-budget-regression.test.ts`（5 条，新增 P0 回归）** + `outline-pressure.test.ts` | ✅ 2000 节 snake_case：`JSON.stringify(outline).length ≤ 8192`、`nodes.length > 0`、折叠成 2 条（`<section>`/`<h3>` 各一）且报文含 `同报文 2000 条`、限流码保留 3 条、`outline_truncated` 恰 1 条且报文含 `另有 1997 条诊断省略（annotation_target_missing 1997 条）` |
| #12 `<style>/<script>/<textarea>/<template>` 不计字，`<noscript>` 计 | 硬要求 | `outline-text.test.ts`（`NON_VISIBLE_TEXT_TAGS` 用例） | ✅ `script/style/template/textarea` 全 0（`<textarea><p>正文</p></textarea>` → 0）；`noscript>p` 计词 |
| #13 `state-of-the-art`=4、`1,234.56`=3、`l'été`=2、NFC/NFD 同值、`𠀀`=1、非 ASCII 拉丁整串=1 | 硬要求 | `outline-text.test.ts` 字数矩阵（26 条） | ✅ 全部钉住；`l'été`=2 因撇号即分隔符；希伯来/阿拉伯/全角均=1（整串） |
| #14 `h3` 在 section 内 = 3 | 硬要求（v2 裁定，非迁就实现） | `outline-structure.test.ts` | ✅ 改为 3，用例注释写明是 v2 裁定 |
| #15 双报 `script_in_meta` + `invalid_meta` | 硬要求 | `outline-meta.test.ts` | ✅ 同一份输出里两条都在，`codes` 断言钉住这一对 |
| #16 批注 targetId 校验用 `targetId` | — | `outline-meta.test.ts` | ✅ 变异体 M3 已证 |
| #17 冻结/深等 | — | `model-immutable.test.ts` / `outline-perf.test.ts` | ✅ |
| #18 字数口径 | — | `outline-text.test.ts` | ✅ |

### 3. 缺陷复核（4 条登记 → 复核结果）

| 编号 | 上轮状态 | 复核结果 | 证据 |
|---|---|---|---|
| D6（全角/希伯来/阿拉伯按串计 1） | P2 登记 | **CLOSED（R1 已修）** | v2 #13 把"非 ASCII 拉丁整串=1"写成裁定，`outline-text.test.ts` 正面断言 1；不再是缺陷 |
| D7（`<title>` 计入字数） | P3 登记 | **CLOSED（R1 已修）** | `NON_VISIBLE_TEXT_TAGS` 扩到含 `title`；用例覆盖 |
| D9（无标题内层 section 的 text 为空） | P2 登记 | **CLOSED（R1 已修）** | 现取"最近的 section 标题"；`outline-structure.test.ts` 断言 `["inner", 2, "外层"]` |
| D4（多 MB raw text 偶发 `RangeError`） | P1 登记 | **OPEN（降级为 P3）** | 10MB raw text 复跑 6 次全绿；`model.test.ts` 仍保留"只容忍 `RangeError`"的契约钉子。若再复现升级登记 |

### 4. 变异测试（5/5 有效）

基线：`npx vitest run packages/core/tests/outline-*.test.ts` = **92 passed**；改完即还原。

| 变异体 | 改动 | red |
|---|---|---|
| M1 CJK 当 0 | `text.ts` `CJK_CHARACTER` → `/$^/u` | **11** |
| M2 去掉 `outline_truncated` | `diagnostics.ts` `withTruncation` 直返 `selected.list` | **8** |
| M3 `targetId` 改用 `id` 属性 | `annotations.ts` 校验键换掉 | **3** |
| M4 截断按 UTF-16 单元 | `characterCount(text) > limit` → `text.length > limit` | **1** |
| **M5 删掉诊断聚合** | `diagnostics.ts` `fitDiagnostics` 直返 `base`（不折叠/不限流/不加 truncation） | **14**（新增 P0 回归 5/5 全红 + `outline-pressure` 6 红 + `outline-structure` 3 红） |

**结论：P0 回归用例咬住了第 5 个变异体**（5/5 全红），即"实现若退回 v1 的丢弃式截断，这条用例必先红"。

### 5. 本轮修掉的自身腐化（都是测试自己的问题，不涉实现）

1. `entry-points.test.ts` 的 `Object.keys(...).sort()` 与 `REQUIRED_RUNTIME_EXPORTS` 顺序不一致 → 改为两侧同序。
2. `model.test.ts` 1MB 性能门假红：参考负载只在大文档之前测，并发 GC 尖峰落到大文档上（实测 632ms vs 预算 200ms）→ 改为**参考负载前后各测一次取小**、`cost/reference < 14` 兜底。
3. `outline-text.test.ts` 里"`<p>a</p><p>b</p>` 计 2"与 v2 #12 相邻用例重复 → 合并，避免同一事实两处维护。

### 6. 仍存裂缝（未变）

1. 性能门自校准，`--coverage` 下走"参考切片 × 12 + 比值 < 14"，抓 O(n²) 有效、抓常数退化 2–3 倍弱。
2. 10k 节点必然触发体积裁剪，"不溢出"断言的是不崩 + 一条 truncation + `JSON ≤ 8192`。
3. `outline_node_without_id` 仍按 `code+message` 折叠（文案带 `同报文 N 条`），不是逐位置诊断。
4. 并行改动风险：跑测期间 `src/**` 被 R1 改动多次，本报告数字对应 21:5x 那次 `pnpm verify`。

ACP: Estimate: 51.5k (7%) | Provider-reported: 59.9k (7%)
