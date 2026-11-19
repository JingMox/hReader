# hReader 产品巡回测试 · 第 1 轮（R1）台账

> 测试员视角：把 hReader 当已上线产品，第一次当真人用户用。不读 `src/**`，不改仓库（本文件除外）。

## 环境

| 项 | 值 |
| :-- | :-- |
| git HEAD | `28c5c40` |
| node | v24.15.0 |
| pnpm | 11.1.3 |
| macOS | 27.0.1（Build 26A434） |
| Chrome | 157.0.8103.79 |
| `git status --short` | 干净（测试开始时无输出） |

工作目录：`~/hreader-sweep/R1`（本报告外的一切产物都在这里或 `/tmp`）。

## 套件结果（第一步）

| 命令 | 退出码 | 摘要 |
| :-- | :-- | :-- |
| `pnpm verify` | 0 | `Test Files 265 passed (265)` / `Tests 2974 passed (2974)` / `All files 100% 覆盖` / depcruise `no dependency violations found` / knip 无输出 |
| `pnpm desktop:check` | 0 | Rust 单测 81 passed；`connect_recheck` 3 passed；`cargo check` 干净 |
| `pnpm test:e2e` | 0 | `OK: 分页 / A4 / 白底 / 无外链（7 页；抽掉分页规则后 3 页）｜长图 2400×5074、裁剪 2400×4000` |
| `pnpm smoke:pi` | 0 | 真 pi 1.5.2 加载扩展，`/hreader`、`/hr-style` 作为命令被执行；对照组验证非恒真 |
| `pnpm smoke:dsh` | 0（SKIP） | `SKIP 烟测：本机没有可用的 dsh（dsh --version 退出 null）` —— **D2 宿主面本机无法验证** |

结论：**套件全绿**。以下 B 条目全部是「套件绿但产品坏了 / 用户会卡住」的类型。

## A 组 CLI

工作目录 `~/hreader-sweep/R1`；CLI 一律 `node <repo>/skills/hreader/scripts/hr.mjs`。
原料：自写 `demo.html`（657B，无任何 `data-hr-id`，`grep -c data-hr-id` = 0），`long.html`（12 节），`source-doc.html`（手写合法 `data-hr-id`，模拟产品生成的文档）。

### B-01 `hr outline` 对手写 HTML 静默输出空 + 退出 0
- 入口: `hr outline demo.html`
- 复现: 1) 手写一篇无 `data-hr-id` 的 HTML（有 `<article><h1><h2><p>`） 2) `hr outline demo.html`
- 期望: 打印标题树与字数；至少给出「缺 data-hr-id，无法建立骨骼」+ 下一步怎么做
- 实际: stdout 与 stderr **都是空的**，`EXIT=0`（`out.txt` 与 `err.txt` 都是 0 字节）。`--json` 才有 `diagnostics`：
  `{"ok":true,"data":{"nodes":[],"wordCount":103,"diagnostics":[{"code":"outline_node_without_id","severity":"warning","message":"<h1> 缺少合法 data-hr-id，已从 outline 省略"},…]}}`
- 严重度: P1
- 判定依据: SKILL.md「看结构：outline。输出每行 `- <id> <标题> (<字数>)`；没 id 的标题会作为 warning 出现在 stderr」——文本模式既没树也没 warning；`hr --help` 的 `--json` 只是选项，不该是唯一能看到诊断的通道。

### B-02 手写 HTML 无法进阅读器，报错点名用户调不到的内部函数
- 入口: `hr serve demo.html`
- 复现: 1) `hr serve demo.html --port 8899` 2) 同一条加 `--json`
- 期望: 文档能被打开（自动补 id / 给出可执行的一步）；否则至少给出用户能跑的命令
- 实际: `{"ok":false,"code":"invalid_document","message":"<article> 缺少合法的 data-hr-id：模型根 ID 不得为空（输入需先经 injectNodeIds）"}`，`EXIT=1`。`injectNodeIds` 是内部函数，CLI/`--help`/SKILL.md 里没有入口。
  对照：`hr export demo.html --out demo-print.html` 产出的打印稿带齐 18 个 `data-hr-id`、且 `hr serve demo-print.html` 能起服务——说明能力存在，只是没有以「给这份文档补 id」的名义暴露。
- 严重度: P0（E1 要求「有明确入口把它变成可读文档，而不是报错说不合法」）
- 判定依据: `.workflow/sweeps/entrypoints.md` E1；docs/03 §11.55 已把同一现象记为事故（M4.7 用户试用），本轮**仍可复现**。

### B-03 `hr read` 返回的 id 喂回 `hr patch` 一定失败（id 不落盘）
- 入口: `hr read demo.html h1` → `hr patch demo.html <拿到的 id>`
- 复现: 1) `hr read demo.html h1` → `<h1 data-hr-id="hr-0c613625">` 2) `hr patch demo.html hr-0c613625 --action replace --html '<p>x</p>'`
- 期望: 读到的段落能按 SKILL.md 的五原语写回去
- 实际: `找不到 data-hr-id="hr-c51c2ebb" 的元素`，`EXIT=1`；源文件一个字节没动。`read` 是在内存里临时注入 id（`read demo.html --json` 的 `ids` 有 7 个），文件里没有，`patch` 只认文件里的 id。
- 严重度: P1（五原语工作流的第一步就断；SKILL.md「read 是改之前必须读」）
- 判定依据: SKILL.md 五原语工作流 1–4；M1.9 AC5「生成 → outline → read → patch」演练。

