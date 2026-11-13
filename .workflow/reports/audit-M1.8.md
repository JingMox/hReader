G2: FAIL — 2×P1 / 12×P2（0×P0）
# M1.8 审计（CLI `hr` + Universal Skill 壳）

审计对象（工作区未提交）：`packages/cli/src/**` 12 文件 798 行、`skills/hreader/**` 4 文件 329 行。
依据：`.workflow/cards/M1.8.md`（§1 命令面 / §2 退出码冻结表 / §3 输出契约 / §4 `--debug`）。
方法：**不用 `pnpm verify`/`pnpm test` 作判据**（测试员正在改 `tests/**`），全部用 `node packages/cli/src/main.ts …` 直接跑源码，脚本在 `/tmp/m18a/`，实测环境 node v24.15.0 / macOS（cwd 与 `getcwd()` 走 `/private` 真实路径）。
只读：未改任何源码、未 commit、未 touch `tests/**`。

---

## P1-1 `hr read <file> <nodeId>` 拒收裸 node id，与卡片和 `usage` 文本同时冲突

- `packages/cli/src/usage.ts:20`（`hr read <file> <nodeId|selector> [--json] [--max-bytes <n>]`）与 `packages/cli/src/args.ts:119`（缺参报错文案就是 `read 缺少 <nodeId|selector>`）都承诺接受 **nodeId**；
- 实现把第二个位置参数原样当 selector 交给 core（`packages/cli/src/args.ts:130` → `target`，`packages/cli/src/commands/read.ts:19-20` → `readNode(…, input.target)`），而 core 的 selector 语法只有 `#id` / `[data-hr-id="x"]` / `tag` / `tag > tag:nth-of-type(n)`；
- `patch` 则**接受**裸 id（`hr patch <file> <nodeId>` 实测正常），两个命令口径不一致。

复现（`/tmp/m18a/ws2/doc4.html` 的 `<h1 data-hr-id="s1-h1">`）：

```
$ node packages/cli/src/main.ts read ws2/doc4.html s1-h1 --json     # outline 打印出来的正是 "s1-h1"
{"ok":false,"code":"invalid_selector","message":"非法选择器（只支持 #id / [data-hr-id=\"x\"] / tag / tag > tag:nth-of-type(n)）：\"s1-h1\""}   exit=1

$ node packages/cli/src/main.ts read ws2/doc4.html '#s1-h1' --json        → ok, exit 0
$ node packages/cli/src/main.ts read ws2/doc4.html '[data-hr-id="s1-h1"]' --json → ok, exit 0
$ node packages/cli/src/main.ts read ws2/doc4.html h1 --json              → ok, exit 0
```

**为什么是 P1**：卡片 §1 冻结了这条命令面；更要命的是 CLI 自己的输出回灌不了自己的输入——`hr patch` 返回 `newIds: ["hr-ab844d71"]`（见 `/tmp/m18a/ws6/h.html`），把这个 id 喂给 `hr read` 直接 `invalid_selector`。`outline → read` 与 `patch → read` 两条被文档化的回路都断在同一个点上，Agent 必须手工拼 `[data-hr-id="…"]`。AC5a 的端到端用的是 selector 写法，所以测试绿而契约红。

---

## P1-2 `--workspace` 不做 realpath，符号链接工作区被判 `path_outside_workspace`

- `packages/cli/src/args.ts:78`：`workspace: resolve(cwd, raw.values.get("--workspace") ?? cwd)`（只做词法归一，**不 realpath**）；
- `packages/cli/src/args.ts:85-86`：`targetOf = relative(workspace, resolve(cwd, file))`，而 `cwd` 来自 `process.cwd()`，在 macOS 上返回**真实路径**（`/private/…`）；
- 当用户给的 workspace 走符号链接（`/tmp`、`/var/folders` 的 mktemp 目录、`~/work -> /Volumes/x`）时，两个基准不同，`relative()` 产出 `../../private/tmp/...`，core 判为逃逸。

复现（cwd `/tmp/m18a`，`process.cwd()` = `/private/tmp/m18a`）：

