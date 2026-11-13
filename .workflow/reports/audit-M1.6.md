G2: FAIL — 1×P0 / 5×P1 / 9×P2

# G2 审计 · M1.6（风格引擎 + Atelier Editorial 主题 + `hr_apply_style`）

## 0. 审了什么、怎么跑

| | |
| --- | --- |
| 审 | `packages/core/src/style/**`（14 文件 1151 行，含 3 个预设）、`styles/atelier-editorial/theme.css`（244 行）、`packages/core/src/hr-error.ts`（+4 码）、`packages/core/src/index.ts`（导出面） |
| 不审 | `packages/core/tests/**`（测试员独占）、`src/io/**`（M1.5，另有 G2-R3 签字） |
| 依据 | `.workflow/cards/M1.6.md`（含 §6 v2 裁定 #11–#14）、`docs/02` §3.2、`docs/03` §11、`docs/04` |
| 跑法 | `node v24.15.0` + `packages/core/fixtures/load-src.mjs` **直接加载 `src`**；探针 `/tmp/m16a/{a-spec,a2-min,b-tone,b2-tone,c-css,d-apply,d2-head,e-lint,f-load,g-applyfile,h-contrast}.mjs` |
| 判据 | 只认实测输出。**没有**把 `pnpm verify` 当判据（门禁绿 ≠ 行为对：#P1-2 的 D6 场景 `changed:true` 且门禁全绿） |

---

## 1. P0（1 条）

### P0-1 无显式 `<head>` 时主题被写到文件字节 0，`<!doctype html>` 被挤走 → 整篇退化成 quirks mode

- 位置：`packages/core/src/style/apply.ts:51-57`（`spanOf` 守卫）+ `:72-83`（`insertInto`）；根因在上游 `packages/core/src/html/parse.ts:43,52-57,169`
- 复现：`node /tmp/m16a/d2-head.mjs`、`node /tmp/m16a/g-applyfile.mjs`（G3 是落盘路径）

```
── 纯片段
  首个标签="<style id=\"hr-theme\">"  doctype 仍居首=false
  产物前 80 字: "<style id=\"hr-theme\">body{color:#111}</style><article data-hr-id=\"a1\"><p>x</p></"

== 合成 head 的 span ==
  <html> span={"start":0,"end":0,"innerStart":0,"innerEnd":0}
  <head> span={"start":0,"end":0,"innerStart":0,"innerEnd":0}
```

落盘（`applyStyle`，不是纯函数）：

```
── G3 无 head 的片段 + doctype
  1st changed=true bytes=146 sha 862c3f81016a→249498343880
  前 90 字节: "<style id=\"hr-theme\">:root{--hr-bg:#faf8f5}\n/* Atelier */\nbody{color:#1b1a17}\n</style><!do"
```

- 机制：
  1. `parse.ts:52-57` 的 `sourceSpanOf` 对**没有** `sourceCodeLocation` 的元素返回 `ZERO_SPAN`（`:43`），不返回 `undefined`；
  2. `apply.ts:53` 的 `if (span === undefined) throw …` 因此**永远不触发**——`<head>` 缺失时 parse5 会**合成**一个 head，它拿到全零 span，`apply.ts:80-82` 就把 `styleBlock` 插在 `innerEnd = 0`；
  3. 于是 `<style>` 落在 `<!doctype html>` **之前**：doctype 不再位于文档首，parse5/浏览器判定为 parse error 并**忽略 doctype** → 文档进入 **quirks mode**（盒模型、行高、表格与图片尺寸全部改变）。
- 为什么是 P0：
  - 它破坏的是**文档本身**（prologue 被改写），不是"主题没生效"这种可重试的问题；
  - 走的是 AC7.4 要求的落盘 API，第一次调用就写坏文件，第二次调用是幂等的（`changed:false`）——**坏状态被固化**，用户不会收到任何 `HrError`；
  - AC7.4 写的是"没有 `<style id="hr-theme">` 时注入到 `<head>` 末尾（位置确定）"，实测把 `<style>` 放在 `<html>` 之外，正好是反例。
- 编写员自证里"无 head 注入"那条被测成了 ✅（`d2-head` 的 D10、`g-applyfile` 的 G3 都显示 `changed=true`），说明自测只断言了"注入发生了"，没断言"doctype 还在第一位 / `<style>` 在 head 内"。
- 建议修法（二选一，都要有测试锁）：
  - `apply.ts:51-57` 把守卫改成 `if (span === undefined || (span.start === 0 && span.end === 0))`，让合成 head 走 `apply.ts:74-79` 已有的 `invalid_html` 分支（该分支当前是**死代码**）；
  - 或者退一步：`insertInto` 只在 `head.span.innerEnd > 0` 且位置落在一个"真实标签之后"时插入，否则报 `invalid_html`。
  - 无论选哪个，测试必须断言：`patched.startsWith("<!doctype html>")` 且 `patched.indexOf("<style id=\"hr-theme\">") > patched.indexOf("<head")`。

---

## 2. P1（5 条）

### P1-1 CSS 转义绕过静态防线，且 `css.ts:36` 的注释声称"也会被拒"（注释与代码相反）

- 位置：`packages/core/src/style/css.ts:7-12`（`FORBIDDEN`）、`:15-19`（`EXTERNAL_URL`/`SCHEME`）、`:21-34`（`isLocalUrl`/`urlArgumentsOf`）；被证伪的注释在 `:36`
- 复现：`node /tmp/m16a/c-css.mjs`

```
== C2 CSS 转义（注释声称会被拒）==
  ⚠️  url(\68 ttp://evil/x)                          → ACCEPT
  ⚠️  url(\2f\2f evil/x)                             → ACCEPT
  ⚠️  url(java\73 cript:alert(1))                    → ACCEPT
  ⚠️  @im\70 ort "x.css"                             → ACCEPT
  ⚠️  @IMPORT 转义 + 外链                                → ACCEPT
```

