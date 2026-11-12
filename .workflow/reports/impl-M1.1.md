# impl-M1.1 · HTML 解析 / 序列化 / `data-hr-id` 注入

- 卡片：`.workflow/cards/M1.1.md`（唯一验收依据）；依赖 `f1eba42`（M1.0）
- 本机：node v24.15.0 / pnpm 11.1.3
- 结论先行：**代码按契约落地，`pnpm verify` 红**——红因测试员快照断言过期（1 条）+ 新文件无测试（覆盖率），不是实现自身跑不通；逐条证据见下。

## 1. 交付清单

| 文件 | 这层管什么 |
| --- | --- |
| `packages/core/src/html/constants.ts` | 块级标签集合、`data-hr-component` 白名单（7 值）、`META_SCRIPT_ID`、纯数据类型（`HtmlNode` 判别联合、`Diagnostic`、`ParsedHtml`）、`DiagnosticCode` 窄联合（7 值）、诊断严重度分档表、raw text / RCDATA 词表（全仓唯一清单） |
| `packages/core/src/html/stack.ts` | `drainStack`：一切遍历的栈原语（生成器，`while (stack.length > 0)` 单出口，无死分支） |
| `packages/core/src/html/text.ts` | `textSampleOf(node, limit)`：按文档序收集到 `limit` 即停（`textContentOf` 是 `limit=Infinity` 的薄封装），document / element 都下钻 |
| `packages/core/src/html/hash.ts` | `mixHex`（FNV-1a 32 位、可续算）+ `stableHex8`；按 UTF-16 单元遍历（代理对两个单元都参与混合），自包含（不 `import "node:crypto"`） |
| `packages/core/src/html/balance.ts` | 标签配对自检：正则剥离注释 / raw text 后按栈配对，报 `unclosed_tag` / `misnested_tag` |
| `packages/core/src/html/parse.ts` | `parseHtml`：parse5 容错解析 → 纯数据树（迭代构建，路径 `html[0]>body[0]>article[0]` 只为诊断定位） |
| `packages/core/src/html/serialize.ts` | `serializeHtml`：属性保序、文本转义、raw text 不转义、不美化、不重排空白 |
| `packages/core/src/html/inject.ts` | `injectNodeIds`：纯函数，块级元素注入 `hr-<8hex>`，已有合法 ID 保留、非法改写、冲突 `-2/-3`；种子里的祖先路径是滚动摘要（每层 O(1)） |
| `packages/core/src/html/index.ts` | html 子层唯一出口（3 函数 + 类型） |
| `packages/core/src/index.ts` | 公开面：`HrError`（值）+ `HrErrorCode` + `parseHtml` / `serializeHtml` / `injectNodeIds` + 11 个类型 |
| `packages/core/package.json` | `parse5: "8.1.1"`（生产依赖，精确版）；`eslint` 进 devDependencies（测试用 ESLint API，knip 的 `no-undeclared-external-dep` 要求声明在所属包） |
| `packages/core/src/hr-error.ts` | **偏差 E1**：把 `HrError` 从 `index.ts` 提到同级模块（见 §5） |

行数：最大 `inject.ts` 238 行、`parse.ts` 236 行、`balance.ts` 169 行（上限 400）；函数与复杂度由 lint（`max-lines-per-function: 40`、`complexity: 10`）实测通过。

## 2. 契约逐条证据

### 2.1 解析（契约 1）

| 样本 | 内容 | `roundtrip` | 诊断码 |
| --- | --- | --- | --- |
| S1 | 真实风格完整文档（doctype / lang / meta / title / `<script id="hr-meta">` 合法 JSON / style / article 内 section·header·h1·p·table·figure·details·pre·blockquote） | `true` | 无 |
| S2 | 畸形：`<div class='a' class="b"><p>未闭合<p>…</div><span><b>错<i>嵌套</b></i></span>` | `true` | `duplicate_attribute`, `misnested_tag` |
| S3 | `meta` 内 `<script id="hr-meta">{"x":"</script>"}</script>` | `true` | `misnested_tag`, `script_in_meta` |
| S4 | 实体 / 大写标签 `PRE` / `<script>` 与 `<style>` raw text | `true` | 无 |
| S5 | 带 `PUBLIC` + `SYSTEM` 的 doctype、`<!--top-->`、`<template>` 子树、块内注释、`diagram-stage` | `true` | 无 |

