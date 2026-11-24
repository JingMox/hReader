---
name: hreader
description: 用 hReader 起稿和读写 HTML 文档（笔记、报告、会议纪要、决策简报、幻灯片）。当用户要写报告、整理纪要、做一份 HTML 汇报、改某个小节、套排版主题、检查排版或禁用词，或要求"把这段内容排成好看的长文"时使用；也用于按大纲分段改写而不动其余部分。
---

# hReader：按节点读写长文档

hReader 把一份 HTML 长文档拆成"可按 id 读、可按 id 改"的节点，所有写操作都是**字节级区间替换 + 原子落盘 + 可撤销**。你只需读一段、改一段，永远不用整篇重写。

## 什么时候用它

- 文档 > 300 行，或含多个 section，用户只要改其中一小节。
- 需要先看结构再决定改哪里（`outline`）。
- 需要把某一小节原文读出来改写（`read`），再写回去（`patch`）。
- 需要统一文案口吻（`style --tone`）、统一排版（`style --visual`）、检查禁用词（`style --lint`）。

## 命令（全部经 `scripts/hr.mjs`）

```bash
node skills/hreader/scripts/hr.mjs new report.html --kind report --title "Q4 复盘"  # 按形态起稿
node skills/hreader/scripts/hr.mjs outline report.html            # 结构树
node skills/hreader/scripts/hr.mjs read report.html s2-p1 --json   # 读一个节点
node skills/hreader/scripts/hr.mjs patch report.html s2-p1 \
     --action replace --html-file /tmp/new.html                    # 写回
node skills/hreader/scripts/hr.mjs style report.html --visual atelier-editorial
node skills/hreader/scripts/hr.mjs style report.html --tone atelier-editorial
node skills/hreader/scripts/hr.mjs style report.html --lint
node skills/hreader/scripts/hr.mjs check report.html               # 排版约束检查
```

退出码：`0` 成功、`1` 业务失败（节点不存在/片段非法/被锁）、`2` 用法错误、`3` IO 与路径问题、`70` 内部错误。**非 0 时先读 stderr 的报错原文，不要猜。**

## 从零起稿：先选形态（`new`）

不要手写整份 HTML 骨架。`new` 按形态生成一份带齐 id、已套主题、组件占位齐全的起稿，之后逐块 `patch`：

| `--kind`  | 用途     | 骨架                                              |
| --------- | -------- | ------------------------------------------------- |
| `note`    | 笔记     | 一个小节，自由展开（默认）                        |
| `report`  | 报告     | 结论 → 关键数据 → 分析 → 方案对比 → 风险 → 下一步 |
| `minutes` | 会议纪要 | 结论与决定 → 讨论要点 → 待办 → 录音与逐字稿       |
| `brief`   | 决策简报 | 建议 → 依据 → 代价与风险 → 下一步                 |
| `slides`  | 幻灯片   | 标题页 + 每个顶层 `<section>` 一页                |

- 占位文字都写在全角括号里（如 `（一句话结论）`）：`outline` 后逐块 `replace` 掉，**交付前不许留括号占位**。
- 用不上的小节整节 `delete`；要加页 / 加节就对相邻 `<section>` 做 `insert_after`。
- `slides` 每页只讲一件事：一个 `<h2>` 加一个组件或两三句话。浏览器里滚动即翻页，打印 / 存 PDF 是横版一页一张，不需要任何脚本。
- `<file>` 已存在时要加 `--force`；标题不给就取文件名。

## 五原语工作流

1. **看结构**：`outline`。输出每行 `- <id>  <标题>  (<字数>)`；没 id 的标题会作为 warning 出现在 stderr，先修 id 再谈改写。
2. **读原文**：`read <id>` 拿到该节点的 HTML 片段（可能被截断，末尾会给 `truncated` 诊断）。改之前必须读，不要凭大纲猜内容。
   第二个参数先按选择器解析，不命中时把原串当 node id 再试一次——所以 `outline`/`patch` 打印出的 id 可以直接喂回来。**标签优先**：`read div` 读的是 `<div>` 标签；若某节点 id 恰为 `div`，写 `[data-hr-id="div"]`。
