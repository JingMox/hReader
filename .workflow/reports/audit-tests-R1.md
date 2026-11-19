审计完成。以下为报告正文（未改任何文件）。

---

# hReader 测试代码审计 · R1

审计范围：`packages/cli/tests/{normalize,needs-normalize,serve-errors,undo-envelope}.test.ts`、`journey/first-run.test.ts`、`serve-harness.ts`，以及 `M` 状态的 `packages/core/tests/**`（`node-fs.test.ts` 等）、`packages/cli/tests/units-*.test.ts`、`serve.test.ts`。配套读了 `.workflow/reports/tests-R1.md`，并抽查了对应 `src/**`（`serve.ts`、`routes.ts`、`exportPrint.ts`、`units-output.ts`、`args.ts`）。

> 说明：无 shell 权限，测试是否真绿未能实跑。需 supervisor 执行：`pnpm -r test` 与 `pnpm verify`（含 perFile 覆盖率门）。

## 判决：`CHANGES-NEEDED`

- **P1-1** `needs-normalize.test.ts:70-80` —— 名为 “byte-identical” 的用例**从未读取磁盘字节**，只比较了两次 stderr。症状未被测（详见空转节）。
- **P1-2** `journey/first-run.test.ts` 黑盒合格，但 serve 段用 `--json` **绕开了打印 URL 这条主路径**，导致实现里的真实 bug（BUG-01：打印的 URL 打开是 401）没有被这条“用户旅程”抓住——旅程没覆盖它本该覆盖的最典型症状。
- **P2-1** `node-fs.test.ts:26` 顺着实现写：断言 `Object.keys(fsApi).toEqual([... "chmod"])`，锁死端口对象的内部方法名，而非用户症状；且这是新增 `chmod` 覆盖率缺口的根源。
- **P2-2** `serve-harness.ts:38/73/78` 脆性：`addressOf` 用 `?token=` 拼 URL；`firstLineOf` 超时只 `reject` 不 kill 子进程（非 `finally`）；与既有 `serve.test.ts:66` 的 `firstLineOf` 重复。
- **P2-3** `units-output.test.ts` “样式命令” 用例断言输出里含 `<style id="hr-theme">` 字面量——把内部 DOM 形态冻结进用户消息契约。
- **P2-4** `units-output.test.ts` `COMMAND_NAMES` 对 10 个命令名做**顺序敏感**的 `toEqual`；这是 usage 文案，非症状。
- **P2-5** `wire-http.test.ts:200` 断言 `<a href="/healthz">healthz</a>` 精确标签文本；属冻结契约，可接受但偏脆。

## 逐文件用例质量表

| 文件 | 例数 | 锚症状? | 空转? | 诊断? | 脆性? |
|---|---|---|---|---|---|
| `normalize.test.ts` | 6 | ✅ stdout/落盘/`injected`/exit | 否 | ✅ 报错点明文件+命令 | 低（tempdir，`runCli` 子进程） |
| `needs-normalize.test.ts` | 4 | 3 条✅，第 2 条❌ | **1 条（:70）** | ✅ | 中（serve 段） |
| `serve-errors.test.ts` | 3 | ✅ code 码 + 端口/收尾 | 否 | ✅ | 中（真端口、kill -9 模拟） |
| `undo-envelope.test.ts` | 4 | ✅ 恢复字节/sha/仅一次 | 否 | ✅ | 低 |
| `journey/first-run.test.ts` | 3 | ✅ 端到端（JSON 信封） | 否 | ✅ 带阶段前缀 | 中（3 段串行，超时 30s） |

## 找到的空转断言

**`needs-normalize.test.ts:70-80`（最典型）**
```ts
it("should leave the handwritten file byte-identical when refusing", async () => {
  seed(dir, "draft.html");
  const before = checked(await runCli(["outline","draft.html"], {workspace,json:true}));
  ...
  const after  = checked(await runCli(["patch","draft.html",...], {workspace,json:true}));
  expect(after.stderr).toBe(before.stderr);   // ← 只比 stderr
});
```
- 为什么不算测试：名为 “byte-identical”，但 `before`/`after` 都是 `CliResult`（stderr 字符串），**没有任何 `readFileSync(文件)`**。它测的是“两次拒绝的 stderr 相同”，而拒绝路径本就 `assertNormalized` 先返回、写盘分支根本不进——所以这条**永远为真且与文件名无关**。真正有价值的症状（“拒绝时不能改动她的手稿”）没被验证。
- 具体改法：`const bytesBefore = readFileSync(path); ... ; expect(readFileSync(path).equals(bytesBefore)).toBe(true)`（或比 sha），断言名才算兑现。顺带这条也能让 `normalizeFile` 拒绝分支的“不写盘”语义被实锚。

