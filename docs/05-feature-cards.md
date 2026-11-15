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
| M1.0 | Monorepo 骨架与最严 CI | — | `pnpm-workspace.yaml`, `tsconfig*`, `eslint*`, `prettier*`, `vitest*`, `stryker*`, `.dependency-cruiser.cjs`, `knip.json`, `package.json`, `packages/*/package.json`(空壳) | `pnpm verify` 可跑通（空实现也全绿） |
| M1.1 | HTML 解析 / 序列化 / `data-hr-id` 注入 | M1.0 | `packages/core/src/html/**` | 容错解析、稳定 ID、最小 diff 序列化 |
| M1.2 | 文档模型与不变量校验 | M1.1 | `packages/core/src/model/**` | 树模型、ID 唯一性、组件白名单校验 |
| M1.3 | `hr_outline` 骨骼提取 | M1.2 | `packages/core/src/ops/outline*` | 章节树 + 字数 + 未处理批注摘要 |
| M1.4 | `hr_read_node` 节点读取 | M1.2 | `packages/core/src/ops/readNode*` | 按 ID/CSS 选择器读取子树 + 关联批注 |
| M1.5 | `hr_patch_node` 增量 Patch + 原子写 + undo | M1.1–1.4 | `packages/core/src/ops/patchNode*`, `packages/core/src/io/**` | 5 种 action、ID 自动注入、备份可回滚 |
| M1.6 | 双维风格引擎（`style.yaml` + tone 编译 + 禁用词 Lint） | M1.0 | `packages/core/src/style/**` | 解析校验、prompt 编译、Lint 报告 |
| M1.7 | `Atelier Editorial` 主题包 + `hr_apply_style` 0-Token 换肤 | M1.1, M1.6 | `styles/atelier-editorial/**`, `packages/core/src/style/apply*` | 双模 CSS 变量、7 个组件选择器、替换 `<style id="hr-theme">` |
| M1.8 | CLI `hr`（outline/read/patch/style） | M1.3–1.7 | `packages/cli/**` | 严格退出码、`--json` 输出、错误文案 |
| M1.9 | Universal Skill（`skills/hreader`） | M1.8 | `skills/hreader/**` | SKILL.md + `scripts/hr.mjs` + 两份 references |

**执行合并（2026-11-12 起）**：M1.6+M1.7 合并为一张卡（`.workflow/cards/M1.6.md`），M1.8+M1.9 合并为一张卡（`.workflow/cards/M1.8.md`）。合并理由：每张卡都要付一轮完整门禁（G2 审计 + G3 测试 + 返工），而 M1.7 与 M1.9 都无法独立验收——前者是 M1.6 的渲染端、后者是 M1.8 的薄壳。合并后待执行序列：M1.0 → M1.1 → M1.2 → M1.3 → M1.4 → M1.5 → **M1.6(+7)** → **M1.8(+9)**。

**串行推进**：同一时刻只有一张卡处于实现或返工状态；允许在"当前卡实现中"对"上一张刚交付的卡"并行做审计/测试。

---

## 各卡验收标准 (AC)

### M1.0 Monorepo 骨架与最严 CI

> **执行记录（2026-11-12，commit `f1eba42`，`G4: PASS`）**：按 `.workflow/cards/M1.0.md`（含 R1/R2 修订）执行，与本表原稿的偏差如下，均已在卡片与审计报告中留痕：
> - 本卡**不引入构建步骤**：无 `dist`、无 `publint`/`attw`、无 `packages/cli`（CLI 按 M1.8 落地）。原 AC2 作废，理由：M1 的测试与类型检查直接跑源码，产物只会给门禁添噪声。
> - 聚合门禁脚本命名为 `verify` 而非 `ci`（`pnpm verify` 是 pnpm 内建 clean-install，会遮蔽同名脚本造成假绿）。
> - commitlint 未纳入本卡（历史会在 M1.0–M1.9 之间被返工提交污染，收益低于成本），提交信息规范改为人工约定 + 门禁记录表。
> - Stryker 在 M1.0 仅接入配置，真正卡阈值从 M1.1 起（本卡无可变异代码）。