```
$ cd /tmp/m18a && node …/main.ts patch ws2/doc4.html s1-p2 --action delete --workspace /tmp/m18a --json
{"ok":false,"code":"path_outside_workspace","message":"`file` 逃出了 workspace：../../private/tmp/m18a/ws2/doc4.html"}   exit=3

$ node …/main.ts patch ws2/doc4.html s1-p2 --action delete --workspace /private/tmp/m18a --json
{"ok":true,"data":{...}}   exit=0
```

**为什么是 P1**：同一份文件、同一个 workspace，只因写法差一个符号链接就 100% 失败，且报的是**安全类**错误码（`path_outside_workspace`，退出码 3），用户会以为是自己越界了。CI/mktemp 目录天然踩；`core` 侧 `resolveTarget` 已经 realpath 过，CLI 在它前面先做了一次朴素的路径代数，属于"把本该由 core 判的事提前判错"。

---

## P2 清单（12 条，均带实测）

| # | 位置 | 问题 | 实测 |
|---|---|---|---|
| 1 | `packages/cli/src/exit-codes.ts:35` + `run.ts:88` | 未知 `HrErrorCode` → `EXIT_CODES[code]` 得 `undefined` → `process.exitCode = undefined` → **退出码 0（静默成功）** | `exitCodeOf("totally_new_code")` = `undefined`；探针 `/tmp/m18a/unk.mjs` 赋值后 shell 见 `exit=0` |
| 2 | `packages/cli/src/run.ts:58-66,88` | `--json` 下用法错误 stdout 形状依赖"解析失败时是否已看到 `--json`"：未知 flag → stdout 空；缺参 → stdout 有 JSON | `outline … --nope --json` → `stdout=∅ stderr=未知参数：--nope`；`patch … --action delete --json` → `stdout={"ok":false,"code":"usage",…}` |
| 3 | `packages/cli/src/output.ts:20` + `run.ts:64` | 用法错误发出 `code:"usage"`，不在冻结的 `HrErrorCode` 里；`jsonError(code: string)` 让任何字符串都能过 | 同上；`output.ts:20` 签名 `(code: string, …)` |
| 4 | `packages/cli/src/exit-codes.ts:26` vs `.workflow/cards/M1.8.md:45` | 卡片 §2 表写 `style_not_found`，实现用 `unknown_style`（core 词表也是 `unknown_style`） | 静态对照；`hr style … --visual nope` 返回 `unknown_style`，按卡片写断言的测试会红 |
| 5 | `packages/cli/src/commands/read.ts:16,21` | `ids` 字段 = `injected.injected`，即**全文档**注入的 id，可能完全不出现在返回的 `html` 里，且不落盘（内存态）——调用方拿到即失效 | 无 `<article data-hr-id>` 的文档：`read … [data-hr-id="s1-p"]` → `{"html":"<p …>…</p>","ids":["hr-b36edb79"]}`，html 内无此 id；给 `<article>` 补 id 后同样调用 → `ids: []` |
| 6 | `packages/core/src/io/paths.ts:65-92` vs `packages/cli/src/input.ts:22-31` | 同一 `not_a_file` 两种文案：core `realpath时路径不存在：…`（无空格、泄露内部步骤名），CLI `读取时路径不存在：…`；且一个打印传入的相对串（`ws2`），一个打印绝对路径 | `patch ws2/x.html …` → `不是普通文件：ws2`；`patch ws2/doc.html`（不存在）→ `realpath时路径不存在：/private/tmp/m18a/ws2/doc.html` |
| 7 | `.dependency-cruiser.cjs:48-52` | 规则 `cli-parse-and-commands-stay-pure` 只禁 `^(node:)?(process|fs)$`，**`node:child_process` / `node:os` 可穿**（`commands/*` 里 spawn 不会被拦） | 规则本体有效：伪造树 `/tmp/m18a/dc`（`packages/cli/src/args.ts` 引 `node:fs`）→ `error cli-parse-and-commands-stay-pure: packages/cli/src/args.ts → fs`，去掉 import → `no dependency violations` |
| 8 | `knip.json:5` | `skills/**` 是 `ignore`，不是"当已使用方法"——整个 skill 壳零静态检查（`hr.mjs` 无 export，不受影响，但引用路径/常量写错也无人报） | 静态 |
| 9 | `packages/cli/src/main.ts:52`、`skills/hreader/scripts/hr.mjs:52` | `code ?? 70` 是死分支：`run()` 恒返回 number；`spawn` 的 `exit` 回调在 `signal === null` 时 `code` 恒为 number | 静态（两处 `?? 70` 均无覆盖测试也不可能有） |
| 10 | `skills/hreader/scripts/hr.mjs:31` | 版本门只判 `major >= 22`，但 CLI 依赖 `module.registerHooks`（≥22.15，`packages/cli/src/main.ts:5`）与 `--experimental-strip-types`（≥22.6）→ 22.0–22.14 过门后运行期炸 | 静态；本机 24.15 正常 |
| 11 | `packages/cli/src/output.ts:24` | `dataOutline = JSON.stringify(outline)` 违反卡片 §3"键序固定、手写序列化、不依赖 `JSON.stringify(obj)` 隐式键序"（其余 `dataRead`/`dataPatch`/`dataLint` 都手写） | 静态 |
| 12 | `packages/cli/src/args.ts:162` | `--html-file` 的原串不归一到 cwd（与 `--workspace` 的归一不一致），实际靠 `fs` 自己按 cwd 解析兜底；且该路径不受 workspace 边界约束（可读任意文件作片段源） | `--html-file /tmp/m18a/f1.html` 生效；`--html-file ../outside.html` 生效 |

