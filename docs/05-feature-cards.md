# hReader 功能卡清单 (Feature Cards)

> 状态：**全部 todo，等待用户批准开工**。
> 工作规则见 [03-collaboration-workflow.md](03-collaboration-workflow.md)，质量标准见 [04-engineering-standards.md](04-engineering-standards.md)。
> 卡片详情落地在 `.workflow/cards/<id>.md`；本文件是索引与验收标准总表。

## 状态图例

`todo` → `implementing` → `auditing`/`testing` → `rework` → `accepted` | `blocked`

---

## Milestone 1 卡片索引

| Card | 标题 | 依赖 | Scope(写) | 关键交付 |
| :--- | :--- | :--- | :--- | :--- |
| M1.0 | Monorepo 骨架与最严 CI | — | `pnpm-workspace.yaml`, `tsconfig*`, `eslint*`, `prettier*`, `vitest*`, `stryker*`, `.dependency-cruiser.cjs`, `knip.json`, `package.json`, `packages/*/package.json`(空壳) | `pnpm ci` 可跑通（空实现也全绿） |
| M1.1 | HTML 解析 / 序列化 / `data-hr-id` 注入 | M1.0 | `packages/core/src/html/**` | 容错解析、稳定 ID、最小 diff 序列化 |
| M1.2 | 文档模型与不变量校验 | M1.1 | `packages/core/src/model/**` | 树模型、ID 唯一性、组件白名单校验 |
| M1.3 | `hr_outline` 骨骼提取 | M1.2 | `packages/core/src/ops/outline*` | 章节树 + 字数 + 未处理批注摘要 |
| M1.4 | `hr_read_node` 节点读取 | M1.2 | `packages/core/src/ops/readNode*` | 按 ID/CSS 选择器读取子树 + 关联批注 |
| M1.5 | `hr_patch_node` 增量 Patch + 原子写 + undo | M1.1–1.4 | `packages/core/src/ops/patchNode*`, `packages/core/src/io/**` | 5 种 action、ID 自动注入、备份可回滚 |
| M1.6 | 双维风格引擎（`style.yaml` + tone 编译 + 禁用词 Lint） | M1.0 | `packages/core/src/style/**` | 解析校验、prompt 编译、Lint 报告 |
| M1.7 | `Atelier Editorial` 主题包 + `hr_apply_style` 0-Token 换肤 | M1.1, M1.6 | `styles/atelier-editorial/**`, `packages/core/src/style/apply*` | 双模 CSS 变量、6 大组件、替换 `<style id="hr-theme">` |
| M1.8 | CLI `hr`（outline/read/patch/style） | M1.3–1.7 | `packages/cli/**` | 严格退出码、`--json` 输出、错误文案 |
| M1.9 | Universal Skill（`skills/hreader`） | M1.8 | `skills/hreader/**` | SKILL.md + `scripts/hr.mjs` + 两份 references |

**串行推进**：M1.0 → M1.1 → M1.2 → M1.3 → M1.4 → M1.5 → M1.6 → M1.7 → M1.8 → M1.9。允许在"当前卡实现中"对"上一张已交卡"并行做审计/测试。

---

## 各卡验收标准 (AC)

### M1.0 Monorepo 骨架与最严 CI

- AC1 `pnpm i && pnpm ci` 在干净克隆上全绿；`pnpm ci` 含 04 文档 §4.5 全部步骤。
- AC2 `packages/core`、`packages/cli` 各有可编译的最小入口（`export const version: string`），`dist` 构建通过，`publint`/`attw` 通过。
- AC3 ESLint 规则生效可证：故意提交一个 `any` 与一个跨包深层导入，`pnpm lint` 必须报错（用临时文件验证后删除，报告留证据）。
- AC4 `tsconfig` 含 04 文档 §4.2 全部标志；`tsc -b` 在空项目上 0 错误。
- AC5 `dependency-cruiser` 有环/反向依赖规则并在故意违规时报错。
- AC6 `commitlint` 强制 conventional commits；`knip --strict` 0 未使用项。
- AC7 覆盖率阈值与 Stryker 阈值已配置并在低于阈值时 CI 失败（附人为调低阈值的反证）。

### M1.1 HTML 解析 / 序列化 / `data-hr-id` 注入

