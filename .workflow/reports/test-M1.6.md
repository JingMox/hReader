# test-M1.6 · 风格引擎 + Atelier Editorial 主题（G3 测试报告）

- 卡片：`.workflow/cards/M1.6.md`（含 §6 v2 裁定 #11–#14）
- 编写员自证：`.workflow/reports/impl-M1.6.md` §7/§8（**未采信**，以下数字均为本轮实跑）
- 我方范围：`packages/core/tests/**` 独占；`src/**`、配置、阈值一律未改
- 被测：`packages/core/src/style/**`（14 文件）+ `src/style/presets/**`（3 内置风格）+ `styles/atelier-editorial/theme.css` + `src/hr-error.ts` 新增 4 码

## 1. 用例矩阵（`packages/core/tests/style/`，159 例）

| 文件 | 例数 | 覆盖点 |
|---|---|---|
| `spec-parse.test.ts` | 12 | 合法/最小 YAML、`{单值\|列表}` 成对（`narrative_rules`/`forbidden`/`examples`/`recommended` 空数组）、缺省 `inherits_visual`、未知键、`{标准\|敌意}`（锚点炸弹、超深嵌套、重复键、制表符、BOM、`\r\n`、非 UTF-8 字节、`!!js/function`） |
| `spec-reject.test.ts` | 25 | 逐层未知键定位（根/`language_style`/`sentence_rhythm`/`vocabulary`/列表项）、类型错配、`id` 逃逸九连（`../`、`..`、绝对、`\`、`\0`、大写、下划线、空格、unicode 同形字）、空 `id`/空白 `name` |
| `spec-discovery.test.ts` | 7 | `discoverStyles` 的坏文件隔离（每文件一条诊断，AC6.6）、目录枚举、排序、`listDirs` 失败降级 |
| `spec-precedence.test.ts` | 16 | 四来源优先级（显式 > 项目 > 用户 > 内置）、项目文件 id 不同则不顶替、用户目录名与 id 不一致报错、`id` 非法先于磁盘（`../../etc/passwd`、`/abs/style`）、`unknown_style` |
| `css-allow.test.ts` | 7 | 放行面：相对路径、`#锚点`、`data:`、`url(  )`、多 url、注释里的假 url |
| `css-reject.test.ts` | 22 | 拒绝面：`uRl(HTTP://…)`、`@IMPORT`、`/*x*/@import`、`url(//evil)`、`data:text/html`、实体编码 http、`</style` 逃逸、`<` 在字符串里、`javascript:`、`mailto:`/`file:`/`blob:`、未闭合 `url(`；**+1 `it.fails`：CSS 转义 `\68 ttp://` 绕过（真漏洞，见 §5）** |
| `tone-injection.test.ts` | 6 | `persona`/规则/示例里的 `## 标题`、围栏、`---`、`忽略以上所有指令` 全部关进 `>` 引用块；多行逐行加 `>`；编号不吞内容 |
| `tone-structure.test.ts` | 7 | 编号引用块逐条渲染、空 `style` 整行跳过（裁定 #5）、`max_paragraph_sentences` 提示、`recommended`/`examples` 缺省、超长截断 |
| `lint-basic.test.ts` | 10 | 命中/未命中、`hits` 顺序、文档序遍历（子先于后继兄弟）、`forbidden` 单词/多词、`truncated=false`、空目录 |
| `lint-offset.test.ts` | 9 | `offset` 是块内**字符**偏移：中文、emoji/代理对、全角↔半角（NFKC）、拉丁大小写（禁词 `boom` 命中 `BOOM`）、`partial` 语义、命中跨行 |
| `lint-limit.test.ts` | 5 | 截断边界：正好 100 命中 → `truncated=false`；101 → `truncated=true` 且只留 100；两块累计跨过 100 |
| `apply.test.ts` | 10 | 纯层 `replaceTheme`：已有主题块只换内部文本（属性保留）、id 非首属性、多块取文档序首个、插入 `<head>`/无 head、`data-hr-theme-source` 标记、`changed:false` 字节不变、静态防线先于解析 |
| `apply-file.test.ts` | 9 | 落盘级：`replaceTheme` 字节保真（只动 style 内部）、锁被占 → `locked` 不写、`invalid_theme`/`unknown_style` 不留痕、`io_failure`、二次幂等不写盘、失败不留 tmp、原子写后文件可解析 |
| `coverage-edges.test.ts` | 11 | SVG 里的 `<style>`（非 raw text 子树）、摘录末尾不加省略号、显式路径带/不带 `id`、`loadStyle({})` 落内置、`inherits_visual` 缺省、列表项未知键、非字符串输入 → `invalid_style`、列表当映射 → `invalid_style`、门面导出面 |
| `deps.test.ts` | 3 | `nodeStyleDeps` 的 fs/homedir 端口形状；`deps` 不泄漏到纯层函数 |
| `hr-error.test.ts`（改） | — | `CODE_MATRIX` 补 `invalid_style`/`unknown_style`/`invalid_theme`/`style_io_failure` 四键（`tsc` 转绿的前提） |