**未核实**：brief 中的「§5.2 十三处 `dead` 分支自查」在 `.workflow/reports/impl-M1.8.md` 里不存在（该报告只有 §9「待裁定 6 条」），我无法逐条复核那 13 条；本报告 P2-9 是我自己扫出的两处真死分支，其余分支未发现语义不可达项。

---

## 独立复算

### 退出码（`/tmp/m18a`，`--json`，逐个抓 node 自身退出码）

| 场景 | 命令 | exit | stdout |
|---|---|---|---|
| 成功 patch | `patch d s1-p2 --action insert_after --html '<p>x</p>'` | 0 | `{"ok":true,…}` |
| `node_not_found` | `patch d nope --action delete` | 1 | `{"ok":false,"code":"node_not_found",…}` |
| `invalid_selector` | `read d s1-h1` | 1 | `{"ok":false,"code":"invalid_selector",…}` |
| `forbidden_content` | `patch d s1-p2 --action replace --html '<script>alert(1)</script>'` | 1 | `{"ok":false,"code":"forbidden_content",…}` |
| `invalid_fragment` | `patch d … --html ''` | 1 | `{"ok":false,"code":"invalid_fragment",…}` |
| `path_outside_workspace` | `patch /etc/hosts s1 …` | 3 | `{"ok":false,"code":"path_outside_workspace",…}` |
| `not_a_file` | `patch ws2 s1 …`（目录） | 3 | `{"ok":false,"code":"not_a_file",…}` |
| `invalid_utf8` | `patch ws2/bad.html`（含 `\xff\xfe`） | 3 | `{"ok":false,"code":"invalid_utf8",…}` |
| 用法（未知 flag） | `outline d --nope --json` | 2 | **空**（见 P2-2） |
| 用法（缺参） | `patch d --action delete --json` | 2 | `{"ok":false,"code":"usage",…}` |
| `--help` | `--help` | 0 | 用法文本，stderr 空 |
| 未知 code | `exitCodeOf("totally_new_code")` | **0** | —（见 P2-1） |

与卡片 §2 冻结表**一致**（0/1/2/3 全部对上，`invalid_utf8` 落 3），唯一不符是未知 code 落到 0。

### JSON 字节（`style --tone`，prompt 含 49 个换行）

```
bytes=1568  lines=1  ESC字节=0  raw包含字面 "\n" = True  json.loads 后 prompt.count("\n")=49
```
单行、无缩进、恰好一个尾随 `\n`、换行被转义 ✓；`outline/read/patch/style` 五条路径 `cat -v` 扫 ESC → 0 行含 ANSI（含 `HR_DEBUG` 未设的默认路径）。

### 并发（锁是否真的互斥）

