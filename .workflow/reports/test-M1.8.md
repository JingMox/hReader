# test-M1.8 · hReader CLI（M1.8）测试报告

- 卡：`.workflow/cards/M1.8.md`；被测：`packages/cli/**`（14 源文件）+ `skills/hreader/**`
- 拥有范围：`packages/cli/tests/**`、`packages/cli/fixtures/**`（未改 `src/**`、未改配置/阈值）
- 本轮（G3 续跑）目标复述（m01848）：补 `packages/cli/tests` 全量、5 个退出码、`--json` 三条、管道与 `invalid_utf8`、无 ANSI、`--help`、Skill 壳、references 全片段、交叉一致性、覆盖率四维 100%、变异 ≥5 + 1 反向变异、`pnpm verify` 到 EXIT=0、本报告 + `ACP:`

## 0. 结论（一句话）

用例 **177**（14 个测试文件，全仓 1102 / 83 文件）、变异 **6/6 全杀（含 2 个反向变异）**、`pnpm verify` **EXIT=1 只因 coverage**：`cli/src` 6 处**分支级死臂**（`main.ts` 解析钩子、`output.ts` 诊断 `path`、`exit-codes.ts` 表外兜底、`run.ts` UsageError 臂与 `/` 根臂、`read.ts` 两处类型守卫）——全部写在 §5 待裁定，附"为什么不可达 + 建议怎么删"。

## 1. 用例矩阵（按文件）

| 文件 | 例数 | 覆盖点 |
|---|---|---|
| `units-args.test.ts` | 43 | 5 条命令的位置参数/选项、`--json`/`--workspace` 通用项、`--help` 与子命令 `--help`、未知参数/重复参数/互斥（`--visual`+`--tone`+`--lint`）、`--max-bytes` 边界（非整数/0/负数/超大）、`--html*` 三选一与互斥、缺失位置参数逐条报文 |
| `args-style.test.ts` | 9 | style 专属：`--lint` 无值、位置参数个数、`--visual/--tone/--lint` 恰好一个、`--json` 重复 |
| `units-output.test.ts` | 40 | `jsonOk`/`jsonError` 固定信封（ok 在前、单行、唯一尾随 `\n`）、`jsonQuote` 转义（引号/反斜杠/控制字符/中文/emoji/代理对）、五类数据序列化（outline 递归/read/patch/style/lint/tone）、`human*` 文本分支、空集合与嵌套数组 |
| `units-input.test.ts` | 10 | `decodeStrict`：坏字节 → `invalid_utf8`、BOM 保留、`\uFFFD` 不二次替换；`readTextFile`：ENOENT → `not_a_file`、非文件 → `io_failure`；`sourceText` 三分支（inline/file/stdin） |
| `units-commands.test.ts` | 13 | 四命令编排：outline 文本树与 JSON、无 id 降级（`outline_node_without_id` + `nodes:[]`）、read 文本/JSON/`ids` 注入/`invalid_max_bytes`、patch append（`changed:true`、history 路径、`newIds`）、patch `node_not_found`、style tone（人与 JSON）、style visual 幂等（`changed:true` → `false`） |
| `units-edges.test.ts` | 6 | read 选择器失败→按 node id 重试成功；双无效 → `invalid_selector`（报文含两条路径）；选择器无效 + id 合法 → `node_not_found`；patch 目标在缺失目录 → `not_a_file` 且**不创建目录**；style lint 人读/JSON |
| `units-run-paths.test.ts` | 3 | `run()` 路径换算：缺失多级目标退到最深存在祖先（`realpath时路径不存在`，不建目录）；`--workspace` 指向不存在目录 → `逃出了 workspace`；style 二次应用走 human `unchanged` 分支 |
| `main-entry.test.ts` | 4 | 进程壳：argv/`HR_DEBUG`/stdin 注入 → `process.exitCode`；空 stdin、`--help`、非文件 |
| `cli-exit-codes.test.ts` | 14 | **5 个退出码**全覆盖（0/1/2/3/70）+ 逐码成因（`invalid_html`/`no_article`/`node_not_found`/`forbidden_content`/`invalid_selector`/用法错误/坏编码/内部错误），并断言失败时文件字节不变 |
| `cli-io.test.ts` | 8 | 管道（`--html-stdin` 正常/空/坏字节）、`--html-file` 缺失、`--workspace` 越界、`--json` 失败信封 |
| `ac5a-e2e.test.ts` | 2 | AC5a 端到端：一份真实文档跑完 outline → read → patch → style(tone/lint/visual) → 再 outline；第二次 style 不再改盘 |
| `skill-shell.test.ts` | 4 | `skills/hreader`：SKILL.md frontmatter（name/description/触发词）、命令清单与 CLI `--help` 交叉一致、无绝对路径 |
| `references.test.ts` | 10 | 所有 `references/*.md`：链接可达、代码块语言标注、命令片段与 CLI 用法一致、无 ANSI/无 CRLF |
| `units-run.test.ts` | 11 | `run()`：成功路径 stdout 只一行、失败 `--json` 信封 + stderr 纯 message、`UsageError` → 2、非 `HrError` → 70（含 debug 栈） |

