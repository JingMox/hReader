# 功能入口清单（巡回测试用，`docs/03` §12）

> 巡回测试员**只从这里出发**，加上 `--help` 与 `docs/`。不读 `src/`。
> 每一项都要"从用户入口走到产物"，记录命令/点击与真实输出。

## A. CLI（`node skills/hreader/scripts/hr.mjs …`）

| # | 入口 | 用户以为它会做什么 |
| :-- | :--- | :--- |
| A1 | `hr outline <file>` | 看文档骨骼（标题树 + 字数） |
| A2 | `hr read <file> <nodeId\|selector>` | 读某一段/某个选择器命中的内容 |
| A3 | `hr patch <file> <nodeId> --action replace\|insert_before\|insert_after\|append\|delete (--html\|--html-file\|--html-stdin)` | 局部改一段，不整篇重写 |
| A4 | `hr undo <file>` | 撤销上一次 patch |
| A5 | `hr style <file> --visual <id>` | 换视觉主题（内联进 HTML） |
| A6 | `hr style <file> --tone <id>` | 换语言基调（禁用词 lint 会跟着变） |
| A7 | `hr style <file> --lint` | 检查风格违规 |
| A8 | `hr style extract <file...> --id --name --out [--no-llm]` | 从几篇文章萃取 `style.yaml` |
| A9 | `hr export <file> [--out]` | 产出单文件自包含打印稿（封面/目录/正文，零 script 零外链） |
| A10 | `hr pdf <file> --out` | 产出真 PDF（本机 Chrome + CDP，带大纲书签） |
| A11 | `hr png <file> --out --width --scale` | 产出长图 |
| A12 | `hr serve <file> [--port] [--app-dir]` | 起本地服务，浏览器进阅读器 |
| A13 | `hr --help` / `hr <cmd> --help` | 不知道自己该用哪条命令时，从这里找答案 |
| A14 | 通用选项 | `--json`（单行 JSON）、`--workspace`（安全边界）、`--force`（覆盖已存在产物） |

## B. 阅读器 Web UI（`hr serve` 后浏览器里）

| # | 入口 | 用户以为它会做什么 |
| :-- | :--- | :--- |
| B1 | 打开 `serve` 打印的地址 | 直接进阅读器，不用手动复制 token |
| B2 | 左栏书库 | 看到当前目录下的文档，点开能切 |
| B3 | 左栏目录（TOC） | 点标题跳到正文对应位置；滚动时高亮当前节 |
| B4 | 中栏画布 | 正文按主题渲染，字号/行宽可调 |
| B5 | 键盘 `j` / `k` | 上下节导航 |
| B6 | 划词 | 出现批注入口，写下的批注落成页边注（sidenote） |
| B7 | 右侧页边批注 | 批注与正文锚点对得上；可提交给 Agent |
| B8 | Agent 局部 patch 后 | 变动节点闪烁高亮 + 一键 Undo |
| B9 | 刷新/重开 | 批注仍在（写进 HTML 内嵌 `hr-meta`），不丢 |

## C. MCP Server（`packages/mcp-server/dist/main.js`，stdio）

| # | 工具 | 用户以为它会做什么 |
| :-- | :--- | :--- |
| C1 | `hr_create_doc` | 建一篇新文档 |
| C2 | `hr_outline` | 拿骨骼 |
| C3 | `hr_read_node` | 读节点 |
| C4 | `hr_patch_node` | 改节点 |
| C5 | `hr_undo` | 撤销 |
| C6 | `hr_apply_style` | 套风格 |
| C7 | `hr_resolve_annotation` | 处理前端批注 |
| C8 | Prompts 注册（`prompts.ts`） | 语言风格 Prompt 可直接选 |
| C9 | MCP-UI 资源（`resources.ts`/`ui.ts`） | 内联阅读器视图能被宿主渲染 |

## D. 集成面

| # | 入口 | 用户以为它会做什么 |
| :-- | :--- | :--- |
| D1 | Pi 扩展 `packages/pi-extension/pi-hreader.ts`（`/hreader`、`/hr-style`） | 在 Pi 里直接读/改当前文档；批注自动投递 |
| D2 | DSH bundle `packages/dsh-bundle`（host-only） | 装进 DSH 后能挂载 hReader |
| D3 | 桌面壳 `hReader.app` | 拉起 daemon + webview；全局快捷键呼出；`.html` 文件关联 |
| D4 | 桌面壳退出/kill | daemon 跟着退，不留孤儿 |
| D5 | Chrome 扩展 `packages/chrome-extension` | 在浏览器里把网页丢给 hReader |
| D6 | `skills/hreader/SKILL.md` | 按文档说明能让 Agent 自己跑通"生成 → 读骨骼 → 局部改" |

## E. 非功能面（也要当真用户一样撞）

| # | 场景 | 期望 |
| :-- | :--- | :--- |
| E1 | 手写 HTML（无 `data-hr-id`） | 有明确入口把它变成可读文档，而不是"报错说不合法" |
| E2 | 空文件 / 非 HTML / 缺 `<article>` | 明确错误 + 可操作提示，不泄栈 |
| E3 | 超长文档（≥1MB）/ 深嵌套 | 不卡死、不 OOM、耗时在可接受范围 |
| E4 | 中文/emoji/CRLF/非 ASCII 文件名 | 不丢字、不乱码、路径不炸 |
| E5 | 同一命令并发跑两次 | 不损坏文件、不留半写产物 |
| E6 | 端口被占用 / 目录只读 / 权限不足 | 明确报错，不静默失败 |
| E7 | 断电式中断（kill -9 服务/CLI） | 文件仍可打开；无残留锁 |
| E8 | 产物在别的机器/别的浏览器打开 | 自包含（无外链、无 script），版式不塌 |