6 个进程同时 `patch insert_after s1-p2`（各自不同片段）→ `exit 0 ×6`、`changed:true ×6`，最终文件含 **6 个**插入（`i1 i2 i4 i3 i6 i5`），`.hreader/locks` 事后为空。
→ 锁在本机互斥成立，**未复现丢更新**。（我在 M1.5 复审时的"6 并发只剩 1 条"结论是探针参数写错导致的误报，此处更正。）

### `references/*.md` 片段可执行性

`skills/hreader/references/{components-spec,style-authoring}.md` + `SKILL.md` 抽出 **7 个** html 代码块（`/tmp/m18a/snips.json`），逐个 `hr patch --action replace --html-file` 到临时文档：

```
components-spec.md#0..#6   exit=0 ×7   newIds=[…]   outline 重解析 exit=0 ×7
```
7/7 可直接吃下 ✓（`replace` 会消耗锚点 `s1-p`，所以第二跳必须用 `newIds[0]` 或 `[data-hr-id]` 再定位——这与 P1-1 是同一个坑）。

### 文档与代码一致性

- 组件 id 三处完全相同（各 7 个，集合逐项相等）：`packages/core/src/html/constants.ts:8-16`、`styles/atelier-editorial/theme.css`、`skills/hreader/references/components-spec.md`；
- `SKILL.md` 85 行 ≤ 200 ✓；五原语工作流与 `usage.ts` 子命令名一致 ✓；
- `packages/cli/src/args.ts` 只 import `node:path` + 类型 + 本地模块，**无 `process`/`env`/`cwd()`**（`cwd` 由 `main.ts:46` 下传）✓；
- `--workspace` 对 `outline`/`read` 实测**被忽略不报错**（传 `/nope/does-not-exist` 仍成功）✓，符合卡片 §1 末条。

### `hr.mjs` 进程边界

| 场景 | 结果 |
|---|---|
| 路径含空格 + 中文（`ws3/子 目录/文 档.html`） | `exit=0`，JSON 正确 |
| 退出码透传（`path_outside_workspace`） | `exit=3` |
| 退出码透传（用法错误） | `exit=2` |
| 无参数 | `exit=2`，用法进 **stdout**（443 字节） |
| `--html-stdin` 且 stdin 关闭 | `exit=2`，`--html-stdin 读到的内容为空` 进 stderr |
| `--html-stdin` 有内容 | `exit=0`，写入成功 |
| 子进程警告噪声 | 无 `ExperimentalWarning`/`DeprecationWarning` |
| 读环境 | 只读 `process.versions` / `execPath`，不读 env ✓（与 §8.2 裁定 #2 一致） |

ACP: M1.8 审 16 文件 1127 行（CLI 798 + skill 329），自跑 6 组探针（退出码 12 行矩阵、JSON 字节、6 进程并发、7 段片段、depcruise 伪造树、hr.mjs 7 场景）；**G2: FAIL — 2×P1 / 12×P2**。P1 两条：①`hr read` 拒收裸 nodeId（`packages/cli/src/args.ts:130` + `usage.ts:20` 契约冲突，且 `patch` 返回的 `newIds` 无法回灌 `read`）；②`--workspace` 未 realpath（`packages/cli/src/args.ts:78,85-86`），符号链接工作区被误判 `path_outside_workspace` 退出 3。其余为 12 条 P2（未知 code 退出 0、`usage` 码不在冻结集、`outline` 用 `JSON.stringify`、`read.ids` 含不可用 id、错误文案双口径、depcruise 漏 `child_process`、knip 忽略 skills、两处死分支、Node 版本门过宽等）。卡片 §5.2「13 处 dead 分支」在 impl 报告中不存在，无法逐条复核。

---

# G2-R（M1.8 返工复审：R1→R3）

**G2-R: FAIL** — P1 `2/2 CLOSED`；P2 `8 CLOSED / 1 CLOSED-with-note / 3 OPEN`；**返工引入新 P1 ×1**（+ 新 P2 ×5）。

判定口径：**不跑 `pnpm verify`**（测试员正在改 `tests/**`）。全部结论由我自己直连源码复现：
`hr` = `node packages/cli/src/main.ts`，`hr.mjs` = `node skills/hreader/scripts/hr.mjs`，
夹具 `/tmp/m18r/ws/*.html`，脚本 `/tmp/m18r/{raw,cmp,unk}.mjs`。测试红一律不计入。