- AC1 对合法自包含文档解析后，`<article>` 下所有块级元素（section/header/p/h1-h4/ul/ol/table/figure/details/pre/div[data-hr-component]）都有唯一 `data-hr-id`。
- AC2 已有 `data-hr-id` 保持不变；新节点按稳定规则生成（同一输入两次运行结果一致，与文件路径无关）。
- AC3 容错：无 doctype、未闭合标签、嵌套错误、`<script id="hr-meta">` 含 `</script>` 文本时，解析不抛未捕获异常，返回带 `code` 的诊断。
- AC4 序列化保留属性顺序与空白策略一致；往返（parse→serialize→parse）后 outline 结果稳定（属性级不变）。
- AC5 1MB 文档 parse+inject ≤ 300ms（本机基线记录在报告里）。
- AC6 `data-hr-component` 只接受 6 个白名单值，非法值产生诊断而非静默丢弃。

### M1.2 文档模型与不变量

- AC1 模型以纯数据暴露：`{ id, tag, component?, text, children }`，不泄露 parse5 内部节点。
- AC2 校验：重复 id、id 非法字符、`<article>` 缺失、标题层级跳跃（h2→h4）分别给出稳定 `code`。
- AC3 不可变更新：模型变换不就地修改输入（除非显式标注为破坏性且测试覆盖）。
- AC4 属性/文本转义在模型层前完成，模型不持有未转义 HTML 字符串。

### M1.3 `hr_outline`

- AC1 输出 `OutlineNode[]`：`id/tag/level/text/wordCount/children`，中英混排字数统计规则固定（CJK 1 字 = 1，连续拉丁 1 词 = 1，标点不计）。
- AC2 只包含 section/header/h1–h4 层级结构，不返回正文全文；对 1MB 文档输出 ≤ 8KB。
- AC3 `pendingAnnotations` 汇总所有 `status === "pending_ai"` 的批注（id/targetId/comment 摘要），并校验 `targetId` 是否存在（不存在给诊断）。
- AC4 与 M1.1 的 ID 规则一致；对无 section 的扁平文档，按 h1 分块且不崩。
- AC5 输出稳定排序（文档顺序），对同一文档两次调用字节级一致。

### M1.4 `hr_read_node`

- AC1 按 `nodeId` 读取子树 HTML + 关联批注；`nodeId` 不存在时返回 `code: "node_not_found"`。
- AC2 选择器支持：`#id`、`[data-hr-id="x"]`、`article > section:nth-of-type(2)`；选择器语法非法返回 `code: "invalid_selector"`，不抛裸异常。
- AC3 不外泄 `<html>`/`<body>`/`<script id="hr-meta">` 内容；读取 `<script>` 节点时显式拒绝（`code: "node_not_allowed"`）。
- AC4 输出体量控制：默认对超大子树（> 64KB）返回截断 + `truncated: true` + 节点首行提示。

### M1.5 `hr_patch_node`

- AC1 5 种 action 全部实现：`replace`/`insert_after`/`insert_before`/`append`/`delete`；语义与命名严格一致（insert_after 作用于兄弟位置）。
- AC2 新增块级元素自动注入 `data-hr-id`，且与文档既有 ID 不冲突；返回 `newIds`。
- AC3 原子性：写前备份到 `.hreader/history/<file>/<timestamp>.html`，写用 tmp+rename；写入中途 kill 后目标文件仍完整（用子进程 kill 测试）。
- AC4 undo：最近一次 patch 可回滚到字节级一致的原文件（`sha256` 相等）。
- AC5 校验：HTML 片段非法、未闭合、含 `<script>`/`<style>`/`on*` 事件属性时拒绝（`code` 明确），文件不被修改。
- AC6 并发：同一文件两个 patch 串行化（文件锁），不产生丢失更新；锁超时给出 `code: "locked"`。
- AC7 幂等：同一 `replace` 内容重复执行两次，文件字节一致（除历史快照）。
- AC8 路径安全：`../`、绝对路径、符号链接指向工作区外 → 拒绝。

### M1.6 双维风格引擎