（其余三个新增文件未发现恒真断言；`serve-errors` 的 `expect(fieldOf(written,"token")).not.toBe("stale")` 是有效负向哨兵，非空转。）

## 找到的“顺着实现写”

1. **`packages/core/tests/io/node-fs.test.ts:26`**
   - 锁住：`nodeFs()` 返回对象的**方法名集合** `[..., "chmod"]`。
   - 问题：用户看不到 `fsApi`，加一个方法会让“面 API”测试红，但这既不是约定也不是症状；反过来，正因为没人测“只读文件写入被拒”，`chmod` 分支才没拿到行覆盖。
   - 应改成：造一个 `chmod 0444` 的文档，`patch --write` 应得 `io_failure`（exit 3）且 message 含 `chmod +w`（这正是 `atomic.ts:assertWritable` 的行为）——用户可见且顺带覆盖 `chmod`。

2. **`units-output.test.ts` “样式命令” 用例**
   - 锁住：`humanStyle(...)` 输出里出现 `<style id="hr-theme">` 字面量。
   - 问题：这句用户文案把内部 DOM 属性冻结成契约；实现哪天改标签 id，测试必红而用户体验无损。
   - 应改成：断言“产物里包含 `<style`” + “CSS 含 `body` 选择器”（产品语义），或干脆只断言“已写入 N 字节”。同理 `COMMAND_NAMES` 的 `toEqual` 顺序敏感，改为 `expect.arrayContaining`/集合比较。

3. **`wire-http.test.ts:200`（P2）** `<a href="/healthz">healthz</a>` 精确 HTML——属项目的“冻结公开 HTML 契约”，可留，但标注为契约而非症状。

## journey 专项

**确认黑盒**：`journey/first-run.test.ts` 只 `import` `../cli-support`（`node:crypto`/`node:fs`/`node:path`/`vitest`）与 `../harness`，**未 import 任何 `packages/*/src`**；`cli-support.ts` 同样无 src import（仅 `expectNoAnsi`/`CliResult`）。✅ 满足“只用公开契约”。

逐条：
1. `:136` 手稿 → `outline`（含 `data-hr-id` → ok）→ `read` → 断言正文；**先验证“手稿不 normalize 也能 outline”**，锚在 CLI 退出码+stdout 正文。
2. `:156` 编辑一章 → `patch` → 断言 `replacedIds` 含 → `style` → `export`；断言导出 `bytes` 与磁盘打印稿一致。
3. `:180` `startServe` → 断言响应含 `doc.html` → 断言 cookie。

**serve 段的时序问题（关键）**：`startServe(file)` 内部拉的 CLI 带 **`--json`**（见 `serve-harness.startServe` 的 argv），因此拿到 `{port, token}` 并 `--token` 打 `?token=`；**它从没走 `hr serve file`（人读模式）打印的那行 `http://127.0.0.1:PORT/?token=…`**。换言之，最典型的“用户照屏幕上那行 URL 打开”并未被测——而这恰好命中了 BUG-01（人读模式打印的 URL 不带 token，cookie 路由 `/` 对无 token 请求 401）。因此这条旅程“看着像”覆盖了启动/访问，实际绕过了主路径。**建议**：journey 增加一条不传 `--json` 的 serve，抓 stdout 首行的 `http://…` 直接用 `fetch` 打开，断言 200——这条会立刻照出 BUG-01。

## 覆盖与门禁的结论（第 5 条）

**结论：这是“测试缺口”，不是“门禁设计问题”。** `pnpm verify` 红在 perFile 四维（行/分支/函数/语句）100%，根因是新增 src 只被**子进程**覆盖，`v8` 进程内统计看不到。但列出的未覆盖点**全部可以在进程内被测**：

