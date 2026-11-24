# 发布文案（复制即用）

> 所有链接默认 GitHub Pages 已开启：`https://jingmox.github.io/hReader/`。素材：`site/img/demo.gif`（README 和帖子用）、`docs/launch/demo.mp4`（视频平台和 X 用）、`site/img/compare.png`（对比图）。

---

## 1. V2EX ·「分享创造」节点

**标题**

> 做了个开源工具：让 AI 写的笔记用 HTML 排版，但不乱

**正文**

```
大家好，分享一个刚开源的小项目 hReader：https://github.com/JingMox/hReader

起因是两件事：
1. 用 AI 整理笔记时插了一堆录音，Markdown 里只能是链接或裸播放器，插到第五段就乱成一团；
2. 参加黑客松，好几支队伍直接用 AI 生成的 HTML 页面做汇报，比 PPT 好看也好改。

我的想法是：Markdown 当年赢，是因为排版成本由人出，所以大家选了最省事的格式。现在 AI 写 HTML 和写 Markdown 一样便宜，HTML 的表现力等于白送。
但 AI 排版太自由，十份文档十种样子，放进一个资料库比 Markdown 还乱。

hReader 做的就是“给 AI 排版加约束”：
- 8 个语义组件（KPI 卡片、洞察、风险提示、对比分栏、折叠、时间线、图表舞台、音视频卡），AI 只判断内容是什么，长相交给主题；
- 每个块有稳定的 id，Agent 先看大纲、只读一块、只改一块，原子写入可撤销；
- 在阅读器里选中一句话写批注，Agent 只改这一段，页面自动刷新（README 里有 GIF）；
- 文档就是本地一个 .html 文件，双击能开，任何支持 MCP / Skill 的 Agent 都能用。

在线示例（不用安装，直接看）：https://jingmox.github.io/hReader/
里面有一张对比图：同一份带录音的会议纪要，分别用 Markdown、AI 自由生成的 HTML、hReader 来排。

坦白说还很早期：组件 8 个、主题 1 套，排版约束写入时只警告不拒写，桌面版需要本机有 Node 22。推荐先用 MCP 或 Skill 试。

想听听大家的意见，尤其是：你会往笔记/文档里插什么东西？
```

---

## 2. 即刻（AI 探索站 / 独立开发者 / 产品沉思录 等圈子）

```
今天把 hReader 开源了。

一个判断：Markdown 赢在“不让你排版”，因为过去排版成本是人出的。AI 来写之后这个成本没了，HTML 的表现力白送——但 AI 排版太自由，十份文档十种样子。

所以我做了一套“给 AI 排版加约束”的工具：8 个语义组件 + 主题，Agent 只能改你批注的那一段。

不用安装，点开看效果 👉 https://jingmox.github.io/hReader/
GitHub 👉 https://github.com/JingMox/hReader

（配图：compare.png + demo.gif）
```

---

## 3. 黑客松群 / 朋友群（私聊语气）

```
上次黑客松看到有队伍直接拿 HTML 做汇报，给了我挺大启发，回来做了个开源工具 hReader：让 AI 写的文档用 HTML 排版，但通过一套组件约束保持整齐，还能在页面上划一句话让 Agent 只改那一段。

示例不用装，点开就能看：https://jingmox.github.io/hReader/
刚开源，非常欢迎拍砖，尤其想知道你们做汇报/写文档时最想插什么东西。
```

---

## 4. B 站 / 小红书 · 演示视频（1–2 分钟）

**标题**：Markdown 时代要结束了？我让 AI 用 HTML 写笔记，还不乱

**封面**：`site/img/compare.png` 截三栏，配大字「同一份笔记，三种写法」

**分镜脚本**

| 时间 | 画面 | 口播 |
| --- | --- | --- |
| 0:00–0:10 | 一份插满录音的 Markdown 笔记，滚动 | 我用 AI 做笔记，插了一堆录音，结果 Markdown 里乱成这样。 |
| 0:10–0:25 | 对比图中间那栏（AI 自由 HTML） | 那让 AI 直接写 HTML 呢？好看，但每块一种风格，换一次生成就换一套。 |
| 0:25–0:45 | 对比图右栏，再打开 meeting-notes.html 播放录音、展开逐字稿 | 所以我做了 hReader：AI 只能用 8 个语义组件，长相交给主题。十份纪要，十份一样整齐。 |
| 0:45–1:10 | `demo.mp4` | 更重要的是能改：选中一句话写批注，Agent 只改这一段，页面自动刷新，其他内容一个字都不动。 |
| 1:10–1:25 | why-html.html 页面 | 原因很简单：Markdown 赢在不让你排版，现在 AI 替我们付了排版的成本。 |
| 1:25–1:40 | GitHub 页面 | 项目开源，链接在简介。你最想往笔记里插什么？评论区告诉我。 |

**简介**：GitHub：github.com/JingMox/hReader ｜ 在线示例：jingmox.github.io/hReader

**小红书版**：用 compare.png、meeting-notes 截图、demo.gif 截帧做 4–6 张图，标题「AI 写笔记别再用 Markdown 了｜我做了个开源工具」，正文用即刻那段。

---

## 5. HelloGitHub 月刊投稿

去 <https://github.com/521xueweihan/HelloGitHub/issues/new> 按模板提交：