- 机制：`FORBIDDEN` 与 `URL_ARGUMENT` 都按**字面**匹配；CSS 规范允许转义序列（`\68` = `h`、`\73` = `s`、`\70` = `p`、`\2f` = `/`）。浏览器/渲染器在解析 CSS 时**先解转义**，`\68 ttp://evil/x` 等价于 `http://evil/x`。
- 为什么是 P1 而不是 P2：AC7.5/裁定 #9 的整条防线就是"离线自足"，绕过它意味着**用户目录里的 `theme.css` 能引入外部资源或 `javascript:`**；而 `css.ts:36` 的注释明确写着"CSS 转义的 `\68 ttp` 也会被拒"——这句是**假的**，属于"注释自我认证"，正是本仓库 P1 的常见来源。
- 建议：`url()` 参数在判定前先做一次 CSS 反转义（`/\\([0-9a-f]{1,6})\s?/giu` → `String.fromCodePoint(parseInt(h,16))`，以及 `\\（任意字符）` 的单字符转义），反转义**之后**再套 `isLocalUrl`；`@import` 同样在反转义后的串上匹配。另外把 `:36` 的注释改成"反转义后再判定"。

### P1-2 两个 `<style id="hr-theme">` 时只替换第一个，**后面那个旧的赢**（级联后者优先）——主题"应用成功"但页面仍是旧主题

- 位置：`packages/core/src/style/apply.ts:64-69`（`replaceExisting`）、`:86-93`（`replaceTheme` 只处理 `firstElementOf` 的一个）
- 复现：`node /tmp/m16a/d-apply.mjs`（D6）

```
── D6 两个 style 块（重复）
  changed=true  lenBefore=139 lenAfter=172 首个差异下标=59
  产物: "...<head><style id=\"hr-theme\">:root{--hr-bg:#fff}\nbody{color:#111}\n</style></head><body><style id=\"hr-theme\">OLD2</style><p>x</p></body>..."
  二次应用 changed=false 字节相同=true
```

- 机制：`<head>` 里的那块被换成新 CSS，`<body>` 里那块原样保留；两份选择器同优先级（都是 `:root`/`body` 级），**DOM 顺序靠后者胜** → 生效的是 `OLD2`。
- 为什么是 P1：`changed:true` + 落盘成功 + 幂等，**所有信号都说成功**，而用户看到的还是旧主题；没有任何错误、诊断或返回值能让人察觉。
- 建议：`replaceTheme` 应当先收集**全部** `isThemeBlock` 命中，替换第一个、**删除其余**（删除走 span 切片，同样保证块外字节不变）；或者命中数 >1 时抛 `invalid_html`（"文档里有多个主题锚点，先清理"）。无论哪种，测试要断言"替换后文档里 `id="hr-theme"` 只剩 1 个"。

### P1-3 `loadStyle` 能加载的风格，`applyStyle` 说 `unknown_style`（两个解析口径不一致）

- 位置：`packages/core/src/style/theme.ts:18-33`（`themeCandidates` 只查 `~/.hreader/styles/<id>/theme.css` 与 `<repo>/styles/<id>/theme.css`）vs `packages/core/src/style/load.ts:32-41,51`（`themePathOf` 会优先返回**风格自己目录**里的 `theme.css`，即项目 `.hreader/theme.css`）
- 复现：`node /tmp/m16a/f-load.mjs`（F2）+ `node /tmp/m16a/g-applyfile.mjs`（G5/G5b）

```
✅ loadStyle({id:'proj-style'}) → {"source":"project","themePath":"PROJ/.hreader/theme.css"}

── G5 视觉 id 指向项目风格（有自有 theme.css）
  ❌ unknown_style: 找不到视觉主题：proj-style（已查用户 ~/.hreader/styles 与仓库 styles/）
── G5b 同上，项目风格就位后
  ❌ unknown_style: 找不到视觉主题：proj-style（已查用户 ~/.hreader/styles 与仓库 styles/）
```

- 机制：裁定 #12 把 `applyStyle` 定成"`{ workspace, file, visualId }`"，`applyFile.ts:34` 直接 `loadThemeCss(input.visualId, deps)`，而 `loadThemeCss` → `resolveThemePath` **只**接受"主题 id"，完全不看 `LoadStyleInput`/`LoadedStyle.themePath`。于是"系统刚加载成功的风格"没有一条能送到 `applyStyle` 的路：项目级 `.hreader/theme.css`、以及 `inherits_visual` 的解析结果（`load.ts:40`）都进不去。
- 为什么是 P1：AC7.4 的入口在真实链路里不可达——MCP 层只能把 `visualId` 当目录名去猜，项目自定义主题永远应用不上，且报的是 `unknown_style`（"四个来源都找不到"），会把人引向"我是不是 id 写错了"。
- 建议：`ApplyStyleInput` 增加可选 `themePath`（或让 `applyStyle` 接受 `LoadedStyle`），`applyFile.ts:34` 改成"有 path 用 path，否则 `resolveThemePath`"；`themeCandidates` 至少加上 `join(deps.projectRoot, ".hreader", THEME_FILE)`。裁定 #12 只要求"不出现第二条**写入**路径"，多一条**读取**路径不违约。

### P1-4 裁定 #5 的缺省值不可达：`sentence_rhythm`/`vocabulary` 整块省略 → `invalid_style`；显式 `style: ""`、`forbidden: []` 也被拒

- 位置：`packages/core/src/style/spec.ts:110-115`（`recordAt` → `recordOf(undefined)` 抛错）、`:116-124`（`nonEmpty` 拒绝空串）、`:126-139`（`optionalTextOf` 走 `nonEmpty`）、`:141-151`（`listOf` 拒绝空列表）、`:173-186`（`rhythmOf`/`vocabularyOf`）
- 复现：`node /tmp/m16a/a2-min.mjs`、`node /tmp/m16a/a-spec.mjs`（A5/A6）