### B-04 `hr patch --action replace` 会换掉目标节点自己的 id
- 入口: `hr patch demo-print.html hr-c51c2ebb --action replace --html '<p>…</p>'`
- 复现: 1) 对已有 id 的打印稿替换一段（片段不带 data-hr-id） 2) 再按原 id 做 `insert_after` / 再 patch 一次
- 期望: 被替换节点的 id 保留（M1.1 AC2「已有 `data-hr-id` 保持不变；同一输入两次运行结果一致」），或至少在 `newIds`/输出里明确「旧 id 已失效」
- 实际: 第一次成功：`{"ok":true,"data":{"changed":true,"newIds":["hr-6f3d51cf"],…}}`；随后 `insert_after hr-c51c2ebb` → `找不到 data-hr-id="hr-c51c2ebb" 的元素`，`EXIT=1`。第二次 CLI patch 同样失败（`p-1-1` → 新 id `hr-77d98566`）。文档里 `hr-c51c2ebb` 已消失。
- 严重度: P1（Agent 的「读一次、连续改两处」必挂；批注锚点也指向已消失的 id）
- 判定依据: docs/05 M1.1 AC2；SKILL.md「`replace`：整体替换该节点（含它的子节点）」未提示 id 会变。

### B-05 `hr undo --json` 的 schema 与其它命令不一致（无 `ok`/`data`），错误码与文档不符
- 入口: `hr undo work.html --json`
- 复现: 1) patch 一次 2) `hr undo --json` 3) 再 `hr undo --json`
- 期望: SKILL.md/AC4 约定 `--json` 稳定输出 `{ok,data}` 或 `{ok:false,code,message}`；docs/05 M3.4 约定没有快照时对外一律 `nothing_to_undo`
- 实际: 成功时 `{"path":"…","bytes":11519,"restoredFrom":"…","sha256":"…"}`（**没有 ok 也没有 data**）；失败时 `{"ok":false,"code":"undo_unavailable","message":"没有可回滚的历史快照：work2.html"}`（把内部码 `undo_unavailable` 原样外泄，docs/05 明说不许）。
- 严重度: P1（Agent 按 `ok` 判断成败会读到 `undefined`；`change log` 里 undo 成功会被当失败）
- 判定依据: docs/05 M1.8 AC4、M3.4「核心内部的 `undo_unavailable` **不外泄**——对外一律翻成 `nothing_to_undo`」。

## B 组 阅读器（`hr serve` + 真 Chrome）

「用户手」：`curl` 抓响应；headless Chrome 9333/9334 + CDP（`Runtime.evaluate` 读渲染后 DOM、`Input.dispatchKeyEvent` 发真按键、`Input.dispatchMouseEvent` 拖选）；`screencapture` 取屏看桌面壳。

### B-06 通过 `hr serve` 打印的地址打开是 401 JSON，地址不可用
- 入口: `hr serve demo-print.html --port 8899` → 打印 `serving /Users/liu/hreader-sweep/R1 on http://127.0.0.1:8899/ (pid 28836)`
- 复现: 1) 照打印的原样 `curl -i http://127.0.0.1:8899/` 2) 再 `curl "http://127.0.0.1:8899/?doc=demo-print.html"`
- 期望: 打印的地址点开就是阅读器（B1）
- 实际: `HTTP/1.1 401 Unauthorized` + `{"code":"unauthorized"}`；`/?doc=…` 同样 401。token 只在 `~/.hreader/daemon.json` 的 `token` 字段里，命令行/SKILL/`--help` 都没有教怎么拿 cookie。带上 token 的 `/s/<docId>?t=` 会 302 设置 cookie，但重定向目标是 `/s/<doc>`——该路由返回**原文件字节**（11519B，`content-type: text/html`），不是阅读器 UI；只有手动再访问 `/`（带 cookie）才会 302 到 `/?doc=` 的阅读器外壳。
- 严重度: P0（打印给用户的地址不能用，B1 直接卡死）
- 判定依据: docs/05:145 明确「`GET /` 是 cookie 认证、`/s/:docId` 是 token 认证」；docs/03 §11.55 事故①，本轮**仍可复现**。

### B-07 不带 `--app-dir` 时 `/` 不是阅读器，只有一个 186 字节的链接页
- 入口: `hr serve demo-print.html`（不传 `--app-dir`）
- 复现: 1) 默认起服务 2) 带 cookie 打开 `/`（跟随 302 到 `/?doc=demo-print.html`）
- 期望: 默认就是阅读器
- 实际: body 恒为 `<!doctype html><meta charset="utf-8"><title>hReader</title><h1>hReader</h1><p>当前文档：<a href="/s/demo-print.html">demo-print.html</a></p><p><a href="/api/healthz">healthz</a></p>`（186B，无 script、无书库/目录/批注）；传 `--app-dir <repo>/packages/app/dist` 才拿到 2941B 的阅读器外壳。`--help` 只说 `[--app-dir <dir>]`，没说默认值/去哪找。
  在仓库内、在文档目录、在 `/tmp` 三种 cwd 下默认都是 186B（说明不是 cwd 相对）。