- AC1 `pnpm i --frozen-lockfile && pnpm verify` 在干净克隆上全绿（六步：format / lint / typecheck / test:coverage / depcruise / knip）。
- AC2 ✅ 已按上表偏差执行：`@hreader/core` 有可编译入口与真实 `HrError`；无 dist 构建。
- AC3 ESLint 规则生效可证：`any` / `as` / 41 行函数 / 复杂度 11 / `eslint-disable` / `@ts-ignore` 全部被拦（测试用 ESLint 9 `lintText` 内存探针，非临时文件）。
- AC4 `tsconfig` 含 04 文档 §4.2 标志；`tsc --noEmit` 覆盖 `src` **与** `tests`（测试里写类型错误必须红）。
- AC5 dependency-cruiser 边界规则生效，含 `tests` 扫描与"src 不得反向依赖 tests"；`node_modules` 由 `doNotFollow` 控制而非 `exclude`。
- AC6 `knip --strict` 0 未使用项；commitlint 缓期（见上）。
- AC7 覆盖率 `perFile: 100%` 已配置；Stryker 阈值卡在 M1.1 首卡（本卡无变异源）。

### M1.1 HTML 解析 / 序列化 / `data-hr-id` 注入

- AC1 对合法自包含文档解析后，`<article>` 下所有块级元素（section/header/p/h1-h4/ul/ol/table/figure/details/pre/div[data-hr-component]）都有唯一 `data-hr-id`。
- AC2 已有 `data-hr-id` 保持不变；新节点按稳定规则生成（同一输入两次运行结果一致，与文件路径无关）。
- AC3 容错：无 doctype、未闭合标签、嵌套错误、`<script id="hr-meta">` 含 `</script>` 文本时，解析不抛未捕获异常，返回带 `code` 的诊断。
- AC4 序列化保留属性顺序与空白策略一致；往返（parse→serialize→parse）后 outline 结果稳定（属性级不变）。
- AC5 1MB 文档 parse+inject ≤ 300ms（本机基线记录在报告里）。
- AC6 `data-hr-component` 只接受 7 个白名单值（6 类，callout 分 insight/warning），非法值产生诊断而非静默丢弃。

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
- AC3 7 个组件选择器样式齐全：`kpi-bento`、`callout-insight`、`callout-warning`、`split-compare`、`deep-dive`、`step-timeline`、`diagram-stage`（7 个选择器，含 warning/insight 分裂）。
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

- AC1 `skills/hreader/SKILL.md`：触发条件、五原语工作流、7 个组件选择器 HTML 速查、禁用词提醒；≤ 200 行。
- AC2 `scripts/hr.mjs` 零依赖封装，`node scripts/hr.mjs outline <file>` 可跑通（不依赖全局安装）。
- AC3 `references/components-spec.md` 给出每个组件的完整可用片段，复制即用。
- AC4 `references/style-authoring.md` 给出"访谈式"生成自定义 `style.yaml` 的流程。
- AC5 端到端演练（测试员执行）：在临时目录生成一篇含 3 组件的 HTML → `hr outline` → `hr read` → `hr patch` 重写一段 → `hr style --lint` → 结果可被普通浏览器打开且样式正确（用 headless 浏览器截图/断言 DOM 计算样式）。

---

## M3.2 Pi 扩展（`packages/pi-extension`）使用节

单文件扩展：`pi-hreader.ts` 本身就是一个可加载的 Pi 扩展，零本地 import、运行时只依赖 `typebox` 与 `node:` 内建。

**装法**：

```bash
cp packages/pi-extension/pi-hreader.ts ~/.pi/agent/extensions/   # 或：pi -e packages/pi-extension/pi-hreader.ts
```

**两条斜杠命令**（需先 `hr serve` 起 daemon，扩展不会自己拉起进程）：

- `/hreader <path>`：把文档推给阅读器并订阅它的批注事件；`<path>` 相对 daemon 的 workspace 或绝对路径。
  无参时只给用法 + daemon 状态（`127.0.0.1:<port>`、workspace，换过视觉时追加当前风格）——不打印根 URL，
  因为 `GET /` 是 cookie 认证、`/s/:docId` 是 token 认证，无参时没有可点的合法链接。
