# 测试报告 · M1.1（HTML 层：parse / serialize / inject / balance）

角色：测试员。白名单内只写了 `packages/core/tests/**` 与本报告；未动 `src/**`、根配置、卡片与 impl 报告。

**结论（G3.2 R2 覆盖率补齐后）：`pnpm verify` 全绿（EXIT=0），219 次执行 / **177 条唯一用例** / 15 文件，`src` 全部行/分支/函数 100%（`balance.ts` 从 95.29%→100%）。发现实现缺陷 0 个 P0；D2 已由 R1 修复（§8）。**

> 首轮（R1 前）数据：172 用例 / 13 文件、5 个 `it.fails` 钉住 D2。R1 后这 5 条已翻成 `it`，另加 27 条回归用例（§8）；R2 后又加 14 条父链/noscript 用例（§9）。报数口径见 §9.4。

## 1. 交付物

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `packages/core/tests/html-parse.test.ts` | 24 | 结构解析、边界输入、`empty_document`、`duplicate_attribute`、组件白名单 7 值、10k 深嵌套 |
| `packages/core/tests/html-serialize.test.ts` | 15 | 文本/属性转义、raw text 原样输出、void 元素、`<pre>` 首个换行、doctype 三种形态 |
| `packages/core/tests/html-inject.test.ts` | 25 | 注入范围、div 判定、块级词表、既有 ID 保留/改写、诊断顺序、确定性、幂等、冲突后缀 |
| `packages/core/tests/html-inject-tree.test.ts` | 13 | 种子采样契约、手搓树、纯函数性、权重规则 |
| `packages/core/tests/html-balance.test.ts` | 26 | 未闭合、错嵌套、raw text 剥离、注释/bang、引号内 `<`/`>`、D2 噪音（R1 前是 5 个 `it.fails`，现已翻成 `it`） |
| `packages/core/tests/html-r1-regression.test.ts` | 27 | R1 十项修复的回归闸：`stableHex8` 代理对、4000 深注入线性、raw text 清单、`div#hr-meta`、severity error 档、结束标签命名、修噪声未误伤 |
| `packages/core/tests/html-meta.test.ts` | 12 | `script#hr-meta` JSON 校验、`</script>` 截断、空/纯空白块、非 meta script |
| `packages/core/tests/html-roundtrip.test.ts` | 16 | 15 个自选恶意样本 + 三次连乘不漂移 + 不美化 |
| `packages/core/tests/html-perf.test.ts` | 3 | 1MB ≤300ms、4x 规模 <8x、10k 深嵌套不 RangeError |
| `packages/core/tests/html-support.test.ts` | 6 | 测试工具自检（遍历/取属性/擦除调用） |
| `packages/core/tests/entry-points.test.ts` | 4 | 公开面（改判据，见 §5） |
| `packages/core/tests/gates.test.ts` / `hr-error.test.ts` | 10 / 15 | M1.0 存量，未改 |
| `packages/protocol/tests/core-contract.test.ts` | 3 | M1.0 存量，未改 |

## 2. 真实输出（最终一轮）

```
$ prettier --check .        All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives   （无输出）
$ tsc --noEmit -p tsconfig.json --pretty false                   （无输出）
$ vitest run --coverage
 Test Files  13 passed (13)
      Tests  172 passed (172)
   Duration  6.30s (transform 131ms, setup 0ms, collect 751ms, tests 7.49s, environment 1ms, prepare 685ms)
All files      |     100 |      100 |      100 |      100 |
$ depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (31 modules, 66 dependencies cruised)
$ knip --strict            （无输出）
VERIFY_EXIT=0
```

覆盖率：`hr-error.ts`、`index.ts`、`html/{balance,constants,hash,index,inject,parse,serialize,stack,text}.ts` 全部 100/100/100/100（无 Uncovered Line）。

## 3. 重点攻击与实测结论

