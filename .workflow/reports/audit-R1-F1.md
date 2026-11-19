本次会话没有写文件工具（可用工具只有 read / grep / find / ls / watchdog_diff / 上下文管理），因此下面的**完整报告即是 `.workflow/reports/audit-R1-F1.md` 的内容**——请协调者原样写入该路径。审计全程只读，未改任何代码/测试，未 commit。

---

# Audit · 巡回测试 R1-F1 / R1-F2（`src/**` + `docs/**`）

- 审计对象：工作树 F1+F2 改动（29 改 + 新增 `document-normalize.ts`、`normalize.ts`、`normalizeFile.ts`、`print-html.ts`、`print-css.ts`、`atomic.ts`、`errors.ts`、`listen.ts`、`daemon-guard.ts` 等）
- 需求侧：`.workflow/reports/sweep-R1.md` B-01…B-28；契约侧：`.workflow/cards/M4.8.md` C1/C2/C3/C4 + AC-1…AC-6
- 限制：本会话无 shell，**所有证据为静态代码 + 实现报告所附命令输出**。凡需实跑确认的，已在条目里写明"待验证命令"。

## 判决：CHANGES-NEEDED

- P0：**0** 条
- P1：**2** 条（P1-1 阻断 F1 契约 C1；P1-2 阻断 Linux 平台）
- P2：**6** 条

理由：F1 的 13 项声称修复里 11 项经代码核验确实消掉了用户可见症状（且改法是对的：`injectNodeIds` 内容寻址、EADDRINUSE 之外加 `/healthz` pid 印证、registry 查 tone id）；但 `normalize --write` 的 JSON 输出**违反 M4.8 C1 明文**（`needsNormalize` 写回后仍为 `true`），且 `ipv6Occupied` 的探测方式在 Linux（CI 矩阵有 ubuntu）上会对本机自己的 IPv4 监听误报。两者都在测试编写员照着契约写用例时会直接炸。

---

## P1-1 `normalize --write` 之后 `needsNormalize` 仍为 `true`，违反 M4.8 C1

- 位置：`packages/core/src/ops/normalizeFile.ts:59`、`:61-67`
- 代码：`const needsNormalize = normalized.injected > 0;` → `result = { needsNormalize, ... , changed: input.write && needsNormalize, html: input.write ? injected.html : html }`。写回后 `html` 换成了注入结果，但 `needsNormalize` 是用**归一化前**的 `injected` 算的，**从未重算**。
- 契约冲突：`.workflow/cards/M4.8.md:33`「带 `--write`：原地写回；**写回后 `needsNormalize === false`**」；`:60` AC-1。`packages/cli/src/commands/normalize.ts` 的 `--help`/usage 也把 `needsNormalize` 描述为"结果里是否还需要 normalize"。
- 用户可见后果：`hr normalize a.html --write --json` → `{"ok":true,"data":{"needsNormalize":true,"injected":3,...}}`。任何"循环 normalize 直到 `needsNormalize===false`"的脚本永不收敛；测试编写员按 C1 写 `expect(json.data.needsNormalize).toBe(false)` 必红。
- 最小修法（2 行，不重排版）：
  ```ts
  html: input.write ? (changed ? injected.html : html) : html,
  needsNormalize: changed ? false : needsNormalize,
  ```
  即"写回成功后 `needsNormalize` 必须为 false"。
- 待验证命令（协调者）：
  ```
  cd /tmp && D=$(mktemp -d) && printf '<article><h1>A</h1><p>x</p></article>' > $D/a.html
  node --experimental-strip-types packages/cli/src/main.ts normalize $D/a.html --write --json --workspace $D
  ```
  期望 `needsNormalize:false`；当前会得到 `true`。

> 注：F1 报告 §B-01 证据里恰好只看了 `injected`，没看 `needsNormalize`，所以这条漏网了。

