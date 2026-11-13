# 交接卡 · 编写员 第 4 代（worker-4）

> 第 3 代会话已完成 M1.6、M1.8 两张卡和 M2.1 的大部分返工，会话文件已被清理，无法续接。
> **读这三份就够开工**：本文件 → `.workflow/state.md` → 当前卡片（`.workflow/cards/M2.1.md`）。
> 不要读历史报告全文；需要细节时按报告里的 `§` 编号定向读。

## 1. 你继承的代码面（`pnpm verify` 基线：1423 例、四维 100%、113 文件）

| 提交 | 内容 | 关键导出 |
| --- | --- | --- |
| `f1eba42` | 门禁（一条 `pnpm verify` 跑全部） | — |
| `7ec0110` | HTML 解析/序列化/ID 注入 | `parseHtml` `parseFragment` `serialize` `injectIds` `textOf` |
| `66382e7` | 文档模型（只读投影） | `toModel` `HtmlNode` `findById` `walk` |
| `bf34c87` | `hr_outline` | `outline` `Diagnostic` `DIAGNOSTIC_SEVERITY` |
| `8916c63` | `hr_read_node` | `readNode` `select` |
| `f9d00bb` | patch / 原子写 / undo | `applyPatch` `patchNode` `atomicWrite` `withLock` `undoPatch` `HrError` |
| `8e5c15b` | 风格引擎 + 主题 + `hr_apply_style` | `compileTone` `lintByStyle` `applyStyle` `loadStyle` |
| `20d5e37` | CLI + Skill 壳 | `serve`（待提交）`outline`/`read`/`lint`/`patch`/`style` 命令 |
| 未提交 | M2.1 daemon + SSE | `serve()`（`src/server/index.ts`） |

## 2. 本仓的硬规矩（踩出来的，不是抄来的）

1. **`pnpm verify` 必须 EXIT=0 且四维 100%**（perFile 阈值，无豁免）。报"全绿"必须贴 `EXIT=` 原文。
2. **死代码即 P1**：恒假谓词、走不到的分支、`join()` 后被归一化抹平的拼接。能删就删，**不许** `/* v8 ignore */`。
3. **边界守卫若不可由真实输入触发**（第三方库类型上的可选字段、非 TCP 监听、非 HTTP/1.1 请求）→ **内部导出 + 直接单测**（先例：`src/style/spec.ts` 的 `syntaxErrorOf`，用 `@internal` 且不进 `index.ts`）。
4. **注释只写签名表达不了的**：量级包络、精度承诺、抛错条件、与外部规范的对应关系。模块头 ≤ 3 行。**注释声称的行为必须为真**，做不到就删掉那句话（本仓库最常见的 P1）。
5. **裸异常 = P0**：任何非 `HrError` 从公开 API 漏出都按 P0 处理。
6. **列表/单值成对建例**：凡 `split().join()`、`replaceAll` 再比对，必问"第二个元素呢"。
7. 无 `any`/`as`（`as const` 除外）/`!`；`readonly` 默认；`exactOptionalPropertyTypes` 已开。
8. **你不碰** `packages/**/tests/**`、`vitest.config.ts`、`knip.json`、`.dependency-cruiser.cjs`；门禁配置改动要协调者批准。
9. 长命令**拆开跑**、每条后 `echo DONE`——两个会话都因为串联长命令静默 5 分钟被看门狗杀过。

## 3. M2.1 当前状态（你接手的位置）

- `src/server/**` 17 文件已实现：daemon 生命周期、token/cookie 鉴权、SSE hub（`frame()` 统一转义）、repo 级串行锁、watcher 自身回声抑制、`daemon.json` 原子写。
- 已过：G2 FAIL→R1（3×P0 修完）→ G2-R PASS；G3 多轮；R5 修了**丢写 P1**（`ageOf` 在 `lstat` 失败返回 `MAX_SAFE_INTEGER` → 刚建的锁被判陈旧被抢；改为 `0`，并在 `trySteal` 加 nonce 二次校验）。
- 现在只剩 `packages/core/src/server/server.ts` 的两处分支（`113` 的 `req.url ?? "/"` 假支、`149` 的 `typeof address === "string"`），按规矩 3 处理。

## 4. 与另两个角色的接口

- 审计员只读、自己跑命令复算；报告写"已验证"必须附真实输出。
- 测试员独占 `tests/**`；你新增错误码会让 `tests/hr-error.test.ts` 的码表红——**那是预期的**，在报告里列出来即可。
- 遇到合同歧义：**停手**，报告里写"待裁定：…（A/B + 建议）"。