- **ID 确定性**：同输入两次字节相同；改 `process.cwd()` 到 `os.tmpdir()` 后一致；20 个文档交错注入（`Promise.all`）后逐个比对仍一致；`serialize → parse → inject` 不产生新 ID。
- **冲突后缀**：文档里预置 `idOf` 计算出的基 ID → 注入侧得到 `-2`；再预置 `-2` → 得到 `-3`；第二次运行保持既有后缀不再加码（"walk past taken suffixes" 用例）。
- **往返**：15 个样本含属性重复/大小写（`z="1" A="2" z="3"`）、自闭合与 void 混排、`<script>`/`<style>`/`<textarea>` raw text、`<pre>` 换行、实体表、带 PUBLIC/SYSTEM 的 doctype、`<template>`、错嵌套、隐式 `<td>`、大写+Unicode+emoji、SVG 外来内容、meta 内 `</script>`、真实 docs/02 骨架。断言是 `second.root` 与 `first.root` 深等 **且** 二次序列化字节相同。
- **容错**：未闭合 `<div><span>x` 报两条 `unclosed_tag` 且按出现顺序；`<div><span><b></div>` 报两条 `misnested_tag`；孤儿 `</span>` 报一条；10k 深嵌套 parse+inject+serialize 全程无 `RangeError`；空串/纯空白返回空文档且不抛；注释可作唯一内容。
- **meta**：`{"x":"</script>"}` 被 HTML 规则截断 → `script_in_meta` 且保留截断文本；空块与纯空白块不报；非 meta 的 `script` 不校验。
- **白名单**：7 个合法值逐个断言通过且属性原样保留；非法值给 `invalid_component` 诊断而**不丢属性**（`data-hr-component="nope"` 仍在树上）。
- **性能**：1MB（1,133,766 字符）parse+inject **43.9ms**（预算 300ms，7x 余量）；750→3000 份文档耗时比 <8（线性应 ~4x，平方 ~16x）；另测重复内容 750/3000/6000 份 = 6.9/8.9/14.7ms，**无 O(n²) 迹象**。

## 4. 断言有效性的硬证据（变异体，`/tmp/mut` 副本）

| 变异 | 目标测试 | 结果 |
| --- | --- | --- |
| M1 `stableHex8` 恒返回 `"00000000"` | `html-inject-tree`（种子采样契约） | **红**：`should take only the first 64 characters`（另：全量跑时 1MB 用例 14.5s 超预算，冲突后缀退化为平方级） |
| M2 冲突后缀恒为 `-2` | `html-inject` | **红**：`should walk past taken suffixes instead of reusing them` |
| M3 `script` 从 raw text 集合里删掉 | `html-balance` | **红**：2 个 script 用例 |
| M4 属性值不转义 `"` | `html-serialize` | **红**：`should escape & and " in attribute values only` |
| M5 关掉 meta JSON 校验 | `html-meta` | **红**：4 个用例 |
| M6 把 `span` 塞进块级词表 | `html-inject` | **红**：`should skip inline, unknown and plain div siblings` |

**M1 的存活分析（重要）**：常数哈希下"两次相同""换 cwd""20 并行""ID 互异"全绿——因为冲突后缀会自动把重复 ID 变成 `-2/-3`，把"内容不敏感"伪装成"确定性"。真正杀死它的是**种子采样契约**（63 字符相同、第 64 字符不同的两个文档必须得到不同 ID）与**性能预算**。教训：确定性用例不能替代敏感性用例。

## 5. `entry-points.test.ts` 的规格裁决（`toEqual(["HrError"])` → 两张表）

M1.0 那条是快照断言：任何卡片的合法扩面都会把它变红，而"实现漏了一个导出"与"实现多了一个导出"在它眼里是同一种红。现改为：

1. `REQUIRED_RUNTIME_EXPORTS = ["HrError", "injectNodeIds", "parseHtml", "serializeHtml"]`（来源：docs/02 §5.2 与 M1.1 卡片）逐条断言是函数；
2. 反向断言 `Object.keys(coreEntry)` 里**不允许出现表外名字**，报错即"多出了谁"。