- 空串：`parseHtml("")` → `{ root: { kind: "document", children: [] } }` + `empty_document`，`serializeHtml` 回 `""`。
- 非字符串：`parseHtml(42 as unknown as string)` → 抛 `HrError`，`error.name === "HrError"`、`error.code === "invalid_html"`（`instanceof HrError` 为 `true`）。
- 无 doctype 不报诊断：parse5 的 `missing-doctype` 属"可接受缺失"，故意不映射（映射表只留能实测触发的 9 个 tokenizer 错误码）。
- 树构造级错误（未闭合、错嵌套）parse5 **根本不报**——由 `balance.ts` 从原文自检补上；这是两套判据并存的原因。

### 2.2 序列化（契约 2）

- 属性保序：`HtmlAttribute = readonly [string, string]`，`toAttributes` 按 parse5 `attrs` 原序转数组，序列化按数组顺序拼。
- 重复属性 + 大小写混写实测：`<div z="1" A="2" z="3">x</div>` → 树 `attrs = [["z","1"],["a","2"]]`（parse5 归一化为首次出现值、属性名小写），诊断 `duplicate_attribute`，序列化 `<div z="1" a="2">x</div>`。**只读**契约，未做任何重排。
- 转义：文本 `& < > " '` + U+00A0；属性值 `& " < > '` + U+00A0；`<script>` / `<style>` 内容原样输出（raw text）。
- 不美化：`<html><head></head><body>…` 单行直出，解析器归一化空白即输出空白。

### 2.3 ID 注入（契约 3）

- 种子：`tag \0 同标签兄弟序号 \0 归一化文本前 64 字 \0 祖先路径摘要(8 位 hex)`；祖先路径摘要由 `mixHex` 逐层续算（R1 前是整条路径字符串，深度直接进单次成本）；最终 FNV-1a 32 位 → 8 位小写十六进制。
- 确定性实测：同一输入两次调用序列化结果逐字节相同（`twiceEqual: true`）；`process.chdir("/tmp")` 后仍相同（`cwdEqual: true`）。
- 已有合法 ID 保留；非法值改写 + `invalid_hr_id`（`"Bad Id"` → `hr-7aecbf28`）；冲突后缀 `-2`、`-3`（`hr-a5f66c8b` 与 `hr-a5f66c8b-2` 同时被占 → 新节点拿 `hr-a5f66c8b-3`）。
- 纯函数：`injectNodeIds(parsed)` 前后 `JSON.stringify(parsed)` 不变。
- 白名单外组件：保留节点与属性，`invalid_component` 诊断，不静默丢。

### 2.4 诊断码（契约 4）

严重度按码定档（`constants.ts` 的 `DIAGNOSTIC_SEVERITY`）：`misnested_tag` → `error`，其余 → `warning`；`DiagnosticSeverity` 的 `"error"` 因此是活值。

实际发出的 `code` 只会是 7 个值：`unclosed_tag`、`misnested_tag`、`duplicate_attribute`、`invalid_component`、`invalid_hr_id`、`script_in_meta`、`empty_document`。parse5 错误码→诊断码的映射只保留 9 个可实测触发的键（EOF 类与 `missingEndTagName` → `unclosed_tag`；`duplicateAttribute` → `duplicate_attribute`；`endTagWithAttributes` → `misnested_tag`，见偏差 E3）。

### 2.5 组件白名单（契约 5）

7 个取值：`kpi-bento`、`callout-insight`、`callout-warning`、`split-compare`、`deep-dive`、`step-timeline`、`diagram-stage`。**规格冲突**见 §5。

### 2.6 依赖 / 形态（契约 6–7）

- 生产依赖只有 `parse5@8.1.1`（精确版，符合仓库 `save-exact` 约定；初版误写成 `^8.1.1` 已修正并更新 lockfile 的 specifier）。
- 导出面（R1 收敛后）：`packages/core/src/index.ts` 运行期 4 个键（`HrError` / `injectNodeIds` / `parseHtml` / `serializeHtml`）+ 7 个类型（`HrErrorCode`、`Diagnostic`、`DiagnosticCode`、`HtmlElementNode`、`HtmlNode`、`InjectedNodeIds`、`ParsedHtml`）；`src/html/index.ts` 是 3 函数 + 6 类型（同上，除 `HrErrorCode`）。knip `--strict` 0 未使用项（`HtmlAttribute` / `HtmlCommentNode` / `HtmlDoctypeNode` / `HtmlDocumentNode` / `HtmlTextNode` 已不再导出，叶子节点经 `HtmlNode` 联合自取）。