## P1 复核

### P1-1 `read` 裸 node id —— **CLOSED**

| 输入 | 实测 | 判定 |
|---|---|---|
| `hr outline ws/doc.html` | `- s1-h1  标题  (2w)` | 提供 id |
| `hr read ws/doc.html s1-h1` | `exit=0` / `<h1 data-hr-id="s1-h1">标题</h1>` | ✅ 裸 id 命中 |
| `hr read ws/doc.html h1` | `exit=0` / 同一 `<h1 …>` | ✅ 标签优先（不是把 `h1` 当 id） |
| `hr read ws/doc.html 'a > > b'` | `exit=1`；`读取目标 "a > > b" 失败：按选择器 → 非法选择器（标签名应以 ASCII 字母开头）…；按 node id → …` | ✅ 两种尝试都在 |
| `hr read ws/doc.html nosuchid --json` | `{"ok":false,"code":"node_not_found",…}` | ✅ |
| `hr read ws/doc.html '#a' --json` | `code:"node_not_found"` | ✅ 语义正确（`#a` 语法合法、只是没命中，**不该**报 `invalid_selector`） |
| `patch → read` 回路 | `hr patch … --json` 的 `newIds:["hr-19ab138c"]` 直接喂 `hr read` → `exit=0` | ✅ 闭环 |

**子项 OPEN（降级 P2-N1）**：brief 断言的 `'a > > b' → invalid_selector` **不成立**——实测 `code:"node_not_found"`。
原因 `packages/cli/src/commands/read.ts:47-49`：`codeOf` 只看 `["\\\n\r]`，把"选择器语法错"一律归成 `node_not_found`
（exit 仍是 1，脚本按退出码无感；按 `code` 判定会误分类）。

**子项 OPEN（降级 P2-N2）**：`read.ts:50-55` 的报文把内部细节写进用户文本——
`按 node id → HrError: 选择器 "[data-hr-id=\"nosuchid\"]" 没有匹配到任何节点`：`HrError: ` 前缀与合成的内部选择器都是实现细节。

### P1-2 `--workspace` realpath —— **CLOSED**（1 子项 OPEN）

| 场景 | 命令 | 实测 | 判定 |
|---|---|---|---|
| 符号链接 workspace | `patch wslink/doc.html s1-p1 --action replace --html … --workspace /tmp/m18r/wslink` | `exit=0`，`path:/private/tmp/m18r/ws/doc.html` | ✅ 不再误报 |
| 真越界 | `patch ../ws/doc.html … --workspace /tmp/m18r/ws` | `exit=3`，`path_outside_workspace`（`…逃出了 workspace：../../ws/doc.html`） | ✅ |
| workspace 不存在 | `--workspace /tmp/m18r/nope` | `exit=2`，`--workspace 不存在：/tmp/m18r/nope`（**不是** `path_outside_workspace`） | ✅ 按用法错误 |
| 目标是符号链接文件 | `patch d2link.html … --workspace /tmp/m18r` | `exit=0`，落到真实文件 `/private/tmp/m18r/ws/d2.html` | ✅ |
| 目标不存在、父目录存在 | `patch out/new.html article --action append --html …  --workspace /tmp/m18r/out` | `exit=3`，`not_a_file`：`realpath时路径不存在：/private/tmp/m18r/out/new.html` | ❌ **OPEN** |

子项 OPEN（P2-N3）：`packages/cli/src/run.ts:44` 注释写「目标可能尚不存在（**patch 允许新建**）」，但 core 的 `patchFile` 对缺失文件一律 `not_a_file`；
即 `realpathThroughAncestors` 的分支只服务于"报错报文用绝对路径"，与注释声称的能力不符。卡片 M1.8 全文没有"新建文件"条款（`grep -n "新文件\|--out" .workflow/cards/M1.8.md` 无命中），故按注释与实现不一致计，不计功能缺失。

## P2 逐条（12 条）

