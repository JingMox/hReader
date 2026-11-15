# HANDOFF writer #1 — 2026-11-15

你是**编写员**，本仓 (`/Users/liu/Documents/Project/hReader`) 的代码由你一个人写。这是新会话，前一个会话跑了四张卡，上下文已重生。

## 已完成的卡与结论

- **M2.3** accepted — 划词批注持久化 + 字符级 Visual Diff + 撤销。commit `c96f8f5`。
- **C1** accepted — 清 `L-04`/`L-05`：`Host.focus` 收回、wire 删 `reason`/`originNodeId`，9 条 wire 断言转反向锁。
- **M3.1** accepted — 标准 MCP Server + MCP-UI（5 tools + resources + prompts）。commit `74781fc`。期间发现 `L-21`（产物离开仓库即失效）/`L-13`（路径判定两份）。
- **M3.1.1** accepted — 你的 F1–F4：样式随包发布（包内优先 + 仓库兜底候选链）、路径判定收敛 core（`isInside`/`isInsideOrSelf` 导出，逻辑零改动）、`..foo` 判定分叉修复、`install-sim` 哨兵臂、build 缺源守卫。commit `3134499`。全量门禁 `EXIT=0`，191 文件 / 2102 例 / 四维 100%。

## 已确立的约定（逐条遵守）

1. **裸类型**：导出签名不写 `any`、不写包装接口；参数/返回值用 `string`/`number`/`boolean`/`readonly T[]`/字面量联合。
2. **注释纪律**：只解释"无法从函数签名看出来的东西"（为什么这样、边界是什么、哪个约束逼的）。不写"这个函数做什么"。
3. **门禁最严档**：`tsc --noEmit`、`eslint --max-warnings=0`、`prettier --check`、`knip`（无 hint）、覆盖率 `perFile: true` **四维 100%**（line/branch/function/statement）。**不许** `istanbul ignore`、`skip`、`only`、降阈值。
4. **测试代码是你的活**（用户 2026-11-15 裁定）：测试员只交规格与攻击向量，落地由你写。
5. **禁区**：不跑 `pnpm verify`（协调者单点跑）；不 `git commit`（协调者提交）；不碰 `.workflow/`（协调者记账）；不改 `docs/`（除卡片明确授权）。
6. **定向命令**：`npx vitest run <文件…>`、`npx tsc --noEmit -p tsconfig.json`、`npx eslint <路径> --max-warnings=0`、`npx prettier --check <路径>`、`npx knip`。
7. **错误码**以 `packages/core/src/errors.ts` 为准；失败返回带码的文本，不抛裸异常。
8. **公开导出面钉在两处**：`packages/core/tests/entry-points.test.ts`（根 barrel 精确集）与 `packages/core/tests/io/facade.test.ts:35`（io 子门面精确键集）。加导出时**两处都要动**。
9. 每批交付都要给：改了什么（文件:行）、命令**原样输出**、`git diff --stat`、以及"这条用例能杀掉哪种改动"的反向验证。

## 已知坑与教训（别重犯）

- **证明不了"来源"的断言等于没有断言**：`install-sim` 的期望值原本直接从被拷进 sim 的那份文件读，两边字节本就相同 → "实现改读仓库"照样绿。修法是往 sim 那份写入"仓库字节 + 唯一哨兵注释"，让原等值断言获得分辨力。
- **定向测试全绿 ≠ 门禁绿**：M3.1.1 你报 148 例定向全绿，全量 CI 仍红 1/2102（公开面第二处拼写）。交付前自己先想"这次改动会不会撞上另一个精确集/快照"。
- **变异可能被 `tsc` 杀而不是被测试杀**：把模块常量换成字面量后未使用导入报 `TS6133`，别误判成"测试守住了"。
- **`knip` 5.81 已从 `package.json` 的 `bin` 解析 `src/main.ts`**：不要再为 `src/main.ts` 加 entry，只会换来 `Remove redundant entry pattern`。
- **等价变异会 SURVIVED 且是正常的**：把实现换回逐字等价的另一份写法，测试不红是对的。
- **测试的红要红对原因**：攻击形状不对时，用例可能红在别的断言上（例如红在"主题资源缺失"而不是"内容不符"），那不是有效证据。

## 当前未完成事项

- **M3.2 卡已立、未开工**：`.workflow/cards/M3.2.md`（Pi 单文件扩展）。这是你的下一张卡。
- M3.1.2（去重复份：`target.ts:93-97` realpath 序列、`ui.ts:15` POSIX 归一、`hooks.ts` 整份 `cli/resolve-hook.ts`、`errors.ts:60-80` cwd 折叠）**未开卡**，等你以后碰到这些文件时顺手做。

## 需要你先读的文件（按序，≤ 8）

1. `/Users/liu/Documents/Project/hReader/.workflow/cards/M3.2.md`（唯一验收依据）
2. `/Users/liu/Documents/Project/hReader/docs/04-engineering-standards.md`
3. `/Users/liu/Documents/Project/hReader/docs/03-collaboration-workflow.md`（§1.2 你的角色、§三 门禁）
4. `/Users/liu/Documents/Project/hReader/packages/core/src/server/routes.ts`
5. `/Users/liu/Documents/Project/hReader/packages/core/src/server/auth.ts`
6. `/Users/liu/Documents/Project/hReader/packages/core/src/server/event-ring.ts`（+ `hub.ts`）
7. `/Users/liu/Documents/Project/hReader/packages/core/src/server/contracts.ts`
8. `/Users/liu/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## 不要重复做的探索

- 不要再搜 knip 怎么解析 entry（结论见上）。
- 不要再试图让 G1 阶段跑 `pnpm verify`（结构性假红：新模块未被 import 时 knip 报 unused）。
- 不要再验证"路径判定两份是否等价"（`L-13` 已在 M3.1.1 收口，core 现在是唯一真值源）。
- 不要再猜 Pi 扩展 API 形状（上面第 8 个文件是权威）。