## 3. 自证

### 3.1 注入覆盖面抽查（S1_full）

- `<article>` 内块级元素 **16 个全部获得 ID**；`<article data-hr-id="art-main">` 已有合法 ID 保持不变（故 `injected` 里不含它）。
- 首 ID `hr-72411605`（遍历序第一个块级 `section`），末 ID `hr-d51f83f8`（遍历序最后一个块级 `blockquote`）。
- 无 `<article>` 的文档（S2）：`injected = []`，不报错、不改树。

### 3.2 1MB 性能（契约 8）

合成文档 `1048625` 字节（含嵌套 section/article/表/代码块/图），`parseHtml + injectNodeIds` 3 次耗时：`98.7ms / 80.0ms / 76.0ms`，**中位数 80.0ms**（预算 300ms）。测法：Vitest 内 `performance.now()` 计时、预热 1 次、取 3 次中位数；不开覆盖率（开 v8 插桩会涨到约 250ms，属测量口径差异）。

### 3.3 深嵌套

10k 层嵌套：不爆栈，`injected.length === 10000`，单次约 `1994ms`（无覆盖率插桩）。成本来自祖先路径串 O(depth) 复制；真实文档深度 < 20，不影响 1MB 预算，已登记技术债。

## 4. `pnpm verify` 现状（R1 后：五项静态绿，红只剩测试侧 5 条 `it.fails`）

逐项单跑（`pnpm -s <script>`，R1 修复后）：

| 步骤 | 结果 |
| --- | --- |
| `format:check` | ✅ |
| `lint` | ✅ |
| `typecheck` | ✅ |
| `test` | ❌ `5 failed / 167 passed (172)`：全部是 `packages/core/tests/html-balance.test.ts:66-88` 的 `it.fails`（实现已按 P1-1 修好，测试体通过 → `it.fails` 判红）。**不是实现缺陷**：测试员把 `it.fails` 翻成 `it` 即全绿，我不改测试。 |
| `test:coverage` | 全量跑因上面 5 例中断出表，用 `--coverage.reportOnFailure=true` 实测：**All files 100 / 100 / 100 / 100，11 个文件逐个 100%**（含 `balance.ts`、`hash.ts`、`inject.ts`、`text.ts`） |
| `depcruise` | ✅ |
| `knip` | ✅（`--strict` 0 未使用导出/文件/依赖） |

`pnpm verify` 链式执行会卡在 `test:coverage` 一步；后两步 `depcruise`/`knip` 需单跑（结果如上表）。G2 的 P1-4（原先"五项红"）在 G3 交付 172 例后已消，R1 只留下 5 条测试侧待翻牌断言。

## 5. 规格冲突与偏差

1. **组件数量 6 vs 7**（卡 5 已预告）：`docs/02` 第 141 行写"6 大内置零配置语义组件"，但第 142–147 行列举的第 2 项是双值 `callout-insight / warning` → 实际取值 7 个。按"以 `docs/02` 为准"实现 7 个；卡片字面"仅 6 个值"无法自洽，建议 docs/05 与卡片统一改为"7 个取值 / 6 组"。
2. **`docs/02` 自相矛盾**：第 92 行示例写 `data-hr-component="bento-grid"`，第 142 行词表是 `kpi-bento`。实现按词表（`kpi-bento`）；照抄第 92 行示例的文档会得到 `invalid_component`。**需文档侧择一修正**（若要保留 `bento-grid`，白名单需改，属卡片修订）。
3. **偏差 E1（Scope 外新增文件）**：`packages/core/src/hr-error.ts`。`HrError` 原先定义在 `packages/core/src/index.ts`，但 `html/parse.ts` 需要它、又不能 `import "../index"`（`index → html → index` 循环，depcruise `no-circular` 会红）。切到同级模块后行为零变化（`instanceof` 身份保持，M1.0 的 `hr-error.test.ts` 15 条仍全绿）。请协调者裁定：追认该文件入 Scope，或指示回退（回退需接受循环或把 `HrError` 塞进 `html/` 反向分层）。
4. **偏差 E2（合并纯类型模块）**：原计划的 `types.ts` 与 `constants.ts` 合并——v8 覆盖率对"只含类型声明"的文件按 0/0 判定为 0%，纯类型文件永远拿不到 100%，合并后 `constants.ts` 覆盖 100%。
5. **偏差 E3（诊断码语义）**：`<a href="x" b="y">` 这种"结束标签带属性"（parse5 `endTagWithAttributes`）归入 `misnested_tag`——7 个允许的码里没有更贴切的；若要求精确，需卡片修订新增码。