- 严重度: P1（用户按 SKILL/`--help` 跑出来的「阅读器」没有阅读器；需要猜一个包内路径）
- 判定依据: entrypoints B 组整体期望；M1.8 AC6「`--help` 覆盖所有命令与参数」——`--app-dir` 的默认值未覆盖。

### B-08 左栏书库没有文档列表，搜索框禁用，无切换入口
- 入口: 阅读器 `/?doc=demo-print.html`（工作区同时存在 `demo-print.html`、`second.html`、`long-print.html`、`source-doc.html`）
- 复现: 1) 打开阅读器 2) 读 `#hr-library.innerHTML`
- 期望: 看到当前目录下的文档并可点开切换（B2）
- 实际: `#hr-library` 只有 `<h2>书库</h2>`、`<input id="hr-search" disabled title="搜索将在后续卡片启用">`、`<h3>目录</h3><ul id="hr-toc"></ul>`；文档列表 0 项、搜索框 disabled。切换文档只能手改 URL `?doc=`。
- 严重度: P1
- 判定依据: entrypoints B2「看到当前目录下的文档，点开能切」。

### B-09 左栏目录永远为空（0 条），文档自带的打印目录顶替它并撞了同一个 id
- 入口: 阅读器同 B-08
- 复现: 1) 打开 `/?doc=source-doc.html`（12 节，没有打印目录） 2) `document.querySelectorAll('#hr-toc a').length` 3) 打开 `/?doc=long-print.html`（打印稿）
- 期望: 左栏目录列出各节，点击跳转、滚动高亮（B3）
- 实际: 源文档 `#hr-toc a` = **0**；打印稿 `#hr-toc a` = 13，但这些是文档内部 `<nav id="hr-toc" class="toc">` 的条目（打印稿自带目录也用了 `id="hr-toc"` → 与外壳的 `<ul id="hr-toc">` **重复 DOM id**）。外壳的 `ul#hr-toc` 高度 0、无子节点。滚动到 1200px 后 `aria-current`/active class 数量均为 0。
- 严重度: P1
- 判定依据: entrypoints B3；另：同一页面出现两个 `id="hr-toc"`，`document.querySelector('#hr-toc')` 命中的是外壳那个空 ul。

### B-10 `j` / `k` 不生效（`h` 生效）
- 入口: 阅读器，正文 5500–6800px 高
- 复现: 1) 打开 `/?doc=source-doc.html` 2) 用 CDP `Input.dispatchKeyEvent` 发真实 `j`、`k`（也试过点选段落后再发） 3) 观察 `scrollY`、`activeElement`、任何 current 类
- 期望: 上下节导航（B5）
- 实际: `j`×2、`k` 后 `scrollY` 恒为 0，`activeElement` 恒为 `BODY`，无任何 current/active 类。对照组：同一通道发 `h` 立刻给 `#hr-canvas` 加 `canvas--focus`，说明按键通道本身是通的。
- 严重度: P1
- 判定依据: entrypoints B5；footer 自己写着「j/k 移动 · h 高亮 · c 旁注」。

### B-11 中栏只有主题下拉，没有字号/行宽可调；主题下拉只有一项
- 入口: 阅读器 `#hr-controls`
- 复现: 1) 打开阅读器 2) 读 `#hr-controls` 与 theme 接口
- 期望: 正文按主题渲染，字号/行宽可调（B4）
- 实际: 只有 `<select id="hr-theme-select"><option value="atelier-editorial">` 与一个「专注」标签；没有字号/行宽控件。`GET /api/theme`（带 cookie）= `{"themes":["atelier-editorial"],"default":"atelier-editorial"}`，仓库 `styles/` 也只有 `atelier-editorial`（docs/05 M1.6 AC5 说的 3 个预设 tone 是 tone，不是 visual）。
- 严重度: P2
- 判定依据: entrypoints B4「字号/行宽可调」。

### B-12 划词后没有批注入口，提交空转；批注面板自己写着「M2.3 启用」
- 入口: 阅读器正文划词（CDP 真鼠标 drag，选中 44px 高的一段）
- 复现: 1) 打开 `/?doc=source-doc.html` 2) 用真鼠标从段首拖到段中 3) 查 `#hr-note-btn.hidden` 4) 点按钮、填 `#hr-note-draft`、点 `#hr-note-submit`
- 期望: 出现批注入口，写下的批注落成页边注（B6/B7）
- 实际: 选区确实存在（`getSelection()` 非空，锚点块 `data-hr-id="p-1-1"`），但 `#hr-note-btn` 始终 `hidden=true`、`display:none`；强行 `.click()` + 填文本 + 提交后 `#hr-note-error` 空、`#hr-notes-pending` 空、页面无 `mark`/`sidenote`，源文件 `grep -c hr-meta` = 0。面板文案：`本章有 0 条批注（M2.3 启用）`。`c` 快捷键（footer 宣称「c 旁注」）无反应。
- 严重度: P1
- 判定依据: entrypoints B6/B7；SKILL.md 说「选中的段落可写批注」。注：面板自称 M2.3 未启用，但入口清单把它当已可用功能——**记账归「承诺了但没入口」**。

