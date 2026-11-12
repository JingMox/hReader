# impl-M1.4 · `hr_read_node` 节点读取（实现报告）

- 卡片：`.workflow/cards/M1.4.md`（唯一依据）；基线 `bf34c87`（M1.3，393 例 / 四维 100%）。
- 复用：`serializeHtml`（唯一序列化器）、`parse5` 产物、`src/meta/readMeta`、`src/html/text.ts`。**未复制**任何序列化/解析/归一实现。

## 1. 交付清单

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/core/src/ops/readNode/selector.ts` | 170 | 窄文法逐字符扫描（含 3 行 BNF 头） |
| `packages/core/src/ops/readNode/resolve.ts` | 92 | 单趟先序定位 + 匹配总数（`matches`） |
| `packages/core/src/ops/readNode/shell.ts` | 57 | 外壳判定 + `hr-meta`/`hr-theme` 剔除（迭代复制） |
| `packages/core/src/ops/readNode/truncate.ts` | 160 | 元素边界截断 + 闭合补齐 + 码点安全文本前缀 |
| `packages/core/src/ops/readNode/diagnostics.ts` | 42 | M1.1 诊断子集过滤 + 3 个新码报文 |
| `packages/core/src/ops/readNode/annotations.ts` | 29 | 按 `targetId` 取批注（**不看** status） |
| `packages/core/src/ops/readNode/attrs.ts` | 16 | `attributeOf` / `identifierOf`（`data-hr-id` 优先） |
| `packages/core/src/ops/readNode/constants.ts` | 38 | 默认/硬顶字节、外壳集合、`Selector`/`ReadNodeResult` |
| `packages/core/src/ops/readNode/index.ts` | 62 | `readNode` 编排 |
| `packages/core/src/html/constants.ts` | +3 码 | `ambiguous_selector`/`stripped_shell`/`truncated_output`（含定级） |
| `packages/core/src/hr-error.ts` | +1 码 | `invalid_max_bytes` |
| `packages/core/src/ops/index.ts`、`src/index.ts` | +2/+2 | 两级门面导出 `readNode` + `ReadNodeResult` |

## 2. 选择器 BNF（模块头也留了精简 3 行）

```
selector   := id-form | attr-form | tag-form | child-form
id-form    := "#" id
attr-form  := "[" "data-hr-id" "=" value "]"           ; value 可为 "x" / 'x' / x
tag-form   := name
child-form := name wsp* ">" wsp* name wsp* ":nth-of-type(" n ")"
name       := [A-Za-z][A-Za-z0-9]*
id         := [a-z0-9-]+
n          := [0-9]+ 且 >= 1
wsp        := 空格 / 制表 / 换行
```
`#id` 与 `[data-hr-id="id"]` 走同一条 `{kind:"id"}` 分支（逐字同义）。

## 3. 12+2 个非法输入 → 全部 `HrError.invalid_selector`（实测，含 message）

| 输入 | code | message（`非法选择器（<原因>）：<原文>`） |
| --- | --- | --- |
| `""` | invalid_selector | 空串 |
| `..` | invalid_selector | 标签名应以 ASCII 字母开头 |
| `#a,b` | invalid_selector | id 之后不应再有字符 |
| `*` | invalid_selector | 标签名应以 ASCII 字母开头 |
| `a:hover` | invalid_selector | 只支持 #id / [data-hr-id="x"] / tag / tag > tag:nth-of-type(n) |
| `a b` | invalid_selector | 同上（不支持后代空格） |
| `a > ` | invalid_selector | 标签名应以 ASCII 字母开头 |
| `a > p:nth-of-type(0)` | invalid_selector | 序号必须 ≥1 |
| `a > p:nth-of-type(-2)` | invalid_selector | 此处应为序号 |
| `a > p:nth-of-type(1.5)` | invalid_selector | 缺少 `)` |
| `a > p:nth-of-type(` | invalid_selector | 此处应为序号 |
| `[data-hr-id="x"` | invalid_selector | 缺少 `]` |
| `a[href]` | invalid_selector | 只支持 #id / … / tag > tag:nth-of-type(n) |
| `a > p > p` | invalid_selector | 只支持 `:nth-of-type(n)` |