3. **写片段**：把新内容放进一个临时 `.html` 文件，只用 `--html-file`（`--html` 只适合无引号无换行的短片段）。
4. **落盘**：选 action——
   - `replace`：整体替换该节点（含它的子节点）。
   - `insert_after` / `insert_before`：**在该节点同级插入**，不是塞进子节点；插入物必须有且只有一个根元素。
   - `append`：塞进该节点的子节点末尾（目标可以是空元素）。
   - `delete`：删除该节点及其子树。
5. **验成果**：`--json` 返回 `{"ok":true,"data":{...}}`；关注 `changed`（`false` 表示写盘字节与原文完全一致，没产生历史快照）、`newIds`（插入内容里自动分配的 id）、`historyPath`（可撤销锚点）、`warnings`（排版约束问题，见下）。

## 排版约束：写入时就查

长相归主题管，正文只声明语义。两类问题会被查出来：

- **组件结构不对**（`component_root` / `component_shape`）：根标签不对、子元素个数不对、缺必备子元素。规约表见 `references/components-spec.md`。
- **内联 `style`**（`inline_style`）：任何元素都不要带 `style` 属性（内联 SVG 内部除外）。

`patch` 不会因此拒写——片段照常落盘，问题出现在回执的 `warnings` 里；整篇用 `check <file>` 复查（`--json` 时看 `count`）。**看到 warning 就再 patch 一次改掉，`check` 干净了再说“完成”。**

要把 `check` 当门禁用就加 `--strict`：有 error 级诊断时退出 1（报告照常先写 stdout）；`--strict=warning` 连 warning 也算失败。

## 安全区内不能做的事

- 片段里**不允许** `<script>`、`<style>`、`<iframe>`、`<object>`、`<embed>`、`<link>`、`<meta http-equiv=refresh>`、`<form>`，不允许 `on*` 事件属性，不允许 `javascript:` / `data:text/html` 链接。会被 `forbidden_content` 拒绝，文件一个字节都不会变。
- 片段必须**单根**：多根、纯文本、注释开头都会被 `invalid_fragment` 拒绝。
- 路径必须在 `--workspace` 内；`../`、绝对路径、指向外部的符号链接都会被 `path_outside_workspace` 拒绝。

## 组件速查（复制即用）

完整片段见 `references/components-spec.md`。八个组件靠 `data-hr-component` 触发主题样式：

| 组件         | 选择器                                | 用途                          |
| ------------ | ------------------------------------- | ----------------------------- |
| KPI 卡阵     | `data-hr-component="kpi-bento"`       | 3–6 个关键数字                |
| 洞察 callout | `data-hr-component="callout-insight"` | 需要读者记住的判断            |
| 风险 callout | `data-hr-component="callout-warning"` | 代价、坑、边界条件            |
| 对比分栏     | `data-hr-component="split-compare"`   | 方案 A/B、前后对照            |
| 深度折叠     | `data-hr-component="deep-dive"`       | 可跳过的推演细节              |
| 步骤时间线   | `data-hr-component="step-timeline"`   | 流程、roadmap、复盘           |
| 图表舞台     | `data-hr-component="diagram-stage"`   | 图片/SVG + 图注               |
| 媒体卡片     | `data-hr-component="media-card"`      | 录音/视频 + 图注 + 折叠逐字稿 |

## 风格与禁用词

- 写之前先取口吻：`style --tone <id>` 会返回一段 prompt，把其中的规则当作写作约束。
- 写完跑 `style --lint`：命中禁用词会给出 `offset`（块内字符偏移）和上下文，逐条改掉再说"完成"。
- 默认风格 `atelier-editorial`：结论先行、每三段转一个视觉结构、每个论断挂数字或来源。自定义风格见 `references/style-authoring.md`。

