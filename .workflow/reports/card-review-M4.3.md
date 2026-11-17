## Review

### 事实核验
- ✅ 实：`packages/renderer-html/` 只有 `package.json`（无 `src`/`tests`/build）；根 `package.json` devDeps 逐字相符；`COMMAND_NAMES`（`packages/cli/src/usage.ts:3`，本身是 `export const`）确无 `export`；`theme.css` 恰 244 行、`@media print` 在 `:225-244`；`core/src/index.ts:5` 三函数与 `:9` 类型、`core/src/ops/index.ts:3` `buildOutline`；`.gitignore:4`、`packages/mcp-server/package.json:11` 的 `cpSync`；`#hr-toc`/`#hr-toc-title` 在 `packages/app/static/index.html:16-17`。
- ❌ 不实（P2 事实错误，合并报）：`styleDeps.ts` 哨兵实为 **`:23`**（卡写 `:21`）、候选顺序实为 **`:30-33`**（卡写 `:31-34`）；`tocSpecs` 实为 **`library.ts:12-20`**（卡写 `:14-25`）；`SYNOPSIS` 数组起于 **`usage.ts:18`**（卡写 `:22`）；`.hr-sidebar/.hr-toc-toggle/.hr-mode-toggle` 在 `packages/app` **全仓 0 命中**（只在 `theme.css:73/220/226-228` 当死选择器），"宿主选择器已存在"不成立；`[data-hr-ui]` 全仓 0 命中，D9 却当既有契约；`docs/demo.html` **不存在**（全仓无 `demo*.html`，AC-1 无法照抄执行）；`docs/05-tool-contracts.md` **不存在**（真文件是 `docs/05-feature-cards.md` 的"使用节"）；`docs/02` 里 M4.3 实际列在 M4.2（`:346`）与 M4.x（`:347`）**之后**（`:348`），§8"列在其之前"反了；D2 引的 `L-16/L-17` 内容是 ajv shim 与 knip entry，**与"产物可复现"无关**；`docs/03` 有**两个 §11.21/§11.22**（`:554/:567` 与 `:652/:660`），D11 的引用号有歧义。

### Finding
- **P1** D5+AC-4 的计数等式与 `buildOutline` 语义不符：`section`/`header` 也进树（`core/src/ops/outline/constants.ts:6`、`:47` 注释"无标题则继承父级、顶层记 0"），而 h5/h6 被 `level <= OUTLINE_DEPTH_LIMIT` 排除（`walk.ts:200`）→ "`<h1..h6>` 数 = outline 节点数"对任何真实文档都假，无法通过。改为"outline 节点中 `tag` 为 heading 的计数"，并单独排 section/header。
- **P1** AC-5 的"越级记 `1.1.1`"不唯一：按树深（容器节点也加一层）与按 `level` 差自增给出不同结果，两种都"符合描述"；且 level=0 的 section 编号未定义。补一句口径（"编号只由 heading 节点的 `level` 决定，容器不参与"）。
- **P1** AC-2 与 AC-6 直接对撞且检查对象未写清：AC-6 允许 `attr(href)::after`，AC-2 要求产物 `grep -c 'https\?://'` = 0 —— 正文凡有 `<a href="http…">` 必然 >0。写明"AC-2 只对无外链 fixture + 只查 `<link|src=|@import|url(` 属性面；渲染出纸面的 URL 文本不计"。
- **P1** D12 的 `--json` 形状不符既有 envelope：`output.ts:35` 是 `{"ok":true,"data":<payload>}`，`dataRead`（`:59`）返回**内层** payload，全仓 payload 无 `kind` 键（`grep kind` 只在 intent/args）。D12 自称"与 dataRead/jsonOk 同形"为假；应按 `jsonOk('{"out":…,"bytes":…}')` 写。
- **P1** `empty_document` 是**新** `HrErrorCode`（`core/src/hr-error.ts:5-38` 无此码），与 AC-8"沿用既有码、不新造"矛盾；且 `exit-codes.ts:15-48` 是 `satisfies Record<HrErrorCode,number>` 的穷尽表，新增码必须连 core 公开面一起改，F1–F4 一个都没列。
- **P1** D7/AC-8 把主题读取指向 `packages/mcp-server/src/styleDeps.ts`，但 core 已导出正好干这事的 `loadThemeCss`/`resolveThemePath`（`core/src/style/theme.ts:24/44`，`index.ts` 已导出，含 `unknown_style`/`style_io_failure` 文案与 `assertThemeSafe`）。照卡做会新增 `cli→mcp-server` 跨包边、复制候选链（L-21 同款债），并**绕过 `assertThemeSafe`**（`core/src/style/css.ts:69`，拦 `</style>` 逃逸与非本地 `url()`）= 真 XSS 面。改：`loadThemeCss(id, nodeStyleDeps(workspace))`。
- **P1** D10 的"core 既有原子写"不可达：`writeAtomic` 在 `core/src/io/atomic.ts:102`，但 `io/index.ts:10-14` 与 `core/src/index.ts` 都没导出它；要么授权加导出（记 docs/02 §5.2 极小导出面），要么改写落盘方案。
- **P1** F3 文件清单缺解析层：`--out/--force/--visual` 的 argv→intent 在 `args-extract.ts` 式新解析器 + `intent.ts` union + `args.ts` dispatch（`hr` 命令表也要加 `export`），F3 只写 `usage.ts`+`exportPrint.ts`+`run.ts` —— 正是 §10.5 M2.2 `--app-dir`"flag 写了解析器不认"的复刻。
- **P1** D11 与 §6.1 确自相矛盾：§6.1 要求每条 AC-6 规则至少一条真 Chrome 断言，D11 允许"缺 Chrome 就 SKIP 且退出 0"，又不要求留真跑记录 → 允许"从未真跑"结卡，正是 `docs/03:567-582` §11.22 的形态。补："SKIP 时测试员不得签核 AC-6，SKIP 文案必须带可执行安装命令"。
- **P1** F4 的 `scripts/print-e2e.mjs` 会打红 knip：根 workspace entry 只收 `scripts/**/*.ts`（`knip.json` `"."`），且现有 smoke 全是 `.ts`。改 `.ts` 并加 `smoke:print` 脚本。
- **P2** D1 的立论引已废止口径：`execution-manual.md` §10.10 明写"'不新增任何依赖'废止"，而 D1/§5 仍以"零新工具链"为策略要求；应改写成"本卡自查不需要"。
- **P2** D2 的确定性口径盖不住"用户目录主题覆盖"（core 候选顺序是用户目录优先，`core/src/style/theme.ts:19-22`）：同一 `--visual` 在另一台机器上会取 `~/.hreader/styles/...` → 字节不同；AC-3 只换 cwd 不换 HOME。
- **P2** 封面/目录/`section.chapter` 的**内容来源**无裁定（标题取自 `<title>`？首个 h1？文件名？）—— D2 禁时间戳后封面还剩什么，卡没写，AC-1 只说"可见三段"。