```
❌ sentence_rhythm 省略 + vocabulary: {} → s.yaml.language_style.sentence_rhythm：必须是映射（YAML 的 key: value 结构）
❌ sentence_rhythm: {} + vocabulary 省略 → s.yaml.language_style.vocabulary：必须是映射（YAML 的 key: value 结构）
✅ sentence_rhythm: {} + vocabulary: {} → rhythm={"maxParagraphSentences":3,"style":""} vocab={"forbidden":[],"recommended":[]}
❌ style: "" → s.yaml.language_style.sentence_rhythm.style：必须是非空字符串
❌ forbidden: [] → s.yaml.language_style.vocabulary.forbidden：必须是非空字符串或非空字符串列表
```

- 机制：缺省机器（`DEFAULT_MAX_SENTENCES`、`optionalTextOf(…, "")`、`listOrEmptyOf(…, [])`）全都存在，但**父块本身是必填**，所以这些 fallback 只有写 `sentence_rhythm: {}`（空映射）才生效——这是一条谁也不会想到的写法。
- 为什么是 P1：裁定 #5 明写"`sentence_rhythm` 缺省：`max_paragraph_sentences: 3`、`style: ""`（空串表示"不约束"）"。实测：
  - 省略 `sentence_rhythm` 报错（缺省被当成错误）；
  - 显式写 `style: ""` 报错（**卡片钦定的哨兵值在输入侧非法**）；
  - `forbidden: []` 报错，但省略 `forbidden` 却是合法的 `[]`——同一语义两种写法一对一错。
  用户按卡片文档写，一半的写法会被拒；这条不影响安全，但它把"文档说的"变成"文档说的不算"。
- 建议：`recordAt` 换成"可选映射，缺省则用空映射"（`mapping[key] === undefined ? {} : recordOf(...)`）；`optionalTextOf` 允许空串；`listOf` 允许 `[]`（把"至少一项"的要求只留给 `narrative_rules`，并在报文里写清"叙事规则至少要一条"）。

### P1-5 未知键报文里的"这一层的合法键"永远是**顶层**键集；嵌套报文因此误导，且每层的 `assertKnownKeys` 是死代码

- 位置：`packages/core/src/style/spec.ts:76-95`（`walkUnknown` 一次递归到底、把各层未知键塞进同一个数组）、`:97-103`（`assertKnownKeys` 用**本次调用**的 `schema.keys` 拼合法键集）、`:197,204,235`（三个层级的调用）
- 复现：`node /tmp/m16a/a-spec.mjs`（A1/A2）

```
❌ top.unknown + language_style.unknown + rhythm.unknown → invalid_style
   …：未知键 X.language_style.sentence_rhythm.bogus_rhythm、X.language_style.bogus_lang、X.bogus_top；
      这一层的合法键：id、name、description、inherits_visual、language_style
❌ examples[0].note → …：未知键 X.language_style.examples[0].note；
      这一层的合法键：id、name、description、inherits_visual、language_style
```

- 机制：`:235` 的顶层调用把嵌套未知键全收进 `unknown`，于是**永远在顶层抛出**，`:103` 的 `legal` 自然取顶层键集；`:197`/`:204` 的两次 `assertKnownKeys` 对未知键**永不可达**（顶层已经抛了）。合法键集与报错的层级不匹配——用户看到 `sentence_rhythm.bogus_rhythm` 被报，却被告知合法键是 `id、name、description、inherits_visual、language_style`，照着改只会再错一次。
- 为什么是 P1：裁定 #4 要求"报文必须列出**全部**未知字段**与合法字段集**"。未知键 ✅ 完整（这点通过），合法键集 ❌ 错层。这是"错误提示把人带偏"，且它靠的是 `walkUnknown` 的递归特性，读代码时极易误判为正确。
- 建议：`walkUnknown` 收 `unknown: string[]` 时同时收 `Record<string, string[]>`（路径 → 该层 schema 键集），或者干脆按层抛（让每个 `assertKnownKeys` 先跑本层的 `keys` 再递归），并把 `legal` 换成 `按层分组` 的输出；顺手删掉那两处死代码或改用"逐层"语义。

---

## 3. P2（9 条，按危害降序）