为什么不是放水：两表仍能抓住"漏导出"（表 1）与"内部符号泄漏"（表 2），但两者红得可区分。判据仍来自规格文档，不来自实现；新增导出必须同时改表——这是有意的摩擦点。

## 6. 缺陷与裂缝

- **D2（质量项，非 P0，只登记不修；R1 已修，见 §8.2）**：`html/balance.ts` 把"被外层结束标签强制收尾"一律记为 `misnested_tag`，于是**合法**的隐式闭合也报 warning：`<ul><li>a</ul>`、`<table><tr><td>a<table>`…、`<select><option>…`、`<dl><dt><dd>`、`<section><h1>t</section>`。卡片只要求"错嵌套不得抛异常"，未定义该语义。已用 5 个 `it.fails` 钉住：若实现收窄为"仅交叉嵌套"，它们会转绿并提示改写成正经断言。风险是诊断噪声（真实文档会带一堆 warning），建议协调者决定是否要求收窄。
- **C1 覆盖率口径**：`entry-points.test.ts` 只能间接守 `index.ts` 的再导出（运行时键集合）；如果将来出现纯类型再导出，需要 `dts` 层断言。
- **C2 性能用例的时间预算依赖机器**：43.9ms / 300ms 有 7x 余量，但在 CI 抖动或并行跑时会放大；已在用例里输出实际耗时（失败信息带 `took X ms`），便于区分"真回归"与"环境抖"。
- **C3 确定性用例的盲点**（M1 的教训）：见 §4；已由种子采样契约补齐，但"内容敏感"只在 `<p>` 上取样，其它标签的种子公式仍只由结构位置用例间接覆盖。

## 7. 入库面

`git status` 中测试侧：`packages/core/tests/**`（9 个新增 html-*.test.ts + `html-support.test.ts`，`entry-points.test.ts` 修改）与本报告；`src/**`、根配置、`package.json`、卡片、impl 报告均未触碰。

ACP: Estimate: 63.9k (9%) | Provider-reported: 75.4k (10%)

## 8. R1 复核（G3.1）

### 8.1 事实更正（先说清背景）

委托单写"5 条 `it.fails`：`html-balance.test.ts:66-88` 4 条 + `html-serialize` 1 条"。实测：**5 条全部在 `html-balance.test.ts`，`html-serialize.test.ts` 里没有 `it.fails`**（`grep -rn 'it.fails' packages/core/tests/` 只命中 balance 的同名 describe）。以实测为准，不按委托单描述行动。

### 8.2 翻牌 5 条：逐条核实"真的断言了正确行为"

变的只有实现：`packages/core/src/html/balance.ts:152-158` 的 `closeTag` 现在只对 `FORMATTING_TAGS`（adoption-agency 那一组）报 `misnested_tag`，非格式化元素被外层结束标签收尾时静默。核实方式不是读报告，而是**双向变异**（`/tmp/g31` 副本，基线 `53 passed`）：

| 变异 | 结果 |
| --- | --- |
| 变体 1：`if (FORMATTING_TAGS.has(open))` → `if (!VOID_TAGS.has(open))`（回到旧行为） | **5 条翻牌用例全部转红**（`li`/`td`/`option`/`dd`/`h1` 五个"应静默"用例），其余 48 绿 |
| 变体 2：条件改成恒假（什么都不报） | **反向 5 条转红**：`should report each element force-closed by an outer end tag`、`should actually emit the error tier`、`should name the outer end tag in force-close messages`、`should still report cross-nested formatting elements`、`should document the remaining heuristic limit` |

结论：这 5 条既不会因为"旧噪音回来"被糊弄，也不会因为"干脆不报"而假绿——它们钉的是**窄化后的语义**，不是迎合实现的空断言。五条对应的输入（`<ul><li>a</ul>`、`<table><tr><td>a<td>b</table>`、`<select><option>a<option>b</select>`、`<dl><dt>a<dd>b</dl>`、`<section><h1>t</section>`）全部是 parse5 合法隐式闭合，卡片只要求"错嵌套不得抛异常"、语义层需要的是"结构被外力改写"的信号，故静默是正确的目标行为。翻牌时每条都补了"这条曾经红过、为什么如今应该绿"的注释（describe 头 4 行 + 用例本身）。