合计：`tests/style` 159 例；全仓 `884 passed | 2 todo`（含 M1.5 遗留 2 个 `it.todo`，等 G1-R1 导出面）。

## 2. 覆盖率（`--coverage`，perFile 100% 四维）

`src/style` 汇总：**lines 98.94% / branches 98.15% / functions 98.79% / statements 98.94%**；全仓 `All files 99.82 / 99.66 / 99.74 / 99.82`。

| 文件 | lines | branches | functions | statements | 未覆盖行 |
|---|---|---|---|---|---|
| `apply.ts` | 97.18 | 97.05 | 100 | 97.18 | 54-55 |
| `load.ts` | 100 | 97.67 | 100 | 100 | 59 |
| `spec.ts` | 97.46 | 96.20 | 95.83 | 97.46 | 52, 219-222 |
| `contracts.ts` | 0 | 0 | 0 | 0 | （纯类型文件，无运行期语句；不产生阈值 ERROR） |
| 其余 11 文件 + `presets/**` | 100 | 100 | 100 | 100 | — |

四处缺口全部是"公共 API 走不到"的防御性分支，见 §6 待裁定（未加 ignore、未改阈值）。

## 3. 变异测试（真改 src → 跑指定用例 → 逐字节还原）

工具：`packages/core/fixtures/style-mutants.mjs`（结果落 `style-mutants-result.json`，退出码非 0 表示有存活或还原失败）。

| # | 变异 | 文件 | 结果 | 杀死它的用例 |
|---|---|---|---|---|
| S1 | `changed` 恒 true（幂等比较失效 → 重复写盘） | `style/apply.ts` | **KILLED（2）** | `apply.test.ts > replaceTheme · 替换（已有主题块） > should report changed:false and byte-identical html…`；`apply-file.test.ts > applyStyle · 幂等与插入 > should be idempotent…` |
| S2 | 用整元素区间替换（丢掉 `<style>` 开标签与属性） | `style/apply.ts` | **KILLED（2）** | `apply.test.ts > should replace only the inner text and preserve the opening tag attributes`；`apply-file.test.ts > applyStyle · 字节保真 > should replace only the theme block and keep all other bytes` |
| S3 | `url()` 白名单恒真（远程地址不再被拒） | `style/css.ts` | **KILLED（1）** | `css-reject.test.ts > assertThemeSafe · 远程与危险 url() > should reject mailto: with invalid_theme` |
| S4 | 去掉 `` `<` `` 扫描（允许 `</style>` 逃逸） | `style/css.ts` | **KILLED（1）** | `css-reject.test.ts > assertThemeSafe · @import 与逃逸 > should reject </style 逃逸 with invalid_theme` |
| S5 | tone 的引用块不再加 `>`（用户文本可自成标题） | `style/tone.ts` | **KILLED（2）** | `tone-structure.test.ts > should render one numbered blockquote per narrative rule`；`tone-injection.test.ts > should quote every injected line…` |
| S6 | **反向**：未知键只查顶层（嵌套层再也不报） | `style/spec.ts` | **KILLED（1）** | `spec-reject.test.ts > should reject unknown key at sentence_rhythm with its location` |
| S7 | **反向**：禁用词匹配不再折叠大小写（`BOOM` 逃过 `boom`） | `style/lint.ts` | **KILLED（1）** | `lint-offset.test.ts > should match Latin case-insensitively and keep the original offset` |

7/7 被杀（含 2 条反向变异）；还原校验用 sha256 逐字节比对，无残留改动。

## 4. 反向变异（实现退化检测）

S6（`walkUnknown` 递归被砍）与 S7（`toLowerCase()` 被砍）都是"把安全逻辑改坏"，套件**变红**，说明断言能抓住退化，不只是"跑通"。

## 5. 自己找 bug：4 条假设

| # | 假设 | 构造 | 结论 |
|---|---|---|---|
| H1 | **CSS 转义可绕过协议判定**：`\68 ttp://` 在浏览器解码为 `http://`，但 `isLocalUrl`（`packages/core/src/style/css.ts:21-25`）只看到反斜杠，当成相对路径放行 | `.a{background:url(\68 ttp://evil.example/x.png)}` | **真漏洞（已复现）**：`assertThemeSafe` 不抛。套件里以 `it.fails` 钉住（`css-reject.test.ts:59`，标注 KNOWN BUG(1)），修复后改回 `it`。建议：`isLocalUrl` 先做 CSS 反转义（`\\[0-9a-f]{1,6}` / `\\` 后跟任意字符）再判协议，或直接禁反斜杠 |
| H2 | `id` 里的 `../`/绝对路径把用户风格目录带出 workspace | `loadStyle({id:"../../etc/passwd"})`、`{id:"/abs/style"}` | **没坏**：`assertStyleId`（`style/id.ts:7-13`）先于任何 `readFile`，返回 `invalid_style`（`spec-precedence.test.ts:71-74`） |
| H3 | YAML 锚点自引用炸弹撑爆解析 | `language_style: &a\n  persona: p\n  narrative_rules: &b [*b]`；`a: &a [1,2]` + `b: [*a,*a]` | **没坏**：`toJS({maxAliasCount:100})` 抛 `RangeError` → 归 `invalid_style`（`spec-parse.test.ts:97`） |
| H4 | `persona`/规则里的 Markdown 结构（`## `、围栏、`---`）逃出引用块、变成文档标题 | 六组敌意文本 | **没坏**：`tone.ts` 对每行加 `> `，`## 标题` 只成为 `> ## 标题`（`tone-injection.test.ts`） |