| # | 位置 | 现象与实测 | 为什么是 P2 |
| --- | --- | --- | --- |
| P2-1 | `lint.ts:108-121` | 5 块 ×150 命中 → 全局 `hits=500`、`truncated=true`（探针 `e-lint.mjs` E4）。上限只按**单块** 100 生效，块数线性放大 | AC6.4 的字面（"单块超过 100"）满足了，目的句"不得无限增长"没满足；工具响应可到 MB 级。建议补一条全局上限（如 500）并在 `LintReport` 里复用 `truncated` |
| P2-2 | `contracts.ts:46` vs 卡 `M1.6.md:62` | `offset` 是 **UTF-16 码元**下标：`"😀😀赋能"` → `offset=4`（码点下标是 2）、`"x😀赋能"` → `offset=3`（码点 2）。另外 `offset + word.length` 不能可靠切出命中（零宽：`"赋\u200b能"` 切片得 `"赋\u200b"`；连字：`ﬁ` 命中 `fi`） | 代码与 `contracts.ts:46` 自洽且有文档，但卡片写的是"字符偏移"，两边措辞需要统一；`slice(offset, offset+len)` 这种常规用法会错，建议在 `LintHit` 上补一句"命中终点不保证 `offset+word.length`" |
| P2-3 | `css.ts:7-9` | `/* @import url(x) */`（纯注释）→ **REJECT**（`c-css.mjs` C1 第 6 行）；而转义后的真 `@import` 放行（P1-1） | 编辑期把 `@import` 注释掉是常规调试手法，被误拒；与 P1-1 正好相反——真威胁放行、无害的拒了。建议先剥注释再匹配 |
| P2-4 | `apply.ts:17-22,24-25` | `id="HR-THEME"`（大写）不匹配 → 不替换而是**再插一块**，旧块留在 `<head>`（`d-apply.mjs` D7：`<style id="HR-THEME">OLD</style><style id="hr-theme">NEW</style>`） | 本次因为新块在后、级联新胜，视觉结果对；但文档里留下两块同义锚点，与 P1-2 的"多锚点"问题同源。建议 `idOf` 用 `name.toLowerCase() === "id"` + 值大小写敏感比较，并在注释里写清"锚点 id 大小写敏感" |
| P2-5 | `resource.ts:50-57` | `existsOf` 吞掉**所有**异常（不只 ENOENT）：`~/.hreader/styles/x/theme.css` 因权限读不了时，`resolveThemePath` 一路到底报 `unknown_style`（`theme.ts:29-32`），不是 `style_io_failure` | 卡片 §3 特意把两者分开（"这是**风格资源**失败"）。建议 `catch (error) { if (isMissing(error)) return false; throw styleIo("探测风格资源", path, error) }`，与本文件 `:37-48` 的口径一致 |
| P2-6 | `lint.ts:39-42` | 注释称"NFKC 在本表里都是等长替换"；实测 `ﬁ`→`fi` 是**变长**（`e-lint.mjs` E1 第 8 行 `hits=1 offset=0`） | 代码是对的（`source` 映射就是为变长准备的），注释是错的。删掉"等长替换"这半句即可，否则后来者会以为 `source` 冗余 |
| P2-7 | `load.ts:17-25,29` | 同一个 `./resource` 被 import 两次（第二次只有 `THEME_FILE`） | 纯风格问题，但 `knip --strict`/人工复核都会读到，合并即可 |
| P2-8 | `node.ts:9-10` | `REPO_STYLES = fileURLToPath(new URL("../../../../styles/", import.meta.url))`：`src/style/` 与 `dist/style/` 深度相同都成立；但作为 npm 依赖安装后，`../../../../styles` 指向的是**使用者**的目录树 | 只要不从 npm 消费就没事；若将来发布，内置主题会"找不到"，且报错是 `unknown_style`。建议构建时把 `styles/` 拷进包内并用固定相对路径 |
| P2-9 | `tone.ts:17-23` | `numberedItem` 产出 `1.\n   > r1`（marker 独占一行，内容用 3 空格续行）；CommonMark 能解析成"列表项里套引用块"，但依赖 lazy continuation 规则 | 渲染结果正确（`b-tone.mjs` 已核对产物），但这是"靠解析器宽容"的写法。建议 `1. > r1` 或 `1.\n\n   > r1`，两端都有确定语义 |

补充一条**非缺陷**但需登记的观察：`git status` 显示 `.workflow/cards/M1.6.md` 是 dirty 的；`git diff` 只有 15 行新增（§6 v2 裁定 #11–#14），内容是协调者裁定、不是编写员改卡，**不算越界**。

---

## 4. 独立复算（我自己跑出来的数字）

### 4.1 对比度（AC7.1 要求"用计算脚本证明"）

`sRGB → 相对亮度 → (L1+0.05)/(L2+0.05)`，探针 `h-contrast.mjs`，8 组全部与 `theme.css` 注释声明**逐位吻合**（|差| ≤ 0.01），且全部 ≥ 4.5:1：

| 组合 | 实测 | 注释声明 |
| --- | --- | --- |
| light 正文 `#1b1a17 / #faf8f5` | 16.42:1 | 16.42:1 |
| light 次要 `#6a645d / #faf8f5` | 5.51:1 | 5.51:1 |
| light 强调 `#8a4a22 / #faf8f5` | 6.43:1 | 6.43:1 |
| light 警示 `#a3341a / #faf8f5` | 6.47:1 | 6.47:1 |
| dark 正文 `#e9e6e1 / #121316` | 14.92:1 | 14.92:1 |
| dark 次要 `#9d968c / #121316` | 6.35:1 | 6.35:1 |
| dark 强调 `#e0a97a / #121316` | 8.96:1 | 8.96:1 |
| dark 警示 `#ff9b73 / #121316` | 9.01:1 | 9.01:1 |
| 代码块（继承 `--hr-fg`）浅/深 | 14.76:1 / 14.92:1 | 未声明 |

结构断言（裁定 #10：只做结构）：`data-hr-mode="dark"` / `="light"` / `@media prefers-color-scheme: dark` 三条路径 ✅；`--hr-measure: 68ch` ✅；`--hr-sidebar: 280px` ✅；`@media max-width: 420px` 折叠 ✅；`overflow-wrap` ✅；grid 子项 `min-width: 0` ✅；`@media print` ✅；`page-break-inside: avoid` ✅；无 `@import` ✅；全文 `http(s)://` 出现 **0 次**（AC7.5 比"只允许在注释"更严）✅；7 个组件选择器全部存在且首条声明 ≥ 4 条 ✅。

### 4.2 Lint 偏移与截断

| 输入 | 实测 `offset` | 参考 |
| --- | --- | --- |
| `我们不要说赋能` / 词 `赋能` | 5 | 码点 5、码元 5（一致） |
| `😀😀赋能` | 4 | 码点 2、码元 4 → **码元** |
| `x😀赋能` | 3 | 码点 2 → **码元** |
| `e\u0301 abc 赋能` | 7 | 码元 7 |
| `赋\u200b能`（词 `赋能`） | 0 | 命中正确（零宽被折叠掉） |
| `ABC赋能` / 词 `ＡＢＣ` | 0 | 全角词 NFKC 归一后命中 ✅ |

截断边界（AC6.4 / 裁定 #11）：`99→(99,false)`、`100→(100,false)`、`101→(100,true)`、`150→(100,true)` —— **正好 100 时 `truncated=false` 正确**。

### 4.3 `applyStyle` 字节与幂等