### B-13 Agent patch 后页面不热更新、无闪烁、无 Undo
- 入口: 阅读器开着 `?doc=source-doc.html`，另一侧 `hr patch source-doc.html p-1-1 --action replace --html '<p data-hr-id="p-1-1">…</p>'`
- 复现: 1) 打开阅读器 2) CLI patch 成功（`changed:true`） 3) 等 3s 读 DOM → 仍是旧文本、`#hr-hint` 空、无 flash/undo 按钮 4) 手刷后才出现新文本
- 期望: 变动节点闪烁高亮 + 一键 Undo（B8）
- 实际: 页面上什么都不变（旧文本 `第 1 节第 1 段：这是一段用于撑开页面高度的正文…`），只能刷新。`GET /api/events` 订阅 8s 只收到一帧 `data: {"type":"ready"}`，CLI 写入没有产生 `doc.changed`。
- 严重度: P1
- 判定依据: entrypoints B8；docs/02:243「订阅本地 Daemon 的 SSE 事件流」。

### B-14 `hr serve` 第二次启动被全局单例挡住，退出码 2，且不教怎么停
- 入口: 已有 daemon 时 `hr serve other.html --port 8898`
- 复现: 1) 起一个 serve 2) 换端口/换文档再起
- 期望: 起第二个服务，或明确告诉用户「先停掉 8899 上那个（命令是 …）」
- 实际: `已有 daemon 在 127.0.0.1:8899 运行`，`EXIT=2`（`--json` 时 stdout 是 `{"ok":false,"code":"daemon_already_running",…}`、stderr 又把同一句打一遍）。退出码 2 在 SKILL.md 里是「用法错误」，这里其实是运行时状态。CLI 没有 `stop`/`status` 子命令，只能 `kill` pid。
- 严重度: P2
- 判定依据: SKILL.md 退出码表；`hr --help` 无 `stop`。

### B-15 `hr serve` 拒绝 cwd 之外的绝对路径，报错泄露内部相对路径
- 入口: 在仓库根 `hr serve /tmp/sweep-r1/demo-print.html`
- 复现: 直接跑上面这条
- 期望: 服务该文件，或提示「cd 到文档目录再跑 / 用 --workspace」
- 实际: `` `file` 逃出了 workspace：../../../../../private/tmp/sweep-r1/demo-print.html ``（`EXIT=1`）。`--help` 把 `--workspace` 描述为「patch/style --visual 用」，serve 没有这个选项；用户带着绝对路径必撞。
- 严重度: P2
- 判定依据: `hr --help` 通用选项说明与 serve 的可用参数不一致。

### B-16 `style --lint` 文本模式不给 offset；`--visual <tone-id>` 静默 unchanged
- 入口: `hr style lint-me.html --lint`；`hr style styled.html --visual feynman-tech`
- 复现: 1) 在正文插入「赋能」 2) `--lint` 3) 再 `--visual feynman-tech`
- 期望: SKILL.md「命中禁用词会给出 `offset`（块内字符偏移）和上下文」；`--visual` 用不存在/不匹配的 id 应报错
- 实际: 文本输出 `hr-bb69d435: 赋能 — 我们稳步推进，赋能团队，把评审拆成「必须」与「可以…`（**没有 offset**；`--json` 里才有 `"offset":7`）。`--visual feynman-tech`/`--visual executive-brief` 都输出 `unchanged … (18279 bytes)`、`EXIT=0`（这两个是 tone id，只有 `--visual nope` 才报「四个来源都找不到风格」）。用户会以为主题换了。
- 严重度: P2
- 判定依据: SKILL.md 禁用词一节；`hr style --help` 未说明 `--visual` 与 `--tone` 的 id 空间不同。`--visual <tone-id>` 具体为何为 unchanged 需读实现 → `NEEDS_CODE_READ`。


### B-17 阅读器外壳（无 `--app-dir`）里的 `healthz` 链接是 404
- 入口: B-07 那个 186B 页面的第二个链接
- 复现: 1) `hr serve demo-print.html` 2) `curl http://127.0.0.1:8899/api/healthz`（带 cookie，因为不带 cookie 先被 401 挡住）
- 期望: 打印出来的链接能用（entrypoints「凡是打印给用户的地址/命令不能再要用户猜」）
- 实际: 带 cookie 后 `{"code":"not_found"}`；真正可用的是 `/healthz`（`{"ok":true,"uptimeMs":…,"pid":…}`）。桌面壳 README 里等的也是 `/healthz`。
- 严重度: P1
- 判定依据: 同上；与 B-06/B-07 同源（默认外壳是半成品，但它被当作「打开地址就能进阅读器」的兑现物）。

## C 组 MCP（stdio 手搓 JSON-RPC）

驱动脚本 `/tmp/sweep-r1/mcp*.mjs`（子进程 `node packages/mcp-server/dist/main.js`，逐条发 `initialize` → `tools/list` → `tools/call`，读回包）。工作目录 `/tmp/sweep-r1/mcp-ws`。

