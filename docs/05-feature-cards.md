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

- AC1 对合法自包含文档解析后，`<article>` 下**可寻址**元素（`packages/core/src/html/constants.ts` 的 `ADDRESSABLE_TAGS`：块级词表 + `h5/h6/div/aside/nav/main/dl/dt/dd/figcaption` + 表格结构 `caption/thead/tbody/tfoot/tr/td/th`）都有唯一 `data-hr-id`。`div` 一律编号，不再只在带 `data-hr-component` 时才算块级（BUG-13）。
  HTML5 的隐含结束标签可能产生空段落（例如 stray `</p>`），它们同样获得 id；`hr outline` 不会列出无文本的块。
- AC2 已有 `data-hr-id` 保持不变；新节点按稳定规则生成（同一输入两次运行结果一致，与文件路径无关）。
  **id 归产品所有**：`hr patch` 片段自带的 `data-hr-id` 一律忽略（片段根带了不同的 id 时给一条 `fragment_ids_ignored` warning，并在 `replacedIds` 里报成 `{from: 片段带的 id, to: 继承到的目标 id}` 这一对；片段没带 id 就不报），`replace` 的新根**继承目标自己的 id**（连续两次 replace 同一 id 都命中），片段内部其它节点由产品重新分配；`append` 保持既有 id 不变。
- AC3 容错：无 doctype、未闭合标签、嵌套错误、`<script id="hr-meta">` 含 `</script>` 文本时，解析不抛未捕获异常，返回带 `code` 的诊断。
  树构造按 HTML5「in body」的隐含结束补全：`<p>` 遇到 `table/div/ul/ol/dl/li/p/h1..h6/blockquote/pre/hr/section/article` 等块级开始标签即结束，块成为 `<p>` 的**兄弟**（no-quirks 下由解析器完成，quirks 文档由 `packages/core/src/html/implicitClose.ts` 补齐；再 normalize 一次必须 `unchanged`）。
  **边界（任意深度）**：判据看的是「`<p>` 内有没有块级元素」，不是「直接子节点是不是块级」——quirks 下 `<p>a<span><table>…</table></span></p>` 的 `<table>` 仍留在 `<p>` 里，必须连那层 `<span>` 一起挪出 `<p>`（`<div>`/`<ul>` 这类解析器自己就关 `p`，无须我们动手）。分裂出来的每段各占自己的源码区间与 id：首段留原 `data-hr-id`，后续段不带 id、由注入阶段分配，因此 `hr patch <首段 id> --action delete` 只删那一段，不会连带切掉挪出去的表格。
- AC4 序列化保留属性顺序与空白策略一致；往返（parse→serialize→parse）后 outline 结果稳定（属性级不变）。
- AC5 1MB 文档 parse+inject ≤ 300ms（本机基线记录在报告里）。
- AC6 `data-hr-component` 只接受 7 个白名单值（6 类，callout 分 insight/warning），非法值产生诊断而非静默丢弃。

### M1.2 文档模型与不变量

- AC1 模型以纯数据暴露：`{ id, tag, component?, text, children }`，不泄露 parse5 内部节点。
- AC2 校验：重复 id、id 非法字符、`<article>` 缺失、标题层级跳跃（h2→h4）分别给出稳定 `code`。
  `data-hr-id` 必须匹配 `^[A-Za-z][A-Za-z0-9_-]{0,63}$` 且全文唯一：`hr normalize` 对不合规/重复（保留第一个）的 id 重新分配并给 `id_reassigned` / `invalid_hr_id` warning；读/写入口（`read`/`patch`/`outline`）遇到重复 id 直接报 `duplicate_id`（exit 2）。
- AC3 不可变更新：模型变换不就地修改输入（除非显式标注为破坏性且测试覆盖）。
- AC4 属性/文本转义在模型层前完成，模型不持有未转义 HTML 字符串。

### M1.3 `hr_outline`

- AC1 输出 `OutlineNode[]`：`id/tag/level/text/wordCount/children`，中英混排字数统计规则固定（CJK 1 字 = 1，连续拉丁 1 词 = 1，标点不计）。
- AC2 只包含 section/header/h1–h4 层级结构，不返回正文全文；对 1MB 文档输出 ≤ 8KB。
- AC3 `pendingAnnotations` 汇总所有 `status === "pending_ai"` 的批注（id/targetId/comment 摘要），并校验 `targetId` 是否存在（不存在给诊断）。
- AC4 与 M1.1 的 ID 规则一致；对无 section 的扁平文档，按 h1 分块且不崩。
- AC5 输出稳定排序（文档顺序），对同一文档两次调用字节级一致。
- AC6 空大纲不静默：`hr outline` 对一个标题都没有的文档仍退出 0，但输出两行——第一行 `（没有标题）`，第二行给出可直接粘的命令 `hr read <file> <nodeId|selector>`（参数名与 M1.8 AC1 的用法行同字面，不写 `<选择器>` 这类会被当字面 target 的占位）。

### M1.4 `hr_read_node`

- AC1 按 `nodeId` 读取子树 HTML + 关联批注；`nodeId` 不存在时返回 `code: "node_not_found"`。
- AC2 选择器支持：`#id`、`[data-hr-id="x"]`、`article > section:nth-of-type(2)`；选择器语法非法返回 `code: "invalid_selector"`，不抛裸异常。`#id` 的字符集与 `HR_ID_PATTERN`（`^[A-Za-z][A-Za-z0-9_-]{0,63}$`）**同源**：大写与 `_` 在 `#` 形态里一样可用（`#hr-Ab12` 与 `[data-hr-id="hr-Ab12"]` 同义）。选择器命中 **>1** 个元素时取**文档顺序第一个**并给 `ambiguous_selector` warning（`data.matches` 报命中总数）；子选择器恰好命中 1 个**不**告警。
- AC3 不外泄 `<html>`/`<body>`/`<script id="hr-meta">` 内容；读取 `<script>` 节点时显式拒绝（`code: "node_not_allowed"`）。
- AC4 输出体量控制：默认对超大子树（> 64KB）返回截断 + `truncated: true` + 节点首行提示；`--max-bytes` 截断时**人读模式也打一行** `（已截断：原 N 字节（序列化后）/ 上限 M 字节 / 已保留 K 个节点）`——就是 JSON `diagnostics` 里那条 `truncated_output` 原文，不许只在 JSON 里有而人读静默。`--json` 的 `data` **恒含** `truncated`（布尔）与 `diagnostics`（数组，未截断时为 `[]`）：键恒在，不因截断而增减。`--max-bytes` 约束的是**内容**（`data.html` 的字节数）；`（已截断：…）` 与 JSON 的 `diagnostics` 是元信息，**不计入该预算**，原告警必须恰好一行。