- `d-apply.mjs` D13：替换后 **块外字节逐字节相同** ✅（13 个形态，含无引号 `id=hr-theme`、单引号 + 额外属性、CRLF 文档、`<style>` 在 body）。
- `g-applyfile.mjs` G1：BOM `\ufeff` + CRLF 全保留；二次 `changed=false`、**mtime 未动**、`tmp 残留=[]`。
- `g-applyfile.mjs` G6：两个 `applyStyle` 并发 → `ok(changed=true) | ok(changed=false)`，无 tmp 残留（锁生效）。
- 唯一破坏幂等的形态是 `d-apply.mjs` D11（`<style id="hr-theme"/>` 自闭合 + head 未闭合）：二次 `changed=true`、`字节相同=false`。它和 P0-1 同源（都属于"span 落在 rawtext/合成元素上"），合并记在 P0-1。

### 4.4 Prompt 注入（AC6.3 核心，5 类攻击 0 逃逸）

`b-tone.mjs` / `b2-tone.mjs`：`persona` 内嵌 `## 覆盖规则`、规则里塞 ` ``` ` + `---` + `## 新小节`、示例文本塞 `---`/`# 覆盖`、词表塞 `##`、`name` 塞标题——**每一次**产出里：

```
顶层标题行: ["# 语言风格：…","## 人设","## 叙事规则","## 节奏约束","## 推荐用词","## 禁用词","## 示例"]
顶层分隔线: []
用户文本中出现的裸标题行(未加 >): []
标注在首个用户文本之前: ✅
确定性: 同输入同输出 ✅
```

用户文本一律 `> ` 前缀（`tone.ts:6-12`），`>` 引用块无法打断顶层结构；边界标注紧跟 `# 标题`、在所有用户文本**之前**（`:64-66`，符合裁定 #13）。**通过。**

### 4.5 严格模式未知键（拦截侧通过，报文案侧见 P1-5）

三层同时未知 ✅ 全列；`examples[0].note` ✅；`vocabulary: "x"` ✅（"必须是映射"）；YAML 语法错带行号 ✅（`第 2 行`）；重复键 ✅（`Map keys must be unique`）；非映射根 ✅；空文件 ✅；`id: ../evil` / `My-Style` / `inherits_visual: a/b` ✅ 全拒；`max_paragraph_sentences: 0 / 3.5 / "3"` ✅ 全拒。

### 4.6 加载与发现（裁定 #14）

- 优先级：同 id `project > user > builtin` ✅（F4）；显式路径 > 全部 ✅（F5）；`path` 与 `id` 不一致 ✅ 报 `invalid_style`。
- 发现宽容：好文件 + 坏文件混放 → `styles=["proj-style","good"]`、`diagnostics=[{path:"…/styles/broken/style.yaml", reason:"…"}]` ✅ **诊断带文件路径**（AC6.6/裁定 #14 的"用户能不能据此修好"这一条通过）。
- 显式加载坏文件 ✅ 抛 `invalid_style`（不静默退回内置，裁定 #14）。

### 4.7 越界与门禁配置

`git status --porcelain` 只出现允许项：`src/style/`、`styles/`、`src/hr-error.ts`、`src/index.ts`、`packages/core/package.json`（唯一新增依赖 `yaml: ^2.9.1`，符合裁定 D-2026-11-12-01）、`pnpm-lock.yaml`、`tests/style/` + `tests/hr-error.test.ts`（测试员）、`.workflow/cards/M1.6.md`（协调者 v2 裁定）。**没有** CLI/`diff`/多文档事务；**没有**改 `knip.json` / `eslint.config.*` / `.dependency-cruiser.cjs` / `vitest.config.ts`。`src/style/**` 里 `as`（`as const` 除外）/`!`/`any`/`v8 ignore` 命中 **0 处**。

### 4.8 自证与实测的 4 处偏差（每条都能对上 `impl-M1.6.md` 的行）

| `impl-M1.6.md` | 自证原文（摘要） | 实测 |
| --- | --- | --- |
| `:101` | "7.4 无该块时注入 `<head>` 末尾｜`apply.ts:insertInto`（找 `head` 的 `innerEnd`；**无 `head` 时退到 `html` 开标签后**）" | 代码里没有这条回退：`head` 缺失时 parse5 合成 head → `ZERO_SPAN` → 插在**字节 0**，`<!doctype html>` 被挤到第二行（P0-1）|
| `:104` | "7.5 … 6 条对抗样本（含 `/*x*&#47;@IMPORT`、`uRl( //evil )`、`url(http://…)`）全部 `invalid_theme`" | 6 条全是**字面**形态；CSS 转义 5 例（`url(\68 ttp://…)`、`@im\70 ort`、`url(java\73 cript:…)` 等）**全部放行**（P1-1）|
| `:76` | 冒烟报文原文里就有 `未知键 …language_style.sentence_rhythm.stylee；这一层的合法键：id、name、description、inherits_visual、language_style`，勾 ✅ | 该报文本身就是缺陷证据：嵌套的 `stylee` 报的却是**顶层**合法键集（P1-5）|
| `:80` | "冒烟 #5：`persona` 注入 + **缺省 `sentence_rhythm`** → 产物含 `- 每个自然段最多 3 句。`" | YAML 里省略 `sentence_rhythm` 直接 `invalid_style`（`a2-min`）；能通过的一定是 `sentence_rhythm: {}` 或 TS 直构的 spec（P1-4）|

---

## 5. 结论

- **FAIL**：1×P0（P0-1，落盘改写 doctype）+ 5×P1（CSS 转义绕过、多主题块旧者胜、apply 与 load 口径不一致、裁定 #5 缺省不可达、未知键合法键集错层）。
- 隔离得很干净的部分也值得记：**prompt 注入防线（AC6.3）实测 5 类攻击 0 逃逸**、**主题对比度 8 组逐位吻合**、**块外字节/幂等/BOM+CRLF/锁并发全部通过**。缺陷集中在"span 被当成可信输入"（P0-1、P1-2、P2-4、D11）与"配置语义与卡片措辞不一致"（P1-4、P1-5、P2-2）两处。
- 返工优先级：P0-1 → P1-2 → P1-1 → P1-3 → P1-4 → P1-5。