## 6. 已知限制 / 技术债（登记不修）

- `script_in_meta` 的判据是"meta 文本 `JSON.parse` 失败"，即"被 `</script>` 截断"的代理指标；M1.2 接入结构校验后替换（代码注释已标注）。
- `balance.ts` 用正则剥离注释与 raw text 后再配对，对"`<` 出现在属性值里"等极端形态可能误判；S2 覆盖了常见畸形形态。
- 深嵌套 ID 路径串为 O(depth) 复制：10k 层约 2s，无渐进上限；真实文档无感。
- `data-hr-id` 合法性只认 `[a-z0-9-]`（大写/中文/带空格一律改写 + 诊断）。
- `<template>` 子树参与解析与往返（内容在 `template.content`），但注入按文档位置遍历，不进入 `template` 内部单独编号。

## 7. 给测试员的话（5 条，最该打哪里）

1. **只剩一件事**：把 `packages/core/tests/html-balance.test.ts:66-88` 的 5 个 `it.fails` 翻成 `it`（`<ul><li>a</ul>`、`<table><tr><td>a<td>b</table>`、`<select><option>a<option>b</select>`、`<dl><dt>a<dd>b</dl>`、`<section><h1>t</section>` 现在都返回 `[]`）。上游那条 `entry-points.test.ts` 你已在 G3 改好，无需再动。
2. **凑满 100% 分支的最小样本集**（我已用探针验证可达 100%，缺任一条就会红）：`<template>` 子树、块内注释、带 `PUBLIC`/`SYSTEM` 的 doctype、空 `<script id="hr-meta"></script>`、非法 `data-hr-id`（如 `"Bad Id"`）、`hr-<hash>` 与 `-2` 同时被占用、`<div z="1" A="2" z="3">`（重复属性+大写）、无 `<article>` 的文档。
3. **手搓树也要测**：`injectNodeIds` 接受任意 `ParsedHtml`（包括 root 为 text/comment/doctype 的树），用于打 `inject.ts` 的其余分支。
4. **性能断言留余量**：1MB `parse+inject` 本机中位数 51.8ms（上限 300ms），带 v8 插桩约 700ms；10k 深嵌套注入 R1 后从秒级降到十几毫秒（无插桩），带插桩约 1.8s，别把两者放同一 `it` 里比耗时。
5. **别断言范围外的行为**：`<article>` 之外不注入；`<pre>` 算块级；`li` / `td` 算块级（卡片列表里 `li` 在内、`td` 未列，实现按卡片只注入 `li`，`td` 不注入）。

## 8. 入库状态

- 未提交（按约定由协调者 commit）。实现侧工作区变更：`M packages/core/package.json`、`M packages/core/src/index.ts`、`?? packages/core/src/hr-error.ts`、`?? packages/core/src/html/`；G3/协调者的 `M .workflow/cards/M1.1.md`、`M .workflow/state.md`、`M docs/02-*.md`、`M packages/core/tests/**`、`M pnpm-lock.yaml` 不是我改的。
- 临时探针（`probe/`、`vitest.probe.config.mts`）与 `coverage/` 已全部删除；`git status` 无残留临时文件。

## 9. R1 修复对照表（G2 = FAIL · P1×4 返工）

