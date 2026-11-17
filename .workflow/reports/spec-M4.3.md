### AC 矩阵（含歧义）
| AC | 输入 → 期望观测 → 手段 | AC | 输入 → 期望观测 → 手段 |
|---|---|---|---|
| AC-1 | `fixtures/article.html --visual atelier-editorial --out /tmp/p.html` → exit0、文件非空、产物有 cover/toc/article 三块 → cli 子进程 (`exit/statSync`) + `parseHtml` 结构断言；"⌘P 见三段"→**人工** | AC-2 | 外链 fixture + 纯本地 fixture 各一 → `parseHtml` 计 `script/link/iframe`=0、资源型 `src`(`^https?:`/`^//`)=0、CSS 文本 `@import`/`url(http`=0、`a[href^=https:]`≥1 **不违规** → 纯函数单测 |
| AC-3 | ①不同 out 两次 ②换 cwd ③`HOME=/tmp/poison`（预置同名 theme 异内容）→ 三者 shasum 相同 → cli 子进程 + `shasum` | AC-4 | baseline → 产物 `article`=1、`section.chapter`=outline 中 `tag==="section"` 数、`h1..h6`=outline 中 `tag^=h` 且 `level 1..4` 数、标题 `id=sec-<号>` 与 TOC `href` **双向集合相等** → 纯函数单测 |
| AC-5 | `skip-level.html`、`duplicate.html` → `1/2/1.1.1`；同名两条不同号不同 `id`/`data-toc-id` → 纯函数（产物字符串精确断言） | AC-6 | 11 条规则 → 真 Chrome，分级见下 → `scripts/print-e2e.ts` |
| AC-7 | `ui-junk.html`（混大小写）→ `<article>` 子树内 `button/script/style/input/form/iframe`=0、`[data-hr-ui]`=0、`.hr-sidebar`=0、`on*` 属性=0、`href/src` 伪协议=0 → `parseHtml` 单测 | AC-8 | 6 负例（缺 `--visual`/未知 visual/out 存在无 force/越界/主题读失败/主题逃逸/`empty_document`）→ `exit` + `--json.code` 逐一 → cli 子进程 |
| AC-9 | `depcruise`/`knip` exit0（`knip.json` 需加 `renderer-html` 入口，现无） | AC-10 | `test:coverage` perFile 四维 100%（`vitest.config.ts` include 已覆盖 `packages/*/src/**`）→ 命令 |
| AC-11 | 空 article（仅含 UI）→ `empty_document` **且 out 不存在**（含 out 已存在+`--force` 时旧文件不被覆盖）；纯标题→成功；4 MiB±1 用**程序生成** fixture → 单测 | AC-12 | 源带合法/非法 `data-hr-id` → 合法逐字保留、非法被改写 → 纯函数（`injectNodeIds` + `printHtmlOf`） |
| AC-13 | evil theme（`</style>`、`url(http://…)`）→ `invalid_theme` 且 out 不存在 → `loadThemeCss` 单测 + cli 子进程 | | |

**AC 歧义（建议改写）**：① AC-2 检查面未列 `srcset`/`poster`/`<video|audio|embed|object>` → 改写成"资源标签集 + 资源属性集"；② AC-4"仅一个 `article`"对**嵌套** `article` 未定义（KD-04 多 article 只取首个）→ 补"嵌套时取最外层、内层降级为普通元素"或明说只支持单 article；`header` 容器是否加 `chapter` 未定（现 impl 只给 `section`）；③ AC-7 未限作用域（产物自身 `<head><style>` 必须存在）→ 写死"仅统计 `<article>` 子树"；④ AC-11 上限口径未写是"产物字节 > 4194304"；⑤ AC-12 诊断出口未定（产物内/`--json` 均无字段）→ 建议只断言 id 值；⑥ **D7 落地缺口**：`StyleDeps.home` 是必填（`packages/core/src/style/node.ts:16` 用 `homedir()`），workspace 域 deps 的 `home` 该填什么没有裁定 → AC-3 必须用**毒化 HOME**（有同名主题）才能把这条实测出来。

### fixture 最小集（`packages/renderer-html/tests/fixtures/`）
| fixture | 证什么 | fixture | 证什么 |
|---|---|---|---|
| `article.html` | AC-1/2/4/6 基线（title+h1+h2+p） | `headings-only.html` | AC-11 纯标题**不得** `empty_document` |
| `duplicate.html` | AC-5 同名标题两条 → 两个 id | `skip-level.html` | AC-5 h2→h4 = `1.1.1`，不补空槽 |
| `ui-junk.html` | AC-7 全裁切（`<BUTTON onclick>`/`<script>`/`<style>`/`[data-hr-ui]`/`.hr-sidebar`/`href="java\tscript:"`） | `img-onerror.html` | AC-7 `onerror` 剥离 + 相对 `img src` 断链暴露 |
| `long-table.html` | AC-6 `thead` 重复（须真渲染，单测只能断 `display`） | `external-link.html` | AC-2 不算违规 + AC-6 `::after` 括注 |
| `empty-article.html` | AC-11 `empty_document` 且不写盘 | `nested-article.html` | AC-4/KD-04 嵌套歧义的实证 |
| `theme-evil/*.css` | AC-13（`</style>`、`url(http://)`） | 4 MiB±1 | **测试内程序生成**，不做静态文件 |