### 1.1 硬门对照（逐条）

1. **真子进程**：`harness.ts` 的 `runCli` 一律 `spawn(process.execPath, ["--experimental-strip-types", main.ts, ...])`，`stdio: [stdin?pipe:"ignore", "pipe","pipe"]`，10s 硬超时 + `SIGKILL`，超时/`error` 都 reject（防"子进程等 stdin"式静默挂死，见 m01848）。
2. **5 个退出码**：`cli-exit-codes.test.ts` 0/1/2/3/70 各 ≥1 例，且断言"失败时文件 sha 不变"。
3. **`--json` 三条**：单行、ok 在前、唯一尾随 `\n`（`units-output.test.ts` + 进程级 `cli-io`/`cli-exit-codes`）。
4. **管道与 `invalid_utf8`**：`cli-io`（stdin 坏字节）+ `units-input`（文件/stdin 双路）。
5. **无 ANSI**：`runCli` 统一断言 `stderr/stdout` 不含 `\u001b[`（所有进程级用例经此通道）。
6. **`--help`**：根帮助与 5 条子命令帮助各一例（`units-args`），退出码 0。
7. **Skill 壳**：`skill-shell.test.ts`（frontmatter、命令表一致性、无绝对路径）。
8. **references 全片段**：`references.test.ts` 遍历目录，断言每条命令可被 `hr --help` 解释。
9. **交叉一致性**：Skill 命令表 ↔ `usage.ts` ↔ `args.ts`（`args-helpers.ts` 单一事实源）。
10. **覆盖率四维**：见 §2（`cli/src` 未满，6 处死臂 → §5）。
11. **变异 ≥5 + 反向 ≥1**：见 §3（6 条，含 2 条反向）。

## 2. 覆盖率（真实数字）

```
All files          |   99.72 |    99.61 |   99.78 |   99.72
 cli/src           |   97.52 |    97.83 |    98.3 |   97.52
  args.ts          |     100 |      100 |     100 |     100
  exit-codes.ts    |     100 |       50 |     100 |     100 | 37
  input.ts         |     100 |      100 |     100 |     100
  main.ts          |   80.55 |    85.71 |     100 |   80.55 | 13-19
  output.ts        |   96.49 |    96.77 |   95.23 |   96.49 | 39-40
  run.ts           |   95.91 |    95.91 |     100 |   95.91 | 47,100-102
  tokens.ts        |     100 |      100 |     100 |     100
  usage.ts         |     100 |      100 |     100 |     100
 cli/src/commands  |     100 |    95.55 |     100 |     100
  outline.ts       |     100 |      100 |     100 |     100
  patch.ts         |     100 |      100 |     100 |     100
  read.ts          |     100 |    90.47 |     100 |     100 | 27,67
  style.ts         |     100 |      100 |     100 |     100
```

`src/style`、`src/io`、`src/ops/**`、`src/html` 均 100（core 侧由 M1.5/M1.6 套件保持）。