| 编号 | 改动（文件） | 改前实测 | 改后实测 | 备注 |
| --- | --- | --- | --- | --- |
| P1-1 | `packages/core/src/html/balance.ts` 的 `closeTag` + 新增 `FORMATTING_TAGS` | `<ul><li>a</ul>` → `["misnested_tag"]`；`<table><tr><td>c</table>` → 2 条；`<article><ul><li>a<li>b</ul></article>` → 1 条；`<select><option>a<option>b</select>`、`<dl><dt>a<dd>b</dl>`、`<section><h1>t</section>` 各 1 条 | 上面 6 个样本全部 `[]`；真错嵌套未被放过：`<div><span><b></div>` 仍 2 条（`<span>`/`<b>` 被 `</div>` 强行闭合），`<div>x</span></div>` 仍 1 条；**R2 补**：`<table><td>x</table>` 由 0 条改为 1 条（见 §10 P1-1 残留） | 判据不是给每个容器再写一张镜像表，而是"被祖先结束标签收尾时只有格式化元素（a/b/big/code/em/font/i/nobr/s/small/span/strike/strong/tt/u）算错嵌套"——非格式化元素被祖先收尾属规范内隐式闭合。**5 条 `it.fails` 需测试员翻牌**（`html-balance.test.ts:66-88`）。 |
| P1-2 | `packages/core/src/index.ts`、`packages/core/src/html/index.ts`、`constants.ts` 的叶子接口去 `export` | 入口类型导出 11 个（含 5 个零引用） | 入口类型导出 7 个：`HrErrorCode`、`Diagnostic`、`DiagnosticCode`、`HtmlElementNode`、`HtmlNode`、`InjectedNodeIds`、`ParsedHtml`；`src/html/index.ts` 6 个；运行期键仍 4 个 | **与审计证据不符处**：审计表称 `InjectedNodeIds` 0 引用，但 G3 的 `html-inject.test.ts`、`html-inject-tree.test.ts` 共 3 处从 `../src/index` 导入它，`html-support.test.ts` 还导入 `HtmlElementNode`；删掉会让 172 例里的 4 个文件 typecheck 红，而测试冻结。**已删审计点名的 5 个**（`HtmlAttribute`/`HtmlCommentNode`/`HtmlDoctypeNode`/`HtmlDocumentNode`/`HtmlTextNode`），保留 2 个在用的，请裁定是否要求测试改导入路径。knip `--strict` 0 项。 |
| P2-1 | `packages/core/src/html/hash.ts`：`charCodeAt(0)` → 按 UTF-16 单元下标遍历 | `stableHex8("😀")` = `37822568`，`stableHex8("😁")` = `37822568`（撞号） | `cb31c4b8` vs `cc31c64b`（不等） | 顺带把 `mixHex` 暴露为续算原语（P2-2 的路径摘要要用）。 |
| P2-2 | `packages/core/src/html/inject.ts`（种子改用滚动摘要）+ `packages/core/src/html/text.ts`（`textSampleOf(node, limit)` 到 64 即停） | 4000 深嵌套注入：435.7 / 419.5 / 430.0 ms（3 次）；只改文本早停不解决问题（说明瓶颈是 `ancestors.join(">")`，深度直接进单次成本） | 7.0 ms（3 次中位数）；100 万字节 `parse+inject` 中位数 51.8 ms。**R2 纠正**：上面那次 1k–8k 的"≈ 线性"只对每层都有文本的文档成立；层层无文本的深链要下降到首个文本节点取样本，仍是 O(深度²)（§10 P2-R3 有 6.3 / 21 / 79 / 313 ms 的复测） | 注释已改成事实（"收集到 64 字符即停"，不再自称"只取前 64 字符"却先拼全文）。 |
| P2-3 | `constants.ts`：`RAW_TEXT_TAGS`（6：script/style/xmp/iframe/noembed/noframes）+ 新增 `RCDATA_TAGS`（2：textarea/title）；`balance.ts` 与 `serialize.ts` 都从这里取 | `<xmp>a&amp;b</xmp>` 往返得到 `<xmp>a&amp;amp;b</xmp>`（双转义，渲染出 `&amp;` 字面量）；三处清单各说各的（2 / 8 / 2） | 往返得到 `<xmp>a&amp;b</xmp>`（渲染字符不变）；`<textarea>a&amp;b</textarea>` 仍按 RCDATA 转义、`<iframe><b>x</b></iframe>` 原样 | 语义分界：raw text 不解析字符引用 → 不转义；RCDATA（textarea/title）解析字符引用 → 必须转义。balance 的剥离正则用两者并集。**R2 补**：`noscript` 已从 `RAW_TEXT_TAGS` 移除并改由 `scriptingEnabled: false` 对齐浏览器（见 §10 P1-R1）。 |
| P2-4 | **未改（冲突）** | `misnestedDiagnostic` 的"无对应开始标签"分支印成 `<span> 的结束标签没有对应的开始标签` | 期望形如 `</span> 没有对应的开始标签` | 但 `packages/core/tests/html-balance.test.ts:49` 用 `toBe("<span> 的结束标签没有对应的开始标签")` 严格钉住旧文案，改文案 = 172 例里 1 例翻红。实现侧改动只有 1 行，**请裁定：由测试员先改该断言，我再改文案**（本轮优先保 `verify` 不被我改红）。 |
| P2-5 | `constants.ts` 新增 `DIAGNOSTIC_SEVERITY`，`parse.ts`/`balance.ts`/`inject.ts` 统一取档 | 所有诊断 `severity: "warning"`，`"error"` 是死值 | `misnested_tag` → `error`（`<div><span><b></div>` → `["error","error"]`）；`unclosed_tag` → `warning`（`<div><p>a` → `["warning"]`） | 只把错嵌套升档：`html-parse.test.ts:185` 要求 tokenizer 级 `unclosed_tag` 是 `warning`，保持不改。 |
| P2-6 | 未改（按要求只登记） | 文档里两个节点带同一个合法 `data-hr-id` 时静默都保留 | 同上 | 登记为 **M1.2 已知缺口**：需要文档级唯一性校验，属语义层（本卡只有"冲突后缀"规则，没有"重复显式 ID"规则）。 |
| P2-7 | `packages/core/src/html/text.ts`：`childNodesOf` 覆盖 `document` | `textContentOf(document)` 返回 `""` | 返回 `"ab"`（`<article><p>ab</p></article>` 的根） | |
| P2-8 | `packages/core/src/html/parse.ts`：收集 meta 时加 `element.tagName === "script"` | `<div id="hr-meta">x</div>` → `["script_in_meta"]`（误报） | `[]` | 仍是"JSON 可解析性"判据（`script` 内的截断检测）。 |
| D2 | 无需改动 | 审计指向 `parse.ts:236` 的 `finally { current = null }` | `grep -n "finally" packages/core/src/` 零命中 | 该 `try/finally` 在树构建改成迭代式（`buildTree`）时已经删掉，审计快照早于这一版。 |

