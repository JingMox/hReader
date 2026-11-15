# HANDOFF auditor #1 — 2026-11-15

你是**审计员**，本仓 (`/Users/liu/Documents/Project/hReader`) 的代码审计由你做。这是新会话，前一个会话审了三张卡（M2.3、C1、M3.1 G2-R1…R5、M3.1.1 G2-R2），上下文已重生。

## 已完成的卡与结论

- M2.3 G2-R3 **PASS**（首轮曾 FAIL：2×P0 已修）。
- C1 G2 **PASS**。
- M3.1 G2-R1…R5 **PASS**（发现 `L-21`/`L-13`/`L-26`，促成 M3.1.1 开卡）。
- M3.1.1 G2-R2 **PASS**，三条判定：①断言序合理但独立杀手是 `toContain(sentinel)` 而非 `not.toBe(repo)`（读仓库后补一个换行会让后者假绿）；②单 `sim` 够用；③`toBe(fileURLToPath(...))` 非巧合对齐。

## 已确立的约定

1. **你不写仓库文件**，只出报告（用户 2026-11-15 裁定：测试与实现都是编写员的活，你的独立性落在"判"而不是"写"）。
2. **产出格式固定**：开头一行 `PASS` 或 `FAIL` + **阻塞项**（P0/P1/P2 分级）；逐条给结论；顺手发现单列一节；最后一句是否签核可提交。
3. **没有 shell**：需要实测的命令写给我（协调者）代跑，别的会话（测试员）有 shell 可以帮你打，但你要自己判结果。
4. **分级口径**：P0 = 会让用户丢数据/静默错误/安全边界破；P1 = 契约漂移、死代码、测试判别力不足、错误路径裸崩；P2 = 可读性、注释、命名、重复拼写（记进 `.workflow/known-defects.md` 时用 `L-xx` 编号，由协调者登记）。
5. **不许只说"看起来没问题"**：每条结论要给判据（文件:行 + 为什么这行说明了问题）。

## 已知坑与教训（别重犯）

- **变异存活不总是漏洞**：等价变异（换回逐字等价的另一份实现）SURVIVED 是预期结果；只有"用例不设防"才升 P1。
- **"定向全绿"不等于"门禁绿"**：M3.1.1 你与测试员双签核，全量 CI 仍红 1/2102（`packages/core/tests/io/facade.test.ts:35` 公开面第二处拼写）。所以签核前必须问一句"这次改动会不会撞上另一个精确集/快照/导出面"。
- **缺陷登记表的机制描述会过期**（`L-17` 的 knip 前提已随工具版本失效）：判之前先复现现象。
- **别把测试实现当契约**：`themeOf` 之类辅助函数锁的是辅助契约，生产接线要靠黑盒臂；判"白盒单测覆盖了生产接线"是错的。
- **判据强度要单独看**：`toContain` / `not.toBe` / `toBe` 的判别力差别很大；`not.toBe` 单独用是脆的。

## 当前未完成事项

- **M3.2 卡已立、未开工**：`.workflow/cards/M3.2.md`（Pi 单文件扩展）。协调者会派 G2。
- `.workflow/known-defects.md` 里 `L-14`…`L-27` 的状态由协调者维护，你只读。

## 需要你先读的文件（按序，≤ 8）

1. `/Users/liu/Documents/Project/hReader/.workflow/cards/M3.2.md`
2. `/Users/liu/Documents/Project/hReader/docs/04-engineering-standards.md`
3. `/Users/liu/Documents/Project/hReader/docs/03-collaboration-workflow.md`（§1.3 你的角色、§四 测试矩阵）
4. `/Users/liu/Documents/Project/hReader/.workflow/known-defects.md`
5. `/Users/liu/Documents/Project/hReader/packages/core/src/server/auth.ts`（认证/CSRF 是本卡最大风险面）
6. `/Users/liu/Documents/Project/hReader/packages/core/src/server/routes.ts`
7. `/Users/liu/Documents/Project/hReader/packages/core/src/server/handlers.ts`
8. `/Users/liu/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## 不要重复做的探索

- 不要再复核 M3.1.1 的哨兵臂（已双签核，结论在 `.workflow/cards/M3.1.1.md` D9/D13/D14）。
- 不要再验"公开面两处拼写"（`packages/core/tests/io/facade.test.ts:35` 已改）。
- 不要再试图跑 `pnpm verify`（§10.9：单点执行者是协调者）。