## P1-2 `ipv6Occupied` 双栈探测在本机 IPv4 监听之后运行 → Linux 上每次 `hr serve` 假警告

- 位置：`packages/core/src/server/listen.ts:73-90`（`probe.listen({ port, host: IPV6 }, ...)`，无 `ipv6Only`）；调用点 `packages/core/src/server/server.ts:194-201`（先 `listen(options.host)` 绑 IPv4，**随后**才 `await ipv6Occupied(port)` 并打 stderr 提示）。
- 机制：libuv 对 `AF_INET6` 默认把 `IPV6_V6ONLY` 置 0（双栈）。绑成功 `127.0.0.1:P` 之后再绑 `::`:P，在 `bindv6only=0` 的 Linux 上会 `EADDRINUSE`（与自己的 v4 socket 冲突）→ `ipv6Occupied` 返回 `true` → 每次正常 `hr serve` 都打一行"注意：`::` 上已有监听…"。
- macOS 上未观察到（macOS 默认 `v6only=1`，与 F1 报告 B-17 证据无该行一致），因此**实现者是"本机没炸"**；但 `pnpm verify`/CI 若跑 ubuntu，任何断言 stderr 内容的 serve 用例都会红，且是纯噪音。
- 最小修法（1 处）：`probe.listen({ port, host: IPV6, ipv6Only: true }, ...)`。语义也更对——我们要问的是"有没有人单独占了 v6"，不是"v6 通路是否可用"。
- 待验证命令（Linux / CI）：
  ```
  cd /tmp && hr serve demo-print.html --port 8897 2>err.txt; cat err.txt
  ```
  此时 `err.txt` 不应含 `::` 提示（无人监听 v6），当前 Linux 下会有。
- 若 Linux/Windows 实跑证明不触发，本项降级 P2。

---

## B-xx 逐条核验表

判据 = 用户在终端**看到/看不到**什么；证据 = `file:line` + 实现报告所附实跑输出（`impl-R1-F1.md`），标注 `[需实跑]` 的由协调者复核。