## 6. `pnpm verify` 真实输出（EXIT=1，仅 coverage 一项红）

```
 Test Files  67 passed (67)
      Tests  884 passed | 2 todo (886)
   Duration  13.22s
...
 src/style         |   98.94 |    98.15 |   98.79 |   98.94 |
  apply.ts         |   97.18 |    97.05 |     100 |   97.18 | 54-55
  load.ts          |     100 |    97.67 |     100 |     100 | 59
  spec.ts          |   97.46 |     96.2 |   95.83 |   97.46 | 52,219-222
ERROR: Coverage for lines (97.18%) does not meet global threshold (100%) for packages/core/src/style/apply.ts
ERROR: Coverage for statements (97.18%) does not meet global threshold (100%) for packages/core/src/style/apply.ts
ERROR: Coverage for branches (97.05%) does not meet global threshold (100%) for packages/core/src/style/apply.ts
ERROR: Coverage for branches (97.67%) does not meet global threshold (100%) for packages/core/src/style/load.ts
ERROR: Coverage for lines (97.46%) does not meet global threshold (100%) for packages/core/src/style/spec.ts
ERROR: Coverage for functions (95.83%) does not meet global threshold (100%) for packages/core/src/style/spec.ts
ERROR: Coverage for statements (97.46%) does not meet global threshold (100%) for packages/core/src/style/spec.ts
ERROR: Coverage for branches (96.2%) does not meet global threshold (100%) for packages/core/src/style/spec.ts
EXIT=1
```

lint 与 typecheck 阶段均通过（无 error 输出），`vitest` 全绿；红只在 coverage 阈值。注意：`&&` 链在 coverage 处断开，`depcruise` / `knip` 两阶段**本轮未执行**。

## 7. 待裁定（均为 `src` 侧不可达分支，我无权删）

1. `packages/core/src/style/apply.ts:51-56` `spanOf` 的 `throw new HrError("invalid_html", …)`：两个调用点（`:66`、`:80`）的节点都来自 `parseHtml(html, { locations: true })`（`replaceTheme:88`），`span` 不可能为 `undefined`。**建议删除该防御分支**（或改成 `assert` 级不可达），否则 perFile 100% 永远差 2 行。
2. `packages/core/src/style/load.ts:59` `if (path === undefined) throw new HrError("invalid_input", …)`：唯一调用方 `loadStyle:86` 已用 `if (input.path !== undefined) return explicitStyleOf(...)` 保证 `path` 有值。**建议把该判断上移/删除**，或在 `explicitStyleOf` 改签名收窄为 `path: string`。
3. `packages/core/src/style/spec.ts:219-222` `documentOf` 的 `catch` 与 `:52` `messageOf` 的 `String(error)` 分支：`yaml` 的 `parseDocument` 对**任意字符串输入**只回填 `document.errors`、不抛异常（已实测：制表符缩进、重复键、`[1, }` 均返回 `errors.length=1`）。只有"库自身抛非 `Error`"才走这条，公共 API 不可达。**建议删掉 `try/catch`，改为 `document.errors` 单一错误路径**（顺带删 `messageOf` 的 else 分支）。
4. `packages/core/src/style/contracts.ts` 四维 0%：纯 `interface`/`type` 文件，`v8` 统计为 0 但不产生阈值 ERROR。若协调者希望表格全绿，可把 `contracts.ts` 从 coverage `include` 中排除（配置变更非我范围）。

## 8. 证明不了的地方

- **视觉 AC（68ch / 280px / 420px 折叠 / `min-width:0` / `overflow-wrap`）**：只断 CSS 结构（选择器与声明存在），不伪造布局、不断言渲染结果。
- **`url(/absolute)` 被判为本地**：与卡片"只允许相对路径"的措辞存在张力，实现口径是"非 `//`、非协议即本地"。未断言为 bug，记录为口径差异，等协调者裁定。
- **CSS 转义漏洞**：只证明"当前实现放行"，不证明真实浏览器全部解码规则（`\68 ttp` → `http` 是 CSS2.1 转义语义，已按规范断言）。