- `initialize` 回 `serverInfo {name:"hreader",version:"0.0.0"}`，`protocolVersion` 正常协商。
- `tools/list` 回 7 个工具：`hr_create_doc`、`hr_outline`、`hr_read_node`、`hr_patch_node`、`hr_undo`、`hr_apply_style`、`hr_resolve_annotation`。
- 逐个 `tools/call` 各一次：**7 个工具全部返回 `isError:false` 且结构符合 `{ok,data}`**；`hr_create_doc` 落盘成功（`records/doc-*.html`），`hr_outline`/`hr_read_node` 能读到它，`hr_patch_node` 改后 `hr_read_node` 读到新内容，`hr_undo` 回滚成功。**C 组无缺陷**。
- **C8 未兑现**：`initialize` 回包里没有 `prompts` capability，`prompts/list` 返回 `error {code:-32601,message:"Method not found"}`。entrypoints C8 期望「语言风格 Prompt 可直接选」。→ B-18（P2，Agent 宿主里选不到 prompt，但主链路可用）。
- **C9 未兑现**：`initialize` 的 `capabilities` 只有 `tools`，没有 `resources`；`resources/list` 也是 `-32601`。entrypoints C9 期望「内联阅读器视图能被宿主渲染」。→ B-19（P2）。
- 顺带：`tools/call` 对未知工具名回 `isError:true` + 文本 `未知工具`，不是 JSON-RPC error——合理。

### B-18 MCP 不暴露 prompts（C8 承诺落空）
- 严重度: P2 ｜ 判定依据: entrypoints C8；docs/02 把「Prompt 注册」列为集成面之一。

### B-19 MCP 不暴露 resources / MCP-UI（C9 承诺落空）
- 严重度: P2 ｜ 判定依据: entrypoints C9。

## D 组 集成面

### B-20 桌面壳按默认方式双击启动：GUI 永不出现，错误只进 stderr
- 入口: `packages/desktop/src-tauri/target/release/bundle/macos/hReader.app`（仓库里已构建好的产物）
- 复现: 1) 直接跑 `Contents/MacOS/hreader-desktop --home /tmp/sweep-r1/apphome --workspace ~/hreader-sweep/R1` 2) 再 `open -n hReader.app`
- 期望: D3「拉起 daemon + webview」，冷启动看到窗口
- 实际: `找不到 hr CLI：装一下 @hreader/cli，或用 --cli-path / HREADER_CLI 指定` → 进程**立刻退出**（`pgrep` 空、`daemon.json` 不存在、`System Events` 里没有窗口）。用 `open -n` 时这条信息**任何地方都看不到**（Finder 用户看不到 stderr），表现为「点了图标什么都没发生」。
  根因可观测证据：仓库没有 `bin` 字段（`package.json` 无 `bin`）、`skills/hreader/scripts/hr.mjs` 模式是 `-rw-r--r--`（不可执行）、`node_modules/.bin` 里没有 `hr`——即**这个仓库没有任何一步会装出 `hr` 命令**，而壳的默认定位链是 `--cli-path` > `HREADER_CLI` > `PATH`。
- 严重度: P1
- 判定依据: D3；`packages/desktop/README.md` 第 2 步。

### B-21 桌面壳首次启动被 macOS 文件权限弹窗卡住，且弹窗与 workspace 无关
- 入口: `open -n hReader.app --args --home /tmp/sweep-r1/apphome4 --workspace /tmp/sweep-r1/ws-clean`（workspace 在 `/tmp`，不在文档目录）
- 复现: 如上；随后 `screencapture` 取屏
- 期望: 直接出窗口
- 实际: 屏幕上是一个系统弹窗 **“hReader.app” would like to access files in your Documents folder.**（按钮 Don't Allow / Allow），窗口始终没出现；`pgrep` 显示进程活着、`System Events` 回 `background only = false` 但 `name of every window` 为空、`daemon.json` 未生成。用脚本点 Allow 无效（TCC 弹窗不在可脚本化的窗口层），只能人手点。
  用户视角：装好、双击、看到「要访问你的文档」——而他说不出为什么（他打开的是 `/tmp` 里的文档），此时三个方向（拒绝/允许/关弹窗）都不会给他任何反馈。
- 严重度: P1
- 判定依据: D3；排查方向 `NEEDS_CODE_READ`（为什么 workspace 在 `/tmp` 仍触发 Documents 的 TCC 请求：是否读了默认 home 之外的路径）。

### B-22 桌面壳被 kill -9 后 daemon 留成孤儿
- 入口: 壳正常起来（`HREADER_CLI=/tmp/sweep-r1/hr`，daemon 起来了，`daemon.json` 有 `pid 31432`）
- 复现: 1) 记下壳 pid 与 daemon pid 2) `kill -9 <壳 pid>` 3) 等 3s / 再等 5s
- 期望: D4「daemon 跟着退，不留孤儿」（壳自己给 daemon 传了 `--exit-with-parent`）
- 实际: 壳死后 **8s 内 daemon 仍在跑**（`pgrep -fl "hr.mjs"` 仍有 `31431 node …/hr.mjs serve demo-print.html … --exit-with-parent --port 0`），端口 65283 仍可用、`/healthz` 回 `{"ok":true,…}`。必须手动 `kill` 才消失。
  影响：用户强退壳（或壳崩）后，端口和 daemon 常驻；下一次启动虽然能复用，但用户以为「已经关掉了」。