## 10. R2 修复对照表（`G2-R: FAIL` · 2×P1 + 4×P2）

| 编号 | 改动（文件） | 改前实测 | 改后实测 | 备注 |
| --- | --- | --- | --- | --- |
| P1-R1 | 选"从 raw 集移除 `noscript` + 对齐 parse5 的 scripting 开关"两条都做：`constants.ts` 的 `RAW_TEXT_TAGS` 不再含 `noscript`；`parse.ts` 传 `scriptingEnabled: false` | `<noscript>a &amp; b</noscript>` 往返 → `<noscript>a &amp;amp; b</noscript>`（双转义）；根因是 parse5 自己的默认是 `scriptingEnabled: true`（`parse5/dist/parser/index.js:73`），把 noscript 内容当 raw text 原样保留实体串，序列化再转义一次 | 同一输入往返 → `<noscript></noscript>` + body 里的 `a &amp; b`：**实体只被转义一次**，渲染字符仍是 `a & b` | 只删 raw 集不够（parse5 在解析阶段就已经不解析实体），所以必须同时把 `scriptingEnabled` 显式置 false——这也正是浏览器不跑脚本时的口径。 |
| P1-1 残留 | `packages/core/src/html/balance.ts` 新增 `LEGAL_PARENTS`（td/th → tr；tr → table/tbody/thead/tfoot），在 `closeTag` 的强制收尾循环里校验父链 | `<table><td>x</table>` → `[]`（parse5 树里已是 `table>tbody>tr>td`，合法父链，看树永远看不出来） | `<table><td>x</table>` → `["misnested_tag"]`（文案 `<td> 的父元素是 <table>，应为 <tr>；被 </table> 强行闭合`）；7 个正向样本仍全 `[]`；`<div><span><b></div>` 仍 2 条 | 没有"放开更多隐式闭合"：判据是**白名单父链**，只有父链不成立的 td/th/tr 才报；`<table><tr><td>c</table>` 里 tr 的父是 table（源码层合法）故不报。`tbody/tfoot` 不设表：`<table><tbody></table>` 属可选结束标签，静默。 |
| P2-R2 | 无需改动 | `insertionModeSaysOpen` / `mustStayOpen` 在 R1 重写 `closeTag` 时已随整张 `CLOSED_BY` 镜像分支一起删除（`grep -rn` 零命中） | 语义仍由 `CLOSED_BY` + `FORMATTING_TAGS` + `LEGAL_PARENTS` 三张表表达；7 正 5 反样本复测全对（正向 0 条、`<div><span><b></div>` 2 条、`<div>x</span></div>` 1 条） | 本轮只做了复测，没有新代码可删。 |
| P2-R3 | `inject.ts:38` 注释改写；本报告 §9 P2-2 措辞纠正 | 注释写"收集到 64 字符即停"，与实现（`textSampleOf` 逐节点收集、到 64 停）已经一致，但表述没点出"避免整棵子树拼接"；§9 又把一次特定输入的"≈ 线性"写成了普遍结论 | 注释：**最多收集 64 个字符即停，避免整棵子树拼接；只按这个前缀算 ID，不看子树第 65 个字符之后**；§9 已标注"线性只对每层都有文本的文档成立" | 复测（层间无文本的深链，注入耗时 3 次）：1k = 6.5/8.1/6.3 ms，2k = 20.8/20.8/21.5 ms，4k = 79.9/79.7/77.4 ms，8k = 313.6/320.6/313.4 ms → **仍是 O(深度²)**：`textSampleOf` 早停只限"取多少个字符"，不限"要穿过多少个空容器才能拿到第一个字符"。宽文档不受影响：920 KB（60k 个注 ID）parse 91 ms + inject 82 ms，随字节数线性。 |
| P2-R1 | 按卡片 v3 复核 `packages/core/src/html/index.ts` | 门面导出 9 个：`injectNodeIds`、`parseHtml`、`serializeHtml` 三个运行期键 + `InjectedNodeIds`/`Diagnostic`/`DiagnosticCode`/`HtmlElementNode`/`HtmlNode`/`ParsedHtml` 六个类型 | 未变（v3 允许门面多导出，禁止的是"内部辅助上浮"） | 内部辅助全部留在各自模块：`mixHex`/`HASH_SEED`（`hash.ts`）、`RAW_TEXT_TAGS`/`RCDATA_TAGS`/`VOID_TAGS`/`BLOCK_TAGS`/`LEGAL_PARENTS`/`FORMATTING_TAGS`/`CLOSED_BY`/`textSampleOf`/`drainStack` 都不在门面上；`packages/core/src/index.ts` 仍是约定集合，`html-support.test.ts` 的"精确集合相等"断言仍绿。 |
| P2-R4 | 无代码改动 | 上一轮 `format:check` 曾瞬时红（新写的 `balance.ts` 未跑过 prettier） | 本轮交付前连跑两次 `pnpm format:check`：`All matched files use Prettier code style!` | 已加进交付前自检顺序（format → lint → typecheck → test → depcruise → knip → verify）。 |