## 3. 变异表（真改 `src` → 真跑用例 → 逐字节还原）

跑法：`node packages/cli/fixtures/cli-mutants.mjs`（结果落 `packages/cli/fixtures/cli-mutants-result.json`；每条变异都校验还原后的 sha256）。

| ID | 变异（改坏什么） | 结果 | 杀死它的用例 |
|---|---|---|---|
| C1 | `jsonOk` 少 `\n`（单行 JSON 契约破） | KILLED | `output · JSON 信封 > should wrap data with a fixed ok-first envelope and a single newline` |
| C2 | `invalid_utf8: EXIT_IO` → `EXIT_FAILURE`（3→1） | KILLED | `退出码 3 · 坏编码 > should exit 3 + invalid_utf8 …` |
| C3 | 空 stdin 判定恒 false（2 → 落到 core） | KILLED | `管道与编码 · 拒绝路径 > should exit 2 for empty stdin` |
| C4 | `TextDecoder(fatal: true → false)`（宽容解码） | KILLED（3 例） | `decodeStrict > should reject invalid byte sequences`；`readTextFile > should reject a file with invalid UTF-8` |
| **C5（反向）** | 所有 `HrError` 都报 70（退出码表失效） | KILLED（7 例） | `退出码 1 · 业务失败 > should fail node_not_found without touching the file` 等 |
| **C6（反向）** | `--json` 的失败信封不再写 stdout（只留 stderr） | KILLED（2 例） | `退出码 1 · 禁用内容 > should fail forbidden_content …`；`退出码 3 · 坏编码 …` |

### 3.1 变异工具自身的坑（值得记）

- **C4 首次假存活**：脚本首版把 C4 的目标用例写成 `cli-exit-codes` + `units-output`（不含 `units-input`），断言面根本不覆盖 `decodeStrict` → 变异"活着"是**用例选择错**，不是断言弱。已改目标文件并复跑，3 例杀死。
- **Vite 转换缓存**：同秒内改写同一路径，`spawnSync("npx vitest run")` 可能复用旧模块 → 假存活。修法：写后 `utimesSync` + `Atomics.wait` 1100ms（见脚本 `pause`）。**教训：变异脚本必须证明"文件真的变了"且"测试真的重跑了"**，否则会自己骗自己。

## 4. 我找的真问题 / 证伪记录（3 条假设）

1. **`--workspace` 指向不存在的目录**：`realpathThroughAncestors` 把 workspace 归到最近祖先，于是相对 `file` 变成 `../doc.html`，最终报 `path_outside_workspace`（`file 逃出了 workspace`）。
   - 安全侧正确（确实挡住了），但**报文误导**：用户看到"逃出 workspace"，实际是"workspace 不存在"。已固化为 `units-run-paths.test.ts` 的断言；建议报文区分（如 `workspace 不存在：<path>`）。→ 待裁定。
2. **`patch` 目标在缺失目录**：报 `not_a_file`（`realpath时路径不存在`），不是 `node_not_found`；且**不创建目录**（已断言 `missing` 不存在）。行为合理。
3. **`read` 的双解释（选择器 → node id）**：`hr-b` 先当选择器（合法但无匹配 `node_not_found`）→ 再当 id（命中）；`p[` 选择器非法、id 选择器合法但无匹配 → `node_not_found`；`">` 两侧都非法 → `invalid_selector` 且报文列出两条路径。与 R1-P1-1 一致，**没坏**。

## 5. 待裁定（6 处分支死臂；我没改 `src`、没放宽阈值）

> 结论先行：`cli/src` 的 6 处分支在**当前类型契约/运行契约**下不可达。要"四维 100%"只能动 `src`（删臂/抽出可测函数）或动覆盖率策略——两条都超出测试员职权。