- 严重度: P2（不阻断，但「退出不干净」会被用户当成后台偷跑）
- 判定依据: D4；`--exit-with-parent` 的实现在 `NEEDS_CODE_READ`（是 ppid 轮询还是 prctl/PDEATHSIG 一类，为什么 SIGKILL 没生效）。

### B-23 Chrome 扩展在仓库里是空包（无 manifest、无源码、无构建）
- 入口: `packages/chrome-extension`（entrypoints D5「在浏览器里把网页丢给 hReader」）
- 复现: `ls -R packages/chrome-extension`；`cat package.json`；`grep -rn chrome-extension pnpm-lock.yaml`
- 期望: 有可加载的 `manifest.json`（或至少 `build` 脚本产出 unpacked 目录）
- 实际: 目录里**只有 `package.json`**（`{name:"@hreader/chrome-extension",version:"0.0.0",private:true,type:"module"}`），没有 `manifest.json`、没有 `scripts`、没有产物；仓库文档（docs/01、docs/02、docs/05）也没有这项的卡片。Chrome「加载已解压的扩展程序」指过去会直接报错。
- 严重度: P1（清单承诺的入口在仓库里不存在；用户无法安装）
- 判定依据: entrypoints D5；无法装 = 无法验证功能，故同时记入「未覆盖」。

### D 组其余项
- **D1 Pi 扩展**：`pnpm smoke:pi` 绿（真 pi 1.5.2 加载 `packages/pi-extension/pi-hreader.ts`，`/hreader`、`/hr-style` 均被执行，且带对照组证明非恒真）。**通过**。未做的部分：没在真 pi 会话里手动敲 `/hreader` 看输出形态（烟测已覆盖命令被调用，交互体验未评）。
- **D2 DSH**：`pnpm smoke:dsh` 直接 `SKIP`（本机 `dsh --version` 不可用）→ **无法在本机验证**，原因：没有 dsh 宿主。
- **D6 SKILL.md**：按文档命令逐条跑过（见 A 组）。结论：SKILL.md 的**命令写法本身可执行**（全部用 `node skills/hreader/scripts/hr.mjs`，无 `hr` 前缀），但文档承诺的「五原语工作流」在第 1→2→3 步就断（B-01 无 warning、B-03 read 的 id 喂不回 patch、B-04 replace 换掉自己的 id），Agent 严格照做会连续失败三次。

## E 组 非功能面

工作目录 `~/hreader-sweep/R1` 与 `~/hreader-sweep/R1/E`（大文件产物在 `/tmp/sweep-r1/E`）。

### B-24 `hr export` 不幂等：对同一文档重复导出，标题里的序号会一层层叠加
- 入口: `hr export demo-print.html --out re1.html` → `hr export re1.html --out re2.html` → 再一次
- 复现: 连跑三次 export（用户很自然会做的事：改完再导一次），每次拿上一次的输出当输入
- 期望: 同样的内容导出结果一致；序号只出现一次
- 实际: 三次的 `<h1>` 依次是
  1. `<h1 data-hr-id="hr-0c613625" id="sec-1"><span class="secnum">1 </span>季度复盘：把发布节奏拉回来</h1>`
  2. `…<span class="secnum">1 </span><span class="secnum">1 </span>季度复盘…`
  3. `…<span class="secnum">1 </span><span class="secnum">1 </span><span class="secnum">1 </span>季度复盘…`
  即每导出一次就把已有 `secnum` 再包一层，读者看到的是「1 1 1 季度复盘」。`pdf`/`png` 是否复用这条导出链**未验证**（未做跨命令产物比对），但「导出 → 再导出」这条路径本身已足够触发。
- 严重度: P1（得到错产物，且是「再导一次」这种最常见的动作触发）
- 判定依据: docs/05 M1.1 AC2「同一输入两次运行结果一致」；entrypoints E8「产物在别处打开，版式不塌」——这条是内容级的塌。

### B-25 目录只读时，错误信息点名内部锁目录，不说是权限问题
- 入口: `chmod 555` 目录后 `hr patch doc.html …`
- 复现: `mkdir ro && cp source-doc.html ro/ && chmod 555 ro && cd ro`，跑 patch / export / undo
- 期望: 「无法写入 <文件>：目录只读」这类可操作提示
- 实际: patch/undo → `建目录失败：/private/tmp/sweep-r1/E/ro/.hreader/locks`（`EXIT=3`）；export → `原子写失败：/private/tmp/sweep-r1/E/ro/out.html`（`EXIT=3`）。用户看到的是 `.hreader/locks` 这个他完全不知道的东西，也没被告知「是权限不足」。
- 严重度: P2
- 判定依据: entrypoints E6「明确报错，不静默失败」——不静默，但不可操作。

### B-26 `chmod 444` 的文件被 CLI 静默改写，权限被改成 644
- 入口: `chmod 444 ro-file.html; hr patch ro-file.html p-1-2 --action replace …`
- 复现: 如上
- 实际: `patched …/ro-file.html (13300 bytes, +1 ids)`、`EXIT=0`，随后 `ls -l` 显示 `-rw-r--r--`（444 → 644）。写是通过「临时文件 + rename」实现的，绕过了只读位，也不保留原权限。
- 严重度: P2（用户以为设了只读就安全；更常见的影响是 umask/权限位被悄悄改掉）
- 判定依据: entrypoints E6「权限不足 → 明确报错」；这里既没报错也没保住权限。