ACP:
- 目标：M1.6 测试交付（`packages/core/tests/**` 独占）
- 用例：159（`tests/style` 15 文件）+ `hr-error.test.ts` 补 4 码；全仓 884 passed / 2 todo / 0 failed
- 覆盖率：`src/style` 98.94 / 98.15 / 98.79 / 98.94（lines/branches/functions/statements）；全仓 99.82 / 99.66 / 99.74 / 99.82
- verify：EXIT=1，红仅 coverage（4 个不可达防御分支，见 §7；未 ignore、未改阈值）
- 变异：7/7 被杀（含 2 条反向变异），还原 sha256 校验通过
- 真 bug：1（CSS 转义 `\68 ttp://` 绕过 `isLocalUrl`，`it.fails` 钉住）；另 3 条假设验证"没坏"
- 待裁定：4 项（apply.ts:51-56、load.ts:59、spec.ts:52/219-222、contracts.ts include）
- 未碰：`src/**`、`vitest.config.ts`、阈值

---

# G3.2（编写员 R1 交付后收尾，2026-11-13 第二轮）

## 9.1 五条红：逐条裁定 —— 全部**接受**，无一否决

判据统一：R1 的裁定（R2/R5/R6 + 修好的 P1-1）**替代**了旧断言；旧断言固化的行为本身就是审计的缺陷面（例如"保留第二个 `hr-theme`"= 旧 CSS 靠级联赢）。

| # | 旧断言 | 裁定 | 改成什么 | 为什么不能保留旧断言 |
| --- | --- | --- | --- | --- |
| 1 | `it.fails` 钉 `\68 ttp://` 漏洞 | 接受（缺陷已修） | 转正向：7 种转义全抛 `invalid_theme`；另加"注释里的 `@import` 放行" 2 例 | `it.fails` 是"已知缺陷的钉子"，缺陷消失后继续留着等于把 bug 写进规格 |
| 2 | 任何未知键都列**根**键集 | 接受（R6） | 4 例：根层 `render: x` → 根键集；`language_style.tone_style` → `persona、narrative_rules、sentence_rhythm、vocabulary、examples`；`sentence_rhythm.cadence` → `max_paragraph_sentences、style`；`vocabulary.banned` / example 项 → `forbidden、recommended` / `bad、good` | 报错若指引到错层，用户照提示改会继续失败（"修一个报一个"） |
| 3 | `recommended: []` 要拒 | 接受（R5） | 正向 3 例，`toEqual` 精确比 `{forbidden, recommended}`；`forbidden: []`、`recommended: []`、双空都合法 | 空列表语义是"不约束"，拒绝会让用户没法只禁用不禁用 |
| 4 | 显式 `style: ''` 要拒 | 接受（R5） | `style: ''` 合法且原样保留；缺省块 → `toEqual({maxParagraphSentences:3, style:""})`；另补 `vocabulary` 缺省 `{forbidden:[],recommended:[]}` | 空串是"不约束句式"哨兵，与"缺省"必须同值同语义 |
| 5 | 取文档序**首个** `hr-theme` | 接受（R2 单锚点） | `removed === 1`、输出恰 1 个块、其内容为新 CSS、块外字节不变（挖掉主题块后与原文相等）；单锚点时 `removed === 0` | 留旧块 = 旧 CSS 级联获胜，是 G2 P1-2 本体 |

## 9.2 新增用例（R1 新行为，不补等于没验）

| 位置 | 例数 | 钉住什么 |
| --- | --- | --- |
| `tests/style/apply.test.ts` `replaceTheme · 畸形文档的 doctype 不得被挤走` + `· doctype 与注释序` | 6 | `<!doctype` 必须在字节 0：只有 `<body>`、只有 `<div>`、doctype-only、`<!-- x --><!doctype>` 序（注释在前时 doctype 紧跟其后）、无头 `<html>`（注入后为 `<html><head>`）、空串仍 `invalid_html` |
| 同上（新增第 7 例，故意断"未合成"） | 1 | 纯片段 `<div>x</div>`：R1 只保证"已有 doctype 不被挤走"，片段仍以合成的 `<head>` 开头 —— 行为如实钉住并列为 §9.5 待裁定 |
| `tests/style/apply-canonical.test.ts`（新文件） | 2 | 非规范锚点（`ID="HR-THEME"`、`id="HR-THEME" media="print"`）整块重写成规范形态，且**第二次 apply 字节相同**（`changed:false`，证明 canonicalize 收敛） |
| `tests/style/apply-file.test.ts` `resolveStyle 单一解析链` | 3 | 同一 `{id}`：`loadStyle` 成功 → `applyStyle` 不得 `unknown_style`；内置 id / 用户显式路径 / 项目目录三种来源 |
| `tests/style/css-reject.test.ts` 转义段 | 7 + 2 | `\68 ttp://`、`@im\70 ort`、`java\73 cript:`、`u\72l(http://)`、`\75 rl(//…)`、`\40 import`、`URL(\68 ttp://…)`；对照：`/* @import url(x) */`、`/*! 版权注释… */` 放行 |
| `tests/style/deps.test.ts` `existsOf` | 2 | `lstat` 报 EACCES → `style_io_failure`（不是"当作缺文件"）；ENOENT → `false`、存在 → `true` |
| `tests/style/spec-reject.test.ts` `rhythm.style 的非字符串` | 3 | `style: 3 / true / [a,b]` → `invalid_style`（R5 只放行空串，不放过任意非字符串） |
| `tests/entry-points.test.ts`、`tests/outline-surface.test.ts` | 2 | 2 个 `it.todo` → 真断言：core 27 项精确集（多一个内部符号也红，并点名 `resolveStyle/readThemeCss/THEME_ANCHOR_ID/messageOf` 四个不得出现）、`ops/index` 恰 4 项 |