## 4. 四种形态正例（实测输出）

| 选择器 | 输出（节选） |
| --- | --- |
| `#s1` | `<section data-hr-id="s1"><p data-hr-id="p1">one</p><p data-hr-id="p2">two</p></section>` |
| `#p2` | `<p data-hr-id="p2">two</p>` |
| `[data-hr-id="s2"]` | `<section data-hr-id="s2"><p data-hr-id="p3">three</p></section>` |
| `[data-hr-id=p3]`（无引号） | `<p data-hr-id="p3">three</p>` |
| `p`（多命中） | 文档序第一个 `<p data-hr-id="p1">` + `ambiguous_selector: 选择器 "p" 命中 3 个元素，已取文档顺序第一个` |
| `section`（多命中） | `<section data-hr-id="s1">…` + `ambiguous_selector`（命中 2） |
| `article > section:nth-of-type(1)` | `<section data-hr-id="s1">…` |
| `article > section:nth-of-type(2)` | `<section data-hr-id="s2">…` |
| `article > section:nth-of-type(3)`（越界） | `HrError(node_not_found)` |

## 5. 外壳防护（实测全 `node_not_allowed`）

`html` / `body` / `head` / `script` / `style` / `template` / `#hr-meta`（`<script id="hr-meta">`）→ `HrError(node_not_allowed)`。
读 `<article>`：输出中 `<script` 与 `<style` 均不存在，诊断 `stripped_shell: 已剔除 2 处页面外壳锚点（hr-meta / hr-theme）`。

## 6. 截断（实测）

| 场景 | 结果 |
| --- | --- |
| 全文 120035 B，`maxBytes=120034` | 输出 120032 B，`truncated=true`，开标签保留，`parseHtml` 回读 0 诊断 |
| `maxBytes=120035` | 输出 120035 B，`truncated=false` |
| `maxBytes=120036` | 输出 120035 B，`truncated=false`（不补空） |
| emoji（`"😀"×20000`），`maxBytes=65539` | 输出 65538 B，末尾无半截代理对，回读 0 诊断，`truncated=true` |
| 单元素本身超限（`maxBytes=40`） | `<section data-hr-id="s1">中</section>` + `truncated_output: 原 120035 字节 / 上限 40 字节 / 已保留 3 个节点` |
| 中文 40000 字 | 按码点二分试探取前缀，不切坏字符 |

截断策略：**先排队闭合标签、把它们的字节从预算里预留**（`Emitter.reserved`），因此任何时刻写出的前缀都仍能补齐成可解析片段；元素批次级截断，文本则取码点前缀。

## 7. 字节口径（`byteLength` 调用纪律）

- 一处 `TextEncoder` 实例；每个字符串**只编码一次**（`utf8Length` 内部即算即弃，不缓存全文）。
- 文本前缀用**二分探测**（`prefixThatFits`）：120 KB 文本约 17 次编码，而不是逐字符重算。
- 未对"整个结果"反复调 `Buffer.byteLength`：`fits()` 每写一个 chunk 只量它自己。

## 8. 批注（status 不过滤，与 M1.3 的刻意差异）

实测 `hr-meta` 三条批注（`an1=resolved`、`an2=pending_ai`、`an3` 指向别的 id），读 `#h` 得：
`[{"id":"an1","targetId":"h","comment":"keep"},{"id":"an2","targetId":"h","comment":"wait"}]` —— `resolved` 也返回，顺序按 `hr-meta` 数组顺序，不排序；`an3` 因 `targetId` 不符被排除。
差异说明：`buildOutline` 只收 `status === "pending_ai"`（待办视角）；`readNode` 要复原上下文，收全部状态（契约 4 明示）。