ACP: 审 `src/style/**` 14 文件 1151 行 + `theme.css` 244 行 + `hr-error.ts`(+4 码) + `index.ts` 导出面；自跑 10 个探针（`/tmp/m16a/{a-spec,a2-min,b-tone,b2-tone,c-css,d-apply,d2-head,e-lint,f-load,g-applyfile,h-contrast}.mjs`）；1×P0（无 head 时 `<style>` 落到字节 0、doctype 被挤走 → quirks mode，落盘可复现，根因 `apply.ts:51-57` 守卫因 `parse.ts:43` 的 `ZERO_SPAN` 成为死代码）、5×P1（CSS 转义 5 例全放行且 `css.ts:36` 注释声称已拒 / 多主题块旧者胜 / `loadStyle` 能载而 `applyStyle` 报 `unknown_style` / 裁定 #5 缺省与 `style:""`、`forbidden:[]` 被拒 / 嵌套未知键的"合法键"恒为顶层集）、9×P2；通过项：注入 5 类 0 逃逸、对比度 8 组逐位吻合、块外字节与 BOM/CRLF 保留、二次 `changed:false` 且 mtime 未动、锁并发无 tmp、截断边界 100 正确、7 选择器与三条深色路径齐备、未改门禁配置。只读审计：未 commit、未改源码/测试，仅写本报告。

---

## G2-R（R1 返工复审：只验上轮 1×P0 + 5×P1 + 3 个"修法引入的新问题"）

G2-R: PASS — 6/6 CLOSED，0 新 P0/P1，1 条 P2-R1（空串契约待裁定）

上一轮我报的 **P0-1 + P1-1..P1-5 全部关闭**，且三条"修法风险"逐条排查后未发现新缺陷。唯一悬而未决的不是 bug，是**契约措辞**：0 字节文件现在抛 `invalid_html`（P2-R1）。

| # | 条目 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | P0-1 doctype 被挤 | **CLOSED** | 7 例带 doctype 全部保首位；插入点由 `prologueEnd`/`html.innerStart` 决定 |
| 2 | P1-1 CSS 转义 | **CLOSED** | 13 拒 / 8 放行 / 21 断言全中；200KB 病态输入 ≤1.1ms |
| 3 | P1-2 多主题块 | **CLOSED** | 去重后与手工期望**逐字节相等**，`removed=1` |
| 4 | P1-3 load/apply 分叉 | **CLOSED** | `proj-foo` 两侧同源；`no-such` 两侧同码 |
| 5 | P1-4 缺省值不可达 | **CLOSED** | 省略 / `{}` / `null` 三形态均得 3 句缺省 |
| 6 | P1-5 合法键错层 | **CLOSED** | 四层同时未知 → 四条报文各带本层键集 |
| 7 | 新死代码 | **无新增** | 新分支全部实测可达（见 §G2-R-7） |

### G2-R-1 · P0-1（doctype 被挤）→ CLOSED

复现：`node /tmp/m16r/r1-p01.mjs`（`/tmp/m16r/r1b-tree.mjs` 看区间）

```
── ① 只有 <body>（带 doctype）        ✅ doctype 保持首位   "<!doctype html><head><style id=\"hr-theme\">body{color:#111}</style></he"
── ② 只有 <div>（带 doctype）         ✅ doctype 保持首位   "<!doctype html><head><style …"
── ③ 空文档（仅 doctype）             ✅ doctype 保持首位   "<!doctype html><head><style …"
── ④ 空字符串                          ⚠️ 抛 invalid_html: 文档没有 <head>：无从注入主题样式块
── ⑤ 纯片段（无 doctype）             — 输入本就无 doctype（未新增）  "<head><style …</head><p>x</p>"
── ⑥ 上轮 P0-1 原样复现               ✅ doctype 保持首位
── ⑦ doctype 前有换行+注释            ✅（`\n<!-- c --><!doctype html><head>…`，注释在 doctype 之前本就合法）
── ⑧ 大写 DOCTYPE                     ✅ doctype 保持首位
── ⑨ doctype + 空 head                ✅ doctype 保持首位

== 带 doctype 的 9 例：被挤走 0；抛错 1（0 字节文件） ==
```

关键点：`apply.ts:125-138` 的 `insertSplices` 已经不再用"元素的 `innerStart` 退化值"，而是三分支——真 `<head>`→`head.innerEnd`；合成 `<head>`+真 `<html>`→`html.innerStart`；连 `<html>` 都合成→`prologueEnd(html)`（`apply.ts:16` 的 `PROLOGUE` 正则吃掉 `\s*` 与前置注释）。上轮 `apply.ts:51-57` 那条因 `ZERO_SPAN` 而死的守卫不再是唯一路径。

**BOM/CRLF 端到端未回归**（这条是新插入点最容易带出的副作用）：`node /tmp/m16r/r5b.mjs`

```
原始长度=78 之后=142
BOM 在第 0 字节=true        doctype 紧随 BOM=true
原文尾部（CRLF 正文）逐字节保留=true   裸 LF 数=0
产物="﻿<!doctype html><head><style id=\"hr-theme\">:root{--hr-bg:#faf8f5}</style></head>\r\n<article data-hr-id=\"a1\"><P CLASS=X>中文</P></article>\r\n"
```