### 8.3 新增 27 条回归用例（`html-r1-regression.test.ts`）

| 组 | 条 | 打的是哪一项 R1 修复 | 坏掉会怎么红 |
| --- | --- | --- | --- |
| `stableHex8` 代理对 | 3 | 摘代理对后逐码点混入 | `😀`/`😁` 同值；20 个连续 astral 字符出现重复；实测 `cb31c4b8` vs `cc31c64b` |
| 深嵌套耗时 | 2 | 注入改迭代 + 单趟分配 | 比值 `deep/shallow ≥ 16`（O(n²) 会到 ≈64）或 4000 层 <div> 少一个 id |
| raw text 清单 | 8（6 标签 `it.each` + RCDATA + 成员自检） | `RAW_TEXT_TAGS` 补 `xmp`/`noembed`/`noframes` | 少一个 tag → 该元素内容被当普通文本转义成 `&lt;b&gt;`，往返字符串不等；RCDATA 多转义一次同样红 |
| `div#hr-meta` | 2 | meta 只认 `script` | `<div id="hr-meta">not json</div>` 误报 `script_in_meta`；反向：真截断的 `script#hr-meta` 不再报 |
| severity 分档 | 4 | `DIAGNOSTIC_SEVERITY` 表 | `misnested_tag` 不再产出 `"error"`、或 warning 档整档消失 |
| 结束标签命名 | 2 | message 里的标签名 | `<div>x</span></div>` 报成 `<div>`；强制闭合消息丢掉 `</div>` |
| 修噪声未误伤 | 2 | 与 8.2 同一修复的守门 | 见 8.2 变体 2 的 5 条 |

### 8.4 实测耗时（4000 深嵌套注入，取 5 次最小值）

```
DEPTH=500   BEST_MS=0.76
DEPTH=1000  BEST_MS=0.92
DEPTH=2000  BEST_MS=1.73
DEPTH=4000  BEST_MS=2.87     ← 深度 8 倍，耗时 3.8 倍
```

比例 3.8× 小于线性 8×（固定开销占比大），远小于 O(n²) 的 64×；断言写的是 `deep/shallow < 16` 且 `deep < 2000ms`，对机器抖动留了余量。同时用 4000 层 `<div>` 逐层 `findElement` 走到最内层，确认每一层都拿到 id（迭代式 DFS 不爆栈）。

### 8.5 驳回项：0

但有 2 条"修得不彻底"的观察，均已在用例里钉成"已知边界"而非判缺陷：

1. **token 级栈看不到 adoption agency 的重建**：`<p><b>a</p>` 里 `b` 实际上由 EOF 收尾（浏览器树是 `<p><b>a</b></p>` 之后 b 仍在格式化元素列表里），本实现仍按"`b` 被 `</p>` 强行闭合"报 `misnested_tag`。这不是 R1 引入的回归（旧实现同样报），但 R1 把"报什么"的理由收窄到"adoption-agency 组"后，这条理由在这个输入上并不成立。用例 `should document the remaining heuristic limit on <p><b>a</p>` 把它钉成"当前行为 = 单条 misnested_tag"，将来改成树级比对会红并提示改写。建议协调者把它并入 M1.2 的 balance 语义定义（要么按规范排除"EOF 收尾"，要么把 balance 升级为树级 diff）。
2. **`<div><p>a</div>`** 同理会静默（`p` 非格式化元素），即"块级交叉"不报警。与 1 是同一根因。卡片未定义该语义，不判缺陷。

### 8.6 最终一轮 `pnpm verify`（真实输出）