| B | 严重度 | 判定 | 判据（用户可见差异） | 证据 |
|---|---|---|---|---|
| B-01 outline 静默空树 | P1 | **已修** | 无 id 文档从"空输出 + EXIT=0"变为 `needs_normalize`（EXIT=2）+ 可粘贴的 `hr normalize … --write`；有 id 文档输出零变化 | `packages/cli/src/run.ts:227-234` 走 `withinWorkspace`→`assertNormalized`（`document-normalize.ts:9-40`）；`derive.ts:80-88` 改 `needs_normalize`；M4.8:55 明定退出码 2；impl §B-01 实跑 `dump.json` 附 JSON |
| B-02 serve 报内部函数名 | P0 | **已修** | `invalid_document`+"输入需先经 `injectNodeIds`"→ `needs_normalize`+"文档缺少 data-hr-id，先跑 `hr normalize demo.html --write`"，EXIT 由 1→2 | `serve.ts:34-40` catch→`withNormalizeAdvice`+`modelOf`；`derive.ts:84-88`；impl §B-02 输出原文。⚠ 仍是"两步走"（非自动补 id），但台账期望写的是「自动补 id **/ 给出可执行的一步**」，后者满足 |
| B-03 read 的 id 喂回 patch 失败 | P1 | **已修** | 先 `normalize --write` 落盘后再 `read`→`patch` 同 id 成功；`read` 也会拒绝未归一化文档并指路 | 归一路径 = 运行期路径（同一 `injectNodeIds`，`ids.ts:1-28` 家族插槽 + 同标签同文本同序号内容摘要），故落盘 id 与派生 id 同源；impl §B-03 全链路 EXIT=0；三处场景 p1→3583 / p2→同一 id 一致 |
| B-04 patch 不打印 `newIds` | P1 | **已修** | 文本模式多出 `+N ids: …`（≤5 个加省略号），`--json` 原有字段不变 | `output.ts:64-76` `idsLine`；`:171-190` `humanPatch` 首行追加 `\n+…`（`appendString` 小工具）；impl §B-04 实跑 |
| B-05 替换后 `insert_after` 找不到锚点 | P2 | **已修（设计层面）** | 新根 id 现在**被打印**（B-04），用户能拿到替换后的新 id 再插；替换本身不改 sibling id | 同 B-04；`docs/05-feature-cards.md:440-441` 补了"替换会重算子树 id"的说明 |
| B-15 绝对路径 serve 报内部相对路径 | P2 | **部分（按台账"或"分支已达标）** | 错误文案从 `../../..` 内部相对路径改为「文档在 workspace 之外…换工作目录或用 `--workspace`」；**能力未变**（仍不能 serve 任意绝对路径） | `packages/core/src/paths.ts` 仅改 `withinWorkspace` 的 message；`run.ts:227-234` 仍 `withinWorkspace`→`resolveTarget` 拒绝外部·绝对路径。impl §B-15 用了 `cd /tmp` 才成功 → **报告正文"按文档所在目录作为 workspace 起服务"的说法不实**（见 P2-1） |
| B-16 `--visual` 指向 tone 报 `unknown_style` | P2 | **已修（F2）** | tone id 现在走 `invalid_input`+"该 id 是 tone：… 用 `--tone`"，不再谎报 `unknown_style`；未知 id 仍 `unknown_style`；visual 仍走注册表 | `packages/cli/src/commands/style.ts:40-70` `assertVisualId`；`packages/core/src/styles/validate.ts:33-45` `hasVisualTheme`（查 `BUILTIN_STYLES`+`discoverStyles`）；新增 `isToneId`。**无硬编码 id**，未知仍 `unknown_style` ✔（任务关注点 1 达标） |
| B-14 daemon 已运行 / 端口占用 | P2 | **已修（区分加强）** | 我们的 daemon 活着 → `daemon_already_running`（EXIT 1，并指路 `hr daemon stop/status`）；别人占端口 → `port_in_use`（EXIT 2，"被**别的进程**占用"） | `daemon-guard.ts:18-46`：`isProcessAlive(pid)`→`portOpen`→`ownerOfPort`（`GET /healthz` 比对 pid，500ms 超时）→ 三态，命中自己才 `daemon_already_running`；`listen.ts:28-50`；`server.ts:190-196` `bindErrorOf`→`port_in_use` |
| B-17 `hr serve` 无入口地址 | — | **未修（不在 F1/F2 范围）** | 需 C2/C3，卡里写"并入 B-06 的修法" | 见"B-06 仍打开" |
| B-24 重复 export 叠加 secnum | P2 | **已修** | 有 secnum 的打印稿再 export 不再变 `1 1`；`--dry-run` 与普通导出共用同一纯函数 | `print-html.ts:200-210` `withoutLeadingSecnum`（首子节点是原 secnum 则剥离后重编号）；`exportPrint.ts:92-110` 同源 |
| B-25 只读文件 patch/undo 报错无提示 | P1 | **已修** | 444 文件 → `io_failure` + "文件或目录是只读的……`chmod u+w`"；文件不再被写；原文件 mode 保留 | `atomic.ts:101-131` `assertWritable`（owner write 位）+ 原子写；`atomic.ts:140-152` `targetModeOf`+`applyMode`（写后回填 mode）；`io/errors.ts:17-25` `permissionHintOf`（EACCES/EPERM 追加）；impl §B-25/§7 实跑（444 → 提示；600/644 → 保留）；`docs/05`「`hr undo` 必用只读路径」说明 |
| B-26 权限导致 EPERM 无法定位 | P1 | **已修** | 同 B-25（undo 的 `locks/` 建目录失败也带该提示） | 同上；`lockDepsFor` 等均经 `ioFailure` |
| B-27 read 泄漏 `HrError:` 前缀 | P2 | **已修** | stderr 不再出现 `HrError: `；`assertIsDocument` 让空文档出 `no_article` 而非 `no_target` | `packages/cli/src/io-report.ts` 新增 `messageOf`；`derive.ts:74-78` `assertIsDocument` |
| B-28 只监听 `::` 的服务被静默失败 | P2 | **部分** | 现在能起：绑 `127.0.0.1` + 一行 `::` 占用提示；但该提示在 Linux 上**会误报**（P1-2），且 v6-only 客户端仍连不上（只提示，不双绑） | `server.ts:198-201`；`listen.ts:73-90`。功能目的（"别再静默空转"）达成，噪音问题见 P1-2 |
| B-29 `read --json` 缺文档 meta | P2 | **已修** | `--json` 新增 `title`/`lang`/`stylePath`（只增不减，键序稳定） | `output.ts:213-226` `dataRead`（`{...dataRead(pre), title, lang, stylePath}`）；impl §B-29 |