### 从 1..N 篇语料摸出自己的风格（`style extract`）

```bash
# 离线：不开 key，只跑统计层（开发机 shell 里常有真 key，照抄带 key 的版本会花真调用）
mkdir -p .hreader
env -u OPENCODE_API_KEY node skills/hreader/scripts/hr.mjs style extract 文1.md 文2.md \
  --id my-voice --name "我的口吻" --out .hreader/style.yaml
```

- **没 key 不报错**：没设 `OPENCODE_API_KEY` 或加了 `--no-llm`，走纯统计版（节奏 + 词表定值），stderr 一行提示“仅用统计结果”——两条路径的 `style.yaml` 都能直接被 `style --tone` 用。
- **`--out` 必须落在发现路径上**，否则 `style --tone my-voice` 找不到它：项目级 `<workspace>/.hreader/style.yaml`，或用户级 `~/.hreader/styles/my-voice/style.yaml`。写到别处也合法（导出/归档），但 `--tone` 只认 id、没有路径入口——要让 `--tone` 用上它，就得写到上面两条路径之一；写别处时 stderr 会给一行提示。
- `--out` 指向已存在的文件时必须加 `--force`，否则 `file_exists`；父目录不自动建。
- 模型/网关可用 `--model`、`--base-url` 覆盖；`--json` 输出 `{ok,data:{path,stats,yaml,dropped}}`（`dropped` 仅 LLM 路径出现），错误也是单行 JSON。
- fixture 与模型换代（换 `--model` 或改 prompt）后须重录 `fixtures/llm/`，否则回放证明的不再是今天的模型输出。

## 让宿主自己带着风格（不用每次取口吻）

本仓有两个包把这个"取口吻"的步骤变成了宿主侧的常驻约束，效果和 `style --tone` 完全相同（同一份 `compileTone` 编译器）：

- **DeepSeek Harness (`dsh`)**：`@hreader/dsh-bundle` 把语言规约织进 system prompt，会话一开就生效。装法（`--profile` 必填）：
  ```bash
  dsh plugin --profile <profile> add "$(pwd)/packages/dsh-bundle"
  ```
  `config.workspace` 不写就按宿主进程 cwd 找项目风格，并在 stderr 打一行 WARNING 说明用的是哪个目录；未知 `styleId` 会直接报错并列出可用 id。
- **Pi**：`pi-hreader.ts` 扩展的 `/hr-style` 切换当前会话绑定的风格。
- **MCP**：prompt `use-hreader-style`，由宿主按需拉取。

换句话说：**当用户问"怎么让 AI 一直按这个风格写"，先看它跑在哪个宿主里**——`dsh`/Pi/MCP 都有现成通道，不要再让 Agent 每轮手工 `style --tone`。

## 常见错误对照

| 报错 code                | 含义                     | 正确做法                           |
| ------------------------ | ------------------------ | ---------------------------------- |
| `node_not_found`         | id 打错或该标题没有 id   | 先 `outline`，按输出的 id 取       |
| `invalid_fragment`       | 多根 / 纯文本 / 注释开头 | 包一层根元素，只留一个             |
| `forbidden_content`      | 命中可执行内容           | 换成 `<pre class="code">` 展示代码 |
| `path_outside_workspace` | 路径逃出 workspace       | 用 `--workspace` 指向文档所在目录  |
| `locked`                 | 另一个进程正在写同一文件 | 等 2 秒重试；连续失败就停下问用户  |
| `not_a_file`             | 路径不存在或不是文件     | 先确认文件路径                     |

## 不要做的事

- 不要 `read` 整篇再整体 `write`：那就绕过了节点机制，也会丢掉未改动的字节。
- 不要在 `--html` 里塞含换行的长片段：用 `--html-file`。
- 不要为了绕开 `forbidden_content` 改写 `<script>`：直接告诉用户这段需要人工处理。
- 不要连续 `undo` 超过历史保留数（默认 10 份）。