| # | 位置 | 状态 | 我实测到的证据 |
|---|---|---|---|
| 1 | `exit-codes.ts:36` / `run.ts:107` | **CLOSED**（保留风险注记） | 表 20 项 vs `packages/core/src/hr-error.ts:4-24` 的 20 个 code 逐字相等，`satisfies` 已兜住漏项；表外 code 仍不被兜底：`/tmp/m18r/unk.mjs` → `known: 3 / foreign: undefined`，`process.exitCode=undefined` 后 `shell exit=0`。**不崩**（无 `TypeError`），故未升级为 P0；但它比旧兜底更糟（70 → 静默 0），**仅在 core 加码而 CLI 表未跟随时才会暴露**，同仓同版本不可达 → 判 CLOSED |
| 2 | `run.ts:107-108` | **CLOSED** | 两种用法错误现在都不发 JSON：`outline ws/doc.html --nope --json` → `stdout=∅`；`patch ws/doc.html s1-p1 --json`（缺 `--action`）→ `stdout=∅`，均 `exit=2` 且 stderr 有报文+usage。与 `run.ts:2` 的注释口径一致 |
| 3 | `output.ts:28` | **CLOSED** | `jsonError(code: HrErrorCode, …)`（不再是 `string`）；`code:"usage"` 这条路径已随 P2-2 一起消失（用法错误不再产生 JSON） |
| 4 | `exit-codes.ts:26` vs `.workflow/cards/M1.8.md:45` | **OPEN** | 卡片仍是 `style_not_found`，实现与 core 词表都是 `unknown_style`（`hr style ws/doc.html --visual nope` → `code:"unknown_style"`，`exit=1`）。`impl-M1.8.md:382-384` 选的是"改卡片"（方案 A），但 `git status` 里 `.workflow/cards/M1.8.md` **未被修改** → 漂移仍在，需一眼卡片编辑 |
| 5 | `commands/read.ts:22-25` | **CLOSED** | `idsOf(html)` 只扫返回的 html：无 id 文档 `read … p` → `{"html":"<p data-hr-id=\"hr-84d9a167\">无id段一</p>","ids":["hr-84d9a167"]}`；有显式 id 文档 → `ids:["hr-19ab138c"]`，不再出现"文档里其它节点的 id" |
| 6 | `packages/core/src/io/paths.ts` vs `packages/cli/src/input.ts:27` | **OPEN** | 同一 `not_a_file` 仍是两套文案：CLI `读取时路径不存在：/private/tmp/m18r/inside.html`；core `realpath时路径不存在：/private/tmp/m18r/out/new.html`。`impl-M1.8.md:387` 标为"待裁定"，未改 |
| 7 | `.dependency-cruiser.cjs:48-56` | **CLOSED** | `to.path` 已扩为 `^(node:)?(process\|fs\|fs/promises\|child_process\|os)$`；`node -e 'console.log(/^(node:)?(…)$/.test("node:child_process"))'` → `true`；规则本体有效性已在首轮用伪造树实测（`args.ts → fs` 报 `error cli-parse-and-commands-stay-pure`） |
| 8 | `knip.json` | **CLOSED** | `skills/**` 不再进 `ignore`：根 `entry` 加 `skills/hreader/scripts/hr.mjs`，并新增 `workspaces["."] = { entry/project: skills/** }`；`ignore` 只剩 `docs/**` |
| 9 | `main.ts` / `hr.mjs:65-72` | **CLOSED** | `main.ts` 尾部只剩 `process.exitCode = code;`（`?? 70` 已删）；`hr.mjs` 用显式 `if (code === null) { fail(…信号…, 70); return; }`，无死分支 |
| 10 | `hr.mjs:28` | **CLOSED** | 版本门 `major < 22 \|\| (major === 22 && minor < 15)`，与 `main.ts:5` 的 `registerHooks` 下限对齐 |
| 11 | `output.ts:49-53` | **CLOSED**（但见 P1-N1） | `dataOutline` 改为手写，键序 `nodes→pendingAnnotations→wordCount→diagnostics`，与 `packages/core/src/ops/outline/constants.ts:60-65` 声明序逐字一致；输出 1 行、`endsWith("\n") && !endsWith("\n\n")` = true、`JSON.parse` 通过 |
| 12 | `args.ts:148-151` | **OPEN** | `--html-file` 仍按 **cwd** 解析且不受 workspace 约束：cwd=`/tmp/m18r`、`--workspace /tmp/m18r/ws` 时 `--html-file f1.html`（workspace **外**）→ `exit=0` 并注入；`--html-file inside.html`（workspace **内**）→ `exit=3 读取时路径不存在：/private/tmp/m18r/inside.html`。内外判定反了，且 fail 的是"更该允许"的那个 |