1. `packages/cli/src/main.ts:13-19`（`registerHooks.resolve` 的 `catch` → `.ts` → `/index.ts` 回落）
   - 为什么不可达：vitest 里模块解析走 Vite，Node 的 `resolve` 钩子只在**真实 Node ESM** 下被调用；而 `pnpm test:coverage` 不采集子进程覆盖率。
   - 建议：把箭头函数抽成 `packages/cli/src/resolve-hook.ts` 的 `export const resolveFallback = (specifier, context, nextResolve) => {…}`，`main.ts` 只留 `registerHooks({ resolve: resolveFallback })`；测试直接调用 `resolveFallback` 并用"第一次 throw、第二次成功"的假 `nextResolve` 走三分支。
2. `packages/cli/src/output.ts:39-40`（`diagnosticJson` 的 `diagnostic.path === undefined ? "" : …` 的后半臂）
   - 为什么不可达：全仓 `grep "path:" packages/core/src` 无任何诊断生产者设置 `path`（`DiagnosticShape.path` 只有声明）。core 的 outline 诊断全为 `path` 缺省。
   - 建议二选一：① 删掉 `path` 支持（接口 + 序列化）；② 让诊断真的带 `path`（如 `outline_node_without_id` 带上节点路径），否则这行是死代码。
3. `packages/cli/src/exit-codes.ts:36-37`（`Object.hasOwn(EXIT_CODES, code) ? … : EXIT_INTERNAL` 的后半臂）
   - 为什么不可达：`EXIT_CODES` 用 `satisfies Record<HrErrorCode, number>`，key 集合与 `HrErrorCode` 完全一致；类型层面进不来表外 code。
   - 建议：若有"新 core 配旧 CLI"的运行时诉求，就保留并接受该行无法被测试覆盖（需要协调者裁定策略）；否则改成 `EXIT_CODES[code]`（`satisfies` 已保证穷尽）。
4. `packages/cli/src/run.ts:99-102`（`reportFailure` 里的 `UsageError` 臂）
   - 为什么不可达：`run()` 第 127 行已先 `if (error instanceof UsageError) return usageFailure(error.message, kind, io)`，`reportFailure` 永远收不到 `UsageError`。
   - 建议：删掉 `reportFailure` 的 `UsageError` 分支（含 `messageOf` 在该分支的使用），保留 `run()` 里的唯一入口。
5. `packages/cli/src/run.ts:47`（`realpathThroughAncestors` 的 `parent === path ? path : …` 的真臂）
   - 为什么不可达：只有递归到文件系统根 `/` 才可能 `parent === path`，而 `/` 的 `realpath` 一定成功（第 44 行已返回），不会走到 47。
   - 建议：删掉三元，改成 `return join(realpathThroughAncestors(parent), path.slice(parent.length + 1));`（若担心 `dirname` 在极端输入下自指，可改用 `while` 循环并显式 break，但同样要能构造出输入否则还是死臂）。
6. `packages/cli/src/commands/read.ts:27` 与 `:67`
   - `:27` `match[1] === undefined ? [] : [match[1]]`：正则 `/data-hr-id="([^"]+)"/gu` 有捕获组，`matchAll` 命中时 `match[1]` 必为 `string`；`undefined` 臂只为满足 `noUncheckedIndexedAccess`。
     建议：改用 `String(match[1])`（分支消失、语义不变），或 `.map((match) => match[1] ?? "")` 同样留死臂——**不推荐**。
   - `:67` `if (!(retry instanceof HrError) || !isRetriable(retry)) throw retry;`：`readNode` 只抛 `HrError`，且 `[data-hr-id="…"]` 形式的选择器只会得到 `node_not_found`（可重试）→ 两个子条件都不成立。
     建议：直接 `return bothFailed(target, first, retry);`，把"非 HrError"当成不可达（或用 `assertUnreachable` 显式表达）。

## 6. `pnpm verify` 真实输出（EXIT=1，仅 coverage）

