# hReader 总体架构设计兼演进路线图 (Architecture & Roadmap)

> [!IMPORTANT]
> 本文档基于 [01-competitor-research.md](file:///Users/liu/Documents/Project/hReader/docs/01-competitor-research.md) 的竞品调研结论，详细定义 **hReader** 的总体系统架构、自包含 HTML 文档规范、“视觉+语言”双维风格引擎、DOM 增量 Patch 协议、四大生态插件（Skill / MCP / Pi / DeepSeek Harness）的实现方案，以及分阶段演进路线图（Roadmap）。

---

## 一、 架构设计原则 (Architectural Principles)

1. **Local-First & 单文件自包含（Self-Contained HTML）**：
   每一篇由 hReader 生成或管理的 `.html` 文件都是合法的、标准的单文件网页。主题样式、语义组件、甚至用户的划词高亮与批注元数据均内嵌在文件内部，脱离 hReader 用普通浏览器也能完美打开。
2. **骨骼先行与手术刀式增量编辑（Skeleton-First & Surgical DOM Patch）**：
   彻底摒弃“修改一句话重写整个 HTML 文件”的低效模式。通过自动维护 `data-hr-id` 语义锚点，让 Agent 先读百字级 DOM 大纲骨骼，再对特定节点执行毫秒级局部 Patch。
3. **视觉主题与语言文风正交解耦（Orthogonal Visual & Language Styles）**：
   **视觉风格（Visual Theme）**由 CSS 变量与语义组件布局决定，支持在阅读器中 **0 Token 即时换肤**；**语言风格（Language Tone）**由结构化 Prompt 规约（人设、叙事结构、句式节奏、禁用词）决定，支持按章节驱动 Agent 局部重写润色。
4. **单核多端适配（Single Core, Multi-Harness Adapters）**：
   核心解析、DOM 修补与实时通信全部收敛于 `@hreader/core`，向上为 **Universal Skill、MCP、Pi Coding Agent、DeepSeek Harness (Cordis)** 提供零冗余的原生插件封装。

---

## 二、 总体系统架构全景图

```mermaid
flowchart TB
    subgraph Adapters["Layer 4: 多生态 Agent 插件与适配层 (Harness Adapters)"]
        direction LR
        Skill["Universal Skill\n• SKILL.md\n• hr-cli.mjs 脚本\n• 风格按需加载"]
        MCP["hReader MCP Server\n• DOM 增量读写 Tools\n• 语言风格 Prompts\n• MCP-UI 内联视图"]
        Pi["Pi Agent Extension\n• pi-hreader.ts 单文件\n• /hreader & /hr-style\n• context.ui 双向注入"]
        DSH["DeepSeek Harness Bundle\n• Cordis 插件 (dsh.bundle)\n• systemPrompt.section 织入\n• 强类型事件 (发送侧)"]
    end

    subgraph Core["Layer 3: 核心引擎与同步守护进程 (@hreader/core & Daemon)"]
        direction TB
        DOMEngine["语义 DOM 引擎 (AST Parser & Patcher)\n• parse5 / rehype AST 解析与容错自愈\n• data-hr-id 语义锚点自动生成与索引\n• Outline 提取 / 节点局部 Patch / Diff 计算"]
        StyleEngine["双维风格引擎 (Style & Tone Compiler)\n• 内置旗舰风格 (Atelier Editorial)\n• 自定义 style.yaml & theme.css 加载器\n• 语言风格 Prompt 编译与校验器 (Lint)"]
        SyncBridge["实时双向通信桥 (WebSocket + File Watcher)\n• Agent ➔ Reader: 节点级热更新 (DOM Morphing)\n• Reader ➔ Agent: 划词批注 & 局部改写任务队列"]
    end

    subgraph Client["Layer 2: hReader 阅读器宿主 (Web UI / Tauri v2 Desktop)"]
        direction LR
        Library["本地书库与检索\n(Bookshelf & Full-text Search)"]
        Canvas["沉浸式阅读画布\n(TOC / 0-Token 换肤 / 键盘导航)"]
        Annotator["划词批注与指令栏\n(Highlight / Sidenotes / Ask AI)"]
        DiffViewer["变更闪烁与版本对比\n(Visual DOM Diff & Rollback)"]
    end

    subgraph Storage["Layer 1: 本地持久化层 (Local File System)"]
        HTMLDoc["增强型自包含文档 (*.html)\n• <article> 语义正文 + data-hr-id\n• <style id='hr-theme'> 视觉样式\n• <script id='hr-meta'> 批注与历史快照"]
        StyleDir["风格包仓库 (~/.hreader/styles/)\n• builtin/atelier-editorial/\n• custom/<user-style>/style.yaml"]
    end

    Adapters <-->|"API / CLI / JSON-RPC"| Core
    Core <-->|"WebSocket (JSON Events)"| Client
    Core <-->|"AST Read / Write"| Storage
```

---

## 三、 核心子系统详细设计

### 1. 自包含增强型 HTML 文档规范 (`hReader HTML Spec`)

为了兼顾“普通浏览器直接双击可读”与“hReader 深度交互与增量编辑”，我们定义标准化的单文件 HTML 结构：

```html
<!DOCTYPE html>
<html lang="zh-CN" data-hr-visual="atelier-editorial" data-hr-tone="feynman-tech">
<head>
  <meta charset="UTF-8" />
  <title>分布式一致性协议深度解析</title>
  <!-- 1. 视觉风格层：可由阅读器或引擎 0-Token 动态替换 -->
  <style id="hr-theme">
    :root { --hr-bg: #FAF8F5; --hr-fg: #1C1917; --hr-accent: #C84B31; /* ... */ }
    /* 内置响应式排版、Bento 卡片、Callout、Sidenotes 样式 */
  </style>
</head>
<body>
  <main class="hr-container">
    <article data-hr-id="root-article">
      <!-- 2. 语义块层：每个章节/组件拥有唯一稳定的 data-hr-id -->
      <header data-hr-id="sec-header">
        <h1 data-hr-id="title-main">分布式一致性协议深度解析</h1>
        <p class="hr-lead" data-hr-id="p-lead">从物理时钟的不可靠性出发，推演 Raft 与 Paxos 的本质同构。</p>
      </header>

      <section data-hr-id="sec-problem" data-hr-component="callout-warning">
        <h2 data-hr-id="h2-problem">为什么直觉上的“主从复制”一定会丢数据？</h2>
        <p data-hr-id="p-problem-1">假设网络发生分区...</p>
      </section>

      <section data-hr-id="sec-comparison" data-hr-component="kpi-bento">
        <!-- 语义化网格卡片或内联 SVG / Mermaid -->
      </section>
    </article>
  </main>

  <!-- 3. 内嵌元数据与批注层：普通浏览器自动忽略，hReader 读取并渲染为页边批注 -->
  <script id="hr-meta" type="application/json">
  {
    "version": "1.0",
    "style": { "visual": "atelier-editorial", "tone": "feynman-tech" },
    "annotations": [
      {
        "id": "ann-01",
        "targetId": "p-problem-1",
        "selectedText": "假设网络发生分区",
        "comment": "这里请用银行跨行转账的例子具象化解释一下脑裂问题",
        "status": "pending_ai",
        "createdAt": "2026-11-12T14:30:00Z"
      }
    ]
  }
  </script>
</body>
</html>
```

---

### 2. “视觉 + 语言”双维风格引擎 (`Dual-Axis Style Engine`)

风格引擎将**视觉表现（Visual）**与**语言文风（Language/Tone）**拆分为两个可独立配置、也可打包分发的维度：

```mermaid
flowchart LR
    subgraph Pack["风格包 (Style Pack)"]
        V["视觉维度 (Visual Theme)\n• CSS 变量令牌 (色彩/明暗)\n• 字体排印组合 (衬线/等宽)\n• 6大语义组件样式"]
        L["语言维度 (Language Tone)\n• 叙事人设与结构 (Narrative)\n• 句式节奏与段落呼吸规则\n• 禁用词表 (Forbidden Words)\n• 句型转换范式 (Few-shot)"]
    end

    V -->|"注入 <style id='hr-theme'>\n(0 Token 毫秒级换肤)"| HTML["目标 HTML 文档"]
    L -->|"编译为结构化规约\n注入 Skill / MCP / Pi / DSH"| Agent["AI Agent (LLM)"]
    Agent -->|"按文风生成或局部重写 DOM"| HTML
```

#### (1) 内置默认风格：`Atelier Editorial`（工坊社论风）
* **内置视觉设计**：
  * **纸感与暗夜双模**：日间采用温暖羊皮纸白（`#FAF8F5`）与深炭墨黑，夜间自动切换为深曜石蓝灰（`#121316`），拒绝刺眼纯白与纯黑。
  * **黄金阅读人体工学**：正文区严格锁定 `68ch` 最佳阅读视宽，右侧预留 `280px` 边栏用于展示浮动目录与页边批注（Sidenotes）。
  * **7 个内置零配置语义组件（6 类，callout 含 insight/warning 两型）**（Agent 只需写 `data-hr-component="xxx"`）：
    1. `kpi-bento`：多维核心指标卡片网格
    2. `callout-insight / warning`：高辨识度洞察与警示框
    3. `split-compare`：左右双栏优劣/方案对比视图
    4. `deep-dive`：可折叠的底层细节/源码剖析手风琴框（`<details>` 增强）
    5. `step-timeline`：纵向编号流转步骤条
    6. `diagram-stage`：带缩放与图例说明的 SVG / Mermaid 画布容器
* **内置默认语言风格（社论深度剖析调性）**：
  * **结论先行（BLUF）**：每个 `<section>` 第一句必须给出明确判断，不绕圈子。
  * **反 AI 废话过滤器（Anti-Slop Lint）**：内置禁用词表（如“总而言之”、“在当今数字化时代”、“毋庸置疑”、“赋能”、“抓手”），引擎在 Patch 时甚至可对命中禁用词的段落向 Agent 发出重写警告。
  * **三段一视觉法则**：连续纯文字段落不得超过 3 段，第 4 段必须转化为对比表、列表卡片、引语或图表。

#### (2) 自定义语言风格定义规范 (`style.yaml`)
用户可在 `~/.hreader/styles/<style-id>/style.yaml`（或项目根目录 `.hreader/style.yaml`）中创建任意数量的自定义语言风格：

```yaml
id: sharp-reviewer
name: "毒舌架构师锐评风"
description: "一针见血指出设计缺陷，拒绝和稀泥，用工程数据说话"
inherits_visual: "atelier-editorial" # 继承内置社论视觉，也可指定自定义 theme.css

language_style:
  persona: "拥有 15 年分布式系统经验、极度讨厌过度设计的首席架构师"
  narrative_rules:
    - "开篇直接戳破方案中最脆弱的假设或性能瓶颈"
    - "凡是提到『高可用』『高性能』，必须追问或给出具体的延迟/吞吐量量级"
    - "对比竞品时明确给出『什么时候绝不要用它』的反面清单"
  sentence_rhythm:
    max_paragraph_sentences: 4
    style: "短句为主，多用设问与强对比，善用括号补充犀利吐槽"
  vocabulary:
    forbidden: ["赋能", "抓手", "闭环", "大概", "可能也许", "不仅...而且..."]
    recommended: ["权衡 (Trade-off)", "瓶颈", "单点故障", "代价是", "本质上"]
  examples:
    - bad: "该架构具有很好的扩展性，能够满足未来的业务需求。"
      good: "这套架构在 QPS 破万时状态同步会直接打满网卡——所谓的『高扩展性』前提是你得先忍受 30ms 的跨机房延迟。"
```

---

### 3. 语义 DOM 增量编辑协议 (`Semantic DOM Patch Protocol`)

为了支撑所有插件高效编辑 HTML，`@hreader/core` 提供以下 7 个核心原语（与 MCP Tools 一一对应）：

| 原语名称 | 输入参数 | Token 消耗与作用说明 |
| :--- | :--- | :--- |
| `hr_create_doc` | `filePath`, `title` | **建稿**。写一份最小合法文档（`<article data-hr-id="root">` + `<h1>` + 一个 `<section>`），节点 id 交给 `injectNodeIds` 派生；已存在的文件不覆盖。 |
| `hr_outline` | `filePath` | **~150 Tokens**。返回文档的 `<section>` / `<h1~h4>` 骨骼树、各节点 `data-hr-id`、字数统计、以及**所有未处理的 `pending_ai` 用户划词批注**。 |
| `hr_read_node` | `filePath`, `nodeId` (或 CSS Selector) | **~200 Tokens**。仅提取目标节点及其子树的 HTML 源码与关联批注，避免读取整篇文件。 |
| `hr_patch_node` | `filePath`, `nodeId`, `action` (`replace` \| `insert_after` \| `insert_before` \| `append` \| `delete`), `htmlContent` | **极速局部写入**。解析 HTML 片段，自动为新增块级元素注入 `data-hr-id`，校验标签闭合与禁用词，更新文件并触发 WebSocket 局部热更新。 |
| `hr_apply_style` | `filePath`, `visualId?`, `toneId?` | 若仅切换 `visualId`，引擎直接替换 `<style id="hr-theme">`（**0 LLM Token**）；若切换 `toneId`，返回该语言风格的完整规约供 Agent 改写正文。 |
| `hr_resolve_annotation` | `filePath`, `annotationId`, `resolutionNote?` | 将 `<script id="hr-meta">` 中对应的用户批注标记为 `resolved`，阅读器界面自动将该批注归档并高亮显示修改后的段落。 |
| `hr_undo` | `filePath` | **一次调用回退一步**。取最近一份快照 → 校验**快照自身**的哈希与文件名一致（防截断/改写；不校验目标文件是否被人改过）→ 原子还原 → 删掉该快照；没有历史时返回 `nothing_to_undo`。快照链由 `patch` / 批注处理 / 新建文档共用，但 **`hr_apply_style` 不写快照**（`L-32`）：换过样式后的一次 undo 会把正文一起退，不要把“换样式”当成可单独撤销的一步。 |

---

### 4. 四大生态插件实现方案 (Ecosystem Adapters)

#### 交互时序图：从阅读器划词批注到 Agent 局部增量更新

```mermaid
sequenceDiagram
    actor User as 用户 (在 hReader 阅读器)
    participant Reader as hReader Client (Web/Tauri)
    participant Daemon as @hreader/core Daemon
    participant Plugin as Agent 插件 (Skill / MCP / Pi / DSH)
    participant LLM as AI Agent (LLM)

    User->>Reader: 1. 划词选中段落 #p-problem-1，输入批注：<br/>"用自定义风格 sharp-reviewer 重写这段"
    Reader->>Daemon: 2. WebSocket 发送 Annotation Event
    Daemon->>Daemon: 3. 持久化写入 HTML 内嵌 <script id="hr-meta">
    Daemon->>Plugin: 4. 推送编辑请求事件 (含 filePath, nodeId, comment, style)
    Plugin->>LLM: 5. 唤醒 Agent / 注入 Context：<br/>目标节点源码 + 用户批注 + sharp-reviewer 语言风格规约
    LLM->>Plugin: 6. 调用 hr_patch_node(#p-problem-1, replace, newHtml)
    Plugin->>Daemon: 7. 执行 AST 局部替换并标记批注 resolved
    Daemon->>Reader: 8. WebSocket 推送 DOM Patch 载荷
    Reader->>User: 9. 页面不刷新，#p-problem-1 平滑过渡为新内容并闪烁高亮（支持一键 Undo）
```

#### ① Universal Skill (`packages/skill`)
* **目录结构**：
  ```text
  hreader-skill/
  ├── SKILL.md                  # 触发规则、工作流指令、6大内置组件 HTML 速查表
  ├── scripts/
  │   └── hr.mjs                # 零配置 CLI 封装 (支持 outline / read / patch / style / serve)
  └── references/
      ├── components-spec.md    # 详细组件 DOM 结构范例
      └── style-authoring.md    # 指导 Agent 帮用户采访并生成自定义 style.yaml 的指南
  ```

#### ② MCP Server (`packages/mcp-server`)
* 基于 `@modelcontextprotocol/sdk` 构建，支持 `stdio` 与 `SSE/Streamable HTTP`。
* 除了暴露上述 5 个核心 DOM 编辑 Tool 外，还将 `~/.hreader/styles/` 下的所有风格动态注册为 **MCP Resources (`hreader://styles/{id}`)** 与 **MCP Prompts (`use-hreader-style`)**。
* 支持 **MCP-UI**：当调用 `hr_create_doc` 或 `hr_patch_node` 时，返回 `_meta.ui.resourceUri`，在支持 MCP-UI 的宿主内直接弹出内联阅读视图。

#### ③ Pi Coding Agent 插件 (`packages/pi-extension/pi-hreader.ts`)
* 严格遵循 Pi (`@earendil-works/pi-coding-agent`) 的单文件 TypeScript 扩展哲学：
  * **注册命令**：
    * `/hreader [path]`：拉起本地 hReader 阅读视图并开启双向监听。
    * `/hr-style [tone-id]`：切换当前 Pi 会话绑定的语言风格与视觉主题。
  * **注册工具**：向 Pi 暴露 `hreader_outline`、`hreader_read_node`、`hreader_patch_node`。
  * **终端与阅读器联动**：订阅本地 Daemon 的 **SSE** 事件流（`GET /api/events`，`cookie` 认证 + `Last-Event-ID` 回填 + 心跳帧；M2.1 决定用 SSE 而非 WebSocket，见 `packages/core/src/server/event-ring.ts`）；事件到达后按需拉取批注（`GET /api/doc/:docId/annotations`），有新条目时调用 `ctx.ui.confirm` / `ctx.ui.notify` 提示用户，把节点源码与批注组装成消息注入 Pi 上下文（`pi.sendUserMessage` / `pi.sendMessage`）。

#### ④ DeepSeek Harness 插件 (`packages/dsh-bundle`)
* 深度适配 **DeepSeek Harness (`dsh`)** 的 **Cordis** 微内核架构（M3.3 只做 host 半边，见下"M4 候选"）：
  * **插件清单：两份都要写**。`package.json` 的 `dsh.bundle.patch: "./cordis.patch.yml"` 指向随包的 patch 文件，该 yaml 里 `insert` 一条 `{ id: hreader, name: '@hreader/dsh-bundle', config: {} }`；`dsh.compatibility.dshReleases` 同样必填（不写 dsh 会拦）。安装命令是 `dsh plugin --profile <profile> add <包目录>`——`--profile` 是**必填**选项（M3.3 调研：漏了直接 usage 报错）。
  * **Cordis 服务注册**：`ctx.provide('hreader', { styleId, prompt })` 暴露语言规约，同时用 `ctx.effect(...)` 注册并在清理函数里摘除 section 与服务（Reversible Effects），重复 `apply` 幂等。
  * **语言规约织入：`ctx.systemPrompt.section({ name, order, text })`**。`text` 逐字节等于 `compileTone(loadStyle(...).spec)`——与 CLI `hr style --tone`、MCP prompt `use-hreader-style` 同一份编译器，本包不拼接任何文案。**上游没有 "Prompt Hook / Prompt Interceptor" 这套机制**（M3.3 调研：`grep -rni "interceptor\|prompt hook"` 零命中），旧版本这里写错了，故改成本条。
  * **强类型事件**：`declare module '@deepseek-ai/cordis'` 里给 `Events` 补 `'hreader/patch-request'`，载荷是 `{ workspace, request: PatchRequest }`。本卡只交付**发送侧的类型契约**（`tsc` 编译期验证），接收方（谁把事件转成 Agent Loop 的一轮修补）在 dsh 侧，本仓无法单独验证。
  * **`dsh-web-app` 内嵌阅读面板：移到 M4 候选，本卡不做。** 冲突理由：DSH client 侧要求 React + `window.__ModuleLoader__.load` + `ctx.slots.inject`，而本仓阅读器（`packages/app`）是"无 bundler、无框架"的纯 DOM（§5 的设计前提），两者互斥；强行做等于给阅读器引入构建链，破坏它"由 daemon 静态托管、单文件可开"的核心约束。

---

### 5. hReader 阅读器宿主设计 (`packages/reader-client`)

阅读器采用 **Web UI + Tauri v2 外壳** 双栖架构（当前阶段只做 Web：`packages/app`，无 bundler、无框架，由 daemon 静态托管；Tauri 外壳留待后期）（同一套前端代码，既可由本地 Daemon 通过 `http://localhost:4321` 在任意浏览器/IDE Webview 中打开，也可编译为约 8MB 的 macOS/Windows/Linux 原生桌面 App）：

* **左栏：书库与语义大纲（Library & Outline）**
  * 自动扫描工作区或本地归档目录中的 `.html` 文档，按标签与阅读状态分类。
  * 实时展示当前文档的多级目录树（TOC），并标注哪些章节含有未处理的批注（📌）或刚刚被 AI 更新过（✨）。
* **中栏：沉浸式画布（Reader Canvas）**
  * 顶部悬浮控制条：**视觉风格下拉切换器**（实时预览切换 `Atelier Editorial`、`Blueprint`、`Paper` 等主题，无需 AI 重新生成）、明暗模式、字号/行宽/行距调节。
  * 键盘流支持：`j` / `k` 在各个 `data-hr-id` 语义块之间平滑跳转聚焦，`h` 高亮当前块，`c` 对当前块添加批注并唤醒 AI。
* **右栏：旁注与 Diff 审阅栏（Sidenotes & Diff Review）**
  * 仿纸质书页边留白设计，所有划词批注与高亮紧贴对应段落右侧对齐显示。
  * 当 Agent 通过 `hr_patch_node` 修改了某个段落后，支持一键切换 **Visual Diff 模式**（直观对比修改前后的文字/排版差异，点击 `Accept` 确认或 `Revert` 毫秒级回滚）。

---

## 四、 拟建工程目录结构 (Monorepo Structure)

建议在 `/Users/liu/Documents/Project/hReader` 下采用 `pnpm workspace` 组织轻量级 TypeScript Monorepo：

```text
hReader/
├── docs/
│   ├── 01-competitor-research.md       # 竞品全景调研报告
│   └── 02-architecture-and-roadmap.md  # 总体架构设计兼路线图 (本文档)
├── styles/                             # 内置风格包仓库
│   ├── atelier-editorial/              # 默认旗舰风格 (style.yaml + theme.css)
│   ├── feynman-tech/                   # 预设语言风格：费曼技术解构风
│   └── executive-brief/                # 预设语言风格：高管精炼简报风
├── packages/
│   ├── core/                           # @hreader/core: AST解析、DOM Patch、风格引擎、WS Daemon
│   ├── cli/                            # @hreader/cli: 命令行工具 (hr outline/patch/serve/style)
│   ├── app/                            # @hreader/app: 阅读器前端（TS 直出 ESM，无 bundler；运行时依赖按需引入，见 §依赖策略）
│   ├── desktop/                        # @hreader/desktop: Tauri v2 桌面端外壳 (后期按需开启)
│   ├── mcp-server/                     # @hreader/mcp: 标准 MCP Server (含 MCP-UI)
│   ├── pi-extension/                   # pi-hreader.ts: Pi Coding Agent 单文件扩展
│   └── dsh-bundle/                     # @hreader/dsh-bundle: DeepSeek Harness Cordis 插件包（host-only）
└── skills/
    └── hreader/                        # Universal Skill (SKILL.md + references + scripts)
```

---

## 依赖策略（2026-11-14 用户裁定，取代"零依赖手搓"）

- **默认按需引入成熟库**：能用成熟开源库直接解决的问题，优先用库；手搓只保留在"引入库的风险大于收益"的场合（体积、许可、原生依赖、维护停滞）。
- **已手搓的模块允许替换**（例如 `packages/core/src/annotations/diff.ts` 的手写 LCS → 成熟 diff 库）：走**单独的重构卡**，分批替换，不夹在功能卡里；未结的卡先收口，不许在卡中途推翻已过审的实现。
- **需先确认的两类**：①前端运行时依赖（`@hreader/app` 目前无 bundler）；②底层核心架构替换（框架 / 打包器 / AST / 解析引擎）。选型方案须列出候选、体积、维护活跃度、替换成本、回退方案。
- **可自行引入**：Node 服务端与测试侧的轻量成熟库（HTTP 工具、diff、测试辅助、fuzz 生成器…），在卡片里登记"引了什么、为什么、替代了什么手搓代码"即可。
- **门禁不变**：`knip` 不得有"装了没用"的依赖，`dependency-cruiser` 层次规则不得破窗，`perFile` 四维 100% 不放宽。

## 五、 分阶段演进路线图 (Phased Roadmap)

我们将研发计划拆分为 **4 个递进里程碑（Milestones）**，确保每个阶段都有可直接使用的闭环产物：

```mermaid
flowchart LR
    M1["Milestone 1: 核心底座与风格引擎\n(@hreader/core + CLI + Skill)"] --> M2["Milestone 2: 阅读器宿主与双向热更新\n(Reader Web UI + 划词批注闭环)"]
    M2 --> M3["Milestone 3: 全生态插件矩阵\n(MCP + Pi + DeepSeek Harness)"]
    M3 --> M4["Milestone 4: 桌面客户端与风格工坊\n(Tauri v2 App + AI 风格提炼向导)"]
```

### Milestone 1：核心底座、双维风格引擎与 Universal Skill（MVP 闭环）
* **目标**：让任何支持 CLI / Skill 的 Agent 都能生成具有 `Atelier Editorial` 出版级质感的自包含 HTML，并支持自定义语言风格与命令行增量 Patch。
* **核心任务**：
  - [x] **M1.1 自包含 HTML 规范与 `@hreader/core` AST 引擎**：基于 `parse5` / `rehype` 实现 `data-hr-id` 自动注入、`hr_outline` 骨骼提取、`hr_read_node` 与 `hr_patch_node` 原子操作。
  - [x] **M1.2 双维风格引擎与默认风格包**：完成内置视觉主题 `Atelier Editorial`（含明暗双模与 6 大语义组件 CSS）及 `style.yaml` 自定义语言风格解析器（含禁用词 Lint 校验）。
  - [x] **M1.3 CLI 与 Universal Skill (`skills/hreader/SKILL.md`)**：封装 `hr` 命令行工具与 `SKILL.md`，在 Claude Code / Antigravity 中跑通“按指定语言风格生成 HTML ➔ 骨骼读取 ➔ 局部节点重写”全流程。

### Milestone 2：hReader 阅读器宿主与“划词即指令”双向同步
* **目标**：告别系统浏览器的简陋预览，提供真正的沉浸式阅读器界面，打通“阅读器划词批注 ➔ Agent 局部更新 ➔ 页面无感热刷新”闭环。
* **核心任务**：
  - [x] **M2.1 本地 Daemon 与 SSE 同步桥**：在 `@hreader/core` 中内置轻量 HTTP 服务（`node:http`），服务端推送走 SSE、客户端命令走 POST，监听文件变更与前端批注事件。
    > 与初版计划的差异：原计划用 WebSocket。自实现 RFC 6455 需处理掩码、分片与关闭握手，属于「能写对但很容易写错」的面；SSE 只有行协议且 `EventSource` 自带重连，语义等价。裁定见 `.workflow/cards/M2.1.md` §1 D3。
    > 超时全部用 Node 内置三档（`headersTimeout` / `requestTimeout` / `keepAliveTimeout`）：超限时由解析器收尾（**不再由服务端手写 408 帧**），头部/半截请求直接关连接。成帧不合规（重复 `Content-Length`、`Transfer-Encoding` 与 `Content-Length` 并存、非 `chunked` 的 TE）由 Node 解析器先拒，客户端拿到裸 `400`/`431`/`501`，**没有 JSON 体**。
    > **事件环只存事件、不带文档实体**（非目标，P2-D）：环形缓冲容量固定为 256，若把节点/段落实体塞进去，内存上界就跟着文档大小走；代价是客户端在 `doc.changed` 后需要一次 `GET /api/doc/<id>/model` 取内容，换取**与文档大小无关的内存上界**。
  - [x] **M2.2 阅读器核心界面 (`@hreader/app`)**：实现左栏书库与动态 TOC、中栏沉浸画布（0-Token 视觉主题实时切换、字号/行宽调节、`j`/`k` 键盘导航）、右栏页边批注（Sidenotes）。
  - [x] **M2.3 划词批注持久化与 Visual Diff**：实现划词高亮/批注自动写入 HTML 内嵌 `<script id="hr-meta">`，以及 Agent 局部 Patch 后的节点闪烁高亮与一键 Undo 回滚。

### Milestone 3：MCP、Pi 与 DeepSeek Harness 全生态插件适配
* **目标**：将 `@hreader/core` 与阅读器能力无缝接入主流 Agent 框架。
* **核心任务**：
  - [x] **M3.1 `@hreader/mcp-server`**：实现标准 MCP Tools、语言风格 Prompts 注册，并兼容 `MCP-UI` 内联资源协议。
  - [x] **M3.2 Pi 插件 (`pi-hreader.ts`)**：编写单文件 TypeScript 扩展，实现 `/hreader`、`/hr-style` 命令及阅读器批注向 Pi `context.ui` 的自动投递。
  - [x] **M3.3 DeepSeek Harness 插件 (`@hreader/dsh-bundle`)**：host-only。插件的两份清单（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`）+ `dsh.compatibility.dshReleases`；用 `ctx.systemPrompt.section({ name, order: 100, text })` 织入 `compileTone` 的语言规约（与 CLI/MCP 同一编译器）；`ctx.provide('hreader')` 暴露 `{ styleId, prompt }` 并以 `ctx.effect` 保证可逆卸载；`declare module '@deepseek-ai/cordis'` 给出 `'hreader/patch-request'` 的强类型事件（发送侧）。`workspace` 缺省取宿主进程 cwd（带 stderr WARNING），相对路径按 cwd 解析，路径不存在 fail-fast。（原路线图的 "Prompt Hook" 概念不存在、"`dsh plugin add`" 缺 `--profile`、以及 `dsh-web-app` 面板三项已按调研更正，其中面板移 M4 候选。）
  - [x] **M3.4 `hr_undo` 工具**：给 MCP 层补撤销入口（前端与 HTTP 早已有 `undoPatch`，MCP 缺一个工具）。2026-11-15 用户裁定从 M3.1 拆出，避免撑爆单卡验收范围。**已完成**：`packages/mcp-server/src/tools/undo.ts`（走 `revertLast`，`nothing_to_undo` 不泄漏 `undo_unavailable`）；164 例 + 真起 daemon 的 MCP↔HTTP 差分；`L-32`（换样式不留快照）/`L-33`（快照无新鲜度校验）已登记。

### Milestone 4：Tauri v2 独立桌面端与“AI 风格萃取工坊”
* **目标**：完善独立桌面软件体验，降低用户编写自定义语言风格的门槛。
* **核心任务**：
  - [x] **M4.1 AI 语言风格萃取器 (`hr style extract`)**：用户只需丢入 3~5 篇自己喜欢的历史文章或博客，Agent 自动分析其句式节奏、常用转折词、叙事结构与高频词汇，一键生成专属的 `style.yaml`。**已完成（2026-11-17）**：纯统计层（`packages/core/src/style/extract/`，十组 `EXTRACT_FLAGS` 可关）+ LLM 层（`LlmPort` 可注入、合并建议不覆盖统计权威值）+ cli（`--out`/`--force`/`--json`/`--no-llm`/`--tone` 发现提示）；229 文件 2527 例、四维 perFile 100%；`L-36`–`L-39` 已登记。
  - [ ] **M4.2 Tauri v2 跨平台桌面应用 (`@hreader/desktop`)**：打包 macOS / Windows / Linux 原生安装包，支持系统级全局快捷键呼出与 `.html` 文件关联打开。
  - [ ] **M4.x DSH Web 面板 (`dsh-web-app` 内嵌 hReader Tab)**：从 M3.3 移出的 (c) 项。在 DSH Web 工作台里加一个 hReader Tab，划词后 `ctx.emit('hreader/patch-request', payload)` 触发修补。冲突：DSH client 插件要求 React + `window.__ModuleLoader__.load` + `ctx.slots.inject`，与本仓"无 bundler、无框架、daemon 静态托管"的阅读器设计互斥，需先决定是"给面板单独引一套构建链"还是"复用 daemon 的 iframe + postMessage"。发送侧类型契约已由 M3.3 的 `declare module '@deepseek-ai/cordis'` 备好。
  - [ ] **M4.3 出版级导出工具链**：优化 `@media print` 样式，支持一键导出带目录书签的精美 PDF 与社交媒体高清长图。

### 已知非目标：片段校验里"不拦"的两类输入（v3 裁定，2026-11-13）

`hr_patch_node` 的片段拒绝名单只覆盖**可执行面**。下面两类在评审中被提出，但**明确不拦**，理由是它们不具备执行能力，拦了反而误杀正常正文：

* `<xmp>…</xmp>` / `<plaintext>` 等 raw-text 容器：内容按 HTML 规范**不再解析**，里面的 `<img onerror>` 只是字面文本，不会生成可执行节点。
* `style="…url(javascript:…)"`：现代引擎不执行 CSS 里的 `javascript:` 协议（`url()` 只用于取图），且 `style` 是合法排版输入。

与之相对，**元素级 URL 属性**（`href`/`src`/`xlink:href`）与**SVG 动画子元素对这些属性的改写**（`<set attributeName="href" to="javascript:…">`，v3#16）一律拒绝——它们的执行路径是真实存在的，也是历史上最常见的绕过面。