**F2 段（`replacedIds`）**：见下文"新伤/回归面"，行为正确性抽检结论：

| 场景 | 结果 | 证据 |
|---|---|---|
| 片段是纯文本（非元素） | 抛 `invalid_fragment`，不可能进 `replacedIdsOf` | `slice/fragment.ts` `singleElementOf` 要求"恰好一个**元素**根" |
| 片段多个根 | 同上 `invalid_fragment`（唯一根断言先于注入） | 同上 |
| 原目标是 `<article>` 根 | `replacedIdsOf` 返回 `[]`（`located.isRoot` 早退）→ 打印 `reserved` 分支文案，不谎报 | `patchNode/apply.ts:160-168` |
| 目标是 `<body>` | `locateById` 在 `derive.ts:80-88` 已把 `body` 标 `invalid_input`（`requestSchema`），不可达 | `derive.ts:80-88`；`apply.ts:102-137` `isBlockLevel` |
| 动作 `append`/`insert_after`/`insert_before`/`delete` | `[]`（仅 `replace` 且非根才有对） | `apply.ts:160-168` |
| 最坏：新文本与原文本相同 | `sameContent` 早退返回 `undefined`，不生成假对 | `apply.ts:170-185` 前段 |

四种最坏情况均未发现错误推导。

---

## 新伤（F1/F2 自引入）

**P1-1、P1-2** 见上（属 F1/F2 新引入：`normalizeFile` 新文件；`ipv6Occupied` 新增）。

### P2-1 F1 报告对 B-15 的结论夸大，若据此结卡会误判
`impl-R1-F1.md` §B-15 写「`hr serve /tmp/x/doc.html` 现在按'文档所在目录'作为 workspace 起服务」。代码里 `run.ts:227-234` 仍无条件 `withinWorkspace` → `resolveTarget` 拒绝 workspace 外的路径（`paths.ts` 只改了 message）。报告自己的证据是"先 `cd /tmp` 再跑"，恰好绕开了这条限制。最小修正：改报告措辞为"错误文案可操作，能力未变（需 `--workspace`）"，或真做"把 `--workspace` 默认成文档所在目录"（后者是行为变更，需另立卡）。

### P2-2 四入口 `needs_normalize` 不一致（码/退出码一致，**判据不一致**）
- `outline`/`read`：`document-normalize.ts` `assertNormalized` —— **任一节点**缺 id 即 `needs_normalize`。
- `patch`：不在入口判，靠 `derive.ts:80-88` 根 id 为空 + `locateById` 的"**一个 id 都没有**才报 needs_normalize"（`apply.ts:75-86`）。
- `export`：完全不判，`exportPrint.ts:93` 直接 `injectNodeIds(...)` 在内存补 id 后打印。
最小复现：`<article data-hr-id="hr-ok"><h1>A</h1><p>x</p></article>`（根有 id，子节点无）→ `hr outline` 退出 2 `needs_normalize`；`hr export` 退出 0 打印 18 个 id；`hr patch hr-ok …` 成功。用户观感："outline 说缺 id，export 却正常"。按任务要求这是**契约不一致**，需协调者裁：要么三入口统一为"根 id 空才拒"，要么 export 也拒。建议后者（export 也要先 normalize），因为"文档无 id → 一切模型操作都要先 normalize"更好讲。（码名与退出码本身四个入口一致：`needs_normalize`→2 ✔）

