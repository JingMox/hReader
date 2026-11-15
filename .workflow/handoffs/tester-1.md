# HANDOFF tester #1 — 2026-11-15

你是**测试员**，本仓 (`/Users/liu/Documents/Project/hReader`) 的攻击性验证由你做。这是新会话，前一个会话跑了四张卡（M2.3、C1、M3.1、M3.1.1），上下文已重生。

## 已完成的卡与结论

- M2.3 G3-R1…R4 全绿（1951 例 / 四维 100%）。
- C1 G3 全绿。
- M3.1 G3 + G3-R2：六组全绿；你主动收紧两条弱断言；变异表中 `target.ts` 的等价变异 SURVIVED（正确）。
- M3.1.1 G3.1：**签核**。你做的对照组实验是全项目最有价值的一条证据——去掉哨兵、只留原等值断言、让实现去读仓库那份 → **全绿**，实证"没有哨兵时该断言对来源完全盲"。

## 已确立的约定

1. **你不写仓库文件**（用户 2026-11-15 裁定：测试代码由编写员落地）。你交：**用例规格 + 攻击向量 + 变异结果 + 判定**。
2. 你有 shell，可以跑任何定向命令、在 `/tmp` 建副本做变异；**不许**跑 `pnpm verify`（协调者单点执行）、**不许**改仓库文件（变异只在 `/tmp` 副本里做，做完 `git status --porcelain` 自证干净）。
3. **产出格式**：`签核 / 不签核` + 逐条结论 + 命令**原样输出** + 残余风险（明确标注"记录，不修"）+ 工作树自证。
4. 你的价值不在"跑绿"，在**能杀掉哪种改动**：每条关键断言都要问"我改哪一行会让它红"。

## 已知坑与教训（别重犯）

- **攻击形状决定证据有效性**：用"路径深度改一层"打 `PACKAGE_STYLES_ROOT`，结果红在 `WARNING 主题资源缺失` 上——红了但不是想验的断言。动手前先确认攻击能走到目标断言。
- **变异可能被 `tsc` 杀**（`TS6133` 未使用导入让 build 失败），别误判成"测试守住了"。
- **对照组法**（你自己发明的，务必沿用）：要证明某条断言有分辨力，就**去掉那个让它可以分辨的输入**，看它是否变成盲的。
- **弱断言清单**：`toContain(<子串>)`、`not.toBe` 单独用、只测列表第一项、用被测实现自己的输出当期望值——这四类都要盯。
- **仓库只发一份 `styles/atelier-editorial/theme.css`**，三个预设都继承它：别把"同一条链跑三遍"说成"测了三份资源"。

## 当前未完成事项

- **M3.2 卡已立、未开工**：`.workflow/cards/M3.2.md`（Pi 单文件扩展）。协调者会派 G3。
- 回归集入口：`packages/core/tests/`、`packages/mcp-server/tests/`、`packages/app/tests/`、`packages/cli/tests/`（每卡结卡后由协调者告知增量入口）。

## 需要你先读的文件（按序，≤ 8）

1. `/Users/liu/Documents/Project/hReader/.workflow/cards/M3.2.md`
2. `/Users/liu/Documents/Project/hReader/docs/03-collaboration-workflow.md`（§1.4 你的角色、§四 测试矩阵、§11.x 实战手册）
3. `/Users/liu/Documents/Project/hReader/docs/04-engineering-standards.md`
4. `/Users/liu/Documents/Project/hReader/packages/core/src/server/event-ring.ts`（SSE 帧/回填/裁剪，本卡攻击重点）
5. `/Users/liu/Documents/Project/hReader/packages/core/src/server/auth.ts`（cookie/CSRF/Host/Origin）
6. `/Users/liu/Documents/Project/hReader/packages/core/src/server/hub.ts`
7. `/Users/liu/Documents/Project/hReader/packages/core/src/server/routes.ts`
8. `/Users/liu/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## 不要重复做的探索

- 不要再验 M3.1.1 的哨兵臂（你已签核，结论在 `.workflow/cards/M3.1.1.md` D14）。
- 不要再验 symlink 逃逸（`L-20` 已关闭：`realpath` 后判定）。
- 不要试图在本卡跑全量 `pnpm verify`。