### M1.5 `hr_patch_node`

- AC1 5 种 action 全部实现：`replace`/`insert_after`/`insert_before`/`append`/`delete`；语义与命名严格一致（insert_after 作用于兄弟位置）。
- AC2 新增块级元素自动注入 `data-hr-id`，且与文档既有 ID 不冲突；返回 `newIds`。
- AC3 原子性：写前备份到 `.hreader/history/<file>/<timestamp>.html`，写用 tmp+rename；写入中途 kill 后目标文件仍完整（用子进程 kill 测试）。
- AC4 undo：最近一次 patch 可回滚到字节级一致的原文件（`sha256` 相等）。
- AC5 校验：HTML 片段非法、未闭合、含 `<script>`/`<style>`/`on*` 事件属性时拒绝（`code` 明确），文件不被修改。
- AC6 并发：同一文件两个 patch 串行化（文件锁），不产生丢失更新；锁超时给出 `code: "locked"`。
- AC7 幂等：同一 `replace` 内容重复执行两次，文件字节一致（除历史快照）。
- AC8 路径安全：`../`、绝对路径、符号链接指向工作区外 → 拒绝。
- AC9 寻址：第二个位置参数与 `hr read` 同一解析器（`nodeId|selector`，先选择器、再 node id），5 种 action 都可寻址；选择器命中多个可寻址元素时不猜——报 `invalid_selector` + `data.reason: "ambiguous"`（附 `count` 与前 5 个 `candidates`），命中不可寻址元素（无 `data-hr-id`）报 `node_not_found`。

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

- AC1 命令：`hr outline <file> [--json]`、`hr read <file> <nodeId|selector> [--json]`、`hr patch <file> <nodeId|selector> --action <a> (--html <s>|--html-file <p>)`、`hr style <file> (--visual <id>|--tone <id>|--lint)`。
- AC2 退出码：`0` 成功、`1` 可预期业务失败（节点不存在等）、`2` 用法错误、`3` IO/权限错误、`70` 内部错误（未捕获）。每种都有测试。
- AC3 stdout 只输出结果（`--json` 时为单行合法 JSON），诊断/日志走 stderr；管道下无颜色码。
- AC4 `--json` 输出 schema 稳定，含 `ok/code/message` 字段；错误时也输出合法 JSON（便于 Agent 解析）。
- AC5 `hr patch` 在 `--html-file` 指向不存在文件、非法 UTF-8 时给出稳定错误码，不写文件。
- AC6 帮助文本 `--help` 覆盖所有命令与参数；`hr` 无参数时输出用法并非 0 退出码。
- AC7 patch 目标集 = `PATCHABLE_TAGS`（默认与 `ADDRESSABLE_TAGS` 同集，当前无例外）：`div`、`tbody/tr/td` 都能直接 `append`/`replace`，行内元素仍拒（`isPatchableTarget`）；表格结构片段（`<tr>`/`<td>`）解析时套上祖先链，不再要求整表替换。
- AC8 公共出口：`locateTarget(parsed, target)` 是 `read`/`patch` 共用的**唯一寻址入口**（兑现 M1.5 AC9 的"同一解析器"）；`patchTargetIdOf(located)` 承载"patch 必须拿到**恰好一个**可寻址 id"的语义。边界：这两个**不承诺**为长期稳定 API，签名演进允许，改动须同步本卡。

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
  因为 `/s/:docId` 是 token 认证，而这里没有文档可指。（`hr serve` 自己打印的根地址是 `/?token=…`，
  `GET /` 也吃 token：首访落 `hr` cookie 后 302 回干净的 `/`，所以那行地址可以直接粘进浏览器。）
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

## M3.4 `hr_undo`（撤销最近一次写）

一个工具、一个必填参数 `filePath`：撤销该文档最近一次落盘，不参数化"撤几次"（要连撤就再调一次）。

**语义由 `@hreader/core` 的 `revertLast` 决定，本包不重实现**：取最近一份快照 → 校验**快照自身**的哈希与文件名一致
（防截断/改写；**不校验目标文件**是否被人改过）→ 原子还原 → 删掉该快照。快照链是 patch / 批注处理 / 新建文档共用的一条，所以"上一次写"可能是其中任意一种。

- **成功**：文本给出还原来源（`.hreader/history/<docId 路径的 sha1>/<内容 sha256 前 16 位>-<ISO 时间戳>-<seq>.html`）
  与**还原后**的字节数，`_meta.ui.resourceUri` 指向
  `ui://hreader/view/<docId>`，并附 `revision`（还原后内容的 sha256 前 16 位，与核心 SSE/前端对齐 revision 同源）。
- **失败**：`not_found`（路径不存在）、`not_a_file`（是目录）、`nothing_to_undo`（没有历史快照 / 已被撤过 /
  快照目录被外部删掉）。核心内部的 `undo_unavailable` **不外泄**——它只表示"存档读不出来"，对外一律翻成
  `nothing_to_undo`，且绝不落到兜底的 `internal`。
- **并发**：锁住在 core（`runLocked`），同一个文件上两个并发的 `hr_undo` 只会有一个成功，另一个拿到 `nothing_to_undo`。
- **锁等待不抄 HTTP 的 5000ms**：HTTP 侧 `LOCK_WAIT_MS` 不在 core 的公开面上，而 `hr_patch_node` 用的就是 core 默认值
  （`DEFAULT_LOCK_TIMEOUT_MS = 2000`）。同一个文件上两个工具必须同源，否则并发语义分叉——所以第三参不传。
  2000ms ≥ 锁的实际持有时长，串行化照样成立。
- **残缺是安全的**：快照目录被手工清空后调 `hr_undo` 得到 `nothing_to_undo`，目标文件原地不动（不是半还原）。

**给 Agent 的使用建议（重要）**：**换过样式之后再 undo，正文会跟样式一起回退**（`L-32`：`applyStyle` 不写快照，
`packages/core/src/style/applyFile.ts` 全文没有 `writeSnapshot`）。所以"刚换完视觉、又想撤掉上一次小改动"时，
**不要指望 undo 只退一步**——要么先 `hr_read_node` 确认正文，再重新 `hr_patch_node` 一次；要么接受这一步会回到
换视觉之前的整份内容。HTTP 侧 `POST /api/doc/<docId>/undo` 是同一个 `revertLast`，行为完全一样。

**限制**：undo 的粒度是"一次**留了快照**的写"，不是"一次字段修改"；也不做 `--dry-run`：先 `hr_read_node` 看现状。

---

### M3.3 `@hreader/dsh-bundle` 使用节（host-only）

**装进宿主 profile**：本包不发布，装的是仓库里的目录，且 `--profile` 是**必填**选项（漏了 dsh 直接 usage 报错）：