## 9. 诊断子集（M1.1 段 + 本卡 3 码）

- 只保留 `path` 等于目标路径或以 `目标路径>` 开头的 M1.1 诊断：实测 `#s2` → `[]`，`article` → `invalid_hr_id`（那条在另一棵子树里）。
- `ambiguous_selector`（多命中）/ `stripped_shell`（剔除数）/ `truncated_output`（原 N / 上限 M / 保留 K）按此序追加在 M1.1 段之后，跨段不做全局排序。

## 10. 性能（3 次中位，实测）

- 文档 1.40 MB（1404504 B，6000 个 `<section>`）：读 64 KB 子树 **3 ms**（契约 ≤ 60 ms）。
- 同一文档读 `<article>`（截断到 65536）：**13 ms**（契约 ≤ 120 ms），输出 65497 B，`truncated_output` 保留 288 节点。
- 确定性：同输入两次 `html` 逐字节相等。

## 11. `pnpm verify` 状态

| 门 | 状态 | 说明 |
| --- | --- | --- |
| `format:check` | ✅ | Prettier 全绿 |
| `lint` | ✅ | 0 问题 |
| `typecheck` | ❌ 1 行（测试侧） | `packages/core/tests/hr-error.test.ts:9` 的 `Record<HrErrorCode, true>` 缺 `invalid_max_bytes`；`verify` 在此中止 |
| `depcruise` | ✅（单跑） | 72 模块 / 208 依赖，无违规 |
| `knip` | ✅（单跑） | 无未用导出/依赖 |
| `test` | ❌ 2 例（测试侧） | `tests/entry-points.test.ts`、`tests/outline-surface.test.ts` 的导出面断言未含 `readNode`（本卡 Scope 要求必须导出）。其余 391 例通过 |
| `test:coverage` | ❌ | `readNode/**` 无测试，覆盖率红属预期（G3 补） |

## 12. 给测试员的 5 条建议

1. 先补两处存量断言：`hr-error.test.ts` 增 `invalid_max_bytes: true`；`entry-points.test.ts` 与 `outline-surface.test.ts` 的导出清单加 `readNode` / `ReadNodeResult`。
2. 选择器打点：`#id` 与 `[data-hr-id="x"]`/`'x'`/`x` 三引号变体**必须同义**；`article > section:nth-of-type(3)` 越界应 `node_not_found`（不是 invalid_selector）。
3. 截断最容易错：`maxBytes=全量-1` 必须丢一个完整字符并补闭合；单元素超限时输出只剩开标签+字符+闭合标签；用 `parseHtml` 回读断言"0 诊断"，别只比字符串。
4. 外壳：`#hr-meta` 要 `node_not_allowed`；读 `article` 要 `stripped_shell` 且输出里搜不到 `<script`；`template` 同样不可读。
5. 批注：同一 doc 里放 `resolved` 与 `pending_ai` 各一条并断言**两条都返回**（这是与 `buildOutline` 的刻意差异），再放一条 targetId 不符的断言被排除。

## R1 · 审计返工（P0-1 + P1-1/P1-2/P1-3 + P2 #14–#18）