- `packages/cli/src/run.ts:248`（`runRemaining` 的 normalize 分支）——用 `run([...], io)` 注入假 `io` + tempdir 即可，不必子进程。
- `normalizeFile.ts`——`nodePatchDeps`+tempdir 进程内直接调。
- `hasArticle`——纯函数，直接 import 测。
- `listen.ts:ipv6Occupied / ownerOfPort / bindErrorOf`——`http.createServer().listen()`/`::` 绑定即可。
- `server.ts:199`（ipv6 diagnose 分支）——先在 `::` 占一个端口，再 `startServer`，断言回退到 `127.0.0.1` 且警告文案。

**最小改法（不放宽阈值）**：按上面 5 项各补 1 条**进程内**用例，命中 perFile 四维；同时 `node-fs.test.ts` 的 chmod 用例（见“顺着实现写 1”）顺手补 `chmod` 行覆盖。**理由**：perFile 100% 对 `server.ts`/`run.ts` 这类“胶水+可注入”文件是合理要求——它们已有 `wire-http`/io 注入测试框架，只是没补到新分支；放宽阈值会掩盖“新分支无人测”的实质风险。**唯一可考虑的豁免**：若某文件确证只能在子进程观测（当前无一例），才用“等价子进程强断言 + 注释豁免”而非降阈值。

## 给业务编写员的 BUG 清单（实现侧，交业务编写员）

- **BUG-01（P1，已复核）** 人读 `hr serve`（无 `--json`）打印 `http://host:port/?token=…`，但 `humanServe` 打印的是 `?token=` **不带** query 里的 token？——核对 `routes.ts`：cookie 路由 `/` 在无 token 时回 **401**；`humanServe` 输出不含 token（token 只在 json 信封里）。结果：用户照屏幕字面 URL 打开得到 401。—— **修**：人读模式打印的 URL 必须带有效 `?token=`，或 `/` 允许首访种 cookie。测试侧已由 journey 缺失暴露（见上）。
- **BUG-02（P2，已复核）** `export`（`exportPrint.ts:93`）对**无 `data-hr-id`** 的文档直接 `injectNodeIds` 落盘，没有 `assertNormalized` 前置；与 `outline/read/patch` 的“拒绝并提示先 normalize”不一致。**修**：导出口径对齐（要么拒绝，要么在 human/json 明确标注“已自动注入 N 个 id”）。
- **BUG-03（P2，已复核）** 首页 fallback（`fallbackHome`）只输出一个 `<a>`，无正文容器；`homeHtml` 测试 `toContain("doc.html")` 只是间接覆盖。产品上“首页应有可用正文区”未实现。—— 确认是否预期。
- **BUG-04（P2）** `--ids` / `--llms-full` 在 `args.ts` 无匹配；若 usage/计划里承诺这两个开关，则未接线。—— 待业务编写员确认是否在范围内。
- **BUG-05（P2，文档一致性）** 实现把 `daemon_already_running` 的 exit code 从 2 改成 1，但 `packages/cli/tests/units-serve.test.ts:201` 的注释仍写“只有 daemon_already_running 是 2”。用例本身不红（该用例断言的是 `invalid_input`），但注释误导，建议业务编写员同步更新（属实现变更遗留，非测试编写员责任）。

---

## 250 字摘要

**判决：CHANGES-NEEDED**（P1×2、P2×5）。五个新增测试文件整体质量好，几乎全部锚在 CLI 的退出码/信封/落盘等用户可见症状上，诊断信息带阶段前缀、可读。**最典型空转**：`needs-normalize.test.ts:70` 名为 “byte-identical” 却只比两次 stderr、**从不读盘**，永真且与文件名无关，应改为 `readFileSync` 前后字节（sha）比较。**journey 黑盒合格**（零 `src` import），但 serve 段用 `--json` 拿 token 绕过“打印的 URL”，导致真实 BUG（人读 URL 打开 401）没被这条旅程抓住——建议补一条非 `--json` 的 serve 抓 stdout URL 直接 `fetch`。**覆盖率门禁结论：是测试缺口不是门禁设计问题**；`run.ts:248`、`normalizeFile`、`hasArticle`、`listen` ipv6 三项、`server.ts:199` 均可进程内覆盖，补 5 条进程内用例即可，**不应放宽阈值**。