### 建议补进卡里的 AC
- 异常输入三态：空 `article`（→ `empty_document` 且不写盘）、纯标题无正文（不许退 `empty_document`）、4 MiB 边界**两侧**（`limit-1` 产出、`limit+1` 报错，按 §10.8 一律测"边界±1"）。
- 同名 h2 出现两次时 `data-toc-id`/`id="sec-<n>"` 不冲突（按 outline 序自增）；文档已带合法 `data-hr-id` 必须**逐字保留**（`html/inject.ts:121-123` 幂等），非法 `data-hr-id` 被改写并留诊断。
- 主题注入前必过 `assertThemeSafe`：用含 `</style>` 与 `url(http://…)` 的主题 fixture 断言 `invalid_theme`，且产物里 `<script` 仍为 0。
- 源文档里的 `on*=` / `href="javascript:"` 属性面：AC-7 只测 `button/script/.hr-sidebar/[data-hr-ui]`，需另测"危险属性/协议被裁或转义"。
- `--json` 用 `{"ok":true,"data":{…}}` envelope，`bytes` 与 `statSync().size` 交叉核对（§6.2），`sections` 定义写死。
- `--out` 相对/绝对路径在 Windows 分隔符下仍在 workspace 内（`isInside` 口径）。

### 挡不住的坏法
1. 源文档 `<a href="https://…">` 或 `<img src="http…">` 残留 → 纸面 URL 渲染 OK，但"自包含"叙事破了；AC-2 现在是假红/假绿的同一处，挡不住。
2. 用户目录主题带 `</style><script>` 逃逸 → 除非走 `assertThemeSafe`，AC-2 的 `grep` 在仓库主题上永远绿，挡不住。
3. 换机器/换 HOME 用同一 `--visual` 印出不同字节 → AC-3 只换 cwd，挡不住。
4. 超大文档（3.9 MiB）拼接 `O(n²)` 或 `⌘P` 时 Chrome 卡死/截断分页 → 无任何量级断言，挡不住。
5. `<article>` 里未包 `<section>` 的正文在跨页处被切断（无 `break-inside` 兜底）→ AC-6 只断言"声明存在"（§6.1 已自知），只靠 D11 人工旁证，挡不住。

上下文自评：能接住 F1 审计——卡的 D1–D12 与 core/cli/app 真实接缝已逐条核过，剩两件须协调者代跑：`pnpm verify` 基线与本机 Chrome 二进制存在性（reviewer 无 bash，未核验）；且 F1 落地前上述 P1（AC-4 计数、`empty_document`、`writeAtomic` 未导出、`docs/demo.html` 缺失）建议先改卡，否则写者按现卡写出的代码必然与门禁或 AC 对不上。