### B-27 空文件 / 纯文本：`outline` 退出 0 且输出全空；`read` 把内部异常类名 `HrError:` 打给用户
- 入口: `hr outline empty.html`、`hr outline plain.txt`、`hr read empty.html p`
- 复现: `: > empty.html`；`printf 'just plain text' > plain.txt`
- 期望: 明确说「这不是文档 / 没有 <article>」，退出码非 0
- 实际: `outline` 对两者**输出 0 字节、`EXIT=0`**（与 B-01 同源）；`read empty.html p` 打 `读取目标 "p" 失败：按选择器 → 选择器 "p" 没有匹配到任何节点；按 node id → HrError: 选择器 "[data-hr-id=\"p\"]" 没有匹配到任何节点`（`EXIT=1`，内部类名 `HrError:` 外泄）。对照：`serve`/`export` 对同两个文件的提示是好的（`文档里没有 <article>：无法派生文档模型` / `源文档里没有 <article>，无法导出打印稿`，`EXIT=1`）；非法 UTF-8 也给清楚的 `not a valid UTF-8`（`EXIT=3`）。
- 严重度: P2
- 判定依据: entrypoints E2「明确错误 + 可操作提示，不泄栈」。

### B-28 端口占用只检测 IPv4；JSON 模式把端口冲突报成 `daemon_already_running`
- 入口: `python3 -m http.server 8891 --bind 127.0.0.1`（占 IPv4）与 `python3 -m http.server 8890`（仅占 IPv6 `*:8890`）两种情况
- 复现: 分别占用后 `hr serve demo-print.html --port <n>`
- 期望: 端口被占 → 一句明确报错；不要和「已有 daemon 在跑」混为一谈
- 实际:
  - IPv4 被占：`端口 8891 已被占用`、`EXIT=2`；`--json` 时 stdout 是 `{"ok":false,"code":"daemon_already_running","message":"端口 8891 已被占用"}`，stderr 又重复一遍同一句。code 与实际原因不符（用户查文档看到 `daemon_already_running` 会去删 daemon.json，但那儿根本没有）。
  - IPv6-only 被占：hr **绑定成功**（`serving … on http://127.0.0.1:8890/`，`lsof` 显示 `node … TCP 127.0.0.1:8890` 与 `Python … TCP *:8890` 并存），`daemon.json` 记 `"port":8890`——两个程序共用同一个端口号，谁在不同地址族上访问就得到不同站点。
- 严重度: P2
- 判定依据: entrypoints E6。

### B-29 陈旧 `daemon.json`（pid 指向别的进程）会让 `hr serve` 永久拒绝启动
- 入口: 手工把 `~/.hreader/daemon.json` 写成 `{"port":8891,"token":"x","pid":<python 的 pid>,"workspace":…}`（模拟上次崩溃/pid 复用/别的工具留下的文件）
- 复现: 写入后 `hr serve demo-print.html --port 8895`
- 期望: 探测到那个端口上不是 hReader，就删掉陈旧记录并启动
- 实际: 只说 `已有 daemon 在 127.0.0.1:8891 运行` 就退出；8891 上其实是 Python，`pid` 是别人的进程。用户没有任何 CLI 手段清它（没有 `stop`/`status`，见 B-14），只能自己去 `~/.hreader` 删文件。
  对照：pid 是**死的**（`999999`）时能正常启动 8895，说明它只判断进程存活、不校验对方是不是自己。
- 严重度: P1（起不来看不到原因，且无法用产品自身手段恢复）
- 判定依据: entrypoints E6/E7；B-14 的「没有 stop/status」放大了这条。

### E 组其余项（通过 / 观察）
- **E3 超大 + 深嵌套：通过**。`big.html`（851740 B，200 节 × 20 段）：`outline` 0.18s、`read p-200-20` 0.16s、`export` 0.24s、`pdf` 2.95s → 306 页 / 201 条书签 / 1.5MB。`deep.html`（700 层 div）：`outline` 0.14s、`read deep` 0.14s（`<p data-hr-id="deep">最深的一段</p>`）。无卡死、无 OOM。
- **E4 Unicode / 文件名：基本通过**。`中文文档.md.html`、`crlf 文档.html`（含空格的 CJK 文件名）都能 outline/read/export；emoji 🚀😀🎉 与全角标点往返无损（打印稿里 🚀 出现 4 次）。
  观察：CRLF 源（6 个 CRLF、0 个裸 LF）导出后变成 **0 CRLF / 467 裸 LF**（`file` 从 "with CRLF line terminators" 变为无该后缀）；`patch` 则**保留** CRLF（改后仍 6/0）。→ 记 B-28 之外的观察，严重度 P2（换行统一通常可接受，但与 patch 的行为不一致）。