## 返工引入的新缺陷

### P1-N1 `outline --json` 丢掉 `diagnostics[].path`，且注释反了事实

- 位置：`packages/cli/src/output.ts:16-21`（结构类型）、`:45-47`（`diagnosticJson`）；对照组 `packages/core/src/index.ts:61`、`packages/core/src/ops/outline/diagnostics.ts:44-45`、`packages/core/src/html/parse.ts:123-135`。
- 复现：`/tmp/m18r/cmp.mjs`（直连 core）对比 `hr outline ws/comp.html --json`，夹具含 `<div data-hr-component="bogus">`。
- 实测（同一文档，同一诊断）：
  - core：`{"code":"invalid_component","severity":"warning","message":"<div data-hr-component=\"bogus\"> 不在白名单内，属性保留待人工修复","path":"html[1]>body[1]>article[0]>section[0]>div[1]"}`
  - CLI ：`{"code":"invalid_component","severity":"warning","message":"<div data-hr-component=\"bogus\"> 不在白名单内，属性保留待人工修复"}` ← **`path` 消失**
- 为什么是 P1：
  1. 卡片 §3 冻结的形状是「`outline` → core 的 `Outline` **原样**」，`Diagnostic.path` 是该类型的字段（`packages/core/src/html/constants.ts:182-183` 明确写「节点定位串（`article[0]>section[1]>p[2]`）」）。掉字段＝违反冻结契约。
  2. 信息量掉在**最需要它**的地方：`invalid_component` 的 message 只说 `<div …bogus…>`，同一文档里多个 `bogus` 时无 `path` 无法定位。
  3. `output.ts:16` 的注释是**反向自证**：「`Diagnostic` 不在 core 的公开面（`src/index.ts` 没有导出）」——实测 `grep -n "Diagnostic" packages/core/src/index.ts` → `41: StyleDiagnostic, // 61: Diagnostic, // 62: DiagnosticCode,`。类型是公开的，`import type { Diagnostic }` 直接可用。
  4. 这是**返工引入的回归**：`git diff packages/cli/src/output.ts` 显示 `dataOutline` 原为 `JSON.stringify(outline)`（`path` 本来在），改手写序列化后漏抄该字段。
- 建议修法（≤5 行）：`import type { Diagnostic }` 替换 `DiagnosticShape`，`diagnosticJson` 末尾按 `path === undefined ? "" : `,"path":${quote(diagnostic.path)}`` 追加，删掉那句反向注释。

### P2-N1 `read` 把选择器语法错误类成 `node_not_found`
`packages/cli/src/commands/read.ts:47-49`：`BREAKS_ATTRIBUTE_QUOTING` 只覆盖 `"`/`\`/换行。
`hr read ws/doc.html 'a > > b' --json` → `code:"node_not_found"`（首次失败明明是 `invalid_selector`）。exit 仍 1。
建议：`codeOf` 传入首次失败的 `first.code`——`first.code === "invalid_selector" && 重试也失败` 就给 `invalid_selector`。

### P2-N2 `read` 双失败报文泄露内部构造
`packages/cli/src/commands/read.ts:50-55`：`String(retry)` 产出 `HrError: 选择器 "[data-hr-id=\"…\"]" 没有匹配到任何节点`。
用户看到的第二个尝试是**我们合成**的选择器，而不是"按 node id」。建议：`按 node id → 未找到 data-hr-id="${target}" 的元素`（不打印 `HrError:` 前缀、不打印合成选择器）。

### P2-N3 `run.ts:44` 注释与 core 行为相反
见 P1-2 子项：注释「patch 允许新建」vs 实测 `not_a_file`。

### P2-N4 `allowImportingTsExtensions` 是仓级放宽，注释里的约定无人校验
`git diff tsconfig.base.json`：新增 `"allowImportingTsExtensions": true` + 3 行注释（「core 仍一律 `.js`」）。
`noEmit: true` 已就位（该选项的硬前提），但**没有任何 lint 规则**约束 `.js` 约定：`eslint.config.mjs:66-74` 的 `no-restricted-imports` 只禁 `@hreader/*/src/*` 深层导入，`import/extensions` 未启用。
即注释承诺的边界靠自觉。建议：给 `packages/core/**` 加一条 `no-restricted-imports` 的 `group: ["**/*.ts"]`（或 `import/extensions` 白名单）。