- `/hr-style <id>`：换当前文档的视觉。无参列出可选 id；id 只来自 daemon 的 `GET /api/theme`，不在列表里的 id
  连 `POST /api/style` 都不发。风格记在**文档**上（`POST /api/style` 带的就是 `docId`）：换到别的文档时状态行
  不报上一个文档的风格，换回来仍记得；连发两次时后一次生效，先发的慢响不覆盖。daemon 与用户来源的字符串
  进终端前会净化控制字符并截断到 400 字符（主题 id 来自 workspace 目录名，属不可信输入）。

**三个工具**（供模型在会话里读写文档）：`hreader_outline`（结构 + 每节字数 + 未处理批注）、`hreader_read_node`
（单个节点的真实 HTML 与其批注）、`hreader_patch_node`（`replace`/`insert_before`/`insert_after`/`append`/`delete`）。
三者都返回文本，失败时把 daemon 的错误码转成文本，不抛裸异常。

**批注联动**：订阅 `/api/events` 的 SSE；文档的 `doc.changed` 到达时拉一次待处理批注（`pending_ai`），
同一 `anId` 只问一次；无 UI 模式（`pi -p`/`--json`）只提示，不擅自注入会话。事件环过期（`reason: events_expired`）
会明确提示刷新，不当成未知事件吞掉；断线带 `Last-Event-ID` 每 2 秒重连，`session_shutdown` 时收尾。

**限制**：单文件（不再拆模块）；不扫主题目录——视觉清单只认 daemon 的 `GET /api/theme`；
只换视觉不换语气（语气规约是 MCP 侧"写稿前读规约"的能力，Pi 侧不重复实现）。

---

### 验证（M3.2 结卡时的实测数字）

| 项 | 值 |
| :--- | :--- |
| 全仓 | **2247 例 / 203 文件**，`pnpm verify` 退出 0 |
| 扩展包 | **145 例 / 12 文件** |
| `pi-hreader.ts` | 1200 行，语句/分支/函数/行 **100/100/100/100**（无 uncovered） |
| `depcruise` | 443 模块 / 1835 依赖，0 违规 |
| `pnpm smoke:pi` | 5 行全绿（真 pi 1.5.2 加载；`/hreader`、`/hr-style` 都被执行；对照组落模型） |
| 变异 | 四轮共 **67** 个，存活 6（其中 4 条转成真缺陷修复、2 条转成假证人修复） |

**这套测试怎么证明自己有效**：不是看覆盖率，而是看「删掉实现里的一行，有没有用例红」。本卡删一行仍全绿的情况出现过 4 次，其中 3 次是真缺陷（见 `.workflow/cards/M3.2.md` §9.3 的 11 条缺陷表）。

## 横切口径：`data-hr-id` 与批注锚点的生命周期

`data-hr-id` 由内容派生（详见 `.workflow/cards/M2.3.md` §8）：同一份字节两次注入 id 稳定，编辑则会让 id 漂移。批注的 `nodeId` **不做落盘迁移**，锚点失效由读时重识别兜底（三档：命中 / `block_reidentified` / `block_missing`）。**发布前**若更换 id 方案，必须先交付 `nodeId` 迁移脚本，否则既有批注全部失效；当前未发布，无迁移义务（`L-02`，重构卡 R-6）。

## Milestone 2–4 卡片（暂只列标题，开工时再拆）

- M2.1 Daemon（HTTP + WS + watcher + 事件协议）
- M2.2 Reader UI 三栏骨架（书库/TOC/画布/边栏）
- M2.3 划词批注持久化 + Visual Diff + Undo
- M3.1 MCP Server（5 tools + resources + prompts + MCP-UI）
- M3.2 Pi 扩展单文件（`/hreader`、`/hr-style`、context.ui 注入）——使用节见上
- M3.3 DSH Cordis 插件（prompt hook + 强类型事件 + Web 面板）
- M4.1 `hr style extract` 风格萃取
- M4.2 Tauri v2 桌面端
- M4.3 出版级 PDF/长图导出