| 项 | 落实位置 | 证据 |
| --- | --- | --- |
| **P0-1** 空内容 | `truncate.ts:loadChildren` 子节点为元素时压 `{kind:"open"}`（原来一律 `leaf`，子树成原子被整块丢弃） | 读 `<article>`（内含 120KB 段落，`maxBytes=65536`）：**改前 37 字节** `<article data-hr-id="root"></article>`；**改后 65535 字节** `<article data-hr-id="root"><p data-hr-id="p1">段落段落…`。原 `openLeaf` 前缀分支现可达：`#p1` + `maxBytes=60` → 59 字节 `<p data-hr-id="p1">段落段落段落段落段落段落</p>` |
| **P1-2** 预算低于可行最小值 | `truncate.ts` 开标签放不下时抛 `HrError("invalid_max_bytes")`，报文给最小可行值 | `maxBytes ∈ {1,24,25,26,34,35,36}` → 全部 `invalid_max_bytes: maxBytes 过小：<article> 至少需要 37 字节，收到 N`；`37`→37B 空壳（截断）、`38`→37B，无超预算、无空串 |
| **P1-1** 路径唯一口径 | 新建 `packages/core/src/html/path.ts`（`pathSegment(tag,index)`/`joinPath`，口径 = 父 `children` 的**原始下标**）；`inject.ts` 与 `resolve.ts` 都调它，`resolve.ts` 自己的同标签算法删除 | 同一文档两层给同一串：`html[0]>body[1]>article[0]>section[0]>p[0]`（`inject` 诊断 path 与 `readNode` 的 `withinSubtree` 前缀一致）。栅栏实测：两个非法 id 分别在 `section[0]`/`section[1]` 下，读 `#mid` 只回 `section[0]` 那条、读 `article` 回 2 条 |
| **P1-3** 子树内 script/style/template | `shell.ts:isShellContent = BLOCKED_CONTENT_TAGS.has(tag)`（删掉两个永远为假的 `script#hr-meta`/`style#hr-theme` 臂） | 4 个外壳内容（`<script>alert(1)</script>`、`<style>`、`<template>`、`<script id="hr-meta">`）全部不进输出：输出 62 字节仅 `<article data-hr-id="root"><h2 data-hr-id="h">t</h2></article>` + `stripped_shell: 已剔除 4 处…` |
| **P2 #14** `#id` 不再回退原生 id | `attrs.ts:identifierOf` 只读 `data-hr-id` | `#native` 命中 `data-hr-id="native"` 而非 `id="native"`；只有原生 id 时 → `HrError(node_not_found)` |
| **P2 #15** 入口形状校验 | `index.ts:assertParsedHtml` → `HrError("invalid_input")`（新码已入 `HrErrorCode`） | `"str"` / `null` / `{root:"x"}` / `injectNodeIds(...)` 返回值 4 种输入全部 `invalid_input`，无 `TypeError` |
| **P2 #16** meta 字段名写错 | `annotations.ts:unknownFields` + `metaFieldDiagnostics`（顶层键只接受 `annotations`） | `{"annotation":[]}` → `invalid_meta: hr-meta 含未知字段 "annotation"（只接受 "annotations"）`；`{"annotations":[],"extra":1}` → 同样报 `extra`；合法 JSON 不报 |
| **P2 #17** 截断报文 | `diagnostics.ts:truncatedOutput` 已含"（序列化后）" | `输出已截断：原 N 字节（序列化后）/ 上限 M 字节 / 已保留 K 个节点` |
| **P2 #18** BNF 大小写 | `selector.ts` 头注释注明"标签名与属性名比较不分大小写" | 代码比较前统一小写 |

### R1 后 `pnpm verify` 实测

| 门 | 状态 |
| --- | --- |
| `format:check` | ✅ |
| `lint` | ✅（`max-lines-per-function` 先红过，已抽 `ownDiagnosticsOf` 收敛；`max-params` 用单对象参数解） |
| `typecheck` | ❌ 1 行（测试侧）：`tests/hr-error.test.ts:9` 的 `Record<HrErrorCode,true>` 缺 `invalid_input` |
| `depcruise` | ✅ 77 模块 / 229 依赖 |
| `knip` | ✅ exit 0 |
| `test` | ✅ **496/496**（测试员已按 v2 口径翻牌；期间见过 1 次 perf 用例偶发红，连跑两次均绿） |
| `test:coverage` | ❌ 3 文件：`readNode/annotations.ts`（`invalid_meta` 字段路径未测）、`readNode/index.ts`（`invalid_input` 守卫未测）、`readNode/truncate.ts`（注释节点装不下那条分支）——都是本轮**新增行为**的测试缺口，留 G3 |