```
$ prettier --check .        All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives   （无输出）
$ tsc --noEmit -p tsconfig.json --pretty false                   （无输出）
$ vitest run --coverage
 Test Files  14 passed (14)
      Tests  199 passed (199)
All files      |     100 |      100 |     100 |      100 |
$ depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (32 modules, 71 dependencies cruised)
$ knip --strict            （无输出）
VERIFY_EXIT=0
```

覆盖率没有掉：`packages/core/src/**` 全部行/分支/函数 100%，`html-r1-regression.test.ts` 与 5 条翻牌用例都进了 100% 的分子而不是靠豁免。

### 8.7 入库面（R1）

`git status` 测试侧只动 `packages/core/tests/**` + 本报告：改 `html-balance.test.ts`（翻牌）、新增 `html-r1-regression.test.ts`。`src/**`、根配置、`package.json`、卡片、impl 报告未触碰；`/tmp/g31` 的变异实验全部在副本里做，仓库工作树干净。

ACP: Estimate: 63.9k (9%) | Provider-reported: 75.4k (10%)

## 9. R2 覆盖率补齐（G3.2）

### 9.1 缺口与新增

R2 在 `packages/core/src/html/balance.ts:106-110` 加了 `LEGAL_PARENTS`（`td`/`th` → `tr`；`tr` → `table`/`tbody`/`thead`/`tfoot`），并在 `closeTag` 的强制收尾循环里（`:173-182`）校验父链。R2 交付时 `balance.ts` 是 95.29% 行 / 96.29% 分支，未覆盖行 `175-182`（诊断分支）——只因既有 199 例里没有任何 `<table><td>` 形状的输入。

新增 `packages/core/tests/html-r2-coverage.test.ts`，**14 条**，全部走 `parseHtml`/`serializeHtml` 的对外行为（不直接调 `balance.ts` 内部函数，也不为吃分支写执行型断言）：

| 组 | 条 | 断言形状 | 实现坏掉会怎么红 |
| --- | --- | --- | --- |
| 合法父链（放行侧） | 6 | `codesOf(...) === []` | 白名单收紧过头 / `popImplied` 多弹一层 → 合法样本冒出 `misnested_tag` |
| 非法父链（诊断侧） | 4 | `codes 恰为 ["misnested_tag"]` + `severity === "error"` + **完整 message 逐字相等** | 不校验父链 → 空数组；文案里 `expected` 枚举漏项/顺序变 → 逐字不等；父元素取错（取栈顶而非 `stack[position-1]`）→ 文案里的 `<table>`/`<div>` 变 |
| 父链合法但整体仍错嵌套 | 1 | `<table><tr><td><div><b>x</table>` → 恰 1 条且只点名 `<b>` | 父链校验把合法 td/tr 也算进去 → 多报；`FORMATTING_TAGS` 分支被父链分支吃掉 → 0 条 |
| noscript（R2 P1-R1） | 3 | 往返逐字相等（`a &amp; b` 只转义一次）+ `<noscript><p>` 结构保留 + `RAW_TEXT_TAGS` 不含 `noscript` | 两个修复缺一：只删 raw 集 → 双转义 `&amp;amp;`；只改 `scriptingEnabled` → 内容被当 raw text 原样吞 |

**"位置"的说明**：`Diagnostic` 目前只有 `code`/`severity`/`message` 三个字段（`src/html/text.ts`），没有偏移量。规格里"诊断位置"在当前实现下不可断言，我改为断言**条数 + 顺序 + 逐字文案**（顺序即强制收尾循环的遍历顺序，等价于结构位置）；若 M1.2 给 `Diagnostic` 加 `offset`，这 4 条会是最先补位置断言的地方。

### 9.2 变异证据（`/tmp/g32` 副本，仓库未改）

基线：`Tests 20 passed (20)`（本文件 14 + 被 import 的工具自检 6）。三个变异都只动 `LEGAL_PARENTS` 一行：