```
项目地址：https://github.com/JingMox/hReader
类别：JavaScript / TypeScript
项目标题：让 AI 写的笔记用 HTML 排版，而且不乱
项目描述：hReader 用 8 个语义组件和一套主题约束 AI 的 HTML 排版，并给每个块分配稳定 id，让 Agent 只修改用户批注的那一段。文档是本地单个 .html 文件，支持 MCP、Agent Skill、CLI 和桌面阅读器。
亮点：
- 同一份内容，AI 每次生成的版式都一致
- 在阅读器里划词批注，Agent 只改这一段，页面自动刷新
- 不绑定任何 AI 厂商，Claude Code、Cursor 等都能用
示例代码：README 中的 MCP 配置
截图：https://raw.githubusercontent.com/JingMox/hReader/main/site/img/compare.png
```

---

## 6. 阮一峰《科技爱好者周刊》投稿

去 <https://github.com/ruanyf/weekly/issues> 新建 issue：

```
标题：【开源自荐】hReader：让 AI 写的笔记用 HTML 排版，而且不乱

https://github.com/JingMox/hReader

AI 写 HTML 和写 Markdown 一样便宜，但排版太自由，每次都不一样。hReader 用一套语义组件和主题约束 AI 的排版，并且让 Agent 只修改用户批注的那一段。文档是本地单个 .html 文件。

在线示例：https://jingmox.github.io/hReader/
```

---

## 7. Hacker News · Show HN（第二周，美国时间周二到周四上午）

**Title**

> Show HN: hReader – Let AI write your notes in HTML without the layout chaos

**URL**：`https://github.com/JingMox/hReader`

**First comment**（发完立刻贴）

```
Hi HN, I built hReader after two things happened: my AI-organized notes became unreadable once I embedded a few audio recordings in Markdown, and at a hackathon several teams presented straight from AI-generated HTML pages instead of slides.

My take: Markdown won because humans paid the cost of layout, so we picked the cheapest format. For an LLM, HTML costs the same as Markdown — so its expressiveness is now free. The catch is that AI layout is too free: ten documents, ten different looks.

hReader is a set of constraints for that:
- 8 semantic components (KPI grid, callouts, split comparison, disclosure, timeline, figure, media card). The model declares *what* a block is; a theme decides how it looks.
- Every block gets a stable data-hr-id. Agents read an outline, read one node, and patch one node, with atomic writes and undo — over MCP, an Agent Skill, or a CLI.
- In the reader, you select a sentence and leave a note; the agent picks it up, patches only that block, and the page live-reloads (GIF in the README).
- Documents are plain local .html files. No vendor lock-in.

Live gallery, no install: https://jingmox.github.io/hReader/

It's early (v1.0, 8 components, one theme; layout rules are checked on write but only warn, never reject). I'd especially love feedback on whether "constrained HTML" is the right abstraction, and what you'd want to embed in a document.
```

---

## 8. Reddit

**r/ClaudeAI**（标题）：

> I built an MCP server + Skill that lets Claude write notes in HTML — constrained to 7 components so they stay consistent, and patchable block-by-block

正文：用 Show HN 第一条评论，删掉第一段，开头加一句 “Works with Claude Code via the Agent Skill, or Claude Desktop via MCP.”，附 demo.gif。

**r/ObsidianMD**（标题，注意社区规则，作为讨论而非广告）：

> Is HTML a better note format than Markdown once AI does the writing? I built a tool to test the idea

正文：讲“Markdown 赢在不让你排版”的论点，附 compare.png，项目链接放在最后，主动问大家怎么看。

---

## 9. X / Twitter（thread）

```
1/ Markdown won because humans paid the cost of layout.
AI just paid it for us. So why are AI notes still Markdown?

I open-sourced hReader to explore that. 🧵

2/ Problem: let an AI write HTML freely and every doc looks different. Ten notes, ten styles.
[compare.png]

3/ hReader constrains it: 7 semantic components + a theme. The model says WHAT a block is; the theme decides how it looks.

4/ And you edit by pointing: select a sentence, leave a note, the agent patches only that block over MCP, the page live-reloads.
[demo.mp4]

5/ Plain local .html files. Works with Claude Code, Cursor, any MCP/Skill agent.
Gallery: https://jingmox.github.io/hReader/
Code: https://github.com/JingMox/hReader
```

可 @ 的相关作者：visual-explainer 的作者（同样在做 Agent 生成 HTML），以及做 MCP 目录的账号。

---

## 10. MCP 目录与 awesome 列表（随时可提交）

- **mcp.so**：<https://mcp.so> 页面上的 Submit。
- **Smithery**：<https://smithery.ai> 登录后提交 GitHub 仓库。
- **Glama**：<https://glama.ai/mcp/servers> 提交仓库。
- **awesome-mcp-servers**：给 <https://github.com/punkpeye/awesome-mcp-servers> 提 PR，加在合适的分类下（例如 Knowledge & Memory 或 Other Tools），一行即可：

```
- [JingMox/hReader](https://github.com/JingMox/hReader) 📇 🏠 - Read and surgically patch AI-written HTML documents by stable block id, with 7 semantic layout components, themes, reader annotations and undo.
```

（图标含义按该仓库 README 的图例：📇 TypeScript，🏠 本地运行。提交前再核对一次最新图例和分类名。）