## 9.3 覆盖率前后对比

| 指标 | G3 交付时 | R1 交付后（我先跑） | 本轮收尾 |
| --- | --- | --- | --- |
| 全仓 stmts / branches / funcs / lines | 100 / 99.91 / 100 / 100 | 99.92 / 99.73 / 100 / 99.92 | **100 / 99.93 / 100 / 100** |
| `src/style` | 100 / 100 / 100 / 100 | 99.58 / 98.63 / 100 / 99.58 | **100 / 99.66 / 100 / 100** |
| perFile 红 | 0 | `apply.ts`(113)、`resource.ts`(57-58)、`spec.ts`(67,145) | 仅 `spec.ts:67`（不可达，§9.5） |

补掉的三处：`apply.ts:113` = 非规范锚点臂（`apply-canonical.test.ts` 两例）；`resource.ts:57-58` = `existsOf` 非缺文件异常（EACCES 一例）；`spec.ts:145` = `scalarAt` 非字符串臂（`style: 3/true/[a,b]` 三例）。

## 9.4 `pnpm verify` 真实输出（EXIT=1，仅 coverage 一项红）

```
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives
（无输出）
$ tsc --noEmit -p tsconfig.json --pretty false
（无输出）
$ vitest run --coverage
 Test Files  68 passed (68)
      Tests  917 passed (917)          # 2 个 it.todo 已转真断言，todo=0
All files          |     100 |    99.93 |     100 |     100 |
 src/style         |     100 |    99.66 |     100 |     100 |
  apply.ts         |     100 |      100 |     100 |     100 |
  resource.ts      |     100 |      100 |     100 |     100 |
  spec.ts          |     100 |     98.7 |     100 |     100 | 67
ERROR: Coverage for branches (98.7%) does not meet global threshold (100%) for packages/core/src/style/spec.ts
[ELIFECYCLE] Command failed with exit code 1.
```

`&&` 链在 coverage 处断开，`depcruise` / `knip` 本轮**未执行**（与 G3 时相同的执行边界；R1 自证这两项为绿）。

## 9.5 待裁定（1 项 src 侧不可达分支 + 1 项口径）

1. **`packages/core/src/style/spec.ts:67` 分支不可达**（唯一挡住四维 100% 的地方）：`syntaxErrorOf` 里 `const offset = error.pos?.[0]`，`yaml` 的 `parseDocument` 产生的 `errors[]` **全部带 `pos`**。我实测 30+ 种输入（重复键、`[1,2`、`{a:1`、制表符缩进、块标量缩进、`BAD_DQ_ESCAPE`、`%TAG`/`%YAML` 指令错、`MULTIPLE_DOCS`、`*` 空别名、BOM、CRLF、`\u2028`、NUL 字节）——`errs>0` 时 `pos` 恒为 `[start,end]`，没有一次 `undefined`。
   **建议**：把入参类型收窄（`error: Positioned & { pos: readonly [number, number] }`）并去掉 `?.`，即 `const offset = error.pos[0];`；若不想动类型，`const [offset = 0] = error.pos ?? []` 仍是分支（不解决）。**不接受** v8 ignore / 删阈值。
2. **纯片段不合成 `<!doctype>`**：`replaceTheme("<div>x</div>", css)` → `<head><style …></style></head><div>x</div>`。R1 的 P0 只承诺"已有 doctype 不被挤走"，卡片 AC7.4 也没要求合成；我的用例把现状写成显式期望（不是"跳过"）。若产品要求片段也必须 `<!doctype` 开头，这是 src 侧一行改动，需协调者裁定。

## 9.6 变异测试重跑（8/8 全杀，含 3 条反向变异）

脚本：`node packages/core/fixtures/style-mutants.mjs`（真改 `src/**` → 跑指定用例 → 逐字节还原，还原后 sha256 校验；结果落 `packages/core/fixtures/style-mutants-result.json`）。