- **E5 并发：文件不坏，但行为不可预期**。两个 CLI 同时 patch 不同节点：3 次重复实验里两边都返回 `patched`，最终文件里两处修改**都在**（`AA=1 BB=1`），无半写、无损坏。同一节点 5 并发：1 个成功、4 个报 `找不到 data-hr-id="p-3-2" 的元素`——原因是第一个成功的 `replace` 换掉了 id（B-04），不是并发本身。
- **E7 kill -9 daemon：能自愈，但有残渣**。`kill -9` 后 `daemon.json` 仍留在 `~/.hreader`（pid 已死）、`.hreader/locks` 无残留锁、文档本身完好（`hr outline demo-print.html` 正常）。端口空出后重启成功（`serving … (pid 32811)`）。但残留的 `daemon.json` 一旦 pid 被别人复用就变成 B-29。
- **E8 产物在别处打开：通过**。把 `demo-print.html` / `out.pdf` / `out.png` 拷到 `/tmp/sweep-r1/E/elsewhere` 后，用真 Chrome 以 `file://` 打开：`{title:"季度复盘：把发布节奏拉回来", chars:199, imgs:0, failedImgs:0, sheets:2, scripts:0, external:[], bodyBg:"rgb(255,255,255)", fontSize:"14.6667px"}`——无外链、无 script、样式内联、白底。PDF 的 UTI 是 `com.adobe.pdf`；PNG 2400×1758 正常。

## 试过但没打穿（下一轮的盲区线索）

- 并发写：两个 CLI 同时 patch 同一文件的不同节点，3 次重复都是**两边都成功、两处修改都在**（无半写、无丢更新）。同一节点 5 并发只暴露出 id 被换掉（B-04），不是文件损坏。
- 大文档：851KB / 4000+ 节点的 `big.html` 在 outline/read/export/pdf 下全部亚秒到 3s 级，没找到能拖死它的输入。
- 深嵌套：700 层 `<div>` 无栈溢出、无卡死。
- 非法 UTF-8（2000B 随机字节）：outline/read/serve/export 一致给出 `不是合法 UTF-8`、`EXIT=3`，没泄栈。
- `file://` 打开导出产物：无外链、无 script、样式内联、白底黑字，Chrome 里 0 张图失败。自包含性是过的。
- 目录只读：报错文本不友好（B-25）但**没有**留下半写产物，也没有静默成功。
- XSS/注入方向（未做）：正文含 `<script>`、`onerror=` 的文档未测，属于下一轮该补的攻击面。

## 未覆盖

| 项 | 原因 |
| :-- | :-- |
| **D2 DSH 集成** | 本机没有 dsh 宿主（`dsh --version` 不可用），`pnpm smoke:dsh` 自行 SKIP。**无法在本机验证。** |
| **D5 Chrome 扩展** | 仓库 `packages/chrome-extension` 只有 `package.json`，无 `manifest.json` 可加载（B-23）。装不上 = 功能无法验证。 |
| **D1 Pi 交互体验** | 烟测证明 `/hreader`、`/hr-style` 在真 pi 1.5.2 里被执行，但没在真会话里手动敲命令看输出形态与排版。 |
| **C8 / C9** | MCP 不暴露 prompts/resources（B-18/B-19），无从验证「宿主里选 Prompt」「内联视图渲染」。 |
| **PDF/PNG 内容级校验** | 只验了页数/书签数/像素尺寸/文件可打开，没做文字抽取比对（无法确认排版细节与导出链复用）。 |
| **跨平台** | 只在 macOS 27.0.1 上跑；Windows/Linux、Safari/Firefox 未测。 |
| **批注全链路** | 入口根本不存在（B-12），无法继续测「批注落盘 → MCP `hr_resolve_annotation` → 回写」。 |
| **滚动目录高亮 / j/k** | 入口存在但功能不生效（B-09/B-10），无法测边界（首节、末节、快速连按）。 |

## 摘要

- **套件全绿**（`pnpm verify` 265 文件 / 2974 测试、100% 覆盖；`desktop:check` 81 测试；`test:e2e` 分页 A4 正确；`smoke:pi` 真宿主通过；`smoke:dsh` 本机 SKIP）。**下文缺陷全部是「套件绿但产品坏」**。
- 台账共 **29 条 B 条目**：P0 × 2、P1 × 16、P2 × 11。
- **P0 清单**：
  1. **B-02** 手写 HTML（无 `data-hr-id`）无法进阅读器，报错点名内部函数 `injectNodeIds`——用户的第一件事就撞墙。
  2. **B-06** `hr serve` 打印的地址打开是 `401 {"code":"unauthorized"}`——打印给用户的地址不可用。
- 主线断点：`outline` 对手写 HTML 静默空输出（B-01）→ `read` 的 id 喂不回 `patch`（B-03）→ `replace` 换掉自己的 id（B-04）→ `export` 不幂等、序号叠加（B-24）。即 SKILL.md 承诺的「读改导出」三步里没有任何一条能连成线。
- 阅读器壳（`--app-dir packages/app/dist`）能渲染正文与主题，但书库空（B-08）、左栏目录空且与文档自带目录撞 id（B-09）、j/k 无效（B-10）、划词无批注入口（B-12）、Agent 改动不推送不闪不 Undo（B-13）。
- 集成面：MCP 7 工具全通（C 组无缺陷），但 prompts/resources 未暴露（B-18/B-19）；桌面壳双击无窗口（B-20）、被 TCC 弹窗卡住（B-21）、kill -9 后 daemon 成孤儿（B-22）；Chrome 扩展是空包（B-23）。