### P2-3 `--json` 失败时 JSON 仍可能被 stderr 再写一遍（B-14 的"坏事"未根除）
`packages/cli/src/run.ts` `reportFailure`：`writeJson(io.stdout, JSON.stringify(envelope) + "\n")` **且** `io.stderr.write(text + "\n")`，无条件。`--json` 消费者若合并 2>&1 仍会看到"JSON 后面跟一段中文"。F1 报告 §"F2 范围外"已承认只修了出口码未修此重复。最小修法：`if (options.json && …) 只写 stdout`。属既有行为、非 F1 引入，故 P2。

### P2-4 `docId` 白名单对"平铺目录"是**过严**（新增拒绝面）
`server.ts` `docIdOf` 用 `/^[A-Za-z0-9_-]+\/[^/]+$/`：`hr serve ""`（workspace 根平铺）与 `hr serve ../x.html`（`resolveTarget` 允许"向上"）现在都在**绑定端口之前**就 `invalid_input` 退出（impl §7 已自述）。以前这两种能起服务。这是有意加固，但属于用户可见行为收窄，需在 `docs/05`/报告里明确写"docId 必须是 workspace 内相对路径且至少两级"。目前文档没写 → 建议补一行。**非阻断**。

### P2-5 `ownerOfPort` 的 `unknown` 分支仍会误报 `daemon_already_running`
`daemon-guard.ts:18-46`：`stale`/`unknown` 都走 `outcomeOfAlive(existing)` → **一律** `daemon_already_running`（附 `hr daemon stop` 指路）。误判面（要写清，任务要求）：
1. 端口被**非 hReader** 的 HTTP 服务占着，且 `/healthz` 在 500ms 内返回非 JSON 或超时 → `unknown` → 用户看到"daemon 已在运行，先 `hr daemon stop`"，`hr daemon stop` 却什么也停不掉 → 死胡同。
2. `daemon.json` 文件丢了/坏了，但**我们自己的** daemon 还活着 → `existing` 为 `undefined` → 不拦 → `bind` EADDRINUSE → 报 `port_in_use`"被别的进程占用"（其实是自己）。
改进（最小）：`unknown` 时文案改成"端口 X 已被占用，但无法确认是否是 hReader daemon（`hr daemon stop` 可尝试；否则用 `--port` 换端口）"，并把 `hr daemon stop` 指路保留。**不改代码也可先过**——但请在文档里写清误判面。

### P2-6 `port_in_use` 的退出码选择需要文档支撑（结论：2 是对的，但依赖 M4.8 的风险注记）
`packages/cli/src/exit-codes.ts:39,50-51`：`invalid_input:1`、`invalid_document:1`、`needs_normalize:2`、`port_in_use:2`。这与 `.workflow/cards/M4.8.md:55`（needs_normalize 退出 2，**不得复用 1**）和 `:72`（新增 2 需与 `EXIT_USAGE=2` 对齐）一致 ✔。**不是问题**，仅记录审计结论：`invalid_input` 与"文档状态类"错误（`needs_normalize`）被刻意分到 1 与 2，`docs/05-feature-cards.md:440-442` 三行已对齐，OK。

---

## 回归面（F2 `replacedIds`）

