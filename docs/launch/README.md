# 发布工具包

| 文件 | 用途 |
| --- | --- |
| [why-html.zh-CN.md](./why-html.zh-CN.md) | 中文观点文章，可直接发知乎、掘金、少数派、公众号 |
| [why-html.en.md](./why-html.en.md) | 英文版，可发 Medium、dev.to 或个人博客 |
| [posts.md](./posts.md) | V2EX、即刻、黑客松群、B 站/小红书、HelloGitHub、阮一峰周刊、Show HN、Reddit、X、MCP 目录的文案 |
| [demo.mp4](./demo.mp4) | 22 秒演示视频（1280 宽），给视频平台和 X 用 |
| `../../site/` | GitHub Pages 示例库：首页、3 份示例文档、三方对比页、`img/demo.gif`、`img/compare.png` |

## 上线前要你手动做的事

1. **提交并推送**这批改动到 `main`。
2. **开启 GitHub Pages**：仓库 Settings → Pages → Source 选 **GitHub Actions**。推送后 `Deploy gallery` 工作流会把 `site/` 发布到 `https://jingmox.github.io/hReader/`。
3. 打开示例库确认能访问，录音能播放。
4. （可选）仓库 About 里把 Website 设为示例库地址，Topics 加上 `mcp`、`ai-agent`、`html`、`notes`、`markdown-alternative`。

## 节奏建议

| 时间 | 做什么 |
| --- | --- |
| 第 1 天 | 完成上面 4 步；提交 MCP 目录和 awesome-mcp-servers |
| 第 2 天 | 中文首发：V2EX + 即刻 + 黑客松群；同时投 HelloGitHub 和阮一峰周刊 |
| 第 1 周 | 回复每一条评论，把反馈记进 Issues；修最高频的问题 |
| 第 2 周 | Show HN + Reddit + X |
| 之后 | 每做一个新组件（比如音频卡片），发一条“现在能插 X 了”的短演示 |

## 重新生成素材

- 示例文档：改 `site/examples/*.html` 的正文后运行 `bash scripts/build-site.sh`（补块 id、套主题、检查禁用词）。
- 对比图：`bash scripts/build-site.sh --shots`（需要本机有 Google Chrome）。
