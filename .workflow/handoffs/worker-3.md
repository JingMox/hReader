# 交接卡 · 编写员 第 3 代（worker-3）

> **交接触发**：单会话已累计 2 张卡（M1.4、M1.5）+ 4 轮返工，上下文接近中段，且下一张卡（M1.6 合并卡）体量最大。
> **新会话第一件事**：读本文件 → `.workflow/state.md` → `.workflow/cards/M1.6.md`。不要读历史报告全文。

## 1. 你继承的代码面（都已提交，可信任）

| 提交 | 内容 | 你会用到的导出 |
| --- | --- | --- |
| `f1eba42` | M1.0 门禁 | `pnpm verify` 一条命令跑全部（prettier/eslint/tsc/vitest+coverage/depcruise/knip） |
| `7ec0110` | M1.1 HTML 解析/序列化/ID 注入 | `parseHtml`、`parseFragment`、`serialize`、`injectIds`、`textOf` |
| `66382e7` | M1.2 文档模型（只读投影） | `toModel`、`HtmlNode`/`HtmlElementNode`/`HtmlTextNode`、`findById`、`walk` |
| `bf34c87` | M1.3 `hr_outline` | `outline`、`Diagnostic`、`DIAGNOSTIC_SEVERITY`、诊断限流（1024B 聚合上限） |
| `8916c63` | M1.4 `hr_read_node` | `readNode`、`select`（窄选择器文法） |
| `f9d00bb` | M1.5 patch/原子写/undo | `applyPatch`、`patchNode`、`atomicWrite`、`withLock`、`undoPatch`、`parseFragment`（带拒绝名单）、`HrError`/`HrErrorCode` |

## 2. 你必须遵守的既有约定（踩过坑才写下的）

1. **注释只写签名表达不了的**：量级包络、精度承诺、抛错条件、与外部规范的对应关系。模块头 ≤ 3 行。
2. **死代码即 P1**：恒假谓词、永远走不到的分支、`join(" ")` 之后又被归一化抹平的拼接。
3. **不可达分支不许 `/* v8 ignore */`，也不许 `as` 绕过**：合并守卫让唯一出口真实可达（`parse.ts:54-59` 是范例）。
4. **裸异常 = P0**：任何非 `HrError` 的抛出从公开 API 漏出都按 P0 处理。
5. **列表与单值成对建例**：凡 `split().join()`、`replaceAll` 再比对的代码，审计员必问"第二个元素呢"。
6. **fuzz 语料跨命名空间**：`svg/math × template/table/select` 必须交叉。
7. **无 `any`/`as`（`as const` 除外）/`!`**；`readonly` 默认；`exactOptionalPropertyTypes` 已开（赋 `undefined` 要显式）。
8. 你**不碰** `packages/core/tests/**`、`vitest.config.ts`、`knip.json`、`.dependency-cruiser.cjs`；需要改门禁配置先问协调者。

## 3. 上一代留下的判断

- 内置数据用 **TS 数据模块**，不要为了"统一"把它们写成运行时读 YAML。
- `readNode` 的窄选择器文法（`#id`、`tag`、`[attr="v"]`、后代组合）是**故意不做全 CSS** 的，M1.6 若需要选择器请复用 `select`，不要另写一套。
- 诊断/报告类输出一律**限流**（M1.3 的 1024B 聚合、M1.4 的 8KB 预算）；Lint 命中同样要有上限。

## 4. 与另外两个角色的接口

- 审计员只读，会**自己跑命令复算**，不相信你的报告；报告里写"已验证"必须附真实输出。
- 测试员独占 `tests/**`。你新增错误码后测试会红，**这是预期的**，由测试员同步；你只要在报告里列出新增码。
- 遇到合同歧义：**停手**，在报告里写"待裁定：……（选项 A/B + 你的建议）"，不要自己发明语义。M1.5 有 6 处歧义因此各浪费一轮。