| ID | 变异 | 结果 | 杀死它的用例（首个） |
| --- | --- | --- | --- |
| S1 | `replaceTheme` 的 `changed` 恒 `true` | KILLED ×2 | `apply.test.ts > replaceTheme · 替换（已有主题块） > should report changed:false and byte-identical html when the css is already applied`；`apply-file.test.ts > applyStyle · 幂等与插入 > should be idempotent…` |
| S2 | 主题块用整元素区间替换（丢 `<style>` 开标签/属性） | KILLED ×2 | `apply.test.ts > … > should replace only the inner text and preserve the opening tag attributes` |
| S3 | `url()` 白名单恒真 | KILLED | `css-reject.test.ts > 远程与危险 url() > should reject mailto: with invalid_theme` |
| S4 | 删掉 `<` 扫描 | KILLED | `css-reject.test.ts > @import 与逃逸 > should reject </style 逃逸 with invalid_theme` |
| S5 | tone 引用块不加 `>` | KILLED ×2 | `tone-structure.test.ts > 条目渲染 > should render one numbered blockquote per narrative rule`；`tone-injection.test.ts > … should quote every injected line…` |
| **S6** | **反向**：不再反转义（`\68 ttp` 直接放行） | KILLED | `css-reject.test.ts > 转义先反转义再判（R1 修好的 P1-1） > should reject 十六进制转义的 http with invalid_theme` |
| **S7** | **反向**：未知键只查顶层 | KILLED | `spec-reject.test.ts > 未知键逐层拒绝 > should reject unknown key at language_style with its location` |
| **S8** | **反向**：禁用词匹配不折叠大小写 | KILLED | `lint-offset.test.ts > 归一化 > should match Latin case-insensitively and keep the original offset` |

恢复校验：8 个文件的还原 sha256 与变异前一致（脚本 `restoreFailures=[]`，退出码 0）。

ACP:
- 目标：M1.6 测试收尾（G3.2），只动 `packages/core/tests/**` 与 fixtures 脚本
- 用例：全仓 **917 passed / 0 failed / 0 todo**（R1 前 884 + 2 todo；`tests/style` 16 文件 190 例）
- 覆盖率：全仓 100 / 99.93 / 100 / 100；`src/style` 100 / 99.66 / 100 / 100（唯一残差 `spec.ts:67`）
- verify：**EXIT=1，唯一红 = `spec.ts:67` 不可达分支**（format/lint/typecheck/vitest 全绿；depcruise/knip 因 `&&` 链未执行）
- 五条旧红：全部接受，按 R2/R5/R6/P1-1 转正向，无一否决（理由见 §9.1）
- 变异：8/8 被杀（含 3 条反向变异），还原 sha256 通过
- 待裁定：2 项（`spec.ts:67` 收窄类型去 `?.`；纯片段是否补 `<!doctype>`）
- 未碰：`src/**`、`vitest.config.ts`、阈值

## 10. G3.3 收尾：`spec.ts:67` 不是 `lineAt` 的 `?? 0`

### 10.1 复核结论（与派单诊断不同，有证据）

命令原文与结果（本轮最后一次完整复跑）：

```
$ pnpm verify          # = format:check && lint && typecheck && test:coverage && depcruise && knip
EXIT=1
 Test Files  68 passed (68)
      Tests  921 passed (921)
All files          |     100 |    99.93 |     100 |     100 |
  spec.ts          |     100 |     98.7 |     100 |     100 | 67
ERROR: Coverage for branches (98.7%) does not meet global threshold (100%) for packages/core/src/style/spec.ts
```

`spec.ts` 第 67 行是 `syntaxErrorOf` 里的三元，不是 `lineAt`：

```ts
65  const syntaxErrorOf = (error: Positioned, at: string, text: string): HrError => {
66    const offset = error.pos?.[0];
67    const where = offset === undefined ? "" : `（第 ${String(lineAt(text, offset))} 行）`;
```

1. **V8 分支记录直指第 67 行**：`branch id=9 type=branch counts=[0] locs=["67:27-44"]` —— 单一 loc、计数 0，位置正对 `? ""` 第一臂（`offset === undefined` 成立时）。
2. **`lineAt` 的 `?? 0`（`spec.ts:61`）早已可达**：既有的单行敌意用例 `persona: !!js/function > function(){}` 命中 `pos=[25,37]`，前缀无换行 → `match(/\n/gu)` 返回 `null` → `?? 0` 走 0。所以补单行用例**不会**改变这处覆盖率——补了也只有语义价值（10.2）。
3. **唯一调用点**：`packages/core/src/style/spec.ts:239` `if (first !== undefined) throw syntaxErrorOf(first, at, text);`，`first = document.errors[0]`。
4. **探针（15 组敌意输入）证明 `pos` 恒存在**：`id: [unclosed`→`[13,14]`、重复键→`[6,7]`、制表符缩进→`[6,7]`、`!!js/function`→`[25,37]`、多文档→`[9,17]`、`{`→`[1,2]`、`@invalid`→`[0,1]`、未闭合引号→`[17,18]`、`id: s\n  bad: [x`→3 条全有 pos；NUL/空串/纯注释/`   ` 无 errors。**没有一个 `errors[i]` 缺 `pos`** → `offset === undefined` 恒假 → 第 67 行第一臂在公开 API 下不可达。