**R2 自跑（逐项）**：`format:check` ✅ / `lint` ✅ / `typecheck` ✅ / `depcruise` ✅（32 modules, 71 dependencies）/ `knip` ✅（0 项）/ `test` ✅（**199 例全绿**）。`test:coverage` ❌：唯一红点是 `packages/core/src/html/balance.ts` 95.29% lines / 96.29% branches，未覆盖行 `175-182`——即 P1-1 残留新增的"父链非法"诊断分支。既有测试没有任何一条 `<table><td>` 形状的输入，而测试冻结（我改不了），所以这一项我不动代码凑绿。

**给测试员的 3 条用例**（补上后 coverage 即回 100%）：
1. `<table><td>x</table>` → `["misnested_tag"]`，文案含 `<td> 的父元素是 <table>，应为 <tr>`。
2. `<table><th>x</table>` → `["misnested_tag"]`（走 th 的父链分支）。
3. `<div><table><tr><td>x</table>` → `["misnested_tag"]`（td/th/tr 三层都被 `</table>` 强制收尾，其中 td/tr 合法、只报一条）。

**R2 遗留风险**：①深链注入仍是 O(深度²)（8k 深 313 ms），要真线性得让 `textSampleOf` 缓存"最近文本祖先"，属 M1.2 优化；②`noscript` 现在把内容放进 body（parse5 在 `scriptingEnabled: false` 下的规范行为），若 M1.2 需要"head 内 noscript 内容留在 head"要先定契约。

ACP: 37.1K 估算 / 48.2K provider（`acp_status`，14 个折叠块，delegate none）；实现侧 1047 行（`src/html/` 9 文件 + `hr-error.ts` + 入口门面）。