- ✅ `packages/**/src/**` 内**无 `deepEqual`/`assert.deepStrictEqual`**（grep 确认 0 命中）→ 多一个键不会炸 src 内比较。
- ✅ `dataPatch`（`output.ts:171-190`）**仅在 `replacedIds.length>0` 时**加键；`append` 等场景 JSON 与旧版逐字节同构 → `--json` 旧消费者零影响。键序：`newIds` 之后（`dataPatch` 先展开再追加 `replacedIds`），与 `humanPatch` 一致 ✔。
- ⚠ **测试侧类型破坏**：`PatchResult` 新增**必填** `replacedIds`（`packages/core/src/ops/patchNode/types.ts`）。`packages/cli/tests/units-output.test.ts:52-70` 已自行补过 `replacedIds: []`（说明测试编写员在跟），但 `PATCHED`/`UNCHANGED` 这类字面量在别处若再出现会 typecheck 红。已列入下方 `TESTS_TO_UPDATE` 补充。交给协调者统一。
- ⚠ `replace` 的子树 id 会**整棵重算**（`apply.ts:170-185` `withoutSelfId`+`reserved`），注释已改成如实描述，`docs/05-feature-cards.md:440-441` 也已补。这是既有行为不是回归（B-05 只要求"新根 id 可拿到"，已由 B-04 满足）。

## 错误路径（任务第 3 项）

| 检查 | 结论 |
|---|---|
| `needs_normalize` 在 `HrErrorCode` 联合 | ✔ `packages/core/src/errors.ts`（`HR_ERROR_CODES` 含 `needs_normalize`、`port_in_use`） |
| 在 `exit-codes.ts` 映射 | ✔ `exit-codes.ts:50-51` |
| 在 `docs/05` 错误码表 | ✔ `docs/05-feature-cards.md:440-442` 三行（含 `daemon_already_running` 由 2 改 1） |
| 「`hr daemon start` 已在跑」文案指向 `daemon status` | ✔（`daemon-guard.ts` 文案） |
| `needs_normalize` message 都指向 `hr normalize` | ✔ `derive.ts:84-88` 与 `withNormalizeAdvice` 统一追加 |
| `invalid_document` 仍只在 normalize 用 | ✔ `normalizeFile.ts`（`assertIsDocument`）；`derive.ts` 不再产出 `invalid_document` |

## 可读性（只列真问题）

- **P2-6 级（不计入问题数）** `normalizeFile.ts:26` 的字段名 `needsNormalize` 同时被当成"输入状态"和"结果状态"解释，才导致 P1-1 这种"算完不复位"的错。最小改动不是改名，而是把 P1-1 的 2 行修掉，并在该字段上方补一句"写回后恒为 false"（签名看不出，符合用户要求）。
- `packages/cli/src/run.ts` `runRemaining` 用 `Extract<Runnable,{kind:RemainingKind}>` + `RemainingKind` 字面量重复了 `Intent` 的 kind，属可接受的分派函数，不加注释也对——**不算问题**。
- 未发现"测试专用分支"泄漏进 `src/**`：`grep VITEST|NODE_ENV|__test|isTest` 在 `packages/*/src` 仅命中 `resolve-hook.ts` 一条**注释**。✔ 这项达标（用户硬要求）。
- 未发现"为了过 CI"的回退（无 `try{}catch{return []}` 式吞错）；`normalizeFile` 保留 `changed`/`mode` 字段，`atomic.ts` 的 `applyMode` 显式区分 ENOENT（静默）与其他错误（原样抛）。✔
- 唯一"凑数型注释"嫌疑：`print-html.ts` 里 `SECNUM_CLASS` 常量 + 注释说明"与 print-css 用同一 class" —— 这是签名看不出的跨模块契约，**保留是对的**。

---

## 给测试编写员的 `TESTS_TO_UPDATE` 补充（仅写入本报告，未改测试）