> 结论：这不是"重复跑一次的抖动"，也不是缺单行用例；是 `yaml` v2 的 `YAMLParseError` 必带 `pos` 而代码保留了 `pos?:` 的可选性，于是留下一条永久死亡的兜底臂。**测试侧无法覆盖，只能改 `src`。**

### 10.2 本轮新增用例（4 条，全部绿）

| # | 用例（`packages/core/tests/style/spec-parse.test.ts`） | 输入 | 断言 |
|---|---|---|---|
| 1 | `should name line 1 when the syntax error is on the first line (no newline prefix)` | `id: [unclosed`（单行） | `code === invalid_style`，报文含 `第 1 行` |
| 2 | `should count newlines for a syntax error on a later line` | `id: s\nname: [unclosed` / 三行版 | 报文含 `第 2 行` / `第 3 行` |
| 3 | `should keep reporting 第 1 行 for a single-line tab-indentation error` | `\tid: s`（单行） | 报文含 `第 1 行` |
| 4 | `should treat a comment-only document as an empty document (v3#15), not a 0-byte one`（`apply.test.ts`） | `<!-- x -->` | 注入 `<head>` 成功、注释保留（不抛 `invalid_html`） |

新增后：全仓 **921 passed / 0 failed / 0 todo**（此前 917）。

### 10.3 v3#15 口径核对：0 字节 vs 空文档

探针实测（`replaceTheme(html, css)`）：

| 输入 | 结果 |
|---|---|
| `""`（0 字节） | `invalid_html` ✅ 与 v3#15 一致 |
| `<!-- x -->` | 合法，注入 `<head>`，注释保留 |
| `<!-- x -->\n` | 同上 |
| `<!doctype html>` | 合法，doctype 仍在字节 0 |

我原有断言没有把 0 字节当合法（`replaceTheme("") → invalid_html` 早已存在），无需改动；本轮新增第 4 条把"只有注释=空文档"也钉住。

### 10.4 待裁定（唯一一项）：`spec.ts:65-67` 的死亡兜底臂

建议删除（3 行 → 2 行，`src` 侧一行改动，不是 ignore）：

```ts
// contracts.ts
interface Positioned { readonly message: string; readonly pos: readonly number[] }   // 去掉 `?`
// spec.ts
const [offset] = error.pos;                                                          // `?.` 一并收掉
const where = `（第 ${String(lineAt(text, offset))} 行）`;                            // 三元消失
```

我这侧不改 `src/**`、不加 `/* v8 ignore */`、不动阈值。若产品上确实要保留"无 pos 的错误也给可读报文"的兜底，那唯一合法覆盖手段就是 `/* v8 ignore next */`——**由你裁定**，裁定前 verify 必然是 EXIT=1，且唯一红就是这一行（见 10.1 输出）。

### 10.5 运行产物不再落工作树

- `packages/core/fixtures/style-mutants.mjs` 现在把结果写 `/tmp/hr-style-mutants-result.json`（`node --check` 通过；变异逻辑未改，仍是 8/8 杀，见 §9.6）。
- 仓库内 `packages/core/fixtures/style-mutants-result.json` 已删除（未跟踪文件，`git status` 干净）。
- **建议（我无权改 `.gitignore`）**：M1.5 的 `packages/core/fixtures/mutants-result.json` 已入库，属同类运行产物，建议 `.gitignore` 收掉并 `git rm --cached`。

### 10.6 本轮 verify 的分项状态

| 阶段 | 结果 |
|---|---|
| `prettier --check .` | 绿 |
| `eslint . --max-warnings=0` | 绿 |
| `tsc --noEmit` | 绿 |
| `vitest run --coverage` | 921 passed；行/函数/语句 100%，分支 99.93（仅 `spec.ts:67`）→ **阈值红** |
| `depcruise` / `knip` | `&&` 链在 coverage 处中断，未执行 |

ACP:
- 目标：G3.3（M1.6 最后一处覆盖率收尾），只动 `packages/core/tests/**` + fixtures 脚本
- EXIT=0：**未达成**，`pnpm verify` EXIT=1，唯一红 `spec.ts:67` 分支（98.7%）——该臂不可达，需 src 侧收窄 `Positioned.pos`
- 四维：`100 / 99.93 / 100 / 100`（statements / branches / functions / lines）；921 passed / 0 failed / 0 todo
- 派单诊断已修正：不是 `lineAt` 的 `?? 0`（该分支由单行 `!!js/function` 用例早已覆盖），是 `offset === undefined ? ""` 的兜底臂；15 组探针证明 `yaml` 的 `errors[i].pos` 恒存在
- 新增用例：4 条（行号 1/2/3 + 注释-only 空文档）
- 卫生：变异报告改写 `/tmp`，仓库内 style 运行产物已删；建议 `.gitignore` 收掉 M1.5 的 `mutants-result.json`
- 未碰：`src/**`、配置、阈值