| 变异 | 结果 |
| --- | --- |
| M1 `td: new Set(["tr"])` → `["tr","table"]` | **2 红**：`table>td` 名字用例、`div>td` 文案用例（`expected` 枚举多了 `<table>`） |
| M2 `tr` 的合法父里去掉 `tbody` | **3 红**：`table>tbody>tr>td`、相邻 `td` 隐式闭合、`tr` 父链文案（枚举少一项） |
| M3 `tr` 的合法父里去掉 `tfoot` | **2 红**：`tfoot>tr>td`、`tr` 父链文案 |

还原后 20/20 绿。说明这三张断言真的钉在父链语义上，不是"覆盖率填充物"。

### 9.3 最终 `pnpm verify`（真实输出）

```
$ prettier --check .        All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives   （无输出）
$ tsc --noEmit -p tsconfig.json --pretty false                   （无输出）
$ vitest run --coverage
 Test Files  15 passed (15)
      Tests  219 passed (219)
All files      |     100 |      100 |     100 |      100 |
  balance.ts   |     100 |      100 |     100 |      100 |
  constants.ts |     100 |      100 |     100 |      100 |
  hash.ts      |     100 |      100 |     100 |      100 |
  index.ts     |     100 |      100 |     100 |      100 |
  inject.ts    |     100 |      100 |     100 |      100 |
  parse.ts     |     100 |      100 |     100 |      100 |
  serialize.ts |     100 |      100 |     100 |      100 |
  stack.ts     |     100 |      100 |     100 |      100 |
  text.ts      |     100 |      100 |     100 |      100 |
$ depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (33 modules, 75 dependencies cruised)
$ knip --strict            （无输出）
VERIFY_EXIT=0
```

**没有"试过但覆盖不到"的分支**：v8 口径下行/分支/函数全 100%，R2 新增的 `legalParents === undefined`（非单元格标签）、父链合法、父链非法三种走向都有真实输入命中；`stack[position-1]` 在 `position === 0` 不可达（循环从 `index+1` 起、`index ≥ 0`），该边界由 `String()` 的类型收窄覆盖而非运行期分支。

### 9.4 报数口径更正 + 一条自曝缺陷（我的，不是实现的）

`219 passed` 里有重复：`html-support.test.ts` 被 7 个测试文件 import，Vitest 按文件收集，于是它的 6 条工具自检在 8 个上下文里各注册一次 → **重复执行 42 次**。唯一用例数 = **177**。这不是实现的缺陷，是我把"辅助模块"和"带用例的测试文件"混成一个文件的布局问题。

我试图干净修掉（`html-support.ts` 纯工具 + `html-support-guard.test.ts` 单独放自检），结果：
- 重复消失：`Tests 177 passed (177)`，覆盖率仍 100%；
- 但 `knip --strict` 立刻红：`Unused files (1) packages/core/tests/html-support.ts` —— `knip.json` 的 `entry` 只列 `packages/*/src/index.ts`，`project` 里的 tests 文件必须**自身是测试入口**才算 reachable；
- `knip.json` 不在测试员白名单，改不了，于是**回滚**成现在的形态，并把原因写进 `html-support.test.ts` 头部注释（`grep -n "为什么只能叫" packages/core/tests/html-support.test.ts`）。

建议协调者给 `knip.json` 加一条 `"entry": ["packages/*/src/index.ts", "packages/*/tests/**/*.test.ts"]`（或把 tools 目录纳入 `project` 的 `!` 例外）；之后我可以一次性把工具与自检拆开，用例数才是 177。在那之前，请按 **177 唯一 / 219 执行** 读所有历史数字。

### 9.5 入库面（R2 补齐）

只新增 `packages/core/tests/html-r2-coverage.test.ts`（14 条）+ 本报告；`html-support.test.ts` 头部注释补了"为什么不能改名"。`src/**`、根配置、`package.json`、`knip.json`、卡片、impl 报告均未触碰；变异实验全部在 `/tmp/g32`（`ln -s` 了 node_modules）里做。

ACP: Estimate: 63.9k (9%) | Provider-reported: 75.4k (10%)