- AC1 `style.yaml` 解析：`id/name/description/inherits_visual/language_style{persona,narrative_rules,sentence_rhythm,vocabulary{forbidden,recommended},examples}` 全字段校验；未知字段报错（严格模式）。
- AC2 `sentence_rhythm` 支持 `max_paragraph_sentences`、`style`；缺省有文档化默认值。
- AC3 tone 编译为结构化 prompt 规约（纯字符串，无模板注入漏洞），输出可直接注入 Skill/MCP/Pi。
- AC4 禁用词 Lint：对给定 HTML/文本返回命中列表 `{path(块 id), word, excerpt, offset}`；支持中英文、大小写不敏感（拉丁）、全角/半角归一。
- AC5 内置 3 个预设 tone（`atelier-editorial` 默认、`feynman-tech`、`executive-brief`）可加载并编译。
- AC6 自定义风格目录发现：`~/.hreader/styles/<id>/style.yaml` 与项目 `.hreader/style.yaml`，优先级与覆盖规则明确并有测试。

### M1.7 `Atelier Editorial` 主题包 + `hr_apply_style`

- AC1 `theme.css` 定义 `--hr-bg/--hr-fg/--hr-accent/--hr-muted/--hr-border/--hr-code-bg` 等令牌，日/夜双模通过 `@media (prefers-color-scheme)` + `[data-hr-mode]` 覆盖。
- AC2 正文 68ch 视宽、右侧 280px 边栏布局；无横向滚动（320px 宽度下）。
- AC3 6 大组件样式齐全：`kpi-bento`、`callout-insight`、`callout-warning`、`split-compare`、`deep-dive`、`step-timeline`、`diagram-stage`（7 个选择器，含 warning/insight 分裂）。
- AC4 `hr_apply_style(visualId)` 只替换 `<style id="hr-theme">` 内容，正文 DOM 与 `hr-meta` 字节不变（0 Token 换肤可证）。
- AC5 注入的 CSS 不破坏"普通浏览器直接打开"：无外部字体/图片请求，离线可读。
- AC6 打印样式：`@media print` 隐藏交互控件、保留目录书签锚点。

### M1.8 CLI `hr`

- AC1 命令：`hr outline <file> [--json]`、`hr read <file> <nodeId|selector> [--json]`、`hr patch <file> <nodeId> --action <a> (--html <s>|--html-file <p>)`、`hr style <file> (--visual <id>|--tone <id>|--lint)`。
- AC2 退出码：`0` 成功、`1` 可预期业务失败（节点不存在等）、`2` 用法错误、`3` IO/权限错误、`70` 内部错误（未捕获）。每种都有测试。
- AC3 stdout 只输出结果（`--json` 时为单行合法 JSON），诊断/日志走 stderr；管道下无颜色码。
- AC4 `--json` 输出 schema 稳定，含 `ok/code/message` 字段；错误时也输出合法 JSON（便于 Agent 解析）。
- AC5 `hr patch` 在 `--html-file` 指向不存在文件、非法 UTF-8 时给出稳定错误码，不写文件。
- AC6 帮助文本 `--help` 覆盖所有命令与参数；`hr` 无参数时输出用法并非 0 退出码。

### M1.9 Universal Skill

- AC1 `skills/hreader/SKILL.md`：触发条件、五原语工作流、6 大组件 HTML 速查、禁用词提醒；≤ 200 行。
- AC2 `scripts/hr.mjs` 零依赖封装，`node scripts/hr.mjs outline <file>` 可跑通（不依赖全局安装）。
- AC3 `references/components-spec.md` 给出每个组件的完整可用片段，复制即用。
- AC4 `references/style-authoring.md` 给出"访谈式"生成自定义 `style.yaml` 的流程。
- AC5 端到端演练（测试员执行）：在临时目录生成一篇含 3 组件的 HTML → `hr outline` → `hr read` → `hr patch` 重写一段 → `hr style --lint` → 结果可被普通浏览器打开且样式正确（用 headless 浏览器截图/断言 DOM 计算样式）。

---

## Milestone 2–4 卡片（暂只列标题，开工时再拆）

- M2.1 Daemon（HTTP + WS + watcher + 事件协议）
- M2.2 Reader UI 三栏骨架（书库/TOC/画布/边栏）
- M2.3 划词批注持久化 + Visual Diff + Undo
- M3.1 MCP Server（5 tools + resources + prompts + MCP-UI）
- M3.2 Pi 扩展单文件（`/hreader`、`/hr-style`、context.ui 注入）
- M3.3 DSH Cordis 插件（prompt hook + 强类型事件 + Web 面板）
- M4.1 `hr style extract` 风格萃取
- M4.2 Tauri v2 桌面端
- M4.3 出版级 PDF/长图导出