## 11. G3.4 收尾：`spec.ts:67` 的零 pos 臂已可测（v3#16 裁定落地）

### 11.1 为什么上一轮没打到点

上一轮 §10 的诊断是对的（缺口在 `offset === undefined ? ""` 这一臂，不在 `lineAt` 的 `?? 0`），但**结论错了一半**：我当时判定"只能改 `src`"。裁定 v3#16 既然把 `syntaxErrorOf` 以 `@internal` 内部导出，这条臂就变成了**可测的第三方边界防御**（`yaml` 的 `pos` 是可选的，真实输入恒带）。上一轮缺的不是用例数量，而是**入口**。

### 11.2 新增 `packages/core/tests/style/spec-error-shape.test.ts`（3 例）

从内部路径引入（文件头注释已写明理由）：`import { syntaxErrorOf } from "../../src/style/spec";`
——路径用仓库惯例的无扩展名写法（与 `spec-parse.test.ts:7` 等一致），模块本身是 `src/style/spec.ts`，`syntaxErrorOf` 是 `@internal`，未进 `src/index.ts` 公共面。

| # | 用例 | 输入 | 断言 |
|---|---|---|---|
| A | `should omit the line marker when the third-party error carries no pos` | `{ message: "bad" }` + `"a: 1"` | `instanceof HrError`、`code === invalid_style`、报文字面等于 `style.yaml：YAML 语法错：bad`、**不含** `第`/`行）` |
| B | `should name 第 2 行 for a pos on the second line` | `{ message: "bad", pos: [8, 1] }` + `"a: 1\nb: 2"` | 报文含 `第 2 行`，字面等于 `style.yaml：YAML 语法错（第 2 行）：bad`（有 pos 那侧一起钉住，避免以后只剩半边） |
| C | `should name 第 1 行 for pos[0] = 0 and keep the cause` | `{ message: "bad", pos: [0, 1] }` + `"a: 1"` | 报文含 `第 1 行`，`error.cause === cause`（偏移 0 的边界） |

单文件跑（只为看分支）：`spec.ts` 分支 100%（同一文件的行/函数低是"只跑了这一个测试文件"的正常现象，不是门禁口径）。

### 11.3 `pnpm verify` —— **EXIT=0**（真全绿）

```
$ pnpm verify          # = format:check && lint && typecheck && test:coverage && depcruise && knip
EXIT=0
 Test Files  69 passed (69)
      Tests  924 passed (924)
All files          |     100 |     100 |     100 |     100 |
  src/html         |     100 |     100 |     100 |     100 |
  src/io           |     100 |     100 |     100 |     100 |
  src/ops/patchNode|     100 |     100 |     100 |     100 |
  src/style        |     100 |     100 |     100 |     100 |
  spec.ts          |     100 |     100 |     100 |     100 |
✔ no dependency violations found (177 modules, 613 dependencies cruised)
$ knip --strict      # 无输出、退出 0
```

| 阶段 | 结果 |
|---|---|
| `prettier --check .` | 绿 |
| `eslint . --max-warnings=0` | 绿 |
| `tsc --noEmit` | 绿 |
| `vitest run --coverage` | **924 passed / 0 failed / 0 todo**；四维 **100 / 100 / 100 / 100** |
| `depcruise` | 绿（177 模块 / 613 依赖，0 违规） |
| `knip --strict` | 绿（无未用导出/文件） |

### 11.4 与 §10 的关系（避免报告自相矛盾）

- §10.1 的证据仍然成立：真实 `yaml` 输入恒带 `pos`，所以该臂**不可能**从公开 API 触发。
- §10.4 的"待裁定"**已由 v3#16 关闭**：不删分支、不改类型，改为内部导出 + 直接喂无 `pos` 的错误对象。§10.4 保留作历史记录，结论以本节为准。

ACP:
- 目标：G3.4（M1.6 最后一个分支），只动 `packages/core/tests/style/**`
- verify：**EXIT=0**；`format`/`lint`/`typecheck`/`coverage`/`depcruise`/`knip` 六段全绿
- 用例：**924 passed / 0 failed / 0 todo**（69 测试文件；G3.3 结束 921 → +3）
- 四维：**statements 100 / branches 100 / functions 100 / lines 100**；`src/style`、`src/io`、`src/ops/**`、`src/html` 均 100
- 新增：`packages/core/tests/style/spec-error-shape.test.ts`（无 pos 臂 / 有 pos 第 2 行 / pos[0]=0 边界，含 cause 身份）
- 未碰：`src/**`、配置、阈值、`@internal` 导出本身（编写员已改）