> **P2-R1（待裁定，非阻塞）**：`replaceTheme("")` 抛 `invalid_html`。`parseHtml("")` 的 root **一个子节点都没有**（`/tmp/m16r/r1b-tree.mjs`：`── ""` 下无输出；而 `"<!doctype html>"`、`"<p>x</p>"`、`"<!-- c -->"` 都会合成 `html/head/body`），所以 `apply.ts:127` 的 `!spans.has("head")` **不是死代码**，是空串的唯一出口。字面验收"空文档必须 `startsWith('<!doctype')`"只能靠**新增 doctype/骨架**满足，与 AC7.4"只动 style 块"冲突。建议：卡片里把"空文档"明确成"仅 doctype"（已通过），0 字节文件保持 `invalid_html`，或另开一条"允许为空文件合成骨架"的裁定。

### G2-R-2 · P1-1（CSS 转义绕过）→ CLOSED

复现：`node /tmp/m16r/r2-css.mjs`

```
== 必须拒：转义变形 ==
  ✅ hex-escape http          url(\68 ttp://evil/x)        → REJECT(invalid_theme)
  ✅ hex-escape @import       @im\70 ort url(x)            → REJECT
  ✅ hex-escape url //        u\72l(//evil)                → REJECT
  ✅ @的 hex 转义              \40 import url(x)            → REJECT
  ✅ 大写 + 转义               \40 IMPORT url(x)            → REJECT
  ✅ 全字符转义                url(\68\74\74\70://x)        → REJECT
  ✅ 转义 <                   content:'\3c /style\3e'      → REJECT
  ✅ 大写 HTTPS / 空格 + 混合大小写 / 大写 URL              → REJECT
  ✅ 转义 javascript           url( j\61vascript:…)        → REJECT
== 必须放行（R1 新增：注释里的 @import）==
  ✅ /* @import url(http://x) */  ✅ /* url(//evil) */  ✅ data: URI  ✅ #锚点
  ✅ 相对路径  ✅ 引号包住的相对字体  ✅ url(&#104;ttp://x)（CSS 不解码实体 → 相对路径）
== 自带真主题 ==            ✅ styles/atelier-editorial/theme.css（5750 字节）ACCEPT
== 21/21 条断言符合预期 ==
```

**ReDoS 排除**（用户点名的修法风险）：`css.ts:27-37` 三个正则都是线性——`decodeHexEscapes` 的 `{1,6}` 有上界、`decodeCharEscapes` 只吃"反斜杠+一字符"、`stripComments` 惰性量词末端有 `$` 兜底（未闭合注释一次吃到结尾）。

```
✅ 10k 个「\+字符」转义      1.0ms (20KB)      ✅ 5k 个 hex 转义            0.7ms (20KB)
✅ 50k 个未闭合注释头        0.3ms (98KB)      ✅ 200k 字符的单条未闭合注释   0.4ms (195KB)
✅ 200k 字符的 url 参数      0.6ms (195KB)     ✅ 20k 个开括号              0.1ms (39KB)
```

`\ffffff`（超范围码点）走 `Math.min(…, 0x10ffff)` → 不抛 `RangeError`（`/tmp/m16r/r4-rest.mjs` 实测），`css.ts:8` 的钳位是**活分支**。上轮 `css.ts:36` 那句注释与代码相反的 P1（注释声称"也会被拒"而实际放行）也随之消失：现在注释描述的就是"先归一后判定"。

### G2-R-3 · P1-2（多主题块，旧的赢）→ CLOSED

复现：`node /tmp/m16r/r3-apply.mjs`、`node /tmp/m16r/r3b-bytes.mjs`

```
① 两个规范锚点   changed=true removed=1 style 块=1 → <style id="hr-theme">:root{--hr-bg:#fff}</style>
   二次 changed=false 字节不变=true
② 三个锚点(含单引号+大写值) removed=2 style 块=1
① 去重后的逐字节期望 ==
   out      : "<!doctype html>\n<html lang=\"zh\"><head><meta charset=\"utf-8\"><style id=\"hr-theme\">:root{--hr-bg:#fff}</style></head><body><p>x</p></body></html>"
   expected : 同上（手工构造：替换首个 inner + 删掉第二个块）
   ✅ 与「替换首个 inner + 删掉第二个块」逐字节相等
③ 单锚点五种写法：双引号 / 单引号 / 无引号 / 额外属性(media="print") / 属性名大写(ID=)
   ✅ 开标签原样=true（只换 inner，引号与属性名大小写都不被重写）
⑤ 非锚点 <style>.x{…}</style> 必须保留  ✅ 2 个块，非锚点块原样
```

**修法风险专项**：去重会不会破坏块外字节保真——不会，`apply.ts:141-147` 的 `spliceAll` 按 `start` 倒序应用同一份原文偏移，①的逐字节相等就是证据；`removed` 的计数口径（`apply.ts:149-150` 只数"有字节且不是被选中那个"）与 ① 一致。另外我顺手排掉了上轮 P1-7 教训在本卡的复现：**`<style ID="hr-theme">`（源码大写属性名）能被识别**（`attrs` 的 name 是 parse5 已小写的），不会误判成两个锚点而重复注入。

### G2-R-4 · P1-3（loadStyle 能载、applyStyle 报 unknown_style）→ CLOSED

复现：`node /tmp/m16r/r4-rest.mjs`（第三节）

```
  ✅ id=proj-foo          loadStyle=ok(project, theme=atelier-editorial/theme.css) applyStyle=ok(changed=true)
  ✅ id=atelier-editorial loadStyle=ok(builtin, theme=atelier-editorial/theme.css) applyStyle=ok(changed=false)
  ✅ id=no-such           loadStyle=unknown_style                                 applyStyle=unknown_style
```

`applyFile.ts:34` 现在先 `resolveStyle({ id })` 再 `readThemeCss(style.themePath)`，`load.ts:91-114` 是唯一解析链（`loadStyle` 只是它的别名）。上轮的反例（项目风格 `inherits_visual` 指向内置视觉、自身无 `theme.css`）现在两侧同源。

### G2-R-5 · P1-4（裁定 #5 缺省不可达）→ CLOSED