### R1 性能（3 次中位）

1.55MB 文档（`1551823` 字节，6000 个 section）：读 64KB 子树 **3/4/6 ms（中位 4）**；读 `<article>` 截断到 65536 → **12/14/14 ms（中位 14）**，输出 65519 字节。

### R1 遗留（请协调者定）

- `stripped_shell` 报文仍写"已剔除 N 处页面外壳锚点（hr-meta / hr-theme）"，但计数已含子树内普通 `script`/`style`/`template`（#13）。测试逐字比对该句，所以我没改文案；要么改文案+改 2 条断言，要么保留现状。
- `docs/02` §3.1 的 `html[0]>body[0]>…` 示例是旧的同标签口径，v2 #12 后真实路径为 `html[0]>body[1]>…`，文档需同步。

## R2 · 审计收尾（3 项）

| 项 | 位置 | 改动 | 实测 |
| --- | --- | --- | --- |
| P1-R1 | `annotations.ts:18` `KNOWN_FIELDS` | 白名单收 `version`/`style`/`annotations`，报文点名字段并列出三者；只校验顶层键名、不校验值形状 | 正典 `{"version":1,"style":{...},"annotations":[...]}` → 诊断 **0 条**；`{"pending_annotations":[]}` → `invalid_meta: hr-meta 含未知字段 "pending_annotations"（只接受 "version" / "style" / "annotations"）` |
| P1-R2 | `truncate.ts:openLeaf` | 删掉恒真三元臂：`prefixThatFits` 改返回 `{ text, bytes }`，非空即写出并 `return "partial"` | `truncate.ts` 分支覆盖 100%（此前 98.27%），全仓四维 100% |
| P2-R2 | `diagnostics.ts:strippedShell` | 文案改为 `已剔除 N 处不可读内容（页面外壳 / 可执行容器）` | 审计样本（`script#hr-meta` + `style#hr-theme` + 内联 `style`）→ `已剔除 3 处…`，输出无 `<script`/`<style` |
| v3 #23 | `index.ts` `readNode` 上方 | 一行前置条件注释：`#id`/`[data-hr-id]` 需要 `injectNodeIds(...).parsed` | 未新增其它注释 |

**P0-1 回归自查（本轮重跑）**：`<article data-hr-id="root"><p data-hr-id="huge">30000 汉字</p></article>` + `maxBytes=65536` → `bytes=65534`、`truncated=true`、`hasText=true`、诊断 `truncated_output`。（首次改 P1-R2 时把"写出前缀"一并删了，回归成 62 字节空壳；改为由 `prefixThatFits` 返回序列化结果与字节数后修好。）

### `pnpm verify` 现状

`format:check`/`lint`/`typecheck` 绿；`test` 红在 **3 条测试侧逐字文案断言**（未动 tests，需测试员同步）：

1. `packages/core/tests/read-node-shell.test.ts`「should report stripped_shell with the real count in one diagnostic」— 旧文案 `已剔除 3 处页面外壳锚点（hr-meta / hr-theme）`。
2. `packages/core/tests/read-node-shell.test.ts`「should strip a nested anchor deep inside a subtree too」— 旧文案 `已剔除 1 处…`。
3. `packages/core/tests/read-node.test.ts:73`「should flag an unknown key in hr-meta…」— 旧报文 `（只接受 "annotations"）`，v3 #20 要求列出三者。

覆盖率单跑（`--coverage.reportOnFailure=true`）：**All files 100 / 100 / 100 / 100**，506 例中 503 过；`depcruise`/`knip` 因 `verify` 在 `test` 中止未执行（上一轮单跑皆绿，本轮无新模块）。



ACP: 87.4K 估算 / 119.8K provider（`acp_status`，33 个折叠块，delegate none）；实现侧 `ops/readNode/` 9 文件 + `html/path.ts` 1 文件 + 码表 5 行 + 门面 4 行。