```bash
pnpm -C packages/dsh-bundle build      # 产 dist/index.js（自包含）+ dist/index.d.ts
dsh plugin --profile <profile> add "$(pwd)/packages/dsh-bundle"
```

`pnpm smoke:dsh` 用新建的临时 `$DSH_HOME` + 固定 profile 名 `smoke` 跑同一件事（`--profile` 只收**名字**不是路径，profile 落在 `$DSH_HOME/profiles/smoke`，绝不碰用户 `~/.dsh`）；本机没装 `dsh` 时它 SKIP（不进 CI，SKIP 日志给出 `npm i -D @deepseek-ai/dsh@0.2.2-rc.1` 的装法）。**已用真 `@deepseek-ai/dsh@0.2.2-rc.1` 验过**：`dsh plugin --profile smoke add <包目录>` 退出码 0，`dsh --profile smoke --dump-config` 的合成树里逐字出现：

```yaml
# == @hreader/dsh-bundle
- id: hreader
  name: '@hreader/dsh-bundle'
```

三条断言（注释头 / `- id: hreader` / `name: '@hreader/dsh-bundle'`）各自独立 `check`，失败时贴 `--dump-config` 的尾巴。旧版“临时 profile 目录里出现插件名”的软断言已删：它扫描的目录在 `add` 非 0 时也可能已写进包名，是假绿来源。

**`workspace` 从哪来（四步）**：宿主 `Context` 上**没有**工作区字段——`@deepseek-ai/cordis` 的 `context.d.ts:23` 只有模块解析用的 `baseUrl`，`dsh-system-prompt` 的 d.ts 里 `cwd`/`workspace` 零命中。所以：

1. `config.workspace` 缺省 → 取宿主进程 `process.cwd()`，并往 **stderr** 打一行 `[hreader] config.workspace 未配置，使用宿主进程 cwd=<abs>`（用户有权知道 prompt 是按哪个目录的风格渲染的）；
2. 原始串含 `..` 段 → fail-fast（`resolve` 会把 `<repo>/../..` 静默改成仓库的父目录，`<workspace>/.hreader/style.yaml` 就跟着换人）；
3. 给了**相对路径** → 按 cwd 解析成绝对路径；
4. 给了但**不存在 / 不是目录** → fail-fast，错误文案点名 `config.workspace`（拼错的路径比 cwd 兜底更危险）。

**不要求 `workspace` 落在 cwd 之内**：本包只**读**风格文件、从不写盘（`writeFileSync|writeFile|mkdirSync|renameSync|unlink` 全文零命中），`workspace: "/tmp"` 因此合法；路径 containment 的守卫归 `packages/core/src/io/paths.ts:73-79`（写侧），本包不重复实现一遍。`tests/plugin.test.ts` 有一条名字写明这条理由的钉子用例。

随包的 `cordis.patch.yml` 里 `config: {}` 就是这个意思：开箱即用（按 cwd），想钉死工作区就填绝对路径。**不改随包 yaml 是设计要求**——"让用户手改依赖里的文件"是敌意设计。

**未知 `styleId`**：fail-fast，抛 `HrError`（code `unknown_style`），消息里列出当前可用 id（内置预设 + `<workspace>/styles/` 项目风格 + `~/.hreader/styles`）。不选"退默认风格 + warn"：prompt 里混进一个退了默认的风格，作者永远发现不了自己拼错。

**卸载语义**：注册全在 `ctx.effect(() => {...}, "hreader")` 里，dispose 时摘掉 section 与 `hreader` 服务；同一个 ctx 上重复 `apply` 先撤旧的（`WeakMap` 记账），宿主里始终只有一个 section。

**`order = 100` 的理由**：真常量表在 `@deepseek-ai/dsh-system-prompt@0.2.2-rc.1` 的 `lib/types/index.d.ts`：`HARNESS_IDENTITY = -1000`、`DEPLOYMENT_PERSONA_PREFIX = 0`、`PLAN_POLICY = 500`、`TOOL_BASH = 1000` 起是工具指引。语言规约是 persona 级指令，必须排在 persona 之后、policy 与工具指引之前 → 100。（旧版本文档写的 "`-100` identity / `100-199` tool guidance" 与真包不符，已被 M3.3 更正。）

**`styles` 与 `dist`**：`dsh` 从 profile 的 `node_modules` 加载插件，`exports` 指向 `.ts` 一定失败，故 `build` 产 `dist/index.js`（esbuild 把 `@hreader/core` 与 `yaml` 一起打进，`exports`/`main` 指向它）与 `dist/*.d.ts`（`declare module '@deepseek-ai/cordis'` 的合并要靠它才对使用方可见），并把仓库根 `styles/` 拷到 `dist/styles`（主题 CSS 无法打包）。`nodeStyleDeps().stylesRoot` 指向仓库布局，装进 profile 后路径会落到使用者目录树，故插件显式改写 `stylesRoot`（见 `src/index.ts` 的 `stylesRootOf`）。

**`dist/*.d.ts` 里没有裸依赖（对外形状一律本地镜像）**：G2-R1 指出"声明文件里一个裸 `import type` 就够使用方报 TS2307"，所以 `HreaderPromptSection` 在 `src/events.ts` 里本地重述（`name`/`order`/`text` 三个 readonly 字段），不 import `@deepseek-ai/dsh-system-prompt`；漂移由 `tests/drift.test-d.ts` 的双向/单向赋值盯着（官方改 `order` 类型、加/删字段都会红）。唯一的例外是 `src/events.ts` 里一行 `import type {} from "@deepseek-ai/cordis"`：它不绑任何名字，作用是让本包看见 cordis 的增强链（缺它 `Context` 只剩基础面，`tests/types.test-d.ts` 会红），而 tsc 会把它从 `dist/events.d.ts` 里整行擦掉——有 `tests/dist.test.ts` 的“声明文件里没有 `from "@deepseek-ai/…"`”挡着。因此**没有** `peerDependencies`/`peerDependenciesMeta`，也**没有**为它加的 `knip.json ignoreDependencies` 与 `.dependency-cruiser.cjs` 的 `dependencyTypesNot: ["npm-peer"]`（不需要就一点不留）。

例外且唯一的裸包名出现处是 `src/events.ts` 里那行 `import type {} from "@deepseek-ai/cordis"`：它只做"把 cordis 的增强链载进本包的 program"（缺了它 `Context` 没有 `emit`/`provide`/`effect`，`tsc` 直接红），空绑定会被 tsc 从 `dist/events.d.ts` 里整个擦掉——`tests/dist.test.ts` 断言 `dist/*.d.ts` 里 `from "@deepseek-ai/` 零命中。