### P2-N5 `resolve-hook` 吞掉第一次解析错误，掩盖真实报文
`packages/cli/src/resolve-hook.ts:9-20`：`attempt()` 捕获一切异常 → 对相对说明符会依次尝试 `x.ts`、`x/index.ts`，最终抛出的是**最后一个**尝试的错误。
对"相对模块真不存在"这类错误，用户看到的是 `Cannot find module '…/x/index.ts'` 而不是原始 `…/x`。
建议：仅当错误码是 `ERR_MODULE_NOT_FOUND`/`ERR_UNSUPPORTED_DIR_IMPORT` 时降级，其它一律原样抛。

## 独立复算

- 退出码（`hr.mjs` 真子进程，退出码透传）：`--help` → 0；`outline` 正常 → 0；`read 'a > > b'` → 1；`outline nope.html` → 3；`outline`（缺参）→ 2；空 argv → 2（打印 `hr.mjs` 自带 usage，不进子进程）。signal 分支（`code === null` → 70）无法在不注入的情况下触发，静态确认 `hr.mjs:65-72` 已单列。
- JSON 字节：`style --tone atelier-editorial --json` → 726 字节、1 行、`endsWith("\n") && !endsWith("\n\n")` = true、`body 内 \n 计数 = 0`（prompt 里的 644 字符换行全部转义为 `\n`）；`JSON.parse` 后 `prompt.includes("\n")` = true（语义未损）。
- `outline --json`：1 行、键序 = core `Outline` 声明序、`od -c` 尾部 `}` `}` `\n` 且无尾随空格。
- `--workspace` 无关命令：`read ws/noid.html p --workspace /tmp/m18r/out` → `exit=0`（按卡片 §1"只读不校验"忽略，✅ 未报错）。
- `hr --help` / `hr outline` / `hr read` 走 `resolve-hook` 抽取后的真子进程全部正常（`hr.mjs` 5 条命令矩阵无一条因 hook 失效而崩）。

## §5 三处改动的确认（无夹带）

1. `packages/core/tests/io/unit-helpers.test.ts`：`git diff` 只有一条 `expect(...).toBe("invalid_utf8")` 被 prettier 折成三行（`--numstat` 3/1，`-w` 后仍 3/1 属换行重排），**无断言语义改动**。
2. `tsconfig.base.json`：仅新增 `allowImportingTsExtensions: true` + 3 行注释；无 `strict`/`noUncheckedIndexedAccess` 等阈值改动（`git diff` 全文已核）。约定无人校验 → 见 P2-N4。
3. `packages/cli/src/workspace-paths.ts` 已删：`grep -rn "workspace-paths" --include=*.ts packages/` → 0 命中；等价逻辑在 `packages/cli/src/run.ts:46-72`（`withinWorkspace` / `realpathThroughAncestors`），行为已由 P1-2 五个场景实测。

ACP: 复审 2×P1（**2 CLOSED**）+ 12×P2（**8 CLOSED** / 1 CLOSED-with-note / **3 OPEN**：卡片 `style_not_found` 词表、core `not_a_file` 双文案、`--html-file` 不受 workspace 约束）；不跑 `pnpm verify`，全部证据来自直连 `src` 的 5 组复现（`/tmp/m18r/{unk,raw,cmp}.mjs` + `hr`/`hr.mjs` 命令矩阵）；**返工引入的新缺陷：P1 ×1**（`output.ts` 手写序列化丢掉 `diagnostics[].path`，且附了一句"`Diagnostic` 未导出"的反向注释）+ P2 ×5（read 码分类、read 报文泄露内部合成选择器、`run.ts:44` 注释与 core 相反、`allowImportingTsExtensions` 约定无人校验、`resolve-hook` 吞首错）。只读：未 commit，未改 `src/**`、`tests/**`、三个配置文件。