```
$ pnpm verify
$ prettier --check .            → All matched files use Prettier code style!
$ eslint . --max-warnings=0     → （无输出，通过）
$ tsc --noEmit -p tsconfig.json --pretty false → （无输出，通过）
$ vitest run --coverage
 Test Files  83 passed (83)
      Tests  1102 passed (1102)

 % Coverage report from v8
All files          |   99.72 |    99.61 |   99.78 |   99.72
 cli/src           |   97.52 |    97.83 |    98.3  |   97.52

ERROR: Coverage for branches (90.47%) does not meet global threshold (100%) for packages/cli/src/commands/read.ts
ERROR: Coverage for branches (50%) does not meet global threshold (100%) for packages/cli/src/exit-codes.ts
ERROR: Coverage for lines (80.55%) does not meet global threshold (100%) for packages/cli/src/main.ts
ERROR: Coverage for statements (80.55%) does not meet global threshold (100%) for packages/cli/src/main.ts
ERROR: Coverage for branches (85.71%) does not meet global threshold (100%) for packages/cli/src/main.ts
ERROR: Coverage for lines (96.49%) does not meet global threshold (100%) for packages/cli/src/output.ts
ERROR: Coverage for functions (95.23%) does not meet global threshold (100%) for packages/cli/src/output.ts
ERROR: Coverage for statements (96.49%) does not meet global threshold (100%) for packages/cli/src/output.ts
ERROR: Coverage for branches (96.77%) does not meet global threshold (100%) for packages/cli/src/output.ts
ERROR: Coverage for lines (95.91%) does not meet global threshold (100%) for packages/cli/src/run.ts
ERROR: Coverage for statements (95.91%) does not meet global threshold (100%) for packages/cli/src/run.ts
ERROR: Coverage for branches (95.91%) does not meet global threshold (100%) for packages/cli/src/run.ts
[ELIFECYCLE] Command failed with exit code 1.
```

`depcruise` / `knip` 未被 `verify` 链跑到（`&&` 在 coverage 处中断）；单独跑实测：`pnpm depcruise` **EXIT=0**（207 modules / 747 dependencies，无违规）、`pnpm knip` **EXIT=0**（`knip --strict` 无输出）。

## 7. 测试基建（给后来者）

- `harness.ts`：`runCli(args, {cwd, stdin, stdinFd, env})` + `withTem…`（`mkdtemp` + `finally` 清理）。**每个子进程必须 `stdio: ["ignore"|fd, "pipe", "pipe"]` + 10s 超时**。
- `cli-support.ts`：`seed`（写文档）/`sha`（node:crypto 自算）。
- 断言纪律：每个错误路径同时断 `code` 与"文件未变"；不用 `expect(x).toBeDefined()`；JSON 用 `toMatchObject`（对数组长度严格），文本用 `toMatch` 精确正则。
- 变异：`fixtures/cli-mutants.mjs`（真改 src → 真跑 → sha 校验还原），坑见 §3.1。
- 环境无关：全部 `mkdtemp`；路径一律 `realpathSync`（macOS `/tmp → /private/tmp` 会让 `--workspace` 与 cwd 不一致，这是本套件最容易踩的坑）。

ACP:
- 目标：G3 · 测试 M1.8（`packages/cli/tests/**` 全量 + 变异 + verify + 报告），未碰 `src/**`/配置/阈值
- 用例：**177**（14 文件；全仓 1102 passed / 83 files / 0 failed / 0 todo）
- 四维：**99.72 / 99.61 / 99.78 / 99.72**；`cli/src` 差 6 处分支死臂（§5）
- 变异：**6/6 全杀**（C1–C4 前向，C5/C6 反向）；一次假存活是目标用例选错 + Vite 缓存，已修脚本并复现杀掉
- verify：**EXIT=1**，唯一红点是 coverage 死臂；`format`/`lint`/`typecheck` 全绿，测试全绿
- 真 bug：0 条致命；1 条报文误导（`--workspace` 不存在 → 报 `path_outside_workspace`），3 条假设中 2 条证伪（行为正确）
- 待裁定：6 处死臂的删/留（§5，逐条给了"为什么不可达 + 建议怎么删"）

## G3.5 · R2 死臂清完后的收尾

### 1. 新增 `packages/cli/tests/resolve-hook.test.ts`（5 例，直调函数，不 spawn）

