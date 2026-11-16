# HANDOFF writer #2 — 2026-11-16

你是**编写员**，本仓 (`/Users/liu/Documents/Project/hReader`) 的代码由你一个人写。这是全新会话：上一代编写员（`bbc1e2b7`→`abba30c7`）跑完 M3.2/M3.3 两张卡（含 6 轮返工），上下文已重生。

**读这四份就够开工**（不要读历史报告全文）：本文件 → `.workflow/state.md` → `.workflow/cards/M4.1.md` → `docs/04-engineering-standards.md`。需要细节时按 `L-3x` 编号定向 `grep` `.workflow/known-defects.md`。

## 1. 你继承的代码面（`pnpm verify` 基线：208 文件 / 2305 例 / 四维 100%）

| 提交 | 内容 | 你会用到的导出 |
| --- | --- | --- |
| `f1eba42` | 门禁（一条 `pnpm verify` 跑全部） | — |
| `8e5c15b` | 风格引擎 + 主题 | `compileTone` `lintByStyle` `loadStyle` `StyleSpec` `LanguageSpec` |
| `dc9e9c2` | 本地 daemon + SSE + 鉴权 | `serve` `COOKIE_NAME` `CSRF_HEADER` |
| `c96f8f5` | 阅读器 UI + 划词批注 + diff | `@hreader/app`（零依赖 vanilla） |
| `74781fc` `3134499` | MCP server（11 工具 + MCP-UI） | `packages/mcp-server/src/tools/*` |
| `49d8cb1` | Pi 扩展 | `packages/pi-extension/pi-hreader.ts` |
| `ba9579a` | `hr_undo` | `packages/mcp-server/src/tools/undo.ts` |
| `165da68` | dsh 插件（host-only，esbuild 打包） | `packages/dsh-bundle/*` |

风格引擎目录：`packages/core/src/style/{spec,load,apply,tone,lint,contracts,presets,node,text,id,css,theme,resource,source}.ts`。
**`spec.ts` 是严格解析器**（任何未知键按层报合法键集）——M4.1 的产物必须过它，不许绕过。

## 2. 硬规矩（踩出来的，不是抄来的）

1. `pnpm verify` 必须 EXIT=0 且**四维 perFile 100%**，无豁免；报"全绿"要么贴 `EXIT=` 原文与 `Tests N passed`，要么写"未跑"。**你不跑全量 verify**（只有协调者跑），开发期只跑定向测试。
2. **死代码即 P1**：恒假谓词、走不到的分支。不许 `/* v8 ignore */`。
3. 边界守卫不可由真实输入触发 → **内部导出 + 直接单测**（先例 `packages/core/src/style/spec.ts` 的 `syntaxErrorOf`，`@internal` 且不进 barrel）。
4. **注释只写签名表达不了的**：量级包络、精度承诺、抛错条件、与外部规范的对应关系（例："`x-opencode-session` 是 OpenZen 的路由要求，缺了直接 400"）。模块头 ≤ 3 行。**注释声称的行为必须为真**——这是本仓最常见的 P1。
5. **裸异常 = P0**；错误一律 `HrError(code, 人话)`，文案可操作（说清"哪里错、收到什么、怎么改"）。
6. **参数与返回值用裸类型**（不许 `any`/`as`/`!`，`as const` 除外），`readonly` 默认，`exactOptionalPropertyTypes` 已开。
7. **你不碰** `packages/**/tests/**`（测试用例是代码，归你写；但**变异期间**测试员会临时改，冲突就是两人同时写——协调者会串行化）、`vitest.config.ts`、`knip.json`、`.dependency-cruiser.cjs`（要改先报裁定）。
8. **git 写操作归协调者**：你只许 `status`/`diff`/`log`/`show`。报告里的每个 hash、每个数字必须本轮真跑并原样粘贴（上一代有人编造 `f5e349e`，见 `docs/03` §11.15）。
9. 交付消息 ≤ 25 行；长命令拆开跑、每条后 `echo DONE`（串联长命令曾被看门狗杀过两次）。
10. **prettier 先跑再跑测试**；`pnpm format:check` 红是极常见的一次性失误。

## 3. 当前卡：M4.1（`hr style extract`）

一句话：把"3~5 篇文章 → 专属 `style.yaml`"拆成**可离线验证的统计层**与**只许建议的 LLM 层**；core 不碰网络，传输层在 cli。
关键裁定都在卡 §2（D1–D12），**先读再写**。端点事实在卡 §1（`OPENCODE_API_KEY` / `https://opencode.ai/zen/go/v1` / `deepseek-v4.1-flash` / 必需 `x-opencode-session`）。

## 4. 与另两个角色的接口

- 审计员（`reviewer`，只读）会**逐条核你的断言**，不看结论；它会问"这条断言把哪行代码改坏才会红"。
- 测试员（`worker`，变异期间可写 `tests/**`）会拿变异体打你的用例；**survived 的变异体**你要么补断言，要么在报告里写清"这条由什么兜底"。
- 合同歧义：**停手**，报告写"待裁定：…（A/B + 建议 + 我倾向哪个）"。不许自行扩大范围（上一卡有人自作主张跳过分批、越界改 `docs/`，被记了一次）。