1. **T-NORM-IDEMPOTENT-JSON（会抓 P1-1）**：`normalize a.html --write --json` → 断言 `data.needsNormalize === false` **且** `data.injected > 0`；第二次跑 `injected === 0`、`data.html` 与第一次写回字节一致（M4.8 AC-1）。当前实现必红。
2. **T-NORM-READONLY**：`chmod 444 a.html` → `normalize --write` 退出 1、`io_failure` 带"只读/chmod u+w"、文件字节未变、`stat` mode 仍 444；`chmod 644/600` 走正常路径且 mode 保留。
3. **T-ENTRY-CONSISTENT**：对 `<article data-hr-id="hr-ok"><h1>A</h1></article>` 分别跑 outline/read/patch/export，把四者的"是否 needs_normalize"钉进黄金文件（当前 outline/read 拒、patch/export 过 → 会暴露 P2-2，供协调者裁）。
4. **T-SERVE-IPV6（Linux 跑）**：本机无 v6 监听时 `hr serve` 的 stderr **不得**含 `::` 提示（会抓 P1-2）；再起一个只绑 `::` 的 python，断言正常起服务 + 恰好一行提示。
5. **T-REPLACED-IDS**：`replace` 普通块 → `replacedIds` 恰 1 对；`replace` 片段含嵌套块 → `newIds` 覆盖子树新 id、`replacedIds` 仍 1 对；`append/insert_*/delete` → 键缺失；`replace` 目标 = `<article>` 根 → 键缺失；片段纯文本 / 多根 → `invalid_fragment`。
6. **T-JSON-NO-LEAK**：任一失败 + `--json`，合并 `2>&1` 后 stdout 部分是**合法单条 JSON**（会暴露 P2-3；若协调者决定不修，改成"stderr 允许非空但 stdout 必须单条 JSON"）。
7. **T-PATCHRESULT-TYPE**：`PatchResult` 新必填 `replacedIds` —— 全仓 `grep "newIds:" packages/**/tests` 逐处补 `replacedIds: []`（`units-output.test.ts:52-70` 已补，其余字面量需自查），否则 `pnpm typecheck` 必红。
8. **T-DAEMON-CODES**：`daemon_already_running` 退出码已 2→1，旧断言需同步；新增 `port_in_use` 退出 2 用例（用非 hReader 的 `node -e 'http.createServer().listen(P)'` 占端口）。
9. **T-READ-META**：`read --json` 新增 `title/lang/stylePath` 键，旧黄金文件若整串比对需允许"只增"。
10. **T-STYLE-TONE**：`--visual <toneId>` → `invalid_input` 且 message 含 `--tone`；`--visual <不存在>` → 仍 `unknown_style`；`--visual <真 visual>` → 0。

---

## 给协调者的收口清单（需你跑）

- [ ] 复核 P1-1（`normalize --write --json` 的 `needsNormalize`）→ 决定是否让业务编写员出 2 行补丁
- [ ] 复核 P1-2（Linux 上 `hr serve` 的 `::` 假警告）→ 加 `ipv6Only: true` 或确认不触发后降 P2
- [ ] 裁 P2-2（四入口 `needs_normalize` 判据是否统一）
- [ ] 你自有 `pnpm verify` 是唯一跑过的门；本审计**未跑任何命令**（无 shell，且按边界不在测试收口前跑 verify）

---

### ≤200 字摘要

**判决 CHANGES-NEEDED**，P0=0 / P1=2 / P2=6。最严重两条：**P1-1** `normalize --write` 写回后 JSON 仍 `needsNormalize:true`，直接违反 M4.8 C1 与 AC-1，测试照契约写必红（`normalizeFile.ts:59-67`，修 2 行）；**P1-2** `ipv6Occupied` 在本机 IPv4 绑定之后才用双栈 `::` 探测，Linux（CI ubuntu）上每次 `hr serve` 假警告（`listen.ts:79`，加 `ipv6Only:true` 即解）。其余：B-01/02/03/04/05/16/24/25/26/27/29 经核验真正消症；B-15 仅改文案、报告结论夸大；四入口 `needs_normalize` 判据不一致待裁。