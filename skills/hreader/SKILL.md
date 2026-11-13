---
name: hreader
description: 用 hReader 读写长文档（HTML 报告/文章）。当用户要写报告、改某个小节、套排版主题、检查禁用词，或要求"把这段内容排成好看的长文"时使用；也用于按大纲分段改写而不动其余部分。
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
node skills/hreader/scripts/hr.mjs outline report.html            # 结构树
node skills/hreader/scripts/hr.mjs read report.html s2-p1 --json   # 读一个节点
node skills/hreader/scripts/hr.mjs patch report.html s2-p1 \
     --action replace --html-file /tmp/new.html                    # 写回
node skills/hreader/scripts/hr.mjs style report.html --visual atelier-editorial
node skills/hreader/scripts/hr.mjs style report.html --tone atelier-editorial
node skills/hreader/scripts/hr.mjs style report.html --lint
```

退出码：`0` 成功、`1` 业务失败（节点不存在/片段非法/被锁）、`2` 用法错误、`3` IO 与路径问题、`70` 内部错误。**非 0 时先读 stderr 的报错原文，不要猜。**

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
5. **验成果**：`--json` 返回 `{"ok":true,"data":{...}}`；关注 `changed`（`false` 表示写盘字节与原文完全一致，没产生历史快照）、`newIds`（插入内容里自动分配的 id）、`historyPath`（可撤销锚点）。

## 安全区内不能做的事

- 片段里**不允许** `<script>`、`<style>`、`<iframe>`、`<object>`、`<embed>`、`<link>`、`<meta http-equiv=refresh>`、`<form>`，不允许 `on*` 事件属性，不允许 `javascript:` / `data:text/html` 链接。会被 `forbidden_content` 拒绝，文件一个字节都不会变。
- 片段必须**单根**：多根、纯文本、注释开头都会被 `invalid_fragment` 拒绝。
- 路径必须在 `--workspace` 内；`../`、绝对路径、指向外部的符号链接都会被 `path_outside_workspace` 拒绝。

## 组件速查（复制即用）

完整片段见 `references/components-spec.md`。七个组件靠 `data-hr-component` 触发主题样式：

| 组件         | 选择器                                | 用途                |
| ------------ | ------------------------------------- | ------------------- |
| KPI 卡阵     | `data-hr-component="kpi-bento"`       | 3–6 个关键数字      |
| 洞察 callout | `data-hr-component="callout-insight"` | 需要读者记住的判断  |
| 风险 callout | `data-hr-component="callout-warning"` | 代价、坑、边界条件  |
| 对比分栏     | `data-hr-component="split-compare"`   | 方案 A/B、前后对照  |
| 深度折叠     | `data-hr-component="deep-dive"`       | 可跳过的推演细节    |
| 步骤时间线   | `data-hr-component="step-timeline"`   | 流程、roadmap、复盘 |
| 图表舞台     | `data-hr-component="diagram-stage"`   | 图片/SVG + 图注     |

## 风格与禁用词

- 写之前先取口吻：`style --tone <id>` 会返回一段 prompt，把其中的规则当作写作约束。
- 写完跑 `style --lint`：命中禁用词会给出 `offset`（块内字符偏移）和上下文，逐条改掉再说"完成"。
- 默认风格 `atelier-editorial`：结论先行、每三段转一个视觉结构、每个论断挂数字或来源。自定义风格见 `references/style-authoring.md`。

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