复现：`node /tmp/m16r/r4-rest.mjs`（第一节）

```
  ✅ ① 整块省略 sentence_rhythm + vocabulary   rhythm={"maxParagraphSentences":3,"style":""} vocab={"forbidden":[],"recommended":[]}
  ✅ ② sentence_rhythm: {}（空映射）            同上
  ✅ ③ sentence_rhythm 为空值（null）            同上
  ✅ ④ forbidden: [] / recommended: [] 合法       同上
  ✅ ⑤ style: "" 合法（不约束）                  同上
  ✅ ⑥ vocabulary: hello        → invalid_style: …language_style.vocabulary：必须是映射
  ✅ ⑦ max_paragraph_sentences: 0 → invalid_style: …sentence_rhythm.max_paragraph_sentences：必须是正整数
```

`spec.ts` 的 `mappingAt`（整块可省略，`spec.ts:210-215`）与 `stringsOf` 的 `[]` 分支（`spec.ts:158-166`）让裁定 #5 的三条语义都变得可达；`scalarAt` 的空串不再被"非空"校验打回。

### G2-R-6 · P1-5（报文列顶层键集）→ CLOSED

复现：`node /tmp/m16r/r4-rest.mjs`（第二节）

```
顶层未知：s.yaml：未知键 s.yaml.bogus_top（这一层的合法键：id、name、description、inherits_visual、language_style）
rhythm 内：s.yaml：未知键 s.yaml.language_style.sentence_rhythm.bogus_rhythm（这一层的合法键：max_paragraph_sentences、style）
examples[0]：s.yaml：未知键 s.yaml.language_style.examples[0].note（这一层的合法键：bad、good）
三层同时未知：一条报文革全 4 条，每条各带本层键集（language_style 层列出 persona、narrative_rules、sentence_rhythm、vocabulary、examples）
```

`spec.ts:76-99` 的 `collectUnknown` 把 `legal` 收进 `UnknownKey`，`spec.ts:106-112` 一次列全；`spec.ts:246` 是**唯一**调用点，上轮指出的嵌套 `assertKnownKeys` 死代码已删干净（`grep -n assertKnownKeys spec.ts` 只剩定义 + 1 处调用）。

### G2-R-7 · 新死代码扫描（本仓高频复发项）→ 未发现新增

| 位置 | 分支 | 可达性实测 |
| --- | --- | --- |
| `apply.ts:127` | `!spans.has("head")` | **可达**：`""`（root 无子节点）→ 抛 `invalid_html`；非空输入都会合成 head |
| `apply.ts:134` | `hasBytes(head)` | 真分支 = 有显式 `<head>`；假分支 = `<!doctype html><body>` 等 |
| `apply.ts:136` | `hasBytes(htmlSpan)` | 真 = `<html>` 显式存在（插在 `html.innerStart`）；假 = 纯片段（走 `prologueEnd`） |
| `css.ts:29` | `Math.min(…, MAX_CODE_POINT)` | 可达：`\ffffff` 不抛 `RangeError` |
| `css.ts:41-42` | `isLocalUrl` 五条出口 | 全部命中（`data:` / `#` / `//` / `scheme:` / 相对） |
| `css.ts:37` | `stripComments` 的 `*/` 与 `$` | 两支都命中（闭合注释 / 50k 未闭合头） |
| `theme.ts:44` | `loadThemeCss` | 仍被 `index.ts:24` 导出且被 `tests/style/spec-precedence.test.ts:138-162` 使用 |

唯一"看似死实则活"的是 `apply.ts:127`（我原以为 parse5 恒合成 head，实测空串不合成）；`removedOf` 的 `hasBytes` 谓词恒真但不是分支，无害。

### G2-R 结论

- **P0-1 CLOSED**、**P1-1…P1-5 全部 CLOSED**，共 6/6；无新增 P0/P1。
- 三条"修法引入新问题"排查结果：① 去重未破坏块外字节（逐字节相等）；② 大小写敏感度未被宽松化污染（`<style ID=…>` 正确识别，`<STYLE>` 也识别）；③ 空锚点/多锚点计数与 `changed` 口径一致。
- 1 条 **P2-R1**：0 字节文件抛 `invalid_html`，需要协调者在"卡片措辞"与"新增骨架"之间二选一；不影响 R1 的 6 项修复签字。
- 测试红不作为判据（本轮全部用 `/tmp/m16r/*.mjs` 直连 `src`），未跑 `pnpm verify`。

ACP: 复验 6 条（P0-1 + P1-1…P1-5）全部 CLOSED；自跑 7 个探针 `/tmp/m16r/{r1-p01,r1b-tree,r2-css,r3-apply,r3b-bytes,r4-rest,r5-bom,r5b}.mjs` 直连 `packages/core/src/style/**` 源码；P0-1：带 doctype 的 9 例 0 例被挤、BOM 在第 0 字节且 CRLF 尾部逐字节保留、空串抛 `invalid_html`（P2-R1，`parseHtml("")` root 无子节点故守卫可达）；P1-1：13 拒 / 8 放行 / 21 断言全中、200KB 病态输入 ≤1.1ms 无 ReDoS、`\ffffff` 钳位不抛 RangeError、自带 theme.css 5750B 仍 ACCEPT；P1-2：去重输出与手工期望逐字节相等、`removed=1`、五种单锚点写法开标签字节原样、`<style ID=…>` 不误判；P1-3：`resolveStyle` 单链，`proj-foo` 两侧 ok、`no-such` 两侧同码；P1-4：省略/`{}`/`null` 三形态均得 3 句缺省且 `forbidden: []`、`style: ""` 合法、两类非法仍带全路径报错；P1-5：四层同时未知一条报文列全且各带本层键集，嵌套 `assertKnownKeys` 死代码已删；新死代码扫描 7 处分支全部实测可达；只读审计：未 commit、未改源码与 `tests/**`，仅追加本报告。