**构建上的两个非常规动作（都有原因，别"顺手改掉"）**：`tsc` 发声明时会把 `@hreader/core` 的源码拉进 program 并给它们也发 `.d.ts`（`rootDir` 设了会直接 TS6059 报错），所以 `tsconfig.build.json` 的 `outDir` 指向 `dist/.types`，build 只把 `dist/.types/dsh-bundle/src/*.d.ts` 拷到 `dist/` 再删掉暂存目录；同因，这一步用 `--noCheck`（类型检查由 `tsc -p tsconfig.json` 全覆盖），否则声明一生成就会往 `packages/core/src/` 里拉屎。

**devDeps 里有两个"没人 import"的包**：`@deepseek-ai/dsh-attachment` 与 `@deepseek-ai/dsh-package-manifest` 不是本包用的，而是 `@deepseek-ai/cordis → dsh-llm` 类型链的 peer，缺了 `tsc` 直接 TS2307；`knip.json` 用 `ignoreDependencies` 登记了这条事实，别当垃圾删掉。

**`build` 用 `--sources-content=false`**：`index.js.map` 也是交付物，默认会 `sourcesContent` 内联全部源码（含 `@hreader/core` 的字节），装出去就是把 core 源码随包带走；关掉内联后 map 只留 `sources` 路径，栈帧照样能指回 `src/index.ts`。**别**改成关掉 sourcemap——那是拿宿主的调试能力换一行 grep 干净。`tests/dist.test.ts` 对整份 `dist/**`（含 map）断言 `@hreader/core` / `workspace:*` 零命中。

**已知风险**：①（已消解）`dsh.compatibility.dshReleases` 是照第三方插件 `dsh-web-app@0.6.1` 的实证写法抄的，且本仓装的 `@deepseek-ai/dsh-package-manifest@0.2.2-rc.1` 的类型里**没有** `compatibility` 字段；已用真 `@deepseek-ai/dsh@0.2.2-rc.1` 验过：`dsh plugin add` 退出码 0，`--dump-config` 合成树含本 bundle（见上）。② 依赖全是 `0.2.2-rc.1` 的 rc 版本，上游一改 `SECTION_ORDERS` 或 `SystemPrompt.section` 签名就会漂——`tests/manifest.test.ts` 钉的是精确版本，升级时先读升级后的 `lib/types/index.d.ts` 再改常量。③ `tests/drift.test-d.ts` 只挡类型层漂移（改名/删字段/新增必填必红；新增可选字段不红），`order` 撞位、`name` 新约束这类语义漂移只有 `scripts/smoke-dsh.ts` 兜底，而它不在 CI 里。

**已知限制（`L-34`）**：`dist/styles` 与仓库 `styles/` **同时**缺失时（典型的半截安装：`files` 字段漏了 `dist/styles`，或有人只手拷了 `dist/index.js`），`HrError` 的文案只说"已查内置预设、`<workspace>` 的项目风格、`~/.hreader/styles`"，**不提 `dist/styles`**——而打包安装后前两者都不存在，用户按文案去查会一无所获。复现：`rm -rf packages/dsh-bundle/dist/styles && mv styles /tmp/styles.bak && node -e 'import("./packages/dsh-bundle/dist/index.js").then(m=>m.apply(fakeCtx,{styleId:"atelier-editorial"}))'`。修法（须随"错误文案与资源解析同源"一起改，不许只改文案）：把 `stylesRootOf` 的回落链显式记进错误消息。M3.3 不改 core、也不改文案模板之外的逻辑，故登记不修。

---

## M4.1 hr style extract 使用节

把一个作者的 1..N 篇 `.md`/`.html` 语料摸成一份 `style.yaml`：统计层定节奏与词表，LLM 层只提“人设/叙事规则/句式”建议。产出的 `style.yaml` 就是 `hr style --tone` 的全部输入——**但只有写在发现路径上才找得到**（见下）。

**三个例子**：

```bash
# 纯统计版：不需要 key，0 次网络。CI 默认就跑这条（父目录不自动建，先 mkdir -p）。
mkdir -p .hreader
hr style extract fixtures/extract/*.md --id my-voice --out .hreader/style.yaml --no-llm

# 带 key：人设与叙事规则交给模型，统计值仍是权威（节奏/词表不许模型改）。
mkdir -p "$HOME/.hreader/styles/my-voice"
OPENCODE_API_KEY=… hr style extract fixtures/extract/*.md --id my-voice \
  --out "$HOME/.hreader/styles/my-voice/style.yaml" --force

# --json：给脚本/Agent 用；错误也是单行 JSON（不是人类可读文案）。
hr style extract fixtures/extract/*.md --id my-voice --json | jq -r .data.yaml
```

`--out` 写别处也能用（导出/入库都合法），只是 `hr style doc.md --tone my-voice` 找不到它；此时 stderr 会给一行“不在风格发现路径里”的提示。发现路径只有两条：项目的 `<workspace>/.hreader/style.yaml`、用户的 `~/.hreader/styles/<id>/style.yaml`。

| 旗标                    | 行为                                                                                                                                       |
| :---------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `--out <path>`          | 写到 workspace 内路径；不传就打印到 stdout。已存在需 `--force`（`file_exists`）；父目录不自动建；越界 `path_outside_workspace`             |
| `--id <style-id>`       | 风格 id，必须匹配 `STYLE_ID` 正则（否则 `invalid_style`）；缺省用首篇文件名 slug，并在 stderr 说明用了默认值                            |
| `--name <显示名>`       | 显示名；缺省等于 `--id`，同样在 stderr 说明                                                                                              |
| `--inherits-visual <t>` | 继承的视觉主题，默认 `atelier-editorial`；风格自己的 `theme.css` 优先                                                                    |
| `--workspace <dir>`     | workspace 根，决定 `--out` 的边界与项目级风格路径；默认进程 cwd                                                                         |
| `--force`               | 只放开“覆盖”这一件事，不连带放开目录创建与越界                                                                                           |
| `--no-llm`              | 强制纯统计版；有 key 也不联网                                                                                                            |
| `--model <id>`          | 覆盖模型 id（默认 `deepseek-v4.1-flash`，端点上只这一个可用）                                                                            |
| `--base-url <u>`        | 覆盖网关（默认 `https://opencode.ai/zen/go/v1`）；只收 http(s) 绝对地址，`v1`/`ftp://…` 直接 `invalid_input` 且零请求                    |
| `--json`                | 成功 `{ok:true,data:{path,stats,yaml,dropped?}}`（`dropped` 仅 LLM 路径出现）；失败 `{"ok":false,"code":…,"message":…}` 单行                |