### 攻击面（10 条，≥8）
| 偷懒形态 | 后果 | 挡它的 AC |
|---|---|---|
| 事件属性按黑名单/大小写敏感比对（`sanitize.ts:34` 现用 `startsWith("on")`，依赖 parse5 小写归一） | `<IMG ONERROR>`/`onpointerdown` 漏网 → 产物带脚本 | AC-7（parse 计数）；grep 式断言挡不住 |
| TOC id 用标题文本造、或继承源文档自带 `data-toc-id` | 同名标题 id 冲突、`href` 指向错锚点 | AC-5 + AC-4 双向集合相等 |
| 相对 `img src` 视为合法（非 `http` 就放过） | 单文件移走后断图，D1"自包含"名不副实 | **AC-2 挡不住** → 建议补 `src` 相对路径=0 |
| `--force` 先 `exists` 预检再写：TOCTOU + 失败留 `*.tmp*` | 覆盖未授权文件、目录留半截临时件 | AC-11 三态 + 断言目录无 tmp 残留 |
| 复用 `nodeStyleDeps`（`home:homedir()`）或 docId 用绝对路径/`cwd` | HOME 主题覆盖、换机换字节 | AC-3（毒化 HOME 才是真断言） |
| `findArticle` 取首个（`print-html.ts:38`）；嵌套 article 原样保留 | 产物 2 个 `article`、内层 UI 未裁 | AC-4（对嵌套未定义 → 歧义） |
| `<style>` 两段拼在同一元素、顺序反转，或 print 规则特异性低于主题 | 主题覆盖出版级规则，`@page`/`break-before` 静默失效 | 单测只断 index；**AC-6 真 Chrome** 才挡 |
| 主题缺失时静默回退内置（而非 `unknown_style`） | 静默降级、用户不知 `--visual` 打错 | AC-8 |
| 4 MiB 判在拼接之后 / `bytes` 用 buffer 长度 | 超限已分配、`bytes` 与盘上不符 | AC-11 + D12 `statSync` 交叉 |
| `empty_document` 先写后判（`--force` 场景） | 旧文件被清空/半截 | AC-11"out 不存在"须扩展到 `--force` |

### 验证分级
| 级 | 覆盖 | 断言要点 |
|---|---|---|
| `pnpm verify` 纯单测 | AC-2/4/5/7/12（`printHtmlOf`+`parseHtml` 计数）、AC-13（`loadThemeCss`+`assertThemeSafe`）、AC-9、AC-10 | 只信**解析后**节点/属性计数，禁用字符串 `toContain` |
| `pnpm verify` cli 真子进程 | AC-1、AC-3、AC-8、AC-11、D12 | 真 fs tempdir；`exit`+`--json.code`；`statSync().size===bytes`；目录无 tmp；毒化 HOME |
| `scripts/print-e2e.ts` 真 Chrome | AC-6 全 11 条 + AC-3 浏览器侧复跑 | a) `Emulation.setEmulatedMedia({media:"print"})` 后 `getComputedStyle`：`breakBefore==="page"`、`breakAfter==="avoid"`、`widows/orphans==="3"`、`thead.display==="table-header-group"`、`code.whiteSpace==="pre-wrap"`；`getComputedStyle(a,"::after").content` 含 href（**括注真出现**）；b) `Page.printToPDF` 解析 `/Type /Pages … /Count` 与 MediaBox（A4 595.28×841.89，`@page:first` 首页无 20/18mm 边距→内容偏移变小）；c) 页数增量：双 chapter 各起新页（1→2）、封面/TOC 各 +1、长表格 `table-header-group` vs `table-row-group` 页数差；d) 同一 PDF 两次字节相同 |
| 仅人工 | AC-1 的 ⌘P 观感（三段视觉、字号、封面留白、纸面边距） | 不得用人工替代 AC-6 签核；无 Chrome 时 `SKIP` → **AC-6 不签** |

### 变异预告（4 条，可执行）
| 变异 | 改动 | 期望红 |
|---|---|---|
| M1 | `packages/renderer-html/src/sanitize.ts:34` `name.startsWith("on")` → `name.startsWith("onclick")` | AC-7：`img-onerror` 的 `[onerror]` 计数 ≠ 0 |
| M2 | `packages/renderer-html/src/numbering.ts:24` `parent === "" ? String(index+1) : \`${parent}.…\`` → 一律 `String(index+1)` | AC-5：`h2→h4` 应为 `1.1.1` 却得拍平号 |
| M3 | F2 落地后 `print-html.ts` `headOf` 把 `PRINT_CSS` 拼在主题**前** | 单测 index 顺序红 + e2e `break-before`/`@page` 无效 |
| M4 | `print-html.ts` `articleBodyOf` 的 `body.trim() === ""` → `false` | AC-11：空 article 不再报 `empty_document`、且写出空文件 |

**F1 半成品观察（不作结论，交付时按上表复核）**：`numbering.ts` 现按**树深**编号且 TOC 收全部 outline 节点（含 `section` 容器）→ 与 v2 AC-5/AC-4 相反；`sanitize.ts:8` 只裁 `button/script`，未裁 `style/input/form/iframe` → AC-7 会红；`empty_document` 尚未进 `packages/core/src/hr-error.ts`（`no_article` 倒是已有码）。

**上下文自评：能否接住 F1 验证** — 能：已核 `parse5` 小写归一、`OutlineNode{id,tag,level,text,children}`、`buildOutline` 收容器/排 `h5/h6`、`writeAtomic` 签名、`jsonOk` 信封、`resolveThemePath` 候选链与 `StyleDeps.home` 必填，F1 交付时可按上表逐条跑定向命令；**但**AC-6 与 AC-4 嵌套条款须先由协调者裁定（⑧⑥两条歧义 + AC-2 相对资源），否则我会按现卡面判红而非自造口径。