| 用例 | 覆盖路径 | 断言 |
|---|---|---|
| `直通 > should return the first successful resolution untouched` | `attempt` 的 try 成功臂 | 返回值 `toEqual` 同一 output；`nextResolve` 只被调 1 次、入参为 `(specifier, context)` |
| `直通 > should retry a bare specifier as-is so the real error surfaces` | `if (!specifier.startsWith(".")) return nextResolve(...)` | 第二次的错误（`no export`）原样抛出；最后一次调用 specifier 仍是 `hreader` |
| `补扩展名 > should retry with `.ts` …` | 第 2 次尝试成功 | 调用序列 `["./a", "./a.ts"]`，返回 `.ts` 结果 |
| `补扩展名 > should fall back to `/index.ts` …` | 第 3 次尝试成功 | 调用序列 `["./dir", "./dir.ts", "./dir/index.ts"]` |
| `三次均失败 > should rethrow the LAST error` | `asTs ?? nextResolve(...)` 的抛错臂 | `toThrow(last)`（同一对象，不是首次错误、不是拼装消息）；调用 3 次 |

`resolve-hook.ts` 覆盖率：**100 / 100 / 100 / 100**。

### 2. R2 行为变更导致的测试侧对齐（1 处）

- `tests/units-run-paths.test.ts`：`--workspace` 指向不存在目录，R2 改成 `UsageError("--workspace 不存在：<path>")`。
  用例改为断言 **EXIT_USAGE(2)** + 报文含 `--workspace 不存在：<ghost>` + **目录未被创建**。
  → 这正是我 §4-1 报告的"报文误导"问题的修复；旧断言（`EXIT_IO` + `逃出了 workspace`）是错的期望，已随实现更新，不是放宽。

### 3. 补例（为 100% 分支/函数）

| 文件 | 新例 | 覆盖 |
|---|---|---|
| `tests/units-output.test.ts` | `should serialize annotations and diagnostics with the frozen key order` | `annotationJson` / `diagnosticJson`（此前 `pendingAnnotations`/`diagnostics` 恒空 → 两个函数零调用） |
| `tests/units-commands.test.ts` | `should honour a valid --max-bytes (readNode with a limit)` | `readOnce` 的 `maxBytes !== undefined` 臂（此前只有 `invalid_max_bytes` 早退，真限流路径没跑到） |

### 4. `pnpm verify` 真实输出（EXIT=1，仅剩 1 条分支）

```
 Test Files  84 passed (84)
      Tests  1109 passed (1109)
 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
All files          |     100 |    99.94 |     100 |     100 |
 cli/src           |     100 |      100 |     100 |     100 |
 cli/src/commands  |     100 |    97.77 |     100 |     100 |
  read.ts          |     100 |    95.23 |     100 |     100 | 43
ERROR: Coverage for branches (95.23%) does not meet global threshold (100%) for packages/cli/src/commands/read.ts
```

### 5. 剩这 1 条：`packages/cli/src/commands/read.ts:43`（我够不到，需 src 侧一行）

```ts
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);   // ← 43 行的 String(error) 臂
```

- 谁调它：只有 `bothFailed(target, first, retry)` 的报文插值，`retry` 来自第二次 `readOnce(...)` 的 `catch (retry: unknown)`。
- 为什么不可达：`readOnce` → core `readNode` 的**全部** throw 都是 `HrError`（`packages/core/src/ops/readNode/{selector,truncate,index,resolve}.ts` 里 4 处 `throw new HrError`，无其它 throw），而 `HrError extends Error` → `retry instanceof Error` 恒真。
- 建议（任选，都是 src 侧 1 行）：
  1. 删防御：`bothFailed(target: string, first: HrError, retry: HrError)` + 直接 `retry.message`，删掉 `messageOf`（分支消失，语义不变）；
  2. 或保留防御但改成 `String(retry)`（`String()` 无分支，但会把 `Error` 渲染成 `Error: msg`，**不建议**）。
- 我不会为此 mock core（那会把"不可达"测成"假可达"）；也不动覆盖率阈值。