**降级是默认路径**：没设 `OPENCODE_API_KEY` 就自动走纯统计版（stderr 一行“未设置 OPENCODE_API_KEY，仅用统计结果”），`--no-llm` 是显式版同一条路。两条路径的产物都能被 `loadStyle`/`compileTone`/`lintByStyle` 消费（`packages/cli/tests/style-extract-e2e.test.ts` 各跑一遍）。

**真调用账（D12）**：录制期共 **8 次**（预算 10），逐次明细见 `fixtures/llm/README.md` 的“调用账”；复验期另有约 5 次误用真 key，记在卡 §9。`pnpm verify` 里全是回放，零真实调用。

**已知限制**：`L-36`——模型输出非确定，CI 只有 fixture 回放，真模型换代或改 prompt 先红的是 `extract-llm` 回放用例；`L-37`——统计层的句数判定有两头偏差：**多计**（`packages/core/src/style/extract/paragraphs.ts:148-153` 的 `isAsciiPeriodEnd` 把“`.` 后跟空白”算句末，于是 `e.g. `、`Dr. `、`3. 5` 这类都被切开）与**少计**（`；` 连写的长句、无标点的长段只算一句），短文本（<3 段）上更明显，`max_paragraph_sentences` 因此可能偏高或偏低。

---

## M4.3 `hr export` 使用节（打印稿）

```bash
hr export notes/perf.html --visual atelier-editorial --out notes/perf-print.html
hr export notes/perf.html --workspace /tmp --out /tmp/perf-print.html
hr export notes/perf.html --json | jq -r .data.html > notes/perf-print.html
```

`hr export` 把一篇已解析的文档排成**单文件、离线、可打印**的 HTML（封面 + 目录 + 编号 + 印刷骨架），交给浏览器或后续 PDF 渲染器出纸。管线全程纯函数：CLI 读文件 → `injectNodeIds` → `buildOutline` → `loadThemeCss`（core，带 `assertThemeSafe`）→ `printHtmlOf({ documentHtml, outline, themeCss, … })`（单对象入参，`print-html.ts:238`）→ `writeAtomic` 写盘。

| 旗标 | 行为 |
| :--- | :--- |
| `--visual <theme-id>` | 视觉主题 id，默认 `atelier-editorial`；非法 id 走 `invalid_theme` / `unknown_style` 既有口径 |
| `--out <path>` | 写单文件打印稿，必须在 `--workspace` 内（越界 `path_outside_workspace` / exit 3）；已存在需 `--force`（缺省 `file_exists`）；父目录不自动建，缺失报 `io_failure`（exit 3，与 `hr style extract --out` 缺父目录报 `invalid_input` 不同码，但“不自动建/`--force`/`file_exists`”同口径） |
| `--workspace <dir>` | workspace 根，决定 `--out` 的边界；默认进程 cwd |
| `--json` | 成功 `{ok:true,data:{html,bytes,droppedImages,out}}`；失败 `{"ok":false,"code":…,"message":…}` 单行。键集固定（含 `out:null`、`droppedImages:0` 时不省键） |

**4 MiB 上限**：打印稿按拼接后的 UTF-8 字节判定，`> 4194304` 报 `invalid_input`（exit 1），报文给实际字节数与处理方法——按章拆分文档，单篇控制在 4 MiB 以内再导出。该上限同时写在 `hr export --help` 里（不再只在报错时才可见）。

**`dropped_images` 口径**：只统计被删的 `<img>` 与 SVG `<image>`；`<video>`/`<audio>`/`<svg>`/`<iframe>` 是**整删不计数**。原因：前两者删掉会直接少一张图（用户看得见），后者整块删是结构决策、不是丢图。有图被删时 stderr 另给一行“已移除 N 个外部图片”。

**印刷骨架与主题的关系**：`PRINT_CSS`（骨架）拼在主题 `<style>` **之后**，因此骨架压主题；`themeCss` 里任何 `</style` 先转成 `<\/style`（纯字符串兜底，最后一道物理防线），合法性判定仍由 core 的 `assertThemeSafe` 在 `loadThemeCss` 里做——打印层**不重复实现**该校验。产物里 `@media print` 之外的 `.print-*` 别名只有四个：`.print-cover`/`.print-toc`/`.print-chapter`/`.print-cover__title`，**不补齐**旧骨架类名（别名是迁移期内给旧样式表的短路，不是 API）。

**已知行为（有意为之，不是缺陷）**：源文档自身重复的 `id` **不修复**。生成锚只保证“不与任何既有 `id` 冲突”（冲突加 `-2`/`-3` 后缀）；改写用户 `id` 会打断 `<a href="#sec-1">` 的内部链接语义，而重复 `id` 本身已是非法 HTML，该由源文档修。用例 `source-duplicate-ids-are-preserved` 把这条固化成契约。

**端到端**：`pnpm test:e2e` 调 `scripts/print-e2e.ts`，用真 Chrome（`--headless=new --print-to-pdf`）出 PDF；无 Chrome 或 `HREADER_SKIP_CHROME=1` 时打印 `SKIPPED: <原因>` 并退出 0（不静默）。AC-6 的“分页规则层生效”用**差分**证明：同文同主题断开 `break-*` 规则后页数必须变化——本机缺 `pdftotext`，故不依赖文本抽取。

---

## M4.4 `hr pdf` / `hr png` 使用节（二进制产物）

```bash
hr pdf notes/perf.html --out notes/perf.pdf
hr pdf notes/perf.html --page-size a5 --out notes/perf-a5.pdf --json | jq -r .data.pages
hr png notes/perf.html --out notes/perf.png --width 1200 --scale 2
hr png notes/perf.html --out notes/huge.png --max-height 50000 --scale 1
```

`hr pdf`/`hr png` 把 M4.3 的打印稿交给**本机 Chrome** 渲染成真二进制。CLI 不引任何运行时依赖：Chrome 交互只用 `child_process` + `globalThis.WebSocket`（Node 22+ 内置），协议手工构造 CDP 报文。路径契约与 `hr export` 同口径（`assertOutInsideOf` + `writeAtomic` + `--force`/`file_exists`），**不允许**第二套判定。

| 旗标 | 适用 | 行为 |
| :--- | :--- | :--- |
| `--out <path>` | 两者 | **必填**；必须在 `--workspace` 内（越界 `path_outside_workspace`/exit 3）；已存在需 `--force`（缺省 `file_exists`） |
| `--page-size a4\|letter\|a5` | `pdf` | 默认 `a4`；非法值 `invalid_input`/exit 1。**同时改纸张与 `@page`**（只换纸不改版心会让 a5 被硬切，见下） |
| `--width 256..4096` | `png` | CSS 像素宽，默认 `1200` |
| `--scale 1..3` | `png` | 设备像素倍率，默认 `2`；产物宽高 = CSS 尺寸 × n |
| `--max-height 1000..50000` | `png` | 整页高上限，默认 `20000`；**超出先裁不缩**，`clipped:true` |
| `--timeout 1..600` | 两者 | 渲染上限秒数，默认 60；到点先 `SIGTERM`，2s 后 `SIGKILL` |
| `--json` | 两者 | `pdf` → `{pdf,bytes,pages,out}`；`png` → `{png,bytes,width,height,clipped,out}`（二进制字段是 base64，宽高是**设备像素**，键集固定不省键） |

**Chrome 从哪来**：`HREADER_CHROME` 环境变量优先，缺省探测三个标准路径（macOS/Homebrew/Linux 各一）；全都没有 → `chrome_missing`（exit 3），message 点名 `HREADER_CHROME` 与三个候选路径。**Chrome 的原始 stderr 永不整段进 envelope**（会泄路径、撑爆输出）：最多留首个错误行并截断 200 字。

**四层结构与可测性**：`packages/cli/src/chrome/` 分「协议（CDP 报文纯构造/解析，零 I/O）/ 传输（`send`+`onMessage`+`close` 接口：真实现是 WebSocket，测试实现是内存假双工）/ 会话（spawn、抓 `DevTools listening on ws://…`、超时、杀进程组、清临时目录）/ 命令（`pdf.ts`/`png.ts` 只做参数 → 会话 → 校验 → 落盘）」。因此单元测试**不需要 Chrome**，全链路真假边界只在 `pnpm test:e2e`。

**长图是整页不是首屏**：高度取 `Page.getLayoutMetrics` 的 `cssContentSize.height`，再 `Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot{captureBeyondViewport:true}`。`--max-height` 是**截断**（先裁不缩），不是缩放。短文档（`cssContentSize.height ≤ 1000`）会以 100px 视口**重量一次**，否则视口地板会把几百像素的文档撑成 1000px 白边。

**像素闸（两个，顺序有讲究）**：单边闸 `PIXEL_EDGE_LIMIT = 65535`、总像素闸 `PIXEL_AREA_LIMIT = 2.5e8`。65535 是**保守**单边闸（真机 `1200×76663` 也能出图，此处留余量），不是光栅层天花板；窄档（默认 1200 CSS 宽）先撞高边闸，宽档（`--width 4096 --scale 3`）先撞面积闸。预检只在用户**显式**传 `--max-height` 时查面积（否则默认 20000 会把 `--width 4096 --scale 3` 的短文档误拒），量到真实内容高后的**终检永远查**。

**`--page-size` 为何要动 CSS**：`printToPDF` 固定 `preferCSSPageSize:false`（否则 `print-css` 的 `@page{size:A4}` 永远压过 `--page-size`），但只换纸张不改版心——实测 letter/a5 的版心仍是 A4 的 658 CSS px，a5 右侧被纸边硬切。所以 `@page` 也参数化（`printCssOf(paper)`），三档版心宽必须各不相同：`a4 658px`｜`letter 680px`｜`a5 423px`（@96dpi，容差 ±6px）。

**确定性边界**：PDF/PNG 字节含时间戳与内核版本，**不断言字节相等**。断言点：PDF 的 `/MediaBox`（按纸型，容差 1.5pt）、`/Type /Page` 计数（正则 `/\/Type\s*\/Page\b(?!s)/gu`）、字体内嵌 `/FontFile`；PNG 直接读 IHDR（字节 8..24）取宽高与位深。同一输入两次渲染的**页数/宽高**必须相等（真 Chrome，只在 e2e）。

**进程卫生**：Chrome 带 `--user-data-dir=$TMPDIR/hr-chrome-XXXX`（否则污染用户 profile、单例冲突）；`--headless=new` 会 fork 渲染子进程，故 `spawn(..., {detached:true})` 后 `process.kill(-pid,'SIGTERM')` 杀**整个进程组**；任何退出路径（成功/超时/异常/信号）都在 `finally` 里 kill + `rmSync`。自检：`pgrep -fl 'hr-chrome-' | grep -v pgrep`（应为空）与 `ls -d $TMPDIR/hr-chrome-*`（应为空）。

**端到端**：`pnpm test:e2e` 在真 Chrome 下各出一份 PDF/PNG；无 Chrome 或 `HREADER_SKIP_CHROME=1` 时打印 `SKIPPED: <原因>` 并退出 0（不静默）。

**已知限制**：PDF 大纲/书签已由 **M4.5** 用 Chrome 原生 `generateDocumentOutline` 实现（使用节见下）；不做 PDF 合并/签名/加密、不做并发渲染池。

---

## M4.5 `hr pdf --outline` 使用节（PDF 大纲/书签）

`hr pdf` 默认给产物带**大纲（书签）**：由 Chrome 的 `generateDocumentOutline` 从**打印稿 DOM** 生成，标题文本与打印稿 `<h1..h6>` 的 `textContent` 一致（含打印层注入的 `1` / `1.1` 编号，封面与目录标题刻意用 `<p>` 所以不进货签）。

```bash
hr pdf a.hreader --out a.pdf              # 默认带大纲
hr pdf a.hreader --out a.pdf --no-outline # 不要大纲
hr pdf a.hreader --out a.pdf --json       # {"pdf":…,"bytes":…,"pages":…,"outline":…,"out":…}
```

- `--outline`（默认开）/ `--no-outline`：同传 → `invalid_input` exit 1；`hr png` 上出现任一个 → 同样 exit 1（PNG 没有大纲概念）。两种拒绝都**不落盘**。
- `--json.outline`：本次打印稿里 `<h1..h6>` **元素的个数**（`--no-outline` 或无标题时为数字 `0`，键不省略、不是 `null`）。h1–h6 全收（h4/h5/h6 已真机实测确认 Chrome 会收录）。
- **`outline` 是产物真值（`L-40` 已关闭，M4.5.1）**：`--json.outline` 数的是**产物 PDF 里 `/Outlines` 树的真实条目数**（`packages/cli/src/pdf/` 的 `bookmarkCountOf(bytes)`，命令层统一走这一条路径，`--no-outline` 不短路——产物没有 `/Outlines` 自然得 0）。因此 `display: none` 子树里的标题**不再被计数**（Chrome 不为它生成书签）。读不出来时按 `render_empty` 处理而不是报 0：产物里写了 `/Outlines` 但树读不出、`/First`/`/Next` 断链、条目带 `/Type /Page` 走错进页树、`/Count` 与实走不一致、条目成环，**一律 `render_empty` 且不落盘**；位置在 `startxref` 之后的 `trailer` 不认（写进 `%` 注释的冒充 trailer 也被当注释吞掉）。已知不支持：对象流（ObjStm）、xref 流、`/Names` 大纲——Chrome 产的是明文对象 + 经典 xref，这三类不出现。Chrome 对超长标题会截断到约 1 KB（`L-41`）仍然成立。
- **不引依赖、不自写 PDF 增量更新**：全部交给 Chrome，`packages/cli/src` 里没有 PDF 解析器；测试侧的扫描器只在 `packages/cli/tests/helpers/pdf-scan.ts`（跟 `/Root`→`/Pages`→`/Kids` 算页序、沿 `/First`/`/Next`/`/Parent` 还原标题树、解 `<FEFF…>` UTF-16BE）。

## M4.2 桌面壳 `@hreader/desktop` 使用节（Tauri v2 GUI）

壳**不托管阅读器**：它定位 `hr`、读/复用/拉起 daemon，再把 webview 导航到 `http://127.0.0.1:<port>/s/<docId>?t=<token>`。阅读器行为一行都不在 Rust 侧；细节（一次启动的 6 步、文件分工表、`--smoke`、`accels.json`）见 `packages/desktop/README.md`，本节只写**用户/验收视角的契约**。

```bash
pnpm desktop:check                # cargo fmt --check + clippy -D warnings + cargo test（80 例）
pnpm desktop:build                # 产物在 src-tauri/target/release/bundle/
pnpm desktop:dev -- --workspace <dir> --open <file>   # 开发时直跑
```

- **home 是应用私有目录，不是 `$HOME`**（macOS `~/Library/Application Support/com.hreader.desktop`，Windows `%APPDATA%/com.hreader.desktop`，Linux `~/.local/share/com.hreader.desktop`），daemon 记录落在 `<该目录>/.hreader/daemon.json`。理由：双击 `.app` 时 argv 无 `--home`，若当归宿是 `$HOME` 就会**覆写并删除用户自己那份**记录；目录不存在由壳 `mkdir -p`（`hr serve --home` 要求目录已存在）。并行实例/测试请用 `--home <dir>`。
- **daemon 生命周期**：壳拉起的 daemon 带 `--exit-with-parent`。壳正常退出 → daemon 收 SIGTERM 自退；壳被 `kill -9` → daemon 下一拍发现父消失、自退并删 `daemon.json`。壳侧还有兜底（`Drop`：`TERM` → 等 2s → `KILL`），**但验收不许用"进程没了"当证据**——被 SIGKILL 也算没了（`docs/03` §11.45）。
- **父 pid 只采集一次**：`packages/cli/src/main.ts:12` 在首个 `await` 之前取 `process.ppid`，注入链 `CliIo.launchParentPid`（**必填**）→ `ServeInput.launchParentPid` → 启动前判 `ppid === 1` 即拒启（`invalid_input`，exit 1，不建服务、不写 json）。晚读 `process.ppid` 在类型层不可写。
- **`--exit-with-parent` 的已知限制（`L-42`）**：启动时父进程已是 init（`ppid === 1`，典型：`nohup`、`setsid`、systemd 服务）会**拒启**。语义上不可实现"父消失即自杀"，只能 fail-fast；壳路径永远先采集父 pid，不受影响。不带该旗标时 ppid=1 正常启动。
- **daemon 复用判定**：`/healthz` 回的 pid 与 `daemon.json` 一致才复用；端口被别的进程占着报错而不是接管；文件坏了按"没有"处理并重建。**用户手动跑的 `hr serve` 不会被误判、更不会被误杀。**
- **真机脚本**：`scripts/gui/m4.2/`（`w1-signal-exit.sh` 壳收信号、`w2-parent-death.sh`/`w2-launch-window.sh` 父死与启动窗口、`w7-default-home.sh` 默认 home），`lib.sh` 提供 `mktemp_root`/`make_dirs`。`--home` 一律指向 `mktemp -d` 沙箱；**W7 是唯一例外**：它故意使用真实壳 app data 目录并在开头 `rm -rf` 它，脚本因此要求 `HREADER_GUI_REAL_HOME=1` 才继续——跑之前备份、并确认无在跑实例。无机器相关绝对路径。`pnpm lint:sh` 对它们逐个 `bash -n`。
- **门禁**：`pnpm verify` 八步（`format:check` → `lint` → `lint:sh` → `typecheck` → `build` → `test:coverage` → `depcruise` → `knip`）；桌面侧独立 `pnpm desktop:check`（Cargo 与 TS 不同链，不塞进 `verify` 以免无 Rust 环境者被卡）。

## 错误码表（`HrError.code` → 退出码）

本表是 §2 对外错误契约的**唯一文字版**，由 `packages/core/src/hr-error.ts` 的联合类型与 `packages/cli/src/exit-codes.ts` 的 `satisfies` 表派生：**新增 code 必须同步三处（两文件 + 本表）**，`satisfies` 只能保证前两处不脱节。退出码语义：`0` 成功 / `1` 业务拒绝 / `2` 用法错误 / `3` IO / `70` 内部错误。

| code | 退出码 | 何时出现（用户视角） |
| --- | --- | --- |
| `invalid_html` | 1 | 传进来的不是字符串 / 文档没有 `<head>` 时注入主题样式失败 |
| `no_article` | 1 | **源文档里没有 `<article>`**，无从导出 |
| `empty_document` | 1 | **`<article>` 在，但裁掉交互 UI 后没有可读文本**（与 `no_article` 不许合并）；判定前先剥零宽字符 `U+200B`/`U+FEFF`/`U+180E`，否则只含零宽的文档会排出空白页 |
| `node_not_found` | 1 | 三条来源：①`data-hr-id` 匹配不到节点（id 不存在）；②选择器命中但目标**不可寻址**（如无 `data-hr-id` 的 `<span>` 无法承担 patch 的根）；③文法合法但零命中。三者都归这个码，**不是** `invalid_selector` |
| `node_not_allowed` | 1 | 目标是页面外壳锚点，不可读 |
| `invalid_selector` | 1 | 选择器语法非法（`data.reason: "syntax"`），或选择器命中多个可寻址元素、需要给 id（`data.reason: "ambiguous"` + `data.count` + `data.matches` + `data.candidates`）。`count` 是**这次歧义里可选项的总数**（多义命中时等于 `addressable`，截断不影响它，不变式 `candidates.length === Math.min(count, 5)`）：双解释时恒 2（id 一个 + 选择器一个）；**不是**“选择器命中了几个元素”——那个数在 `matches` |
| `invalid_document` | 1 | `hr-meta` 等伴随文件不是合法 JSON |
| `invalid_fragment` | 1 | 片段为空/只有空白，或解析后不是恰好一个根元素（标签不配平不算错——HTML5 容错解析会补闭合） |
| `invalid_max_bytes` | 1 | `maxBytes` 超出 `(0, MAX_BYTES_LIMIT]` |
| `invalid_input` | 1 | 参数/配置/输入超出契约（含 `hr export` 产物 **> 4 MiB**；按拼接后的 UTF-8 字节**精确**判定，不是估算，故 4 MiB±1 不会走错分支） |
| `locked` | 1 | 并发写锁被抢/被接管 |
| `forbidden_content` | 1 | 待写入内容含禁止项（脚本、外部资源等） |
| `undo_unavailable` / `nothing_to_undo` | 1 | 没有可回滚/可撤销的快照 |
| `invalid_style` / `unknown_style` | 1 | 风格文件非法 / 查不到该 `styleId` |
| `invalid_theme` | 1 | 主题 CSS 非法（含 `</style>`、外部 `url()`） |
| `anchor_lost` | 1 | 批注锚点失效（那段文字被改过） |
| `file_exists` | 1 | 目标已存在且没加 `--force` |
| `not_found` | 1 | 批注等实体不存在 |
| `invalid_request` / `invalid_payload` | 1 | HTTP 请求体不是 JSON 对象 / 载荷自相矛盾 |
| `busy` | 1 | 文档正被另一个写请求占用 |
| `too_many_clients` | 1 | SSE 客户端已满 |
| `unauthorized` / `forbidden_origin` | 1 | 缺凭据 / `Origin` 不在白名单 |
| `chrome_missing` | 3 | 找不到本机 Chrome（`HREADER_CHROME` 与三个候选路径都不存在）；message 点名变量与路径 |
| `chrome_failed` | 3 | Chrome 起不来/握手失败/渲染报错，**或 Chrome 自报的产物尺寸与请求不自洽**（宽度寄生自算值，脚手架内部不一致也算失败，不报用户请求错） |
| `render_timeout` | 3 | 渲染超过 `--timeout`（早退先 `SIGTERM`，2s 后 `SIGKILL`；退出后无孤儿进程） |
| `render_empty` | 3 | 产物 0 字节或结构不合法（PDF 无 `%PDF-` 头 / PNG 无 IHDR） |
| `path_outside_workspace` | 3 | 目标逃出工作区 |
| `not_a_file` | 3 | 路径不存在或不是普通文件 |
| `io_failure` / `style_io_failure` | 3 | 读写失败（磁盘、权限） |
| `invalid_utf8` | 3 | 文件不是合法 UTF-8 |
| `llm_failure` | 3 | 风格建议层调用失败（message 里不许出现 key/prompt/响应原文） |
| `daemon_already_running` | 1 | 已有 daemon 占着端口（运行时状态，不是用法错）；message 点名 pid 与两条后手：`kill <pid>` 或删 `daemon.json` |
| `port_in_use` | 2 | `127.0.0.1:<port>` 的 bind 真失败（`EADDRINUSE`），占端口的**不是**我们的 daemon（是的话报上一条）；`daemon.json` 记的端口上探不到身份（`/healthz` 超时/非 JSON）也落到这条——探不到 ≠ 能证明它是我们的；后手一律是换 `--port`。`::` 上另有监听只作 stderr 提示，不改变能否启动 |
| `needs_normalize` | 2 | 文档**缺** `data-hr-id`（`outline`/`read`/`patch`/`serve` 的前置判定）；message 点名 `hr normalize <file> --write`（normalize 会补齐，是「缺」不是「撞」） |
| `duplicate_id` | 2 | 同一文档里两个元素**共用**同一个 `data-hr-id`（同为 exit 2，与 `needs_normalize` 靠「缺 vs 撞」区分）：`read`/`patch` **在定位之前就报本条并退出 2**——重复的那处永远读不到、也改不到删不掉（不是“只命中第一个”）；message 点名 `hr normalize <file> --write`（normalize 会给后出现的那个改名） |
| `content_model_conflict` | 2 | 片段内容模型与目标容器不兼容（`patch` 的 `append`/`prepend`/`replace` 写盘前判）：`<p>`/`<h1>`–`<h6>`/`<pre>` 这类 phrasing-only 容器装不下块级子节点。**用户可修**（换容器如 `article`/`section`/`div`、或改 `--html`），因此与 `invalid_input`（整条输入不合法、得看文档）分开，也不复用 `invalid_fragment`（片段本身合法，是“放不下”） |

---

## 横切口径：`data-hr-id` 与批注锚点的生命周期

`data-hr-id` 由内容派生（详见 `.workflow/cards/M2.3.md` §8）：同一份字节两次注入 id 稳定，编辑则会让 id 漂移。

三个标签集合的分工（`packages/core/src/html/constants.ts`）：`BLOCK_TAGS` 只判**内容模型**（派生文档模型时算不算块），`ADDRESSABLE_TAGS` 管**有没有 id**（= 批注/`read`/`patch` 的可达面，`div` 与表格内部都在内），`PATCHABLE_TAGS` 管**能不能被改**（默认同为可寻址集；要表达"可寻址但不可作目标"只在这里减项并写理由，不在判定里加 if 链）。`hr normalize` 的迁移是纯增量：已有合法 `data-hr-id` 一律保留，只给裸着的可寻址元素补 id；`replace` 传入逐字相同的子树时保持 `unchanged` 且 id 不变——它是行级锚点不丢的判据。批注的 `nodeId` **不做落盘迁移**，锚点失效由读时重识别兜底（三档：命中 / `block_reidentified` / `block_missing`）。**发布前**若更换 id 方案，必须先交付 `nodeId` 迁移脚本，否则既有批注全部失效；当前未发布，无迁移义务（`L-02`，重构卡 R-6）。

## Milestone 2–4 卡片（暂只列标题，开工时再拆）

- M2.1 Daemon（HTTP + WS + watcher + 事件协议）
- M2.2 Reader UI 三栏骨架（书库/TOC/画布/边栏）
- M2.3 划词批注持久化 + Visual Diff + Undo
- M3.1 MCP Server（7 tools + resources + prompts + MCP-UI）
- M3.2 Pi 扩展单文件（`/hreader`、`/hr-style`、context.ui 注入）——使用节见上
- M3.3 DSH Cordis 插件（host-only：`systemPrompt.section` 织入 + 强类型事件发送侧）——使用节见上；Web 面板移 M4.x
- M4.1 `hr style extract` 风格萃取——LLM 回放 fixture 依赖 model id（`fixtures/llm/README.md`），换模型或改 prompt 需重录
- M4.2 Tauri v2 桌面端
- M4.3 出版级 PDF/长图导出——`hr export` 打印稿使用节见上；真二进制拆到 M4.4
- M4.4 `hr pdf` / `hr png`（本机 Chrome + CDP，零运行时依赖）——使用节见上
- M4.5 `hr pdf --outline`（PDF 大纲/书签，Chrome 原生 `generateDocumentOutline`）——使用节见上；`L-40`/`L-41` 为已知限制
