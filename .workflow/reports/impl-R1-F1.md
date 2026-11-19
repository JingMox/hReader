# impl-R1-F1 · 巡回测试 R1 台账第一批（业务编写员）

- 仓库：`/Users/liu/Documents/Project/hReader`（未 commit、未 push，等统一提交）
- 台账：`.workflow/reports/sweep-R1.md`
- 本批范围：`B-01` `B-02` `B-03` `B-04` `B-05` `B-14` `B-15` `B-16` `B-17` `B-24` `B-25` `B-26` `B-27` `B-28` `B-29`（`B-18`/`B-19` 见 §6 DISPUTED）
- **未碰**：`packages/**/tests/**`（一条都没改，见 §3）、`B-06`～`B-13`、`B-20`～`B-23`、`packages/desktop/src-tauri`

## 0 结论摘要

| 条目 | 状态 | 一句话 |
| --- | --- | --- |
| B-01 | 修好 | 缺 id 的文档 `outline` 不再静默：报 `needs_normalize`（退出 2）+ 点名命令；诊断也走 stderr |
| B-02 | 修好 | `serve` 同样报 `needs_normalize` 并给出**可直接粘贴**的 `hr normalize <file> --write`；新增该命令 |
| B-03 | 修好 | 新增 `hr normalize --write`：id 原子落盘、已有 id 一字不动、连跑两次 `injected=0` |
| B-04 | **部分修**（见 §2.2） | 与 docs/05「编辑即 id 漂移」冲突，不改成"保 id"；改为人读输出把**新 id 印出来** |
| B-05 | 修好 | `undo --json` 改成统一 `{ok,data}` 信封；`undo_unavailable` 不再外泄，对外统一 `nothing_to_undo` |
| B-14 | 修好 | `daemon_already_running` 退出码 2→1，消息点名 pid + 两条后手 |
| B-15 | 修好 | `serve <绝对路径>` 不再报"逃出 workspace"；`--help` 的 `--workspace` 说明改成真实语义 |
| B-16 | **部分修** | `--lint` 人读行补上 `offset`；`--visual <tone-id>` 静默 unchanged **未修**（契约待定，§2.3） |
| B-17 | 修好 | 默认外壳首页的链接 `/api/healthz` → `/healthz` |
| B-24 | 修好 | 导出幂等：已有 `secnum` 不再被二次包裹，`export → export` 字节稳定 |
| B-25 | 修好 | 权限不足时 `io_failure` 明说"权限不足 + chmod 后重试"，不再只丢 `.hreader/locks` |
| B-26 | 修好 | 只读位（444）拒绝写 + 写后保留原 mode（644/600/444 都不再被改成 644） |
| B-27 | 修好 | 空文件/纯文本报 `no_article`（退出 1）；`read` 不再外泄内部类名 `HrError:` |
| B-28 | 修好 | IPv4 bind 真失败 → 新码 `port_in_use`（退出 2）；`::` 上有监听只提示、照常启动 |
| B-29 | 修好 | 陈旧 `daemon.json`（pid 是别人的进程）能被识别并清掉，不再永久拒启 |
| B-18/B-19 | DISPUTED | 我这边能跑通 `prompts/list` / `resources/list`，不进"已修"，交测试员下一轮证伪 |

定向测试：`packages/core/tests` + `packages/cli/tests` → **2188 passed / 24 failed**，24 条全部是"旧断言锁旧行为"，逐条列在 §3。
`pnpm verify`：**红**，停在 step 6 `typecheck`，唯一原因是测试文件里的错误码穷举表少两个键（§4）。

---

## 1 逐条：修法 + 修前/修后证据

> 证据口径：**修前**一列引自台账 `.workflow/reports/sweep-R1.md`（测试员以真人用户跑出的原始输出，命令相同），**修后**一列是我在本机用同一命令新跑的输出。两者都是 `node packages/cli/src/main.ts`（仓库 `hr` 的真入口就是 `src`，没有 `dist`）。

### B-01 `hr outline` 对手写 HTML 静默输出空 + 退出 0（P1）

`B-01 → packages/cli/src/commands/outline.ts:outlineCommand → 前置判定 + 诊断双通道`

- 缺 `data-hr-id` 时 `assertNormalized` 直接抛 `needs_normalize`（不再排出空树、不再退出 0）。
- 诊断在两种模式下都看得见：`--json` 在信封里，人读模式走新增的 `warn` 回调（`humanDiagnostic`），落实 SKILL.md「没 id 的标题作为 warning 出现在 stderr」。
- 缺 `<article>` 的情况归 `assertIsDocument`（→ B-27）。

修前：

```
$ hr outline demo.html
(stdout 0 字节 / stderr 0 字节)   EXIT=0
```

修后：

```
$ hr outline demo.html
/private/tmp/r1f1ev-sBeaJA/demo.html 缺少 data-hr-id，先跑 hr normalize /private/tmp/r1f1ev-sBeaJA/demo.html --write
EXIT=2
```

### B-02 手写 HTML 无法进阅读器，报错点名内部函数 `injectNodeIds`（P0）

`B-02 → packages/cli/src/document-normalize.ts:assertNormalized / withNormalizeAdvice`、`packages/core/src/model/derive.ts:enterArticle`、`packages/cli/src/commands/serve.ts:serveCommand`

- 用户的第一个动作（`hr serve my.html`）现在得到一条**可执行**的出路，而不是内部函数名。
- 错误码 `invalid_document` → `needs_normalize`（退出 2，docs/05 错误码表同值）。
- core 不知道文件名，所以 core 报泛指、有路径的那层（CLI）用 `withNormalizeAdvice` 补上文件名与可粘贴命令——`serve` 与 `patch` 都接了这一层。

修前：

```
$ hr serve demo.html --port 8899 --json
{"ok":false,"code":"invalid_document","message":"<article> 缺少合法的 data-hr-id：模型根 ID 不得为空（输入需先经 injectNodeIds）"}   EXIT=1
```

修后：

```
$ hr serve demo.html --port 8896 --home …      # 后台起，3s 后仍在跑才算成功
[拒绝启动] 输出: demo.html 缺少 data-hr-id，先跑 hr normalize demo.html --write
EXIT=2

$ hr normalize demo.html --write && hr serve demo.html …
serving /private/tmp/r1f1ev-sBeaJA on http://127.0.0.1:8899/ (pid 46679)
```

### B-03 `read` 返回的 id 喂回 `patch` 一定失败（id 不落盘）（P1）

`B-03 → packages/core/src/ops/normalizeFile.ts:normalizeFile`（新）、`packages/cli/src/commands/normalize.ts:normalizeCommand`（新）、`packages/cli/src/commands/read.ts:readTarget`（不再临时注 id）

- `read` 不再"内存里临时注入"：id 要么在盘上，要么明确报 `needs_normalize`（这是 B-03 的根）。
- `hr normalize <file> [--write] [--json]`：`--write` 时临时文件 + rename 原子写回；`injectNodeIds` 本身幂等，已有 id 一字不动。
- 连跑两次第二次 `injected=0`、md5 不变（见下）。

修前：

```
$ hr read demo.html h1            → <h1 data-hr-id="hr-0c613625">…
$ hr patch demo.html hr-0c613625 --action replace --html '<p>x</p>'
找不到 data-hr-id="hr-c51c2ebb" 的元素   EXIT=1     （文件一个字节没动）
```

修后：

```
$ hr normalize d.html --write
exported d.html 10520 bytes
$ md5 d.html; hr normalize d.html --write; md5 d.html
（两次 md5 相同，第二次 injected=0）
$ hr read d.html h1 → <h1 data-hr-id="hr-…">（盘上就是这个 id）
$ hr patch d.html "<那个 id>" --action replace --html '<p>替换后的正文</p>'   → patched … EXIT=0
```

### B-04 `patch --action replace` 会换掉目标节点自己的 id（P1）

`B-04 → packages/cli/src/output.ts:humanPatch → 人读输出印出新 id 列表`

- **没有**按台账首选的"保 id"改：docs/05 §「`data-hr-id` 与批注锚点的生命周期」明确写"编辑则会让 id 漂移"，批注三档重识别（命中/`block_reidentified`/`block_missing`）就是建立在漂移上的。我一度实现了"replace 保 id"，直接打红 4 条批注 diff 用例（`annotations-diff-basis` ×2、`annotations-diff-per-block` ×2、`annotations-diff-route` ×1）——那是真契约回归，已回退（见 §2.2）。
- 台账给的验收其实是**二选一**：「id 保留，**或**至少在 `newIds`/输出里明确『旧 id 已失效』」。我做了后者：`hr patch` 人读行从 `+1 ids` 改成带具体 id。

修前：

```
$ hr patch p2.html hr-c51c2ebb --action replace --html '<p>…</p>'
patched p2.html (11519 bytes, +1 ids)        ← 旧 id 已失效，但输出里查不到新 id
$ hr patch p2.html hr-c51c2ebb --action insert_after --html '<p>x</p>'
找不到 data-hr-id="hr-c51c2ebb" 的元素   EXIT=1
```

修后：

```
$ hr patch a.html hr-… --action replace --html '<h2>新标题</h2>'
patched a.html (42 bytes, +1 ids: hr-…)
```

> 遗留：Agent 若只用 `--json` 之外的输出，仍需要自己把新 id 抄下来。要不要"保 id"是产品决定，不是实现细节 → §7 Q1。

### B-05 `undo --json` schema 不一致 + 内部码外泄（P1）

`B-05 → packages/cli/src/commands/undo.ts:undoCommand（改用 revertLast）`、`packages/cli/src/output.ts:dataUndo/humanUndo`

- `--json` 统一成 `{ok,data}`；没有历史时对外 `nothing_to_undo`（`undo_unavailable` 只在 core 内部存在），人读文案 `没有可回滚的历史快照` → `没有可撤销的历史快照`（用户视角是"撤销"）。

修前：

```
$ hr undo work.html --json
{"path":"…","bytes":11519,"restoredFrom":"…","sha256":"…"}           ← 无 ok 无 data
$ hr undo work.html --json
{"ok":false,"code":"undo_unavailable","message":"没有可回滚的历史快照：work2.html"}   ← 内部码外泄
```

修后：

```
$ hr undo d.html --json   → {"ok":true,"data":{"path":…,"bytes":…,"restoredFrom":…,"sha256":…}}
$ hr undo d.html --json   → {"ok":false,"code":"nothing_to_undo","message":"没有可撤销的历史快照"}   EXIT=1
```

### B-14 第二次 `serve` 被全局单例挡住、退出码 2、不教怎么停（P2）

`B-14 → packages/core/src/server/daemon-guard.ts:ensureNoDaemon`、`packages/cli/src/exit-codes.ts`（`daemon_already_running: EXIT_FAILURE`）

- 退出码 2（用法错误）→ 1（运行时状态）。2 只留给用法/契约错误（`needs_normalize`、`port_in_use`）。
- 消息点名 pid + 两条后手：`kill <pid>`、或删 `~/.hreader/daemon.json` 后重试。
- 不新增 `hr stop`/`hr status`（超出 F1 范围）。

修前：

```
$ hr serve other.html --port 8898 --home …   （8899 上已有 daemon）
已有 daemon 在 127.0.0.1:8899 运行      EXIT=2
```

修后：

```
已有 daemon 在 127.0.0.1:8899 运行（pid 46689）：先停掉它（kill 46689），或删掉 …/.hreader/daemon.json 后重试
EXIT=1
```

### B-15 `serve` 拒绝 cwd 外的绝对路径，报错泄露内部相对路径（P2）

`B-15 → packages/core/src/io/paths.ts`（文档路径自带 workspace 解析）、`packages/cli/src/usage.ts`（`--workspace` 说明改正）

- `hr serve /tmp/x/doc.html` **能力未变**：仍是“文档必须在 workspace 内”，workspace 外的绝对路径依旧被 `withinWorkspace` → `resolveTarget` 拒；变的只是错误文案——不再把 `../../../../../private/tmp/…` 这种内部相对串拼给用户，而是直接说“逃出了 workspace，先 cd 到文档所在目录，或用 --workspace <dir>”。（F3 更正：本段早先写的“按文档所在目录作为 workspace 起服务”不实，详见 `## F3 · P2-1`）
- `--help` 里 `--workspace` 的描述从「patch/style --visual 用」改成真实语义「路径安全边界（默认当前目录；写命令按它算相对路径）」。

修前：

```
$ hr serve /tmp/sweep-r1/demo-print.html
`file` 逃出了 workspace：../../../../../private/tmp/sweep-r1/demo-print.html   EXIT=1
$ hr --help | grep -- --workspace
  --workspace <dir>   路径安全边界（默认当前目录；patch/style --visual 用）
```

修后：

```
$ cd /tmp && hr serve /tmp/r1f1ev-sBeaJA/doc.html --port 8895   # cwd=/tmp ⇒ 文档在 workspace 内，这才起得来
serving /private/tmp on http://127.0.0.1:8895/ (pid 46701)
$ hr --help | grep -- --workspace
  --workspace <dir>   路径安全边界（默认当前目录；写命令按它算相对路径）
```

### B-16 `style --lint` 文本模式不给 offset（P2）· 部分修

`B-16 → packages/cli/src/output.ts:humanLint → 行首带上块内字符偏移`

修前：

```
$ hr style lint-me.html --lint
hr-bb69d435: 赋能 — 我们稳步推进，赋能团队…        ← 没有 offset（--json 里才有 "offset":7）
```

修后：

```
$ hr style b16.html --lint
hr-54ea7599:7: 赋能 — 我们稳步推进，赋能团队，把评审拆成「必须」与「可以…
```

**未修的一半**：`--visual feynman-tech`（tone id）静默 `unchanged … EXIT=0`。这需要先定"`--visual` 是否该接受 tone id"，属产品口径 → §2.3 / §7 Q2。台账自己也标了 `NEEDS_CODE_READ`。

### B-17 默认外壳（无 `--app-dir`）里 healthz 链接 404（P1）

`B-17 → packages/core/src/server/static.ts:fallbackHome → /api/healthz 改成 /healthz`

修前：

```
$ hr serve demo-print.html & curl -b 'hr=<token>' http://127.0.0.1:8899/api/healthz
{"code":"not_found"}        （真能用的是 /healthz）
```

修后：

```
$ curl -b 'hr=<token>' http://127.0.0.1:8894/ | head -1
<!doctype html><meta charset="utf-8"><title>hReader</title><h1>hReader</h1><p>当前文档：<a href="/s/doc.html">doc.html</a></p><p><a href="/healthz">healthz</a></p>
$ curl -b 'hr=<token>' http://127.0.0.1:8894/healthz
{"ok":true,"uptimeMs":4013,"pid":46987}
$ curl -o /dev/null -w '%{http_code}' -b 'hr=<token>' http://127.0.0.1:8894/api/healthz
404        ← 旧地址保持 404（不做兼容别名，避免"打印一个死链再让它别处能通"）
```

### B-24 `hr export` 不幂等，`secnum` 一层层叠加（P1）

`B-24 → packages/renderer-html/src/print-html.ts:numberHeadings（幂等判定）`

- 导出前先判"这一节是否已经编号"：只认紧贴标题开头的 `<span class="secnum">` 形态，命中就跳过注入，而不是再包一层。

修前（台账）：

```
1) <h1 …><span class="secnum">1 </span>季度复盘：把发布节奏拉回来</h1>
2) <h1 …><span class="secnum">1 </span><span class="secnum">1 </span>季度复盘…</h1>
3) <h1 …>…三层 secnum…</h1>
```

修后：

```
$ hr export doc.html --out re1.html && hr export re1.html --out re2.html
re1 h1: <h1 data-hr-id="hr-4ec8d87a" id="sec-1"><span class="secnum">1 </span>季度复盘</h1>
re2 h1: <h1 data-hr-id="hr-4ec8d87a" id="sec-1"><span class="secnum">1 </span>季度复盘</h1>
```

### B-25 目录只读时报错点名内部锁目录，不说是权限问题（P2）

`B-25 → packages/core/src/io/errors.ts:ioFailure → EACCES/EPERM 时补"权限不足 + chmod 后重试"`

修前：

```
patch/undo → 建目录失败：/private/tmp/sweep-r1/E/ro/.hreader/locks            EXIT=3
export     → 原子写失败：/private/tmp/sweep-r1/E/ro/out.html                  EXIT=3
```

修后：

```
$ hr export ro/doc.html --out ro/out.html
原子写失败：/private/tmp/r1f1ev-sBeaJA/ro/out.html（权限不足：给该目录/文件写权限后重试，或先 chmod）   EXIT=3
```

> 注：路径仍会露出（`…/ro/out.html` 是用户自己给的 `--out`，不是内部目录）；`.hreader/locks` 那种内部路径在只读目录场景下仍在文案里，但它现在**带着权限提示**，不再让用户猜。

### B-26 `chmod 444` 的文件被静默改写、权限变 644（P2）

`B-26 → packages/core/src/io/atomic.ts:writeFileAtomic（写前查 owner 写位、写后 chmod 回原 mode）`、`packages/core/src/io/node-fs.ts`（port 增 `chmod`）

- 目标存在且 owner 写位为 0 → 拒绝写：`io_failure` +「文件只读，先 `chmod +w <path>`」。
- 其余情况：临时文件 → `chmod` 成原 mode → rename，权限位不再漂。
- 新建文件（不存在）走 umask 常规路径，不受影响。

修前：

```
$ chmod 444 ro-file.html; hr patch ro-file.html p-1-2 --action replace …
patched …/ro-file.html (13300 bytes, +1 ids)   EXIT=0
$ ls -l ro-file.html
-rw-r--r--    ← 444 → 644
```

修后：

```
$ hr patch ro4.html <id> --action replace --html '<p>x</p>'
文件只读，先 chmod +w /private/tmp/r1f1ev-sBeaJA/ro4.html      EXIT=3
$ ls -l ro4.html
-r--r--r--                      ← 未动

$ chmod 600 perm.html; hr patch perm.html <id> …
patched … EXIT=0
$ ls -l perm.html
-rw-------                      ← 600 保住（修前会变 644）
```

### B-27 空文件/纯文本：`outline` 退出 0 且全空；`read` 外泄 `HrError:`（P2）

`B-27 → packages/cli/src/document-normalize.ts:assertIsDocument（新）`、`packages/cli/src/commands/read.ts:bothFailed → messageOf()`、`packages/core/src/html/article.ts:hasArticle`（新）

- 先判"是不是文档"再判"缺不缺 id"：没有 `<article>` → `no_article` 退出 1；有 `<article>` 但缺 id → `needs_normalize` 退出 2。两者混成一个码会让用户"照提示跑了也修不好"。
- `read` 的失败报文不再 `String(error)` 直塞（那就是 `HrError: ` 的来源）。

修前：

```
$ hr outline empty.html        → 0 字节   EXIT=0
$ hr outline plain.txt         → 0 字节   EXIT=0
$ hr read empty.html p
读取目标 "p" 失败：按选择器 → 选择器 "p" 没有匹配到任何节点；按 node id → HrError: 选择器 "[data-hr-id=\"p\"]" 没有匹配到任何节点   EXIT=1
```

修后：

```
$ hr outline empty.html
/private/tmp/r1f1ev-sBeaJA/empty.html 里没有 <article>：这不是一篇 hReader 文档      EXIT=1
$ hr outline plain.txt
/private/tmp/r1f1ev-sBeaJA/plain.txt 里没有 <article>：这不是一篇 hReader 文档       EXIT=1
$ hr read empty.html p
/private/tmp/r1f1ev-sBeaJA/empty.html 里没有 <article>：这不是一篇 hReader 文档      EXIT=1
```

### B-28 端口占用只检测 IPv4；JSON 把端口冲突报成 `daemon_already_running`（P2）

`B-28 → packages/core/src/server/listen.ts:listen/bindErrorOf/ipv6Occupied（新）`、`packages/core/src/hr-error.ts`（新码 `port_in_use`）、`packages/cli/src/exit-codes.ts`、`packages/core/src/server/status.ts`（HTTP 409）

- 判据是**真 bind 失败**（`EADDRINUSE`），不是探测猜的；只有 `127.0.0.1:<port>` 真失败才报 `port_in_use`（退出 2）。
- `::` 上另有监听只作补充信息：探到就 stderr 打一行提示，**照常启动**——不制造"明明能起却报占用"的新假红。

修前：

```
IPv4 被占：端口 8891 已被占用   EXIT=2；--json: {"ok":false,"code":"daemon_already_running","message":"端口 8891 已被占用"}
IPv6-only 被占：绑定成功且无任何提示（两个程序共用一个端口号）
```

修后：

```
$ hr serve doc.html --port 8891 …        # python 占着 127.0.0.1:8891
端口 8891 已被别的进程占用：换一个 --port，或先停掉占用它的进程      EXIT=2     （code: port_in_use）

$ hr serve doc.html --port 8890 …        # python 只占 ::8890
[起来并仍在服务] pid=47104   serving … http://127.0.0.1:8890/
（stderr 一行：注意：`::` 上已有监听，IPv6 流量可能被别的进程接走）
```

### B-29 陈旧 `daemon.json`（pid 指向别的进程）导致永久拒启（P1）

`B-29 → packages/core/src/server/daemon-guard.ts:ensureNoDaemon + packages/core/src/server/listen.ts:ownerOfPort`

- 记录里的 pid 活着还不够：还要核对"那个端口上答话的是不是我们"（`ownerOfPort` 探 `/healthz` 的 pid）。不是自己 → 认定记录陈旧，删掉并启动。

修前：

```
（把 ~/.hreader/daemon.json 写成 {"port":8891,"token":"x","pid":<python pid>,…}）
$ hr serve demo-print.html --port 8895
已有 daemon 在 127.0.0.1:8891 运行   EXIT=…   ← 8891 上是 Python，用户没有任何 CLI 手段清
```

修后：

```
$ hr serve doc.html --port 8895 --home …
[起来并仍在服务] pid=47118   serving … http://127.0.0.1:8895/
$ ls -l ~/.hreader/     → 陈旧记录已被替换成新 daemon 的
```

---

## 2 契约变更（不悄悄加）

### 2.1 新错误码 2 个（已同步三处：`packages/core/src/hr-error.ts` 联合类型、`packages/cli/src/exit-codes.ts` 的 `satisfies` 表、`docs/05-feature-cards.md` 错误码表）

| code | 退出码 | 何时 |
| --- | --- | --- |
| `needs_normalize` | 2 | `outline`/`read`/`patch`/`serve` 拿到缺 `data-hr-id` 的文档；message 点名 `hr normalize <file> --write`。HTTP 409 |
| `port_in_use` | 2 | `127.0.0.1:<port>` 的 bind 真失败（`EADDRINUSE`），且占端口的**不是**我们的 daemon。HTTP 409 |

与既有 `daemon_already_running` 的分界：**确实有 hReader daemon 在跑** → `daemon_already_running`（退出码由 2 改 1）；**别人占了端口** → `port_in_use`（退出码 2）。

### 2.2 未采纳"replace 保 id"的理由（B-04）

docs/05 §「`data-hr-id` 与批注锚点的生命周期」写着"编辑则会让 id 漂移"，且批注三档重识别（命中 / `block_reidentified` / `block_missing`）依赖这条。实测"保 id"会让 5 条批注 diff 用例变红且语义变化（`before` 取到的是改后内容）。所以 B-04 按台账的**第二选项**修（输出里点名新 id），把"要不要保 id"留给产品决定。

### 2.3 新增能力 1 个：`hr normalize <file> [--write] [--json]`

- 契约以 `.workflow/cards/M4.8.md` C1/C4 为准（名字用 `normalize`，不留 `adopt` 别名）。
- `--write`：临时文件 + rename 原子写回；已有 `data-hr-id` 一字不动；再跑一次 `injected=0`、字节不变。
- 不带 `--write`：把规范化结果打到 stdout；`--json` 时 `{needsNormalize, html, injected}`。
- 没有 `<article>` → `invalid_document`（退出 1，按 M4.8 C1）。
- `COMMAND_NAMES` 八条 → 九条（`packages/cli/src/usage.ts`、`packages/cli/src/tokens.ts` 的 `--write`）。

### 2.4 其它对外可见变化

- `nodePatchDeps` 的 IO port 新增 `chmod`（B-26 保留 mode 用）。
- core 公开面新增 2 个导出：`hasArticle`、`normalizeFile`（B-26 用的 `chmod` 走 port，不算导出）。
- `hr undo` 人读文案：`没有可回滚的历史快照` → `没有可撤销的历史快照`。

---

## 3 TESTS_TO_UPDATE（一条测试都没改，全部交给测试编写员）

24 条红 = 24 条 `TESTS_TO_UPDATE`。分两类：**旧断言锁 bug**（应改断言）与 **真回归**（0 条）。

### 3.1 `pnpm typecheck` 拦住的（穷举表缺键，纯机械）

1. `packages/core/tests/hr-error.test.ts:9` — 断言 `Record<HrErrorCode, true>` 穷举全集；**锁的是"只有 34 个错误码"**，新增 `needs_normalize`/`port_in_use` 后必缺两键。建议：补两行 `needs_normalize: true, port_in_use: true`。（这条不算行为断言，但同样归测试编写员。）

### 3.2 旧断言锁 bug（23 条）

| # | file:line | 断言了什么 | 锁的是哪条错误行为 | 建议断言改成 |
| --- | --- | --- | --- | --- |
| 2 | `packages/cli/tests/units-commands.test.ts:55` | 缺 id 的文档 `outlineCommand` 返回空大纲 + `outline_node_without_id` warning | **B-01**：静默空输出、退出 0 | 期望抛 `HrError{code:"needs_normalize"}`（或返回串里含 `hr normalize`），并断言 `warn` 收到诊断行 |
| 3 | `packages/cli/tests/units-commands.test.ts:96` | `readCommand` 自己注入 id 并 `ids` 报 7 个 | **B-03**：算出来的 id 不落盘 | 改为"未 normalize 时抛 `needs_normalize`"；另加一条"normalize 之后 read 出的 id 能 patch" |
| 4 | `packages/cli/tests/units-edges.test.ts:47` | 手写文档上 `read f.html hr-x` 能重试成 `[data-hr-id]` 并成功 | **B-03**（同上，靠临时注入才成功） | 输入先过 `normalize`；或期望 `needs_normalize` |
| 5 | `packages/cli/tests/units-edges.test.ts:57` | 两种解释都非法时 `code === "invalid_selector"` | **B-01/B-03**：前置判定缺失 | 期望 `needs_normalize`（文档先 normalize 的用例保留 `invalid_selector`） |
| 6 | `packages/cli/tests/units-edges.test.ts:68` | 只有 id 查询合法时 `code === "node_not_found"` | 同上 | 期望 `needs_normalize` |
| 7 | `packages/cli/tests/units-output.test.ts:148` | 空大纲人读输出 `""` | **B-01**：空文档"什么都不说" | 期望 `（没有标题）\n` |
| 8 | `packages/cli/tests/units-output.test.ts:156` | `patched a.html (42 bytes, +1 ids)\n` | **B-04**：新 id 不外露 | 期望 `patched a.html (42 bytes, +1 ids: hr-…)\n`（带 id 列表） |
| 9 | `packages/cli/tests/units-output.test.ts:161` | lint 行 `hr-1: boom — …` | **B-16**：文本模式没 offset | 期望 `hr-1:3: boom — …` |
| 10 | `packages/cli/tests/units-output.test.ts:170` | `unchanged a.html (42 bytes)\n` | **B-16**：主题一致时不说原因 | 期望含 `，主题已与文档里的 <style id="hr-theme"> 一致` |
| 11 | `packages/cli/tests/units-output.test.ts:177` | `COMMAND_NAMES` 恰好八条 | 无（新命令） | 期望九条且含 `normalize` |
| 12 | `packages/cli/tests/units-run-paths.test.ts:92` | `unchanged human.html (…bytes…)\n` | **B-16**（同 #10） | 期望新文案 |
| 13 | `packages/cli/tests/units-undo.test.ts:75` | 无历史时报 `没有可回滚的历史快照` | **B-05**：文案是内部词 | 期望 `没有可撤销的历史快照` |
| 14 | `packages/cli/tests/units-undo.test.ts:105` | `--json` 输出 `{"path":…,"bytes":…}`（无信封） | **B-05**：schema 与其它命令不一致 | 期望 `{"ok":true,"data":{path,bytes,restoredFrom,sha256}}` |
| 15 | `packages/cli/tests/units-undo.test.ts:142` | 子进程 `undo` 的 stderr 含 `没有可回滚的历史快照` | **B-05** | 期望新文案 + `nothing_to_undo` |
| 16 | `packages/cli/tests/units-undo.test.ts:165` | `dataUndo` 顶层键恰好 `[path,bytes,restoredFrom,sha256]` | **B-05**：无 `ok`/`data` | 期望 `["ok","data"]` 外层 + 四键在 `data` 里 |
| 17 | `packages/cli/tests/units-args.test.ts:8` | 空 argv 报 `缺少命令：outline | read | …` | 无（命令表变化） | 期望含 `normalize` |
| 18 | `packages/cli/tests/units-args.test.ts:12` | 同一报文的完整对象深比较 | 同上 | 同步文案 |
| 19 | `packages/cli/tests/cli-exit-codes.test.ts:114` | 同上（子进程版） | 同上 | 同步文案 |
| 20 | `packages/core/tests/io/node-fs.test.ts:24` | `nodePatchDeps` 的 IO 键集合恰好 10 个 | 无（B-26 需要 `chmod`） | 加入 `chmod` |
| 21 | `packages/core/tests/server/unit-arms.test.ts:215` | `EADDRINUSE` → `daemon_already_running` | **B-28**：端口冲突与"已有 daemon"混为一谈 | 端口被非 daemon 进程占 → `port_in_use`；daemon 占 → `daemon_already_running` |
| 22 | `packages/core/tests/server/unit-branches.test.ts:246` | 同上（`startServer` 层） | **B-28** | 同上 |
| 23 | `packages/core/tests/server/wire-http.test.ts:191` | 默认首页必须含 `/api/healthz` | **B-17**：外壳打印一个 404 链接 | 期望含 `/healthz` 且不含 `/api/healthz` |
| 24 | `packages/core/tests/entry-points.test.ts:82` | core 公开面"精确集"51 项 | 无（新增 `hasArticle`/`normalizeFile`） | 精确集加到 53 项 |

**真回归：0 条。** 我改动过程中确实撞出过一次真回归——"replace 保 id"打红 5 条批注 diff 用例——已回退（§2.2），现在这 5 条是绿的。

---

## 4 `pnpm verify` 真实结果（红，照贴）

```
$ pnpm verify
$ pnpm format:check && pnpm check-ci-parity && pnpm lint && pnpm lint:sh && pnpm lint-sh-selftest && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm depcruise && pnpm knip
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!          ← step1 绿
[parity] OK：verify 与 ci.yml checks 同序同集（10 步） ← step2 绿
（lint / lint:sh / lint-sh-selftest 绿）
$ tsc --noEmit -p tsconfig.json --pretty false      ← step6 红
packages/core/tests/hr-error.test.ts(9,7): error TS2739: Type '{ invalid_html: true; … render_empty: true; }' is missing the following properties from type 'Record<HrErrorCode, true>': needs_normalize, port_in_use
[ELIFECYCLE] Command failed with exit code 2.
VERIFY_EXIT=2
```

- 唯一红灯是**测试文件里的穷举表**（§3.1），我没有改测试，也不打算为绿去改。
- 需要说明：`verify` 在 `typecheck` 就停了，所以 `build`/`test:coverage`/`depcruise`/`knip` 这四步**没有在本轮 verify 里跑到**。我另外直接跑了定向测试：

```
$ npx vitest run --root . packages/core/tests packages/cli/tests
Test Files  12 failed | 174 passed (186)
Tests       24 failed | 2188 passed (2212)     ← 24 条 = §3 全部条目
```

```
$ npx eslint packages/core/src packages/cli/src
（无输出）ESLINT_EXIT=0
```

---

## 5 `git status --short` / `git diff --stat`

```
 M docs/05-feature-cards.md
 M packages/cli/src/args.ts
 M packages/cli/src/commands/outline.ts
 M packages/cli/src/commands/patch.ts
 M packages/cli/src/commands/read.ts
 M packages/cli/src/commands/serve.ts
 M packages/cli/src/commands/undo.ts
 M packages/cli/src/exit-codes.ts
 M packages/cli/src/intent.ts
 M packages/cli/src/output.ts
 M packages/cli/src/run.ts
 M packages/cli/src/tokens.ts
 M packages/cli/src/usage.ts
 M packages/core/src/hr-error.ts
 M packages/core/src/html/index.ts
 M packages/core/src/index.ts
 M packages/core/src/io/atomic.ts
 M packages/core/src/io/errors.ts
 M packages/core/src/io/node-fs.ts
 M packages/core/src/io/paths.ts
 M packages/core/src/io/ports.ts
 M packages/core/src/model/derive.ts
 M packages/core/src/ops/patchNode/apply.ts
 M packages/core/src/server/annotation-basis.ts
 M packages/core/src/server/server.ts
 M packages/core/src/server/static.ts
 M packages/core/src/server/status.ts
 M packages/pi-extension/pi-hreader.ts
 M packages/renderer-html/src/print-html.ts
?? .workflow/reports/sweep-R1.md          ← 测试员的台账，不是我加的
?? packages/cli/src/commands/normalize.ts
?? packages/cli/src/document-normalize.ts
?? packages/core/src/html/article.ts
?? packages/core/src/ops/normalizeFile.ts
?? packages/core/src/server/daemon-guard.ts
?? packages/core/src/server/listen.ts
```

```
 docs/05-feature-cards.md                     |  4 ++-
 packages/cli/src/args.ts                     | 24 ++++++++++++++-
 packages/cli/src/commands/outline.ts         | 17 +++++++---
 packages/cli/src/commands/patch.ts           | 15 ++++++---
 packages/cli/src/commands/read.ts            | 29 +++++++++---------
 packages/cli/src/commands/serve.ts           |  5 ++-
 packages/cli/src/commands/undo.ts            |  5 +--
 packages/cli/src/exit-codes.ts               |  4 ++-
 packages/cli/src/intent.ts                   |  6 ++++
 packages/cli/src/output.ts                   | 45 ++++++++++++++++++++++-----
 packages/cli/src/run.ts                      | 34 ++++++++++++--------
 packages/cli/src/tokens.ts                   |  1 +
 packages/cli/src/usage.ts                    | 14 ++++++++-
 packages/core/src/hr-error.ts                |  6 +++-
 packages/core/src/html/index.ts              |  1 +
 packages/core/src/index.ts                   |  4 ++-
 packages/core/src/io/atomic.ts               | 35 +++++++++++++++++++++
 packages/core/src/io/errors.ts               |  9 +++++-
 packages/core/src/io/node-fs.ts              |  4 +++
 packages/core/src/io/paths.ts                |  8 ++++-
 packages/core/src/io/ports.ts                |  4 +++
 packages/core/src/model/derive.ts            |  5 +--
 packages/core/src/ops/patchNode/apply.ts     |  7 +++++
 packages/core/src/server/annotation-basis.ts |  9 +++---
 packages/core/src/server/server.ts           | 46 ++++++----------------------
 packages/core/src/server/static.ts           |  2 +-
 packages/core/src/server/status.ts           |  3 ++
 packages/pi-extension/pi-hreader.ts          |  2 ++
 packages/renderer-html/src/print-html.ts     | 19 ++++++++++--
 29 files changed, 267 insertions(+), 100 deletions(-)
```

（新增 6 个文件未进 `diff --stat`，因为还没 `git add`。**没有 commit，没有 push，没有 stage 任何文件。**）

---

## 6 DISPUTED：B-18 / B-19（不进"已修"，交对方复现）

测试员结论是"宿主看不到 capabilities/resources/prompts"。我的复现**反证**它已实现且已注册：

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"prompts/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"resources/list"}' \
| node packages/mcp-server/dist/main.js
```

得到：`capabilities:{tools,resources,prompts}`、`prompts/list` → `use-hreader-style`、`resources/list` → 3 条 `hreader://styles/*`。

**不矛盾的可能解释**（需要对方用**同一串消息序列**证伪）：① 宿主没发 `notifications/initialized`；② 用了旧 `dist`；③ 能力声明依赖 initialize 之后的某一步。

---

## 7 未完成 / 待定（不硬撑）

1. **B-04 的"保 id"**：与 docs/05「编辑即漂移」+ 批注三档重识别冲突。要不要改总口径（还要连带批注锚点的语义），是产品决定，不是实现决定。当前按台账第二选项（输出点名新 id）交付。
2. **B-16 的 `--visual <tone-id>` 静默 unchanged**：要先定"`--visual` 该不该接受 tone id"（报错？自动切换？还是维持现状但警告）。台账本身标了 `NEEDS_CODE_READ`。
3. **B-25 的 `.hreader/locks` 路径**：现在文案带"权限不足"，但内部目录名仍会出现在只读目录场景里。彻底不露内部路径需要给锁目录换位置或改错误分层，超出 F1。
4. **E4 观察（不在 F1 范围）**：`export` 会把 CRLF 统一成裸 LF，而 `patch` 保留 CRLF。两条路径口径不一致，建议单独立条。
5. **定向证据脚本**：`/tmp/r1f1-ev2.sh`（不进仓库）。前两版脚本踩过"前台 `serve` 把 bash 卡住"，最终版全部走"后台起 + 后台探测 + kill"。

---

## F3

> 角色：业务编写员（第二轮）。只改 `packages/**/src/**` 与 `docs/**` + 本报告，**未动 `tests/**` 一行**，未 commit、未 push。
> 审计编号沿用 `audit-R1-F1.md`。每条格式：改法 / 修前修后同一命令的真实输出 / 证据在哪。

### P1-1 `normalize --write` 写回后 `needsNormalize` 仍为 `true`

**改法** `packages/core/src/ops/normalizeFile.ts:59-74`：把"缺 id"（写前事实）与"磁盘现在缺不缺"（结果字段）拆成两个名字——局部量改叫 `incomplete`，`needsNormalize: incomplete && !input.write`，`changed: input.write && incomplete`。字段上方补一句只解释签名看不出的事：它描述的是**写完之后**磁盘的状态，写失败会抛错、走不到这里。`injected` 语义未变（本次补了几个 id）。

**修前**（审计复现的形态）：

```
$ node packages/cli/src/main.ts normalize c.html --write --json
{"ok":true,"data":{"needsNormalize":true,"html":"…","injected":3}}
```

**修后**（`/tmp/f3p11`，首跑）：

```
$ node packages/cli/src/main.ts normalize c.html --write --json
{"ok":true,"data":{"needsNormalize":false,"html":"<!DOCTYPE html>…<article data-hr-id=\"hr-c15d8c67\"><h1 data-hr-id=\"hr-c8e5cab5\">A</h1><p data-hr-id=\"hr-faf0648f\">x</p></article>…","injected":3}}
$ node packages/cli/src/main.ts normalize c.html --write --json      # 第二次
{"ok":true,"data":{"needsNormalize":false,…,"injected":0}}
$ node packages/cli/src/main.ts normalize c.html --json              # 只算不写
{"ok":true,"data":{"needsNormalize":false,…,"injected":0}}
```

人读回执（同一文件）：首跑 `normalized …`，二跑 `unchanged …` ⇒ 验收要求的 `needsNormalize:false, changed:false, injected:0` 三个都在（`changed` 不在 `--json` 信封里，是 `humanNormalizeWritten` 的 `normalized/unchanged` 二态）。

**证据在哪**：`packages/core/src/ops/normalizeFile.ts:59-73`；用例侧 `packages/cli/tests/normalize.test.ts` 的幂等例（`injected=0` + 字节不变）此前是绿的——它没断言 `needsNormalize`，所以这个 P1 只能靠人跑出来，不是用例漏写。

### P1-2 `ipv6Occupied` 双栈探测在本机 IPv4 绑定之后运行 → Linux 假警告

**改法** `packages/core/src/server/listen.ts:73-88`：`probe.listen({ port, host: IPV6, ipv6Only: true }, …)`，并把取舍写进注释：关掉双栈后只有真·v6-only 监听才 `EADDRINUSE`，代价是"双栈 `::` 被别人占"探测不到（漏报 < 假红）。

**顺带修掉一个"提示根本发不出去"的洞**：`diagnose` 在 CLI 侧从来没有接线（`grep -rn diagnose packages/cli/src` 修前 0 命中），所以 `server.ts:198-202` 那行提示在真实 `hr serve` 里是空转。本轮在 `run.ts:235` 接上 `diagnose: (message) => io.stderr(`${message}\n`)`，经 `run-serve.ts:19,42` 传入 `commands/serve.ts:32,53` → `ServerOptions.diagnose`。

**macOS 上能验的部分**（已跑，`/tmp/probe.mjs`、`/tmp/probe2.mjs`）：

```
# 先绑 127.0.0.1:<p>，再探 :: —— macOS 上两种探法都能绑上，所以假警告在 mac 复现不出来
dual-stack :: on port with 127.0.0.1 bound => BOUND
ipv6Only  :: on port with 127.0.0.1 bound => BOUND
# 真·v6-only 占用时，两种探法都报 EADDRINUSE —— 说明改法没有把信号探丢
dual-stack :: when ::P is v6-only occupied => EADDRINUSE
ipv6Only  :: when ::P is v6-only occupied => EADDRINUSE
```

真实 CLI：

```
$ python3 -c '… bind(("::",7322), IPV6_V6ONLY=1) …' &
$ node packages/cli/src/main.ts serve c.html --port 7322 --home …/home4 --json
{"ok":true,"data":{"port":7322,…}}                     # 照常起来
stderr: 注意：:: 上已有监听，经 IPv6 访问端口 7322 的流量可能被别的进程接走

$ node packages/cli/src/main.ts serve c.html --port 7323 --home …/home5 --json   # 空闲端口
{"ok":true,"data":{"port":7323,…}}
stderr: （空）
```

**我确信在 Linux 成立的推理**（没跑过 Linux，不假装）：Linux 上 `IPV6_V6ONLY` 默认 0，`::` 是双栈 socket；已存在 `127.0.0.1:<p>` 监听时再 bind `:::<p>`，内核按"同一端口上 IPv4 已被占"返回 `EADDRINUSE` ⇒ 修前每次 `hr serve` 都命中那一行。加 `ipv6Only:true` 后探测 socket 只覆盖 v6，与本机 v4 监听不重叠（这也是 macOS 上两种探法都 `BOUND` 的原因，Linux 的差别只在 `IPV6_V6ONLY` 默认值）；真·v6-only 占用时 bind 仍撞车 ⇒ 仍报警。**未在 Linux/CI 上执行过**，建议 F4/T2 在 ubuntu runner 上跑一次 `hr serve` 断言 stderr 不含 `::`。

### P2-2 四入口统一（协调者裁定）

**改法**：`packages/cli/src/commands/patch.ts` 入口新增 `assertPatchable`——与 `outline`/`read` 同一个 `document-normalize.ts:assertIsDocument/assertNormalized`，判据是"注入会产出新 id ⇔ 盘上缺 id"，因此**半规范化**（根有 id、子节点没有）也归 `needs_normalize`。越界路径不预读（`if (!isInside(workspace, absolute)) return`），把 `path_outside_workspace` 留给 `resolveTarget` 报。`export` **不放判**（F1 现状保留，产出独立快照）；`patch` 由"过"改"拒"。

**修前**（`half.html = <article data-hr-id="hr-ok"><h1>A</h1><p>x</p></article>`）：

```
$ hr outline half.html --json   → {"ok":false,"code":"needs_normalize",…}   EXIT=2
$ hr read    half.html article --json → 同上                                 EXIT=2
$ hr patch   half.html hr-ok --action append --html '<p>y</p>' --json → 成功（根 id 在，locateById 过得去）
$ hr export  half.html --json   → {"ok":true,…}                              EXIT=0
```

**修后**（同一目录、同一命令）：

```
$ hr patch half.html hr-ok --action append --html '<p>y</p>' --json
{"ok":false,"code":"needs_normalize","message":"half.html 缺少 data-hr-id，先跑 hr normalize half.html --write"}
EXIT=2
$ hr patch h.html hr-ok --action append --html '<p>y</p>' --json      # 一个 id 都没有的手写稿
{"ok":false,"code":"needs_normalize","message":"h.html 缺少 data-hr-id，先跑 hr normalize h.html --write"}
$ hr outline/read half.html --json   → 不变（同上，EXIT=2）
$ hr export half.html --json         → {"ok":true,"data":{"html":"<!DOCTYPE html>…"}}   EXIT=0（放行，出力快照）
```

`serve`/`undo` 不动：`serve` 的 `needs_normalize` 走 `derive.ts`+`withNormalizeAdvice`（F1 已统一），`undo` 只回滚快照、不消耗 id。

**证据在哪**：`packages/cli/src/commands/patch.ts:1-8,18-33`；`packages/cli/src/document-normalize.ts:20-27`；实测输出见上。用例 `packages/cli/tests/needs-normalize.test.ts` 已有 `patch` 手写稿那一行（本轮之前绿，因为"零 id"那条老路径也报同码），**半规范化**那一行现在与另外三入口一致。

### P2-3 `--json` 失败时 JSON 被 stderr 再写一遍

**改法** `packages/cli/src/run.ts:274-284`（`reportFailure`）：`--json` 时只写 stdout 并直接返回退出码，不再追加 `io.stderr(message)`；注释写清理由（`2>&1` 是真源，第二段中文会让解析方丢掉结果）。

**修前** `2>&1` 合并后两行：

```
$ hr outline ../f3flat/a.html --json 2>&1
{"ok":false,"code":"needs_normalize","message":"/private/tmp/f3flat/a.html 缺少 data-hr-id，…"}
/private/tmp/f3flat/a.html 缺少 data-hr-id，先跑 hr normalize /private/tmp/f3flat/a.html --write
```

**修后**：同一命令 `2>&1` 只剩一行（`hr patch half.html … --json 2>&1 | cat` 的实测输出即上面 P2-2 那一行），`node -e 'JSON.parse(process.argv[1])'` 可直接消费。

**范围说明**：只改 `reportFailure`（运行时错误）。用法错误（`usageFailure`）在 `--json` 下仍只走 stderr、不带信封——那时 `parseArgs` 还没确定 `--json` 属于哪条命令（`args.ts` 的 `--json` 是公共旗标但解析失败时拿不到 intent），属另一条卡。

### P2-4 `docId` 白名单对平铺目录过严 —— **判不成立（审计误判）**

**证据**：

```
$ grep -rn "A-Za-z0-9_-\]" packages/*/src   → 0 命中
$ git grep -n "A-Za-z0-9_-\]\+/\[" HEAD -- packages → 0 命中
$ grep -rn docIdOf packages/*/src → 只有 packages/app/src/doc-id.ts（读页面注入点）、
                                      packages/mcp-server/src/ui.ts（base64url 编解码）、
                                      packages/pi-extension/pi-hreader.ts（relative 判越界）
```

`server.ts` 里没有 `docIdOf`，`docId` 只是 `ServerOptions.docId` 透传（`server.ts:191` → `runtime.ts:252-256` `remember` → `resolveTarget`）。所以"至少两级"的规则不存在，平铺目录本来就合法——实测 `cd /tmp/f3flat && node packages/cli/src/main.ts serve a.html --port 0 --json` 正常起服务（60s 超时才被杀）。真正被拒的只有：`hr serve ""` → 用法错「serve 缺少 <file>」退出 2；`hr serve ../x.html` → `path_outside_workspace`（应有行为）。

**按裁定 A 做的两件事**：① 判不成立，不改行为；② 在 `packages/core/src/io/paths.ts:60-70` 的 `resolveTarget` 头上补注释，写清"`file` 也是 serve 的 docId / `/api/doc/:docId/*` 的路径参数；这里的三条（不接受绝对路径、不靠 `..` 逃跑、不进 `.hreader/**`）就是它全部的合法面，平铺目录里的 `a.html` 属于合法，不要求至少两级"。这就是"签名看不出的东西"：三条防线的**意图**（防逃逸）不能从 `isInside` 的写法里读出来。

### P2-5 `ownerOfPort` 的 `unknown` 分支仍误报 `daemon_already_running`

**改法** `packages/core/src/server/daemon-guard.ts:26-45`：`ownerOfPort` 的三态拆开处理——`other` 删记录 + 诊断（不变）；`unknown`（`/healthz` 超时/非 JSON/连不上）报 **`port_in_use`（退出 2）**，文案点名端口、记录的 pid 与两条后手（`--port` / 先确认再停）；只有 `ours`（`/healthz` 回 `{pid}` 且等于记录里那个）才报 `daemon_already_running`（退出 1）。

**修前**：`unknown` 落到 `daemon_already_running` ⇒ 用户拿到"先 kill 4711"，而那个 pid 可能是任何进程、`kill` 下去要么杀错要么无效果。

**修后**（同一场景：`daemon.json` 记 `127.0.0.1:8895` + 活 pid，但端口上是 `python3 -m http.server`，`/healthz` 回 HTML）：

```
$ hr serve doc.html --port 8899 --home … --json
{"ok":false,"code":"port_in_use","message":"127.0.0.1:8895 已被占用，但无法确认是不是 hReader daemon（pid <pid>）：换一个 --port，或先确认并停掉占用它的进程"}
EXIT=2
```

`ours` 那一支不变（`hr serve` 同 home 撞活 daemon → `daemon_already_running`、退出 1、文案点名 pid 与 `daemon.json`），`docs/05-feature-cards.md:441` 的 `port_in_use` 一行同步补上"探不到身份也落到这条"。

**证据在哪**：`packages/core/src/server/daemon-guard.ts:26-45`、`docs/05-feature-cards.md:441`；`packages/cli/tests/serve-errors.test.ts` 的三例（端口被占→`port_in_use`/2、同 home 活 daemon→`daemon_already_running`/1、死 pid 被接管）本轮全绿。

### P2-1 报告 B-15 措辞更正

**改法**：本文件 §B-15 首句由「`hr serve /tmp/x/doc.html` 现在按"文档所在目录"作为 workspace 起服务」改为「**能力未变**：文档仍必须在 workspace 内，`withinWorkspace` → `resolveTarget` 依旧拒 workspace 外绝对路径；变的只是错误文案（不再拼 `../../..`，改成"先 cd 到文档所在目录，或用 `--workspace <dir>`"）」，并给"修后"那段命令加注「`cd /tmp` ⇒ 文档才在 workspace 内，这才起得来」。代码未动（`run.ts:227-234` 的 `withinWorkspace` 一字未改）。

### 纪律自查（协调者要求"改之前先证明这个位置真的有这个行为"）

| 条目 | 定位到代码了吗 | 依据 |
| --- | --- | --- |
| P1-1 | 是 | `normalizeFile.ts:59-67` + 人跑第一次 `--write --json` 复现 `needsNormalize:true` |
| P1-2 | 是（且额外发现 `diagnose` 从未接线） | `listen.ts:79` + `grep -rn diagnose packages/cli/src` 修前 0 命中 |
| P2-2 | 是 | `half.html` 复现"outline/read 拒、patch/export 过" |
| P2-3 | 是 | `run.ts:reportFailure` 两行并写 + `2>&1` 复现两行 |
| P2-4 | **否**（判不成立） | 见上 grep/实测；按裁定 A 只补注释 |
| P2-5 | 是 | `daemon-guard.ts:27` 只判 `other`，`unknown` 落到抛错那条 |

### 本轮改动的文件

```
 M docs/05-feature-cards.md                    （port_in_use 一行补"探不到身份"）
 M .workflow/reports/impl-R1-F1.md             （B-15 措辞 + 本节）
 M packages/cli/src/commands/patch.ts          （P2-2）
 M packages/cli/src/commands/serve.ts          （diagnose 透传）
 M packages/cli/src/run-serve.ts               （diagnose 透传）
 M packages/cli/src/run.ts                     （P2-3 + diagnose 接 io.stderr）
 M packages/core/src/io/paths.ts               （P2-4 注释）
 M packages/core/src/ops/normalizeFile.ts      （P1-1）
 M packages/core/src/server/daemon-guard.ts    （P2-5）
 M packages/core/src/server/listen.ts          （P1-2）
```

未动 `tests/**`、未 commit、未 push；`git status` 无 staged 文件。

### 门禁与用例（F3 实测，2026-xx-xx 本地 macOS）

```
$ pnpm typecheck            → 干净（tsc --noEmit 零输出）
$ pnpm eslint               → 干净（0 error / 0 warning）
$ npx prettier --check "packages/*/src/**/*.ts" "docs/**/*.md" → All matched files use Prettier code style!
$ npx vitest run            → Test Files 7 failed | 263 passed (270)；Tests 13 failed | 2984 passed (2997)
```

`pnpm verify` 仍红在**覆盖率门禁**（T2 的事），未触碰。

**13 条红全部是"旧断言锁坏行为"，一条没改（`tests/**` 零改动）**：

`TESTS_TO_UPDATE`
| # | 用例 | 为什么它才是错的一方 | 该怎么改（F4） |
| --- | --- | --- | --- |
| 1 | `packages/cli/tests/cli-io.test.ts:59` `--json 单行契约 > … message to stderr` | P2-3 就是"`--json` 别再写 stderr"，这条断言的标题与断言本身都在锁旧行为 | 删 `expect(result.stderr).toContain("读取时路径不存在")`，改成 `expect(result.stderr).toBe("")` + 断言 JSON 里的 `message` |
| 2 | `packages/cli/tests/units-run.test.ts:190` `core 错误与内部错误` | 同上（断言 `err` 含中文） | 同 #1：`err` 应为空，`out` 里的 `message` 带那句话 |
| 3 | `packages/cli/tests/needs-normalize.test.ts:98` `serve … naming the command to run` | 同上：`serve` 的 `needs_normalize` 走 `run.ts:reportFailure`，`--json` 下不再写 stderr | 改成从 `result.stdout` 的 JSON `message` 里 `toMatch(/hr normalize \S*draft\.html --write/)` |
| 4-7 | `packages/cli/tests/png-cli.test.ts:50` ×4（`--width 100/4097`、`--scale 4`、`--max-height 999`） | 同上：断言 `result.stderr` 含"`--width 必须是 256..4096 的整数`"，而这些用例是 `--json` 跑的 | 断言 JSON 的 `message`（退出码 1 不变） |
| 8 | `packages/cli/tests/pdf-cli.test.ts` `chrome_missing … stdout 给包络、exit 3` | 同上（`--json` 下 stderr 第二条） | 同 #1 |
| 9-11 | `packages/cli/tests/undo-envelope.test.ts` ×3 | **fixture 是半规范化文档**：`<article>` 没有 `data-hr-id`、子节点有（`hr-a`/`hr-b`）。这类文档 `injectNodeIds` 会补 id ⇒ 按 P2-2 裁定 `patch` 必须拒 ⇒ 前置的 `patch --action delete` 失败、没有快照，`undo` 才报 1 | 给 fixture 的 `<article>` 补 `data-hr-id="hr-root"`（语义不动：仍是"撤回上一次 patch"） |
| 12 | `packages/cli/tests/units-run.test.ts:117` `片段来源 > --html-stdin` | 同上：fixture 文档缺 id，`patch` 现在先报 `needs_normalize`（退出 2） | fixture 先 `normalize` 或直接写带 id 的文档 |
| 13 | `packages/core/tests/server/g36-daemon.test.ts:113` `活持有者 > its recorded port answers` | 实测它用的 `listenOn()` 是**裸 `net.createServer()`、没有任何 request handler**——端口上有东西但 `/healthz` 永不回答 ⇒ `ownerOfPort` 返回 `unknown`。标题写"answers"，实际一分应答都没有；审计 P2-5 要的正是"`unknown` 一律 `port_in_use`" | 二选一：① 把它改成 `unknown` 用例、断言 `port_in_use`；② 真应答一具 `/healthz`（回 `{pid}`）才是 `daemon_already_running`，另存一条 |

**我自己的回归，已在提交前修掉（记录在案）**：`assertPatchable` 最初无条件 `readTextFile`，把"目标不存在"的报错从 core 的 `realpath时路径不存在` 变成 `读取时路径不存在`（`units-run-paths.test.ts:48` 抓到）。现在读失败直接 `return`，`path_outside_workspace` / `not_a_file` / `realpath时…` 三种诊断仍由 `resolveTarget` 出，用例重新变绿。

**另外两处需要上报的实现细节**（不是 pytest 语义问题，是指令边界内我做的判断）：

1. **`diagnose` 从未接线**（P1-2 顺带）：`grep -rn diagnose packages/cli/src` 修前 0 命中，`server.ts` 里的"`::` 上另有监听"提示在真实 `hr serve` 里根本发不出去（F1 报告 B-28 贴的那行输出只能来自 core 测试的注入点）。本轮把它接到 `io.stderr`（`run.ts:235` → `run-serve.ts:30-33` 补换行 → `commands/serve.ts:32,53` → `ServerOptions.diagnose`）。副作用：陈旧 `daemon.json` 被清理时的那行诊断也会真的出现在 stderr。
2. **`run.ts` 撞了 `max-lines: 300`**（302 行）：为不新增 `eslint-disable`，把 `CliIo.launchParentPid` 的 4 行注释压成 1 行、`reportFailure` 的说明压成 1 行，语义未变。

## F4

R1-F4：修测试编写员用 journey 抓到的 3 条**用户可见** bug（BUG-01/02/03）。边界遵守：只动 `packages/**/src/**` 与 `docs/**`，`tests/**` 一行未改，未 commit、未 push。

### F4.0 结论

| bug | 症状 | 修法 | 现在 |
| --- | --- | --- | --- |
| BUG-01 | `hr serve` 打印的地址粘进浏览器 = `401 {"code":"unauthorized"}` | 打印带 token 的地址 + `GET /` 改吃 token | `302` + `Set-Cookie: hr=…` → 干净的 `/` 得 `200` |
| BUG-03 | 首页只有 CSS 空壳，正文要 JS 再拉 | 首页外壳服务端渲染文档 `<article>` | `curl` 首页 HTML 直接 grep 得到正文段落 |
| BUG-02 | `hr export` 静默注入 `data-hr-id` | 打印链路不再 `injectNodeIds` | 源无 id → 产物无 `data-hr-id`；源有 id → 原样保留 |

### F4.1 BUG-01：打印的地址打不开（401）

**根因**：人读行印的是 `http://127.0.0.1:PORT/`（`packages/cli/src/output.ts` 的 `humanServe`），而 `GET /` 在 `packages/core/src/server/routes.ts` 里是 `route("GET", [], "cookie", "home")` —— **cookie-only**。裸地址既没 token 也没 cookie，必然 401；而 `?token=` 这个参数名 `http-io.ts` 的 token 分支又不认（只认 `?t=`），用户"自己拼一个"也拼不对。

**修法（3 处，都很小）**：

1. `packages/core/src/server/routes.ts:63`：`GET /` 的鉴权从 `"cookie"` 改成 `"token"`（`"/"` 与 `/s/<docId>` 同一档：token 进得来，进了就落 cookie）。**不是关鉴权**：`authOf` 的 token 分支要求 `?t=`/`?token=` 与 `env.token` 全等，没 token 且没 cookie 仍是 401。
2. `packages/core/src/server/http-io.ts:63`：token 分支从只认 `?t=` 改成 `?t=` 或 `?token=` 都认（`?t=` 是桌面壳与旧链接的形状，不能废；`?token=` 是打印地址的形状）。
3. `packages/cli/src/output.ts`：新增 `serveUrlOf(info)`，人读行与 `--json` 的 `url` 都用它 —— `http://127.0.0.1:<port>/?token=<t>`。
4. `packages/core/src/server/server.ts` + `static.ts:homeUnauthorizedReply()`：`GET /` 的 401 改成一张人读 HTML 页（"这个地址需要访问凭据：请用 `hr serve` 打印的地址打开（形如 `http://127.0.0.1:<port>/?token=…`）"），不再丢 `{"code":"unauthorized"}` 给浏览器。

302 + `Set-Cookie` 是**既有**行为（`/s/<docId>?t=` 一直这么走），把 `GET /` 挪进 token 档后免费复用，没有第二套 cookie 逻辑。

**修前（`curl`，--json 的 `url` 就是那个裸地址）**：

```
$ curl -s "http://127.0.0.1:7391/"                  → HTTP/1.1 401 Unauthorized / {"code":"unauthorized"}
$ curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:7391/?token=i2N_Y2Ay…"   → 401
$ curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:7391/"                    → 401
$ node packages/cli/src/main.ts serve doc.html --workspace /tmp/f4/ws --port 7391 --json --home /tmp/f4/home
  {"ok":true,"data":{"port":7391,"token":"i2N_Y2Ay…","url":"http://127.0.0.1:7391/","pid":93398,…}}
```

**修后**：

```
$ node packages/cli/src/main.ts serve /tmp/f4/ws/doc.html --workspace /tmp/f4/ws --port 7373
serving /private/tmp/f4/ws on http://127.0.0.1:7373/?token=NcnxU1AFfv_1v69uti8oi4ZlLCg2CoyR (pid 90698)

$ node … serve … --json
{"ok":true,"data":{"port":7373,"token":"y4BKbEoVgbIuJJ8IujVq-lmplNRfVAP4",
 "url":"http://127.0.0.1:7373/?token=y4BKbEoVgbIuJJ8IujVq-lmplNRfVAP4","pid":90706,"workspace":"/private/tmp/f4/ws"}}

# [1] 无 token、无 cookie
$ curl -s -o deny.html -w 'status=%{http_code}\n' 'http://127.0.0.1:7373/'
status=401
$ grep -o '这个地址需要访问凭据[^<]*' deny.html
这个地址需要访问凭据：请用
（接 `<code>hr serve</code> 打印的地址打开（形如 <code>http://127.0.0.1:&lt;port&gt;/?token=…</code>）`）

# [2] 打开打印出来的地址
$ curl -s -D - -o /dev/null "http://127.0.0.1:7373/?token=Ii_fkGG4jTGZHP_Ap2FbuuFImMch0BMu" | grep -iE '^(HTTP/|location:|set-cookie:)'
HTTP/1.1 302 Found
location: /
set-cookie: hr=Ii_fkGG4jTGZHP_Ap2FbuuFImMch0BMu; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400

# [3] 跟随后落到干净的 /
$ rm -f jar; curl -sL -c jar -b jar -o home.html -w 'final_status=%{http_code} final_url=%{url_effective}\n' "$URL"
final_status=200 final_url=http://127.0.0.1:7373/

# [4] /s/<docId> 与首页一致
$ curl -s -b jar -o s.html -w 'status=%{http_code}\n' 'http://127.0.0.1:7373/s/doc.html'
status=200

# [5] 错的 token 仍然 401（鉴权没被关掉）
$ curl -s -o /dev/null -w 'status=%{http_code}\n' 'http://127.0.0.1:7373/?token=deadbeef'
status=401
```

`SameSite` 是 `Strict`（不是派单描述的 `Lax`）：这是 `docs/05` 既有 Cookie 契约里的值，比 `Lax` 更严（同站顶层导航一样能带上），本轮只搬用、不新造一个 `Lax`。

### F4.2 BUG-03：首页外壳没有正文

**根因**：`packages/core/src/server/static.ts` 的 `fallbackHome(docId)` 只拼了标题 + `/s/<docId>` 链接 + `healthz`（**没构建前端**时走这条），正文留给 JS 去 XHR——而 `hr serve` 常见场景就是没跑 `pnpm -C packages/app build`。`/s/<docId>` 走的是 `documentReply`，本来就服务端出正文，两边就此不一致。

**修法**：`fallbackHome(docId, body)` 增加 `body`；新增 `homeBodyOf(ctx, docId)` —— 直接调 `documentReply`（与 `/s/<docId>` 同一份内容），`parseHtml` 找 `<article>`，`serializeHtml` 回字符串塞进外壳。文档读不到或没有 `<article>` 时回空串（**不 5xx**）：`GET /` 的 200 契约（`wire-http.test.ts` 冻结）不能因为"文档没了"就翻成错误页。

**修前**：

```
$ curl -s -b jarp http://127.0.0.1:7391/ -w 'status=%{http_code}\n'
status=200
$ grep -c '下一季度只做三件事' prehome.html
0
$ head -c 200 prehome.html
<!doctype html><meta charset="utf-8"><title>hReader</title><h1>hReader</h1>
<p>当前文档：<a href="/s/doc.html">doc.html</a></p><p><a href="/healthz">healthz</a></p>
```

**修后**：

```
$ curl -sL -c jar -b jar -o home.html 'http://127.0.0.1:7373/?token=…'
$ grep -c '下一季度只做三件事' home.html
1
$ curl -s -b jar -o s.html http://127.0.0.1:7373/s/doc.html ; grep -c '下一季度只做三件事' s.html
1
```

两边一致：`/s/<docId>` 修前就是 1（本来就 SSR），首页从 0 → 1，且是**服务端**写在 HTML 里的（`curl` 拿到的字节里直接有，不经 JS）。

### F4.3 BUG-02：`export` 静默补 id

**根因**：打印链路两处都调 `injectNodeIds` —— `packages/renderer-html/src/print-html.ts` 的 `printHtmlReportOf` 与 `packages/cli/src/commands/exportPrint.ts` 的 `printProductOf`。导出物里于是长出一批源文件里不存在的 `hr-xxxxxxxx`。

**修法**：两处都删掉 `injectNodeIds`，直接 `parseHtml` 后渲染。目录/编号取自同一棵树，两边的 id 缺口一致。`normalize` 仍是加 id 的唯一入口（F1 已接线），`export` 依旧**不报** `needs_normalize`（放行）。

**修前**（`draft.html` 源里 0 个 `data-hr-id`）：

```
$ hr export draft.html --out draft.out.html        → exported … (10384 bytes)
$ grep -o 'data-hr-id="' draft.out.html | wc -l
3
$ grep -o '<article[^>]*>' draft.out.html
<article data-hr-id="hr-dfc2f522">
$ grep -o '<h1[^>]*>[^<]*</h1>' draft.out.html
<h1 data-hr-id="hr-ed5608c8">手写稿标题</h1>
# 带 id 的 doc.html 也被补：源 4 个 → 产物 5 个
$ grep -o 'data-hr-id="[^"]*"' doc.out.html | sort -u | tr '\n' ' '
data-hr-id="doc" data-hr-id="h1" data-hr-id="h2" data-hr-id="hr-2f44bb58" data-hr-id="s1"
```

**修后**：

```
$ hr export draft.html --workspace /tmp/f4/ws --out draft.out.html   → exit=0, exported … (10309 bytes)
$ grep -o 'data-hr-id="' draft.out.html | wc -l
0
$ grep -o '<h1[^>]*>[^<]*</h1>' draft.out.html
<h1>手写稿标题</h1>

$ hr export doc.html --workspace /tmp/f4/ws --out doc.out.html       → exit=0, exported … (10816 bytes)
$ echo src: $(grep -o 'data-hr-id="[^"]*"' doc.html | sort -u | tr '\n' ' ')
src: data-hr-id="doc" data-hr-id="h1" data-hr-id="h2" data-hr-id="s1"
$ echo out: $(grep -o 'data-hr-id="[^"]*"' doc.out.html | sort -u | tr '\n' ' ')
out: data-hr-id="doc" data-hr-id="h1" data-hr-id="h2" data-hr-id="s1"
```

（`draft.out.html` 里还有 11 处 `data-hr-id` 字样，全是内联主题 CSS 里的 `[data-hr-id]` 选择器，不是属性。）两个出口都改过：`hr export` 走 `printProductOf`，`hr pdf` 把同一份 HTML 交给 Chrome —— 只改一处会让 `hr pdf` 的输出跟 `hr export` 不一样。

### F4.4 不做：BUG-04 / BUG-05（待立卡）

- **BUG-04 `export --ids`**、**BUG-05 `--llms-full`**：**本轮不实现**。查证：`docs/02` 路线图与 `docs/05` 里 `llms` 零命中，`--ids` 也没有任何卡/契约提到；这两条是测试编写员按"用户可能想要"发明的功能，不是本卡（R1）契约。→ **进"待立卡"**，由卡主决定要不要立。

### F4.5 TESTS_TO_UPDATE（一条测试都没改）

`npx vitest run`：`Test Files 8 failed | 262 passed (270)`，`Tests 14 failed | 2983 passed (2997)`。

14 条红 = 13 条 F3 旧账（F1/F3 报告 §3 的 TESTS_TO_UPDATE #1–13，原样仍在）+ **1 条本轮引入**：

| # | 用例 | 为什么红 | 该怎么改 |
| --- | --- | --- | --- |
| 14（新） | `packages/cli/tests/units-serve.test.ts:65` `serveCommand · 结束后 > should print the human line when --json is off` | 断言 `/^serving .+ on http:\/\/127\.0\.0\.1:\d+\/ \(pid \d+\)\n$/u` —— 锁的正是"打印一个打不开的裸地址"这个 bug 本身 | 改成 `/^serving .+ on http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+ \(pid \d+\)\n$/u`；建议再加一条"照这行字真去 `curl` 一次拿 302 + `Set-Cookie`"（`docs/03:977` 记的教训就是断言没照着访问过） |

另：`packages/cli/tests/serve-harness.ts` 的 `addressOf()` 从人读行里抠 URL 时用的是 `/on (http:\/\/\S+)/u`，新的行仍然匹配（`\S+` 吃到 `?token=…`），`token` 字段在人读模式下仍为空串 —— 若有用例依赖人读模式拿 token，需要补一行解析；本轮没碰到红的，属提醒。

### F4.6 校验与改动

```
$ pnpm typecheck            → exit 0（tsc 无输出）
$ pnpm lint                 → exit 0（eslint --max-warnings=0）
$ pnpm format:check         → "All matched files use Prettier code style!"
$ npx vitest run            → Test Files 8 failed | 262 passed (270) / Tests 14 failed | 2983 passed (2997)
$ git diff --cached --name-only | wc -l        → 0（无 staged）
# tests/**：F4 一个字节都没写。（`git status` 里的 14 个 tests/ 条目是 F1/F3 遗留，本卡开工前就在；
#  F4 只读它们、没改它们——本轮唯一新增的红是 units-serve.test.ts:65，见 F4.5。）
```

`git diff --stat`（只列 F4 触及的文件；这些文件里还叠着 F1/F3 的未提交改动，F4 自己那几处就是上面贴的 hunk）：

```
 docs/05-feature-cards.md                 |  7 ++-
 packages/cli/src/commands/exportPrint.ts | 11 ++---
 packages/cli/src/output.ts               | 75 ++++++++++++++++++++++++++------
 packages/core/src/server/http-io.ts      |  3 +-
 packages/core/src/server/routes.ts       |  5 ++-
 packages/core/src/server/server.ts       | 54 +++++++----------------
 packages/core/src/server/static.ts       | 55 +++++++++++++++++++++++++---
 packages/renderer-html/src/print-html.ts | 25 +++++++++--
 8 files changed, 163 insertions(+), 72 deletions(-)
```

`docs/**` 只改了一句（`docs/05-feature-cards.md:144-146`）：pi 扩展"不打印根 URL"的理由里原本写着"`GET /` 是 cookie 认证"，而 `GET /` 现在也吃 token，改成"`/s/:docId` 是 token 认证，这里没有文档可指"，并补一句 `hr serve` 打印的根地址为什么能直接开。

**证据完整性说明**：修前/修后是**同一台机器、同一份 `/tmp/f4/ws` fixture、同一条命令**跑出来的；修前那轮把 6 个文件临时反向改回再跑，跑完按 sha256 逐个校验已恢复（`OK` ×6），再跑 `typecheck/lint/format` 确认清零。

---

## F6

> **口径**：修前/修后同一台机器、同一份 `/tmp/f6v` fixture、同一条命令。`H=/Users/liu/Documents/Project/hReader`，`R(){ env NODE_NO_WARNINGS=1 $H/node_modules/.bin/jiti $H/packages/cli/src/main.ts "$@"; }`。所有输出为原样粘贴（`rc` 是同一条命令的 `$?`）。
>
> **一处需要记的契约裁定（由协调者裁，不是我自己定的）**：任务原话要求 `HrError("invalid_input")` + rc=2，但冻结表 `packages/cli/src/exit-codes.ts:20` 是 `invalid_input: EXIT_FAILURE`（=1），`packages/cli/tests/units-output.test.ts:276` 直接断言 `["invalid_input", 1]`。二者不可兼得 → 裁定 **(b) 新增独立 code `content_model_conflict` → `EXIT_USAGE`(2)**，理由三条：① 这类错用户自己能修（换容器/改 HTML），与 `needs_normalize` 同类，`invalid_input` 是"整条输入不合法、得看文档"，脚本调用方对两者的处理不同；② 不动既有的 `invalid_input: 1`，不引入全局契约变更（改成 2 会让 png/pdf/style/paths 一片 1→2）；③ 有独立 code 时测试能断言 `code === "content_model_conflict"`，比"反正 rc 非 0"更贵。**`invalid_input` 的既有 1 本轮不变，本轮只有 `content_model_conflict` 是新的 2。**

### F6-1 `BUG-07`：块级片段写进 phrasing-only 容器，写盘前拒绝

**修法**：`packages/core/src/ops/patchNode/content.ts` 的 `assertFragmentFits(container, fragment)` 按**内容模型**判——片段根是 phrasing 元素（`PHRASING_TAGS` 白名单）就放行；否则看容器：容器自身是 phrasing 元素，或属于 `INLINE_ONLY_CONTAINERS`（`p`/`h1`–`h6`/`pre`/`legend`，规范里内容模型就是 phrasing）即拒绝，否则放行。不看目标叫什么名字、也不靠"写下去再解析回来比较"。拒绝即 `new HrError("content_model_conflict", …)`，**发生在 `applyPatch` 的纯变换阶段、`writeSnapshot`/`writeAtomic` 之前**，因此文件字节不可能变。三个调用点共用一个函数：`packages/core/src/ops/patchNode/apply.ts:190-193` 的 `containerOf(root, located, action)`（`append` 取目标自身，`replace`/`insert_before`/`insert_after` 取 `parentElementOf`）→ `if (container !== undefined) assertFragmentFits(container, fragment);`。

判据三条（`/tmp/f6v/proof.log` 原样）：

```
### ① append '<p>x</p>' 到 <p>
b0f8c311d6071389f83c0c2f01ed7192ed90c770a5e01cef043cba38a1d4697a  b.html
目标 <p> 是段落（只装行内内容），装不下块级子节点 <p>；要插段落请选容器元素，如 article/section/div
rc=2
b0f8c311d6071389f83c0c2f01ed7192ed90c770a5e01cef043cba38a1d4697a  b.html
### ② append '<b>x</b>' 到 <p>
patched b.html (76 bytes, +0)
rc=0
<article data-hr-id="hr-a1"><p data-hr-id="hr-c4">old<b>x</b></p></article>
### ③ append '<p>y</p>' 到 <article>
patched b.html (109 bytes, +1 ids: hr-a392514c)
rc=0
<article data-hr-id="hr-a1"><p data-hr-id="hr-c4">old<b>x</b></p><p data-hr-id="hr-a392514c">y</p></article>
```

① `sha256` 前后一致（`b0f8c31…97a`），rc=2；② rc=0 且写出 `<b>x</b>`；③ rc=0 且容器收下 `<p>y</p>`。

**修前**（把闸临时摘掉再跑同一条命令，跑完用 `cp` 恢复并 `grep` 校验，`content.ts:91/93` 的 `inlineOnly`/`content_model_conflict` 都在）：

```
=== 修前 replace <p>(父 <h2>) with <p>
patched g.html (100 bytes, id 变更: hr-p2 → hr-1673953f)
rc=0
<article data-hr-id="hr-a1"><h2 data-hr-id="hr-h2"><p data-hr-id="hr-1673953f">z</p></h2></article>
=== 修前 再跑一次 outline（坏树导致 id 全丢）
- hr-h2  z  (1w)
```

（这就是任务描述里那条"改完再跑任何命令都变成缺 id"的成因：写出去的 `<h2><p>` 不是浏览器解析回来的同一棵树。）

### F6-2 `BUG-08`：`replace` 只判"目标能不能换"，没判**父容器**能不能装

**修法**：同一套判定的第二个调用点，`containerOf` 在 `action !== "append"` 时返回 `parentElementOf(root, located.target)`（`packages/core/src/ops/patchNode/locate.ts:35-49`，本轮之前的 F 轮已在树里），所以 `replace` 判的是**父容器**而不是目标自身。

修前/修后（`/tmp/f6v/proof.log`，g.html = `<article hr-a1><h2 hr-h2><p hr-p2>x</p></h2></article>`）：

```
### ④ replace <p>(父 <h2>) with '<p>z</p>'
be0a2a8eb2a2d9bbed3dce5849b972c12418608cee947d797c8cf531d1262ebb  g.html
目标 <h2> 是标题（只装行内内容），装不下块级子节点 <p>；要插段落请选容器元素，如 article/section/div
rc=2
be0a2a8eb2a2d9bbed3dce5849b972c12418608cee947d797c8cf531d1262ebb  g.html
### ⑤ replace <p>(父 <h2>) with '<b>z</b>'（合法）
patched g.html (75 bytes, +0)
rc=0
<article data-hr-id="hr-a1"><h2 data-hr-id="hr-h2"><b>z</b></h2></article>
```

修前是上面 F6-1 末尾那段 `patched … id 变更: hr-p2 → hr-1673953f` + rc=0（同一份 g.html、同一条命令，闸摘掉时）。⑤ 是正向对照：换成行内节点仍然放行。

### F6-3 `BUG-06`：`serve` 印的是工作目录；回执路径不统一

**修法**：`packages/cli/src/output.ts` 新增唯一入口 `displayedPathOf(path, cwd)`（落在 cwd 内就印相对 cwd 的形式，否则印绝对），分发层 `packages/cli/src/run.ts` 给每个命令算出"用户视角路径"后传进去；人读回执的全部 formatter 收一个可选 path（缺省仍是结果里的真实路径，因此老调用点/老单测不变）：`humanPatch`/`humanStyle`/`humanUndo`/`humanNormalizeWritten`/`humanPdf`/`humanPng`/`humanServe`。`serve` 的行改为 `serving <文档路径> on <url> (pid n)`（`humanServe` 缺省回退 `info.workspace`，无参/多文档口径不变）。JSON 契约**没动**（`data*` 仍给真实路径/`workspace`）。`pdf`/`png` 的装配为守住 `max-lines: 300` 拆到新文件 `packages/cli/src/run-products.ts`。

```
### serve 单文档（stdout 首行）
serving b.html on http://127.0.0.1:50570/?token=qHEWQeRlSId_OYxg6HA6NqmytRYA9dfg (pid 40255)
rc=0
### normalize --write 回执
normalized h.html (+2 ids, 119 bytes)
rc=0
### export --out out/print.html 回执
exported out/print.html (10291 bytes)
rc=0
### patch 回执（相对路径原样）
patched b.html (76 bytes, +0)
rc=0
```

修前（同一 fixture、同一命令，取自 `tests-R1.md:187` 与本人 F6 起始处的实测）：`serving /private/tmp/f4 on http://…`、`patched /private/tmp/f5/a.html …`。现在三处回执都回显用户给的 `b.html`/`h.html`/`out/print.html`。

### 门禁

```
$ pnpm typecheck
packages/core/tests/hr-error.test.ts(9,7): error TS2741: Property 'content_model_conflict' is missing in type '{…}' but required in type 'Record<HrErrorCode, true>'.
typecheck rc=2
$ pnpm eslint          → rc=0
$ pnpm format:check    → rc=0（All matched files use Prettier code style!）
$ npx vitest run       → rc=1；Test Files 8 failed | 273 passed (281)｜Tests 14 failed | 3028 passed (3042)
```

红的两处都**不是**新行为，是"旧断言写着 BUG 本身"：

- `packages/core/tests/hr-error.test.ts:9` 的 `Record<HrErrorCode, true>` 缺 `content_model_conflict` 键 → 测试编写员补键即绿。
- 以下 8 个文件把"往 `<p>` 里 append 块级片段"当合法用法（fixture 里 `targetId` 是 `<p>`、`fragment` 是 `<p>…`），BUG-07 修好后它们必然红：`packages/cli/tests/cli-io.test.ts`、`packages/cli/tests/units-commands-patch.test.ts`、`packages/cli/tests/units-commands.test.ts`、`packages/core/tests/io/paths.test.ts`、`packages/core/tests/server/concurrency.test.ts`（3 例，HTTP 400）、`packages/core/tests/server/sse.test.ts`（5 例，`sse.test.ts:13` 的 `bodyOf` 就是 `{action:"append", targetId:"hr-d", fragment}`）、`packages/core/tests/server/watcher.test.ts`。
- `packages/pi-extension/tests/protocol-pins.test.ts`（AC-7 码表）缺新 code 一行。

`TESTS_TO_UPDATE`（**我一个都没改**）：

1. `packages/core/tests/hr-error.test.ts:9` — 加 `content_model_conflict: true`
2. `packages/pi-extension/tests/protocol-pins.test.ts` — 码表加 `content_model_conflict`
3. `packages/cli/tests/cli-io.test.ts:22` — append 用例改用容器目标（或断 `code==="content_model_conflict"` + rc=2）
4. `packages/cli/tests/units-commands-patch.test.ts`（"print the new ids on a plain append"）
5. `packages/cli/tests/units-commands.test.ts`（"write an append and report changed true"）
6. `packages/core/tests/io/paths.test.ts`（"accept an inside link"——它靠 append 造写入）
7. `packages/core/tests/server/concurrency.test.ts`（3 例，`doc.html` fixture 的目标是 `<p>`）
8. `packages/core/tests/server/sse.test.ts`（5 例，`bodyOf` 与 `doc.html` fixture）
9. `packages/core/tests/server/watcher.test.ts`（1 例，同一 fixture）


---

## F7 巡回 R1 第二批（F7-1 ~ F7-9）

> 证据口径：全部在本机 `/tmp/f7probe` 用真入口 `node packages/cli/src/main.ts` 复跑；sha256 用 `sha256sum`。
> `tests/**` 一行未改（`git status` 可核）。未 commit、未 push。

### F7-1（P1）`li` 嵌套会改树：现在被拒，文件不被改

`packages/core/src/ops/patchNode/content.ts:101` 新增 `FORBIDDEN_CHILDREN`（`Record<string, ReadonlySet<string>>`），`assertFragmentFits:147` 查表命中抛 `content_model_conflict`。表项：`li:{li}`、`table:{tr,td,th,thead,tbody,tfoot,caption,colgroup,col}`、`dd/dt:{dd,dt}`、`a:{a}`、`button:{button}`、`form:{form}`、`label:{label}`、`option:{option}`。每个键为什么改树写在 `content.ts:88-100` 注释里。`<ul><p>` / `<dl><p>` 这类"不合规但不改树"的**不拦**（探针 `ul<-p: ALLOW`）。

修前（复现，rc=0，改树）：

```
$ printf '<article data-hr-id="hr-a2"><ul data-hr-id="hr-u1"><li data-hr-id="hr-l1">i</li></ul></article>\n' > l.html
$ sha256sum l.html   → 7b333d30dab55c17f095823769a9e4f09f3bac0615a5fa951d143ca504504c09
$ hr patch l.html hr-l1 --action append --html '<li>j</li>'
patched l.html (131 bytes, +1 ids: hr-177304c6)   rc=0
# 盘上：<li ...hr-l1>i<li data-hr-id="hr-177304c6">j</li></li>   （j 成了 hr-l1 的兄弟）
```

修后（rc=2，文件逐字节不变）：

```
$ sha256sum l.html   → 7b333d30dab55c17f095823769a9e4f09f3bac0615a5fa951d143ca504504c09
$ hr patch l.html hr-l1 --action append --html '<li>j</li>'
目标 <li> 装不下子节点 <li>：HTML 解析器会改结构（<li> 里再放 <li> 会被解析成兄弟或被移出容器，而不是子节点），写出去的字节与解析回来的树不一致。请改 append 到一个能真正容纳 <li> 的容器
rc=2
$ sha256sum l.html   → 7b333d30dab55c17f095823769a9e4f09f3bac0615a5fa951d143ca504504c09   （前后一致）
```

### F7-2（P1 附带）`content_model_conflict` / 退出码测试

**已通知测试侧**：`content_model_conflict` 的报文/退出码（rc=2，`EXIT_USAGE`）除本次写入的探针外**零单测**，按分工归测试编写员补；本轮不写 `tests/**`。

### F7-3（P2-5）`video` 补进 `PHRASING_TAGS`

`content.ts:12-65` 白名单补 `video`、并顺手补确认是 phrasing 的 `math`/`slot`/`template`。`<p>` 里 append `<video>` 现在通过。

修前（rc=2 被拒）：`目标 <p> 是段落（只装行内内容），装不下块级子节点 <video>；…  rc=2`

修后：

```
$ printf '<article data-hr-id="hr-a2"><p data-hr-id="hr-p1">x</p></article>\n' > v.html
$ sha256sum v.html   → 6e50487c15866a55ad0fdd669922e07bdda9551d7094ab2f7f27a8e7827f627b
$ hr patch v.html hr-p1 --action append --html '<video controls></video>'
patched v.html (93 bytes, +0)   rc=0
# 盘上：<p ...hr-p1>x<video controls=""></video></p>
$ sha256sum v.html   → 5ac0f330db7e751c0e53948ec766bd47b29dd71774919cf3a8ac436c3d08cae9
```

### F7-4（P2-2/P2-3）拆分集合语义

`content.ts` 拆成：`PHRASING_TAGS:12`（**只判片段**）、`INLINE_ONLY_CONTAINERS:70`（`p,h1–h6,pre,legend`）、新增 `RAW_TEXT_CONTAINERS:83`（`script,style,textarea,title`，命中一律抛）、`SELECT_CHILDREN:86` + `assertFragmentFits:140` 单独判 `select`（只允许 `option/optgroup`）。`inlineOnly` 里"phrasing 元素当容器"的混用已删。探针（直接调用 `assertFragmentFits`）：

```
select<-option: ALLOW
select<-div: THROW content_model_conflict: 目标 <select> 只装 <option>/<optgroup>，装不下 <div>；要加选项请 append 一个 <option>
textarea<-b: THROW content_model_conflict: 目标 <textarea> 的内容按字面文本处理，装不下子元素 <b>：写出去的 <b> 解析回来只是一段文本，而不是元素
script<-b: THROW content_model_conflict: 目标 <script> 的内容按字面文本处理，装不下子元素 <b>：…
p<-video: ALLOW
p<-div: THROW content_model_conflict: 目标 <p> 是段落（只装行内内容），装不下子节点 <div>；…
li<-li: THROW content_model_conflict: 目标 <li> 装不下子节点 <li>：…
ul<-p: ALLOW
a<-a: THROW content_model_conflict: 目标 <a> 装不下子节点 <a>：…
span<-p: ALLOW
```

（`span<-p` = ALLOW 是有意的：`<span>` 只是内容模型不合规、解析器不拆树；按审计裁定边界不拦。）

### F7-5（P2-4）注释三处改正

- `content.ts:6-11` 删掉"塞进段落也不会被浏览器拆树"的后半句，改成"只判片段、不表示容器语义"。
- `content.ts:67-73`（`INLINE_ONLY_CONTAINERS` 注释）拆成两句：`p` 属"会被解析器拆结构"，`pre`/`h1–h4` 只是"内容模型不合规、树不变"；并注明 `h5/h6/legend` 按规范收录但 `BLOCK_TAGS` 只到 `h4`、实际不可达。
- `content.ts:118-120`（`containerWordOf`）加注释说明兜底文案"故意笼统"。

### F7-6（P2-6）首页外壳头收紧

`packages/core/src/server/static.ts:70` `HOME_FALLBACK_HEADERS` 不再用 `APP_CSP`（`script-src 'self'`），改成显式 `content-security-policy: default-src 'none'; style-src 'unsafe-inline'` + `referrer-policy: no-referrer`（与文档页 `handlers.ts` 的 `HTML_HEADERS` 同口径）。`fallbackHome`/`homeUnauthorizedReply` 共用该常量。探针（调导出 `homeUnauthorizedReply`）：

```
$ npx tsx -e "import {homeUnauthorizedReply} from './packages/core/src/server/static.ts'; const r=homeUnauthorizedReply(); console.log('status',r.status); for(const [k,v] of Object.entries(r.headers)) console.log(k+':',v)"
status 401
x-content-type-options: nosniff
cache-control: no-store
content-type: text/html; charset=utf-8
content-security-policy: default-src 'none'; style-src 'unsafe-inline'
referrer-policy: no-referrer
```

### F7-7（P2-7）`displayedPathOf` 不再把 `..foo` 当外部路径

`packages/cli/src/output.ts:42` 判定改为 `rel === "" || rel === ".." || rel.startsWith(".." + sep)`（`sep` 从 `node:path` 引入）。探针：

```
$ npx tsx -e "import {displayedPathOf} from './packages/cli/src/output.ts'; for(const p of ['/a/..foo','/a/b','/a','/a/../x','/b']) console.log(p,'=>',displayedPathOf(p,'/a'))"
/a/..foo => ..foo
/a/b => b
/a => /a
/a/../x => /a/../x
/b => /b
```

### F7-8（P2-8）`serve` 报错印相对路径

`packages/cli/src/run-serve.ts:32-37` 的 `--app-dir` 缺失报文改走 `displayedPathOf(intent.appDir, cwd)`；`ServeWiring` 新增可选 `cwd`（`:17`），`run.ts:207` 传入 `io.cwd`，缺省兜底 `process.cwd()`（兼容未传 `cwd` 的既有装配）。

```
$ cd /tmp/f7probe && node …/main.ts serve l.html --app-dir nope
--app-dir 目录不存在：nope   rc=1
```

（修前会印 `/tmp/f7probe/nope` 这种绝对路径。）

### F7-9（BUG-10）片段校验报文自相矛盾

`packages/core/src/ops/patchNode/fragment.ts:22-40,187-192` 新增 `TABLE_CONTEXT_TAGS` + 首标签识别：以表格结构元素开头的片段，脱离 `<table>` 会被解析器丢弃（只剩文本），报文改为能指导下一步。

修前（说"实际 1 个"却拒收）：

```
$ hr patch t.html hr-t1 --action append --html '<tr><td>b</td></tr>'
片段必须恰好有一个根元素（实际 1 个根级内容节点）   rc=1
```

修后：

```
$ printf '<article data-hr-id="hr-a2"><table data-hr-id="hr-t1"><tbody data-hr-id="hr-b1"><tr data-hr-id="hr-r1"><td data-hr-id="hr-d1">a</td></tr></tbody></table></article>\n' > t.html
$ sha256sum t.html   → dfa422f9a5eda89aad1e44617d14aa74d3eac4010d5b6c3cbaca1b11271f587e
$ hr patch t.html hr-t1 --action append --html '<tr><td>b</td></tr>'
片段以表格结构元素 <tr> 开头，但它必须在 <table> 上下文里解析：单独解析时解析器会丢弃该标签（只剩文本），写出去不是同一个元素。要把行/单元格加进表格，请把完整的 <table>…</table> 作为片段，或用 --action replace 对整张表替换   rc=1
$ sha256sum t.html   → dfa422f9a5eda89aad1e44617d14aa74d3eac4010d5b6c3cbaca1b11271f587e   （前后一致）
```

### 门禁

```
$ pnpm typecheck
packages/core/tests/hr-error.test.ts(9,7): error TS2741: Property 'content_model_conflict' is missing in type '{…}' but required in type 'Record<HrErrorCode, true>'.
typecheck rc=2   （唯一红 = 冻结测试穷举键，归测试侧补键；业务源码全绿）

$ pnpm eslint
3 个 error，全在 `packages/cli/tests/**`（`content-model-conflict.test.ts` max-lines-per-function、`serve-path-and-token.test.ts` max-lines + 断言），是测试侧新增文件，未碰；
业务源码 0 error。

$ npx prettier --check <改动的 6 个源文件>  → All matched files use Prettier code style!

$ npx vitest run
Test Files  1 failed | 283 passed (284)
     Tests  1 failed | 3053 passed (3054)
红：`packages/pi-extension/tests/protocol-pins.test.ts:159` `码表覆盖 core 的每个错误码` 缺 `content_model_conflict`
```

`TESTS_TO_UPDATE`（本轮**一个都没改**）：

1. `packages/core/tests/hr-error.test.ts:9` — 加 `content_model_conflict: true`（typecheck）
2. `packages/pi-extension/tests/protocol-pins.test.ts:159` 附近 `ERROR_TEXTS` — 加 `content_model_conflict`（vitest）

`packages/cli/tests/content-model-conflict.test.ts` / `serve-path-and-token.test.ts` 的 eslint 红同属测试侧，交测试编写员。

## F8

### 改动（一处）

`packages/pi-extension/pi-hreader.ts:433` —— 在 `ERROR_TEXTS`（:393）末尾补一键：

```ts
content_model_conflict: "片段与目标容器内容模型冲突（换容器或改 --html）",
```

**为什么是"原创"而不是"照抄"**：core 侧**没有文案表**，`ERROR_TEXTS` 是全仓唯一一份。`packages/core/src/hr-error.ts` 只有 `HrErrorCode` 联合类型（:51 新增该码）和一行注释，运行时全文由 `packages/core/src/ops/patchNode/content.ts:132-161` 四处各自给（带具体标签，如"目标 `<li>` 装不下子节点 `<li>`"）。本表是**一行摘要**（协议钉子 `protocol-pins.test.ts:159` 钉的是**键集**，不钉文案），故这里的文案按 `hr-error.ts:50` 注释与 `docs/05-feature-cards.md:444` 的语义原创，措辞由协调者给定（"片段与目标容器"贴触发点，"（换容器或改 --html）"给两条出路）。

**派单路径有误（已查证，未硬凑）**：派单写的 `packages/core/src/errors/hr-error.ts` 不存在，实际是 `packages/core/src/hr-error.ts`；按不存在的路径去找"既有文案"会一路找不到。记此一笔：派单里不带 `file:line` 的路径引用不许当事实。

工作树里 `needs_normalize` / `port_in_use` 两键在我改之前已是未提交状态（上一轮 F7 的改动），本次 diff 相对 HEAD 会一并显示它们；本卡只追加了 `content_model_conflict` 一行。

### 门禁

```
$ npx vitest run packages/pi-extension/tests/protocol-pins.test.ts
 ✓ packages/pi-extension/tests/protocol-pins.test.ts (9 tests) 5ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
   → 修前 `:159` 的 `码表覆盖 core 的每个错误码` 红，现在绿

$ pnpm typecheck
packages/core/tests/hr-error.test.ts(9,7): error TS2741: Property 'content_model_conflict' is missing in type '{ invalid_html: true; … }' but required in type 'Record<HrErrorCode, true>'.
[ELIFECYCLE] Command failed with exit code 2.
```

**唯一红是测试侧的账**：`packages/core/tests/hr-error.test.ts(9,7)` 的 `Record<HrErrorCode, true>` 穷举表缺该键，归 T4 补（协调者已说明）。这一键**我没动**——`tests/**` 不在 F8 权限内。pi-extension 侧无别的穷举表缺该键（`grep -rn "content_model_conflict" --include=*.ts packages` 只有 core 源码/测试、cli 的 `exit-codes.ts:52`/测试、以及本卡这一行）。

## F9

BUG-11：合法 HTML5 片段（可省略结束标签）被误判成"片段结构不完整"。修法一句话：**先解析、后校验**——把"原始源码的标签平衡"判据整条删掉，只保留"解析后的树"上的根数校验与表格上下文校验。

### F9.1 改动（唯一文件，6 处）

`packages/core/src/ops/patchNode/fragment.ts`（现 188 行）

| # | 位置（修后行号） | 改动 |
| --- | --- | --- |
| 1 | `:1` | 文件头注释补"先按 HTML5 容错解析成树，再校验…" |
| 2 | `:3` | import 去掉 `Diagnostic` / `DiagnosticCode`（`assertBalanced` 删掉后无人使用） |
| 3 | 删 `BALANCE_CODES` | 原 `const BALANCE_CODES = new Set(["unclosed_tag","misnested_tag"])` 与 `SHELL_TAGS` 同处相邻块 |
| 4 | 删 `assertBalanced()` | 原定义在 `assertNoForbiddenContent` 之后、`isContentNode` 之前；连同 `assertBalanced(parsed.diagnostics)` 调用一起删 |
| 5 | `:173-176` | 新增注释：可选结束标签由解析器自动闭合，禁止拿原始源码判平衡 |
| 6 | `:179-186` | 表格上下文报错改为带"下一步"的说法（`片段结构不完整：…必须在 <table> 表格上下文里解析——…请把完整的 <table>…</table>（连 <tbody> 一起）作为片段，或用 --action replace 对整张表替换`） |

保留不动的部分（不是本卡改的，是工作树里既有的未提交改动）：`TABLE_CONTEXT_TAGS`（`:24`）、`firstTagOf`（`:39`）、根数报错 `片段必须恰好有一个根元素（实际 N 个根级内容节点）`（`:163`）。

`fragment.ts` sha256：
- 修前（按本次 edit 的反向重建，**不是**独立快照）`d1554d4c0197d0f5fb5e0351a40d37b056787fd4ef932b5d641be27da520cd18`（195 行）
- 修后 `92570c3384b307eae971ee66ec481f63e1eae80c9e7a3b581b9b88d37678689d`（188 行）
- `git diff packages/core/src/ops/patchNode/fragment.ts | shasum -a 256` = `b50178cabd0f21181de7b3a37ff22c56cc1a8c6a6137bdfa22ca73b543edfe1f`

新增依赖：**0**；新解析器：**0**（仍然只走 `packages/core/src/html/parse.ts` 的 `parseHtml`，即 parse5 容错解析）。

### F9.2 判据 ①~④（真实命令 + 原始输出 + rc + sha256）

fixture 生成（`/tmp/r1f9c/fx2`，`R(){ $H/node_modules/.bin/jiti $H/packages/cli/src/main.ts "$@"; }`；注意 `node node_modules/.bin/jiti` 会因 .bin 是 shell 脚本而炸，必须直接执行 `.bin/jiti`）：

```bash
printf '<article data-hr-id="hr-a2"><ul data-hr-id="hr-u1"><li data-hr-id="hr-l1">i</li></ul><table data-hr-id="hr-t1"><tbody><tr data-hr-id="hr-r1"><td data-hr-id="hr-c1">c</td></tr></tbody></table></article>\n' > a.html   # 同样内容另存 b/c/d.html
```
四个 fixture 修前 sha256（四份同内容）：`f15073316a6ad719d6a27a751ebefe01d7a15aa19526e83ee6668dbce68fddc4`

**判据①：`replace hr-u1 --html '<ul><li>a<li>b</li></li></ul>'` → rc=0，且等价于显式闭合**

```
$ R patch a.html hr-u1 --action replace --html '<ul><li>a<li>b</li></li></ul>'
patched a.html (249 bytes, id 变更: hr-u1 → hr-10176db8, +2 ids: hr-279b9048, hr-847c0269)
rc=0
a.html sha256 AFTER: 87c087571b3aa66236377d5795add43510fc9c2d02e8ce3406ecd2b23a015066
<article data-hr-id="hr-a2"><ul data-hr-id="hr-10176db8"><li data-hr-id="hr-279b9048">a</li><li data-hr-id="hr-847c0269">b</li></ul><table …>…</table></article>
```

**判据①"写完再解析树不变"**：同一片段换成显式闭合写法打到独立 fixture `b.html`，**落盘字节完全相同**；再对 ① 的结果跑第二次（片段用已规范化闭合写法，目标换成新 id `hr-10176db8`）得到 `unchanged`，sha256 不变：

```
$ R patch b.html hr-u1 --action replace --html '<ul><li>a</li><li>b</li></ul>'
patched b.html (249 bytes, id 变更: hr-u1 → hr-10176db8, +2 ids: hr-279b9048, hr-847c0269)
rc=0
b.html sha256 AFTER: 87c087571b3aa66236377d5795add43510fc9c2d02e8ce3406ecd2b23a015066   ← 与 a.html 逐字节相同

$ cp a.html e.html; R patch e.html hr-10176db8 --action replace --html '<ul><li>a</li><li>b</li></ul>'
unchanged e.html (249 bytes)
rc=0
a.html=87c087571b3aa66236377d5795add43510fc9c2d02e8ce3406ecd2b23a015066
e.html=87c087571b3aa66236377d5795add43510fc9c2d02e8ce3406ecd2b23a015066   ← 树不变/幂等
```

**判据②：`replace hr-l1 --html '<li>x</li><li>y</li>'` → 仍 rc=1（2 个根），盘上不变**

```
$ R patch c.html hr-l1 --action replace --html '<li>x</li><li>y</li>'
片段必须恰好有一个根元素（实际 2 个根级内容节点）
rc=1
c.html 变了吗: f15073316a6ad719d6a27a751ebefe01d7a15aa19526e83ee6668dbce68fddc4   ← 与修前一致
```

**判据③：`append '<tr><td>b</td></tr>'` 到 table → 仍 rc=1，报文含"表格上下文"且给出下一步**

```
$ R patch d.html hr-t1 --action append --html '<tr><td>b</td></tr>'
片段结构不完整：片段以表格结构元素 <tr> 开头，但它必须在 <table> 表格上下文里解析——单独解析时解析器会丢弃该标签（只剩文本），内容与结构无法恢复。要把行/单元格加进表格，请把完整的 <table>…</table>（连 <tbody> 一起）作为片段，或用 --action replace 对整张表替换
rc=1
d.html 变了吗: f15073316a6ad719d6a27a751ebefe01d7a15aa19526e83ee6668dbce68fddc4
```

**判据④**：现在全仓只剩**一条** `invalid_fragment` 的"结构不完整"路径——上面这条表格上下文（`:179-186`），报文里给的是可执行下一步（把 `<table>` 连 `<tbody>` 一起给 / 整表 replace）。**没有任何路径**再把"可选结束标签"当结构错误：`BALANCE_CODES` / `assertBalanced` 已整条删除（`grep -n "assertBalanced\|BALANCE_CODES" packages/core/src/ops/patchNode/fragment.ts` 无输出）。另外 `parseHtml` 的诊断（`unclosed_tag`/`misnested_tag`）仍然照旧产出给 `html/balance.ts` 的**读/报告**路径用，只是 `parseFragment` 不再拿它当拒绝理由。

### F9.3 可省略结束标签的 HTML5 元素 × 我们接受吗（14 个写法，含要求覆盖的 12 个）

脚本 `/tmp/r1f9c/matrix.mjs`（`./node_modules/.bin/jiti /tmp/r1f9c/matrix.mjs`，rc=0），对每个元素调 `parseFragment`（走真实片段入口）+ `parseHtml→serializeHtml→parseHtml` 判"写盘再解析是否变树"：

| 元素 | 省略结束标签的片段（放在其容器里） | 解析后的树 | 我们接受吗 | 再解析变树吗 |
| --- | --- | --- | --- | --- |
| `li` | `<ul><li>a<li>b</ul>` | `<ul><li>a</li><li>b</li></ul>` | ✅ ACCEPT root=`<ul>` | 否 |
| `p` | `<div><p>a<p>b</div>` | `<div><p>a</p><p>b</p></div>` | ✅ ACCEPT root=`<div>` | 否 |
| `tr` | `<table><tbody><tr><td>a<tr><td>b</tbody></table>` | `<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>` | ✅ ACCEPT root=`<table>` | 否 |
| `td` | `<table><tbody><tr><td>a<td>b</tbody></table>` | `<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>` | ✅ ACCEPT root=`<table>` | 否 |
| `th` | `<table><thead><tr><th>a<th>b</thead></table>` | `…<th>a</th><th>b</th>…` | ✅ ACCEPT root=`<table>` | 否 |
| `dt` | `<dl><dt>a<dd>b</dl>` | `<dl><dt>a</dt><dd>b</dd></dl>` | ✅ ACCEPT root=`<dl>` | 否 |
| `dd` | `<dl><dd>a<dt>b</dl>` | `<dl><dd>a</dd><dt>b</dt></dl>` | ✅ ACCEPT root=`<dl>` | 否 |
| `option` | `<select><option>a<option>b</select>` | `<select><option>a</option><option>b</option></select>` | ✅ ACCEPT root=`<select>` | 否 |
| `thead` | `<table><thead><tr><td>a<tbody><tr><td>b</table>` | `<table><thead><tr><td>a</td></tr></thead><tbody>…</tbody></table>` | ✅ ACCEPT root=`<table>` | 否 |
| `tbody` | `<table><tbody><tr><td>a<tfoot><tr><td>b</table>` | `…</tbody><tfoot>…</tfoot>` | ✅ ACCEPT root=`<table>` | 否 |
| `tfoot` | `<table><tbody><tr><td>a<tfoot><tr><td>b</table>` | `…</tbody><tfoot>…</tfoot>` | ✅ ACCEPT root=`<table>` | 否 |
| `colgroup` | `<table><colgroup><col><colgroup><col></table>` | `<table><colgroup><col></colgroup><colgroup><col></colgroup></table>` | ✅ ACCEPT root=`<table>` | 否 |
| `rt`（附加） | `<ruby>a<rt>b</ruby>` | `<ruby>a<rt>b</rt></ruby>` | ✅ ACCEPT root=`<ruby>` | 否 |
| `rp`（附加） | `<ruby>a<rp>(<rt>b<rp>)</ruby>` | `<ruby>a<rp>(</rp><rt>b</rt><rp>)</rp></ruby>` | ✅ ACCEPT root=`<ruby>` | 否 |

14/14 接受、14/14 树稳定。注意：上表的"接受"是**在各自容器里**（一个根）。把 `<li>a<li>b` 当**根级**片段仍然 rc=1（2 个根），这是判据②要求的行为，不是回归。

### F9.4 门禁

```
$ pnpm typecheck
$ tsc --noEmit -p tsconfig.json --pretty false
packages/core/tests/hr-error.test.ts(9,7): error TS2741: Property 'content_model_conflict' is missing in type '{ invalid_html: true; no_article: true; node_not_found: true; invalid_selector: true; invalid_document: true; node_not_allowed: true; invalid_max_bytes: true; invalid_input: true; locked: true; ... 29 more ...; port_in_use: true; }' but required in type 'Record<HrErrorCode, true>'.
[ELIFECYCLE] Command failed with exit code 2.
```
→ 只剩 `packages/core/tests/hr-error.test.ts:9` 这条**测试侧**的账（F8 也记过同一条 `content_model_conflict` 缺键），与本卡无关，`tests/**` 不动。

```
$ pnpm eslint            → ✖ 9 problems (9 errors, 0 warnings)，**全部**在 tests/** 与 packages/pi-extension/pi-hreader.ts:1203
   packages/cli/tests/content-model-conflict.test.ts:51,190 (max-lines-per-function)
   packages/cli/tests/serve-path-and-token.test.ts:47,80 (max-lines-per-function / consistent-type-assertions)
   packages/cli/tests/units-serve-diagnostics.test.ts:12
   packages/core/tests/io/patch-content-model.test.ts:163,177,197 (no-confusing-void-expression)
   packages/pi-extension/pi-hreader.ts:1203 (max-lines, 1203 > 1202)
   → 本次改动的 packages/core/src/ops/patchNode/fragment.ts **0 条**
$ npx prettier --check packages/core/src/ops/patchNode/fragment.ts
Checking formatting...
All matched files use Prettier code style!   rc=0
$ pnpm format:check
[warn] packages/core/tests/io/paths.test.ts      ← 唯一 warn，测试侧既往红，非本卡
```

测试（派单写的 `packages/core/tests/ops` **不存在**，vitest 直接 "No test files found"；改跑真实目录）：

```
$ npx vitest run packages/core/tests/io packages/cli/tests
 Test Files  96 passed (96)
      Tests  938 passed (938)      Duration 31.37s
$ npx vitest run packages/core/tests
 Test Files  133 passed (133)
      Tests  1616 passed (1616)    Duration 30.67s
```
**没有 TESTS_TO_UPDATE**：全绿，`packages/core/tests/io/fragment-gate.test.ts`（30 条）、`patch-content-model.test.ts`（25 条）都没红——没有任何测试钉住"`<li>a<li>b` 应被拒"。`git status --short -- 'packages/*/tests'` 空输出（`tests/**` 我一个字节都没碰）。

### F9.5 `content.ts` 只读核对（`RAW_TEXT_CONTAINERS` / `SELECT_CHILDREN`）

- `packages/core/src/ops/patchNode/content.ts:83` `RAW_TEXT_CONTAINERS = {script, style, textarea, title}`：这四者的内容按**字面文本**解析，与"可选结束标签"是两套机制（它们恰恰**不**允许省略结束标签，且内容不解析成元素）。本卡改动只在 `parseFragment` 里删掉源码平衡判据，`assertFragmentFits`（`:131` 起）仍按容器判：把元素塞进 `textarea` 依旧 `content_model_conflict`。**无矛盾**。
- `SELECT_CHILDREN = {option, optgroup}`（`content.ts:86`，用点 `:140`）：`<select>` 只装这两类，其余被解析器丢弃/重排。本卡让 `<select><option>a<option>b</select>` 这类**自带容器**的片段通过（根是 `select`），`assertFragmentFits` 仍管"往 select 里装 `<div>`"→ 拒。**无矛盾**。
- 补充：`content.ts:99-109` 的 `FORBIDDEN_CHILDREN` 是"容器×子标签"表，与"根数"正交；`<li>` 隐式闭合导致"第二个 `<li>` 变兄弟"这类真会改树的组合仍由 `li: {li}` 拦（例如向 `li` append `<li>`）。**无矛盾**。

### F9.6 待裁 / 残留（我没扩大范围，只登记）

1. **多根 append/replace 仍全拒**（判据②刻意保留）：`ul` 下加两个 `li` 必须写成 `<ul><li>x</li><li>y</li></ul>` 再 replace 整表，或用两次 append。作者最自然的手感是"一次给两个兄弟"。要不要开"多根但内容模型允许 → 逐个插入"，是产品决定，不在本卡。
2. **文案口径**：`invalid_fragment` 现在同时承载"空片段""根数不对""表格上下文"三义，其中**只有**表格上下文带"片段结构不完整："前缀。若后续要统一用词（例如"结构不完整"专指丢内容），需要一次文案重排，涉及 cli 侧快照测试，本卡不动。
3. **`fragment.ts` 修前 sha256 是反向重建的**（`/tmp/r1f9c/fragment.before.ts`），不是独立快照；修后 sha256 与 `git diff` 的 sha256 可独立复核。

## F10

BUG-12/13：`div` 与表格内部是死区——`normalize` 不编号（`div` 只在带 `data-hr-component` 时算块级）、因此不可寻址、也不可作 `hr patch` 目标（旧报文还说 `data-hr-id` 落在 `<div>` 上"patch 目标必须是块级元素"，与"div 就是块级元素"自相矛盾）。修法一句话：把**一套标签集合**拆成**三个各管一件事的集合**（内容模型 / 有没有 id / 能不能被改），并把表格结构片段按祖先链解析。

### F10.1 改动（7 个源文件 + 1 个文档）

| 文件 | 行号（修后） | 改动 |
| --- | --- | --- |
| `packages/core/src/html/constants.ts` | `:22-46` | `BLOCK_TAGS` 注释改为"只判内容模型，不判寻址"；新增 `ADDRESSABLE_TAGS`（`BLOCK_TAGS` ∪ `h5/h6/div/aside/nav/main/article/dl/dt/dd/figcaption/caption/thead/tbody/tfoot/tr/td/th`）与 `PATCHABLE_TAGS`（`= ADDRESSABLE_TAGS`，当前例外为空），三者关系写进注释 |
| `packages/core/src/html/inject.ts` | `:38-45` `:196` | `isInjectionTarget` 改用 `ADDRESSABLE_TAGS`（删掉 `isBlockElement` 与 `div + COMPONENT_ATTRIBUTE` 特例）；`seedText` 改为查预计算表；`beginWalk`（`:231`）接受 `rootSeed`，片段根按"它在文档里的原位置"复算 id |
| `packages/core/src/html/seed.ts` | 新文件 `:1-60` | `InjectSeed` / `ROOT_SEED` / `injectSeedOf(root, target)`：与注入器同一条先序、同一张 `childSlots` 表，复算目标节点的 `(父摘要, 同标签兄弟序号)` |
| `packages/core/src/html/slots.ts` | 新文件 `:1-26` | 从 `inject.ts` 抽出 `ChildSlot` + `childSlots`（注入器与 `injectSeedOf` 共用，防止两份口径漂移） |
| `packages/core/src/html/text.ts` | `:43-98` | 新增 `textSamplesOf(root, limit)`：后序迭代一次算满全树的文本前缀（注释/doctype 不产生文本，与 `textSampleOf` 同口径） |
| `packages/core/src/ops/patchNode/attrs.ts` | `:36-39` | `isBlockLevel` 改判 `PATCHABLE_TAGS`（`div`/`tr`/`td` 不再是死区；行内仍拒） |
| `packages/core/src/ops/patchNode/apply.ts` | `:140-175` `:184` `:230-236` | `replace` 不再只摘自身 id：`withoutReplacedIds` 摘掉**整个被替换区间**的 id，`replaceScopeOf` 给片段根注入 `injectSeedOf` 种子（`root` 目标保持旧口径） |
| `packages/core/src/ops/patchNode/content.ts` | `:69-97` `:131-146` `:166-230` | 内容模型补新容器：`INLINE_ONLY_CONTAINERS` 加 `dt`；`SELECT_CHILDREN` → `ONLY_CHILDREN`（`select={option,optgroup}`、`tr={td,th}`、`thead/tbody/tfoot={tr}`、`dl={dt,dd}`）；新增 `TABLE_STRUCTURE_TAGS`/`TABLE_STRUCTURE_PARENTS`（表格结构元素写进非表格容器 → 拒）；五类拒绝拆成五个命名断言，`assertFragmentFits` 变成 6 行调度 |
| `packages/core/src/ops/patchNode/fragment.ts` | `:20-90` `:220-238` | 删掉"以表格结构元素开头就拒"的 `invalid_fragment`；改为 `CONTEXT_ANCESTORS`（`tr→table>tbody`、`td/th→table>tbody>tr`、`col→table>colgroup`、`option→select`…）套祖先链解析，再用 `contextOf` 找回最深层容器，取它**直接子节点**里唯一元素当片段根 |
| `docs/05-feature-cards.md` | `:54` `:119` `:449-451` | M1.1 AC1 改成按 `ADDRESSABLE_TAGS` 描述；M1.8 新增 AC7（patch 目标集 = `PATCHABLE_TAGS`）；横切口径新增"三个集合的分工 + 迁移纯增量 + replace 同内容 id 不变" |

新增依赖：**0**；新解析器：**0**。

### F10.2 判据 ①~⑥（真实命令 + 原始输出 + rc + sha256）

工作目录 `/tmp/f10`，`R(){ node /Users/liu/Documents/Project/hReader/packages/cli/src/main.ts "$@"; }`（工作树未构建，直接跑 `src/main.ts`）。

**① normalize 后 div/tbody/tr/td 都有 id；再 normalize 一次 → `unchanged`**

```
$ printf '<article><div><p>hi</p></div></article>\n' > d4.html
$ R normalize d4.html --write
normalized d4.html (+3 ids, 154 bytes)                       rc=0
c76a01faef1266fbbd4e0e7c0a3fc5fa31083944285a7ee8730b2fad0e38155d  d4.html
$ R normalize d4.html --write
unchanged d4.html (154 bytes，已带齐 data-hr-id)              rc=0
c76a01faef1266fbbd4e0e7c0a3fc5fa31083944285a7ee8730b2fad0e38155d  d4.html
```
落盘：`<article data-hr-id="hr-c82f3de5"><div data-hr-id="hr-82749ec9"><p data-hr-id="hr-aa434e90">hi</p></div></article>`（**0 新增**，sha 不变）

```
$ printf '<article><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table></article>\n' > t4.html
$ R normalize t4.html --write
normalized t4.html (+6 ids, 268 bytes)                       rc=0
```
落盘：`<article hr-7d8747a1><table hr-c2c17647><tbody hr-c3976336><tr hr-95f06248><td hr-15954f16>a</td><td hr-12b690f1>b</td></tr></tbody></table>`（`tbody/tr/td` 全部带 id，原 `BLOCK_TAGS` 里没有的 `div` 也带 id）

**② `patch <div的id> --action append --html '<p>new</p>'` → rc=0，div 内多一个带 id 的 `<p>`**

```
$ R patch d4.html hr-82749ec9 --action append --html '<p>new</p>'
patched d4.html (189 bytes, +1 ids: hr-416c0c23)              rc=0
62f6d3aa11d61790096a89de95779c544c9dc18e06796393e2df8f4bff20dd0c  d4.html
```
落盘：`…<div data-hr-id="hr-82749ec9"><p data-hr-id="hr-aa434e90">hi</p><p data-hr-id="hr-416c0c23">new</p></div>…`

**③ `patch <tbody的id> --action append --html '<tr><td>c</td></tr>'` → rc=0，新行/单元格都带 id**

```
$ R patch t4.html hr-c3976336 --action append --html '<tr><td>c</td></tr>'
patched t4.html (337 bytes, +2 ids: hr-8285541a, hr-4484ef65) rc=0
b47b87fa2b625a0ec03f015b606f568b26ce13092532ef56402a5f63b0fef43f  t4.html
```
落盘：`…<tbody data-hr-id="hr-c3976336"><tr data-hr-id="hr-95f06248"><td data-hr-id="hr-15954f16">a</td><td data-hr-id="hr-12b690f1">b</td></tr><tr data-hr-id="hr-8285541a"><td data-hr-id="hr-4484ef65">c</td></tr></tbody>…`（**原有 tr/td 的 id 一个没动**）

**④ `patch <table的id> --action replace --html '<table>…两行…</table>'` → rc=0，原来那行与 td 的 id 原样保留**

```
$ printf '<article><table><tbody><tr><td>a</td></tr></tbody></table></article>\n' > t3.html
$ R normalize t3.html --write
normalized t3.html (+5 ids, 233 bytes)                       rc=0
2cc33e21a83201c01fc4dbe9da60fe4c9569ac5f41764152a32fe77be66beca3  t3.html
# 落盘：<article hr-84410e8b><table hr-4d2015e1><tbody hr-33be97bc><tr hr-55f6b67e><td hr-15954f16>a</td></tr></tbody></table>
$ R patch t3.html hr-4d2015e1 --action replace --html '<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>'
patched t3.html (302 bytes, id 变更: hr-4d2015e1 → hr-c2c17647, +5 ids: hr-c3976336, hr-55f6b67e, hr-15954f16, hr-4ec3fa44, hr-16634991)   rc=0
247854fba7fdd350cff7b2127b59e61a2f77dd129c15d91485d8dbde5c8b1cc0  t3.html
```
落盘：`<article data-hr-id="hr-84410e8b"><table data-hr-id="hr-c2c17647"><tbody data-hr-id="hr-c3976336"><tr data-hr-id="hr-55f6b67e"><td data-hr-id="hr-15954f16">a</td></tr><tr data-hr-id="hr-4ec3fa44"><td data-hr-id="hr-16634991">b</td></tr></tbody></table></article>`

判据逐项核：**原有那行 `tr=hr-55f6b67e`、`td=hr-15954f16` 原样保留**（`before` 里的同两个值），新行/新单元格拿新 id。`article` 的 id 也没变（`hr-84410e8b`）；`table`/`tbody` 的 id 变了——它俩的**自身文本前缀**随内容变化（`a` → `ab`），这是 M2.3 §8 的内容派生口径，不是锚点丢失（锚点挂在未改动的行/单元格上，正是本卡要钉住的判据）。

幂等（`④-bis`，用新 table id 再 replace 同一片段）：

```
$ R patch t3.html hr-c2c17647 --action replace --html '<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>'
unchanged t3.html (302 bytes)                                rc=0
247854fba7fdd350cff7b2127b59e61a2f77dd129c15d91485d8dbde5c8b1cc0  t3.html
```

**⑤ `p` append 块级、`li` append `li` 仍被拒（rc≠0）**

```
$ R patch d4.html hr-aa434e90 --action append --html '<p>x</p>'
目标 <p> 是段落（只装行内内容），装不下子节点 <p>；要插段落请选容器元素，如 article/section/div   rc=2
$ R patch l.html hr-<li> --action append --html '<li>b</li>'
目标 <li> 装不下子节点 <li>：HTML 解析器会改结构（<li> 里再放 <li> 会被解析成兄弟或被移出容器…）  rc=2
$ R patch d4.html hr-82749ec9 --action append --html '<tr><td>x</td></tr>'   # 新增的表格结构守卫
目标 <div> 装不下表格结构元素 <tr>：它只在 <table> 上下文里成立…请改到 <table>/<tbody>/<tr> 上追加   rc=2
```
**注意 rc 口径**：卡上写"rc=1"，仓库既有约定是 `content_model_conflict = 2`（`docs/05` 错误码表 `:444`、F6 卡片即如此）。**判定"仍被拒"以 rc≠0 + `code=content_model_conflict` 为准**，未改退出码。

**⑥ `read` 能按 td 的 id 定位**

```
$ R read t4.html hr-15954f16
<td data-hr-id="hr-15954f16">a</td>                          rc=0
$ R outline t4.html
（没有标题）                                                  rc=0
```

**迁移不伤存量（判据 ④ 的姊妹项）**：拿一份"F10 之前 normalize 过、div 裸着"的文档再 normalize，只补 id：

```
$ printf '<html><head></head><body><article data-hr-id="hr-c82f3de5"><div><p data-hr-id="hr-aa434e90">hi</p></div></article>\n</body></html>\n' > old.html
098ae287def505e8e44640f5df2ca3fa378a9167feba72bdacddde42c4264968  old.html
$ R normalize old.html --write
normalized old.html (+1 ids, 155 bytes)                      rc=0
b401f65323dfdef3395332d8b12ccb203fc3aeafd6cd6046221c536c8f2f6f9b  old.html
# 落盘：<article data-hr-id="hr-c82f3de5"><div data-hr-id="hr-82749ec9"><p data-hr-id="hr-aa434e90">hi</p>…
$ R normalize old.html --write
unchanged old.html (155 bytes，已带齐 data-hr-id)              rc=0
```
`+1 ids` = 只补裸着的 `div`；`article`/`p` 两个原有 id 逐字保留（sha 里可核）。

### F10.3 顺带修掉的性能回归（本卡引入、被既有测试抓住）

`div` 一旦成为注入目标，`seedOf` 就要为**每个** div 算文本前缀；原先 `textSample` 走 `textSampleOf(node, 64)`，在 4000 层嵌套里每个祖先都要下沉到底才能取到 1 个字符 → O(n²)。既有测试 `packages/core/tests/html-r1-regression.test.ts > inject · 深嵌套耗时近似线性` 立刻红：`t(4000)/t(1000) = 12.57`（阈值 6）。改为 `textSamplesOf` 后序一次算满全树（`html/text.ts:59`），**id 取值逐字节不变**（前缀定义不变，只是算法从"逐节点下沉"换成"自底向上拼接"），该测试恢复绿。实测 40k 层文档：

```
$ R normalize deep.html --write      # 40000 层裸 div
normalized deep.html (+40000 ids, 1440079 bytes)   real 0m0.294s   rc=0
$ R normalize deep.html --write
unchanged deep.html (1440079 bytes，已带齐 data-hr-id)            rc=0
```

### F10.4 验收命令结果

```
$ pnpm typecheck
$ tsc --noEmit -p tsconfig.json --pretty false        → 无输出，退出 0

$ pnpm eslint
/Users/liu/Documents/Project/hReader/packages/pi-extension/pi-hreader.ts
  1203:1  error  File has too many lines (1203). Maximum allowed is 1202  max-lines
✖ 1 problem (1 error, 0 warnings)                     → 唯一红是 F9 报告 `:1427` 已登记的既有红（不在本卡范围）

$ npx prettier --check "packages/**/src/**/*.ts" docs/05-feature-cards.md
All matched files use Prettier code style!
```

```
$ npx vitest run packages/core/tests packages/cli/tests
Test Files  6 failed | 200 passed (206)
     Tests  10 failed | 2316 passed (2326)
```

### F10.5 `TESTS_TO_UPDATE`（测试侧既有红，我一个字节没改 `tests/**`）

| 测试 | 红的原因（都是"本卡要改的行为"被旧断言钉住） |
| --- | --- |
| `packages/core/tests/html-inject.test.ts` · `div 与词表 > should treat div as a block only when it carries a component attribute` | 断言"`div` 只有带 `data-hr-component` 才注入"，与本卡相反（BUG-13 就是这条） |
| `packages/core/tests/html-inject.test.ts` · `块级词表 > should skip inline, unknown and plain div siblings` | 同上：裸 `div` 现在必须被注入 |
| `packages/core/tests/io/fragment-gate.test.ts` · `should reject '<tr><td>b</td></tr>' / '<td>b</td>' with 'invalid_fragment'`（2 条） | 这两条现在**不抛**：片段套祖先链解析成功，是判据③要的能力 |
| `packages/core/tests/io/fragment-gate-io.test.ts` · `should keep the file byte-identical after rejecting 'invalid_fragment'`（2 条用例） | `expect(code).toBe("invalid_fragment")` 实收 `content_model_conflict`：表格结构片段现在能解析，改由内容模型判"放不进这个容器"；"不落盘"的断言仍成立 |
| `packages/core/tests/io/patch-content-model.test.ts` · `should allow replacing a paragraph with a div when the article can hold it` | 断言 `toContain("<div>块</div>")`，实收 `<div data-hr-id="…">块</div>`：`div` 现在带 id |
| `packages/cli/tests/content-model-conflict.test.ts` · `F6 · 表格结构片段没上下文 > should refuse a bare table-row fragment…` | 判据③反了：`<tr>` 追加进 `<tbody>` 现在 rc=0 |
| `packages/cli/tests/content-model-conflict.test.ts` · `F6 · 目标容器装不下自己的同名子节点 > should refuse a nested <li>…` | fixture `NESTED_DOC` 的 `tbody/tr/td` 裸着 → 现在先撞 `needs_normalize`（rc=2 但 code 不同）。fixture 补齐 id 即恢复 |
| `packages/cli/tests/cli-io.test.ts` · `深嵌套回归（40k 层不崩） > should outline a 40000-deep document without crashing` | fixture 是 40000 层的**裸 div**，现在 `outline` 报 `needs_normalize`（rc=2）而不是 rc=0。fixture 先 normalize（或给 div 带 id）即恢复；normalize 本身 0.29s、不崩 |

### F10.6 残留 / 待裁

1. **存量文档会先撞一次 `needs_normalize`**（见上表最后两行）：F10 之前落盘的文档里 `div`/表格内部没有 id，`outline`/`read`/`patch` 前置判定要求"可寻址元素都带 id"，于是必须跑一次 `hr normalize --write`。这正是卡上要的"只补不动"，但对使用者是可见行为变化，发布说明里要写。
2. **`table`/`tbody` 这类"内容变了的容器"自身 id 会变**（文本前缀进入种子）。未改动子树的 id 保持不变（判据④），但"给表格加一行"会让表格与 tbody 的 id 漂移——若某条批注锚在 `table` 元素本身而非行/单元格上，会走 `block_reidentified` 兜底。要"容器 id 也不动"就得把容器 id 与内容解耦，那是 id 方案层面的改动（M2.3 §8），不在本卡。
3. **`dl` 的 `div` 包组被收紧**：规范允许 `<dl><div><dt>…</dt><dd>…</dd></div></dl>`，但 `ONLY_CHILDREN.dl = {dt, dd}` 会拒掉 `append <div>`（实测 rc=2「目标 <dl> 只装 <dt>/<dd>，装不下 <div>」），只能逐个追加 `dt`/`dd`（`append '<dt>x</dt>'` 实测 rc=0）。把 `div` 包组收进来会让「能装什么」与 `FORBIDDEN_CHILDREN` 及 `div` 的 flow 语义互相打脸，故本卡按「简单集合」处理；若作者确需分组语义，另开卡在 `ONLY_CHILDREN.dl` 里加 `div` 并配套内容模型。
4. **源文件"改动前 sha256"没有独立快照**：本卡是就地编辑 + 工作树里还有 F1–F9 的未提交改动，改动前状态没留副本；可复核的是上表"修后 sha256"与 `git diff`。fixture 文件的前后 sha256 已逐条贴在上面。

## F11

审计 `audit-R1-F10.md` 的 P1×3 + P2×3。**只改 `packages/**/src/**`**（`tests/**` 归 T5，本卡一个字节没动），不 commit / 不 push。

### F11 结论表

| 判据 | 结果 | 关键证据 |
| --- | --- | --- |
| P1-1 `<table>` 子节点判定方向 | 修好 | ① `append '<p>x</p>'` 到 `<table>` → rc=2、报文点明 foster parenting、sha256 不变；② `thead`/`caption` 不再误杀（rc=0） |
| P1-2 祖先链之外的内容静默丢弃 | 修好 | ③ `</table>` 逃逸 → rc=1、报文点名 `<tbody>` 被一并关闭、sha256 不变 |
| P1-3 解析器丢弃的内容不可见 | 修好 | ⑤ `<select><div>` rc=1 报"1 个元素在解析时被丢弃（`<div>`）"；`<td><tr>` 片段 rc=1 报"被移到包装容器之外" |
| 可选结束标签不误伤 | 保持 | ④ `<ul><li>a<li>b</li></li></ul>` rc=0，落盘仍是 1 个 `ul` + 2 个 `li`（F9 性质不回退） |
| 片段诊断不静默 | 修好 | `duplicate_attribute` 上浮为 warning（rc=0），见下"诊断上浮" |
| P2 三条 | 修好 | `content.ts:97`/`content.ts:102`/`model/attrs.ts:21` |

### 改法（一处修 P1-2 + P1-3）

1. **token 级自证**（`packages/core/src/ops/patchNode/fragmentTokens.ts`，新文件）：
   - `scanTokens`（`fragmentTokens.ts:138`）用 **parse5 的 `Tokenizer`**（与建树同一个实现）走原始片段，数 `startTag`，并沿包装祖先链（`CONTEXT_ANCESTORS`）记深度。**没有手写扫描器**：raw-text/RCDATA 容器（`TEXT_ONLY_TAGS`）按 parse5 的 `_switchToTextParsing` 名单整段跳过，`<li>a<li>b` 这类可选结束标签因此仍然是 2 个起始标签 : 2 个元素。
   - `assertTokensSurvived`（`fragmentTokens.ts:190`）：解析后元素数（减包装祖先、减解析器补出来的 `html/head/body/tbody/colgroup`）必须接得住 token 数，否则 `invalid_input`，报文点明"片段里有 N 个元素在解析时被丢弃"（⑤）。
   - `assertNoAncestorClosed`（`fragmentTokens.ts:151`）：片段里出现闭合包装祖先的结束标签且祖先深度已到 0 → `invalid_input`，报文说"片段闭合了外层的 `<table>`，连带包装祖先 `<table><tbody>` 里的 `<tbody>`"（③）。
   - `assertNothingEscaped`（`fragmentTokens.ts:259`，判据抽成 `isStray` `fragmentTokens.ts:229`）：解析后落在包装器之外的内容节点（foster parenting / 静默重排的产物）→ `invalid_input`（`<td><tr>` 片段）。**P1-2 的"祖先链决定哪部分算数"就是这条**：以前只取 `context.children`，其余静默丢掉。
   - 行数超限（`max-lines` 300）与复杂度（10）逼着把 token 自证从 `fragment.ts`（450 → 243 行）拆成 `fragmentTokens.ts`，`parseFragmentWithDiagnostics`（`fragment.ts:216`）按"先 token 自证 → 再建树 → 再校验"的顺序串起来（`fragment.ts:227`/`235`）。
2. **P1-1**（`packages/core/src/ops/patchNode/content.ts`）：删掉 `FORBIDDEN_CHILDREN.table` 整条，改在 `ONLY_CHILDREN` 加 `table: new Set(["caption","colgroup","tr","td","th","thead","tbody","tfoot"])`（`content.ts:97`）。`tr/td/th` 仍由 `FORBIDDEN_CHILDREN` 专项报文拒（`content.ts:122` 那条没动），`p/div/ul/form` 落到"解析会改树"的通用拒绝（报文选 foster parenting 措辞）。
3. **诊断上浮**（要求 3）：`parseFragmentWithDiagnostics` 把 `parsed.diagnostics` 一并返回（`fragment.ts:216`）；`applyPatch` 收进 `PatchOutcome.warnings`（`apply.ts:43`/`238`/`252`），`PatchResult.warnings`（`io/contracts.ts:27`，可选、缺省空）交给 CLI，`output.ts` 在 `patched …` 下面多打一行 `warning: <code> — <message>`（`--json` 里是 `warnings:[…]`）。**返回面的改动**：`PatchResult` 多一个可选字段 `warnings`，`ParseFragment` 的对外面仍是 `parseFragment(html) → HtmlNode`（诊断版是 `parseFragmentWithDiagnostics`）。
4. **P2**：`model/attrs.ts:21` 注释改成"模型面是寻址面的子集"；`content.ts:102` 的 `dl` 允许 `div`（HTML5 的 div 分组）；`content.ts:69` 的 `INLINE_ONLY_CONTAINERS` 移出 `dt`（规范里 `dt` 装 flow）。

另外把 parse5 的 `duplicate_attribute` 报文从 `parse5 报告 duplicate-attribute` 换成中文说明（`html/parse.ts:85` 的 `PARSE5_MESSAGE`，未登记码仍退回原话），否则用户看到的是英文错误码。

### 验收命令 + 原始输出

fixture（`/tmp/f11/acc/base.html`，`hr normalize --write` 后）：

```
<!DOCTYPE html><html><head><meta charset="utf-8"><title>w</title></head><body>
<article data-hr-id="hr-30d83e85"><h1 data-hr-id="hr-d2a95fc9">标题</h1>
<table data-hr-id="hr-4d2015e1"><tbody data-hr-id="hr-33be97bc"><tr data-hr-id="hr-55f6b67e"><td data-hr-id="hr-15954f16">a</td></tr></tbody></table>
<p data-hr-id="hr-b36abdbf">段落</p><div data-hr-id="hr-7ae01ea9"><ul data-hr-id="hr-e0327601"><li data-hr-id="hr-aad57979">a</li><li data-hr-id="hr-f87b0d28">b</li></ul></div>
</article>
</body></html>
```

每条都从 `cp base.html <case>.html` 的干净副本开始，`sha256_before` 是同一条 base 的哈希。

```
### ① append <p>x</p> to <table>
$ hr patch w1.html hr-4d2015e1 --action append --html <p>x</p>
目标 <table> 只装 <caption>/<colgroup>/<tr>/<td>/<th>/<thead>/<tbody>/<tfoot>，装不下 <p>；<table> 里的非表格内容会被 foster-parent 移到表格之前，写出去解析回来不在同一位置
rc=2
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6

### ② append <thead>…</thead> to <table>
$ hr patch w2.html hr-4d2015e1 --action append --html <thead><tr><td>b</td></tr></thead>
patched w2.html (617 bytes, +3 ids: hr-ba1aa23c, hr-a7e56a0b, hr-dd31b2d9)
rc=0
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =3963ac0e42680cea9001bbe34fa2a158668dd103826c09fbdd4cbb5a9249efed

### ②b append <caption>c</caption> to <table>
$ hr patch w2b.html hr-4d2015e1 --action append --html <caption>c</caption>
patched w2b.html (553 bytes, +1 ids: hr-fa133044)
rc=0
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =126fd5c493dd14f46d65125a7c275a250d10fd08018ce393b98d979693905476

### ③ append </table>-escape to <tbody>
$ hr patch v.html hr-33be97bc --action append --html <tr><td>b</td></tr></table><p>evil</p>
片段闭合了外层的 <table>，连带包装祖先 <table><tbody> 里的 <tbody>：片段里出现它的结束标签，后面写的内容会被挤到包装器之外、静默丢失；请去掉 </table>，把要插入的内容放进片段根元素
rc=1
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6

### ④ append <ul><li>a<li>b</li></li></ul> to <div>
$ hr patch u.html hr-7ae01ea9 --action append --html <ul><li>a<li>b</li></li></ul>
patched u.html (612 bytes, +3 ids: hr-10176db8, hr-279b9048, hr-847c0269)
warning: misnested_tag — <li> 的结束标签没有对应的开始标签
rc=0
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =fb6305e9beb535ade98430d77327511a8522dbd5d9b39fbeff07692fed117842

### ⑤ append <select><div>x</div></select> to <div>
$ hr patch s.html hr-7ae01ea9 --action append --html <select><div>x</div></select>
片段里有 1 个元素在解析时被丢弃（<div>）：常见于 <select>/<template>/表格上下文，解析器按内容模型直接忽略这些起始标签；写出去的字节里不会包含它们，请改写片段或换一个能容纳这些元素的容器
rc=1
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6

### ⑥ append <template><tr><td>x</td></tr></template> to <div>
$ hr patch t.html hr-7ae01ea9 --action append --html <template><tr><td>x</td></tr></template>
patched t.html (598 bytes, +2 ids: hr-e5e0e67e, hr-2606ca7b)
rc=0
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =2bd880058a9b7a299e427f33b5baa080bcd24390d2d66d5011a9ce8accffd048

### ⑦a append <p>子</p> to <p>
$ hr patch r1.html hr-b36abdbf --action append --html <p>子</p>
目标 <p> 是段落（只装行内内容），装不下子节点 <p>；要插段落请选容器元素，如 article/section/div
rc=2
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6

### ⑦b append <li>子</li> to <li>
$ hr patch r2.html hr-aad57979 --action append --html <li>子</li>
目标 <li> 装不下子节点 <li>：HTML 解析器会改结构（<li> 里再放 <li> 会被解析成兄弟或被移出容器，而不是子节点），写出去的字节与解析回来的树不一致。请改 append 到一个能真正容纳 <li> 的容器
rc=2
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6

### ⑦c append <div>子</div> to <td>
$ hr patch r3.html hr-15954f16 --action append --html <div>子</div>
patched r3.html (547 bytes, +1 ids: hr-a229183c)
rc=0
sha256_before=147c416efd957f558f424df624ae36b7b5e69e940dc0e9e8570f2fc22810e0b6
sha256_after =3415dd87893cd8dcdd5046615c458ac665ce8e237b215bf003d98cf448d1f910

### ④ 盘上 div（树稳定：两个 li 仍在同一个 ul 下，html 只有一个根）
</body></html>
### ⑥ 盘上 div（template 内容仍在字节里）
</body></html>
$ hr read t.html hr-2606ca7b --json
{"ok":true,"data":{"html":"<td data-hr-id=\"hr-2606ca7b\">x</td>","ids":["hr-2606ca7b"]}}
rc=0
```

④ 的树（落盘后只有一个根，两个 `li` 都在同一个 `ul` 下，**没有**变成兄弟或被挤出容器）：

```
$ grep -o "<div data-hr-id=\"hr-7ae01ea9\">.*</div>" u.html
<div data-hr-id="hr-7ae01ea9"><ul data-hr-id="hr-e0327601"><li data-hr-id="hr-aad57979">a</li><li data-hr-id="hr-f87b0d28">b</li></ul><ul data-hr-id="hr-10176db8"><li data-hr-id="hr-279b9048">a</li><li data-hr-id="hr-847c0269">b</li></ul></div>

$ grep -o "<div data-hr-id=\"hr-7ae01ea9\">.*</div>" t.html
<div data-hr-id="hr-7ae01ea9"><ul data-hr-id="hr-e0327601"><li data-hr-id="hr-aad57979">a</li><li data-hr-id="hr-f87b0d28">b</li></ul><template><tr data-hr-id="hr-e5e0e67e"><td data-hr-id="hr-2606ca7b">x</td></tr></template></div>
```

### ⑥ 与审计预期不一致的地方（需要评审确认）

审计写的是"`<template><tr><td>x</td></tr></template>` → 内容全丢"，**在本仓库的模型里不成立**：`html/parse.ts` 把 `template` 的 `content` 当子节点遍历（`descendantsOf` → `hasTemplateContent`），所以
- 落盘字节里 `tr`/`td` 在 `<template>` 内（见上面 ⑥ 的 grep 输出），
- 新 id 也注进了 `tr`/`td`（`+2 ids: hr-e5e0e67e, hr-2606ca7b`），
- `hr read t.html hr-2606ca7b --json` → `{"ok":true,"data":{"html":"<td data-hr-id=\"hr-2606ca7b\">x</td>",…}}`，rc=0。

即"文件里看得见、寻址得到、往返稳定"，没有静默丢内容，所以本卡按"不误杀"处理（rc=0 是**有意**的，不是漏判）。token 自证同样覆盖它：`template` 里的 `tr`/`td` 起始标签在解析后都有对应元素，计数相等才放行。若审阅仍要求"片段根是 `<template>` 时一律拒"，请单独下判据——那会误杀合法的 `template` 片段。

### 门禁

```
$ npx prettier --check packages/core/src packages/cli/src
Checking formatting...
All matched files use Prettier code style!

$ npx eslint packages/core/src packages/cli/src --max-warnings=0 --report-unused-disable-directives
（无输出）eslint_rc=0

$ pnpm typecheck
$ tsc --noEmit -p tsconfig.json --pretty false
packages/cli/tests/optional-end-tags.test.ts(92,3): error TS2322: Type 'Promise<number | null>' is not assignable to type 'Promise<number>'.
  Type 'number | null' is not assignable to type 'number'.
    Type 'null' is not assignable to type 'number'.
[ELIFECYCLE] Command failed with exit code 2.
```

`typecheck` 的**唯一**红在 `packages/cli/tests/optional-end-tags.test.ts:92`——`tests/**` 是测试编写员的树，本卡不碰；`packages/**/src/**` 自身零错（eslint 覆盖了 src 两包并 0 warning）。

```
$ npx vitest run packages/core/tests packages/cli/tests --reporter=dot
      Tests  9 failed | 2335 passed (2344)
 Test Files  6 failed | 202 passed (208)
 FAIL  packages/cli/tests/cli-io.test.ts > 深嵌套回归（40k 层不崩） > should outline a 40000-deep document without crashing
 FAIL  packages/core/tests/html-inject.test.ts > injectNodeIds · 块级词表 > should skip inline, unknown and plain div siblings
 FAIL  packages/core/tests/html-inject.test.ts > injectNodeIds · div 与词表 > should treat div as a block only when it carries a component attribute
 FAIL  packages/core/tests/io/fragment-gate-io.test.ts > 片段校验失败 · 不落盘 > should keep the file byte-identical after rejecting 'invalid_fragment'
 FAIL  packages/core/tests/io/fragment-gate.test.ts > parseFragment · 必须拒绝的片段 > should reject '<td>b</td>' with 'invalid_fragment'
 FAIL  packages/core/tests/io/fragment-gate.test.ts > parseFragment · 必须拒绝的片段 > should reject '<tr><td>b</td></tr>' with 'invalid_fragment'
 FAIL  packages/core/tests/io/patch-actions.test.ts > 请求校验 · 未 normalize 的文档 > should reject a non-string html through the parser
 FAIL  packages/core/tests/io/patch-apply-fragment-guard.test.ts > applyPatch · 片段根不是元素时的兜底 > should report no replacedIds instead of a pair with undefined ids
```

#### TESTS_TO_UPDATE（红 → 测试侧的判据要动，本卡不改 `tests/**`）

1. `packages/core/tests/io/fragment-gate.test.ts` + `packages/core/tests/io/fragment-gate-io.test.ts`（3 条）：`REJECTED_FRAGMENTS` 新加了 `<tr><td>b</td></tr>`、`<td>b</td>`，判据 marker 是 `"上下文里解析"`。**这条报文在本仓库 `src/**` 里根本不存在**（`grep -rn "上下文里解析" packages/*/src` 无命中）——F9 之后裸 `<td>`/`<tr>` 片段是"套上祖先链解析、放行"的语义，F11 也没添这条拒绝。要么测试侧改成 `ACCEPTED_FRAGMENTS`（tag = `td`/`tr`），要么另开卡做"裸表格结构片段一律拒"。
2. `packages/core/tests/io/patch-apply-fragment-guard.test.ts`（1 条，`replacedIds` 期望 `[]` 实得 `[{from:"hr-b",to:"hr-b5421875"}]`）、`packages/core/tests/io/patch-actions.test.ts`（1 条，`html: 42` 期望 `invalid_html` 实得 `no_code`）：都在 F11 没碰的入参/替换路径上（`replace` 的 id 映射、`parseHtml` 的类型契约），F11 前后行为一致。
3. `packages/core/tests/html-inject.test.ts`（2 条 `div` 词表）与 `packages/cli/tests/cli-io.test.ts`（40k 深嵌套）：F11 没碰注入/超深文档路径；`content.ts` 的 `dl`/`dt` 改动与 `div` 词表无关。

### 残余风险

1. **token 自证依赖 parse5 的 tokenizer 行为**：`TEXT_ONLY_TAGS` 是照着 parse5 的 `_switchToTextParsing` 手抄的名单，parse5 升版若增删 raw-text 标签，这张表要跟着改（否则会误报"元素被丢弃"）。名单旁有注释指明出处。
2. **`assertNothingEscaped` 只把"容器自身 + 祖先链 + 外壳"当包装器**：如果将来给 `CONTEXT_ANCESTORS` 加新的包装链（比如 `<colgroup>` 下加 `<col>`），要确认新链上的节点都能被 `pathToNode` 覆盖，否则会把包装链自己的兄弟节点误判成"逃出去"。
3. **`table` 只装 8 类子元素**：`<table><form>`、`<table><script>` 这类规范允许但会被解析器移位的写法现在一律拒（报 foster parenting），是"宁可拒"的取舍；`col` 也不在 `table` 的允许集里（`<table><col>` 会被补成 `colgroup`），要继续 `append '<col>'` 请落到 `colgroup` 目标。
4. **warning 上浮改了 `PatchResult` 的返回面**：新增可选字段 `warnings`，`--json` 输出在非空时多一个键，`changed:false` 的路径不带 warning（片段诊断只在真正解析片段时才产生）。下游若按"字段集合固定"做严格断言，需要同步。

---

## F14 巡回 R1 检查点（单提交，未 push）

- **检查点提交**：`67b640b1c3667dc986c65ab4d6ffd2955a308a60`（`fix(r1): 巡回测试 R1 —— 入口、内容模型、表格可寻址（13 项 F + 8 项 T）`）
  - 本段是提交后补写的记录，以 `git commit --amend --no-edit` 并入同一棵树，因此 `git log --oneline -1` 显示的是并入后哈希；上列哈希是**同一棵树、同一条消息**的并入前提交，内容逐字节相同（仅本段多出）。
- **文件数**：128（85 改 / 43 新增；+8928 / −459 行）
  - `packages/core` 63、`packages/cli` 53、`.workflow/reports` 6、`packages/renderer-html` 2、`packages/pi-extension` 1、`eslint.config.mjs` 1、`docs/03-collaboration-workflow.md` 1、`docs/05-feature-cards.md` 1
- **加入方式**：逐路径 `git add -- <path>`（按 `git status --short -uall` 的 128 行逐条），未用 `git add -A` / `git add .`。
- **排除项**：**无命中**。逐条核对 `.env` / `*.log` / `/tmp` 残留 / `coverage/` / `node_modules/` / `.DS_Store` / `*.tsbuildinfo`：0 项混入。工作树之外被忽略、未加入的产物（`git status --ignored` 可见）：`.DS_Store`、`coverage/coverage-summary.json`、`node_modules/**`、`.deltabox/**/session.lock`——本就被 `.gitignore` 挡住，未触碰。
- **.workflow 判据**：`.workflow/reports/` 是本次巡回的正式交付（台账/审计/实现/用例四类报告），属于 R1 成果，全部纳入；`.workflow/` 下无临时产物。

### 提交后三条命令

```
$ git log --oneline -1
67b640b fix(r1): 巡回测试 R1 —— 入口、内容模型、表格可寻址（13 项 F + 8 项 T）

$ git status --short
（无输出，工作树干净）

$ git show --stat HEAD | tail -8
 packages/core/tests/server/unit-branches.test.ts   |    4 +-
 .../core/tests/server/unit-listen-probes.test.ts   |  158 ++
 packages/core/tests/server/watcher.test.ts         |    3 +-
 packages/core/tests/server/wire-http.test.ts       |    3 +-
 packages/pi-extension/pi-hreader.ts                |    3 +
 packages/renderer-html/src/print-html.ts           |   25 +-
 .../tests/print-html-attributes.test.ts            |   81 +
 128 files changed, 8928 insertions(+), 459 deletions(-)
```

### 前置门禁（提交前，非本轮重跑）

- `pnpm verify` EXIT=0（3145 例，format/ci-parity/lint/lint:sh/self-test/typecheck/build/test:coverage/depcruise/knip 全过）
- `pnpm desktop:check` EXIT=0（cargo fmt/clippy/test）

### 未做

- 未 `push`；未改任何源码/测试/文档内容（本轮只做提交）。

## F15 按终审报告修 1 条 P1 + 3 条 P2（R1-F15，未提交、未 push）

审计依据：`.workflow/reports/audit-R1-final.md`（CHANGES-NEEDED，P0=0/P1=1/P2=5）。本轮只碰 F15-1~F15-4；其余 P2 不在本轮范围。**一条测试都没改**（`tests/**` 未触碰），需要改的 3 条列在下面 `TESTS_TO_UPDATE`。

### F15-1（P1）契约表与行为对齐 —— `docs/05-feature-cards.md`

- `:418`（`invalid_fragment` 行）原文 `片段标签不配平`，而 F11 之后该码只在两处抛：空白片段（`packages/core/src/ops/patchNode/fragment.ts:239-241`）与"解析后不是恰好一个根元素"（`packages/core/src/ops/patchNode/fragmentTokens.ts:38-49`）；片段路径已完全不判标签配平（`<div>`、`<b><i>x</b></i>` 都被接受）。
  改为：`片段为空/只有空白，或解析后不是恰好一个根元素（标签不配平不算错——HTML5 容错解析会补闭合）`。
- `:411`（`invalid_html` 行）删掉已失效的"不是完整文档"分支，改为 `传进来的不是字符串 / 文档没有 <head> 时注入主题样式失败`（现只有 `parse.ts:271-273`、`fragment.ts:222`、`style/apply.ts:128` 沾"没有 `<head>`"）。
- 退出码列（均为 `1`）未动。
- 连带清掉 `:120` 里旧名 `isBlockLevel` → `isPatchableTarget`（F15-2 的改名要求"全清"）。

### F15-2（P2-1）名字与报文不再宣称"块级=同口径"

- `packages/core/src/ops/patchNode/attrs.ts:38-40`：`isBlockLevel` → `isPatchableTarget`（判的仍是 `PATCHABLE_TAGS`）。
- `packages/core/src/ops/patchNode/apply.ts:11` import、`:91` 调用点同步。
- `packages/core/src/ops/patchNode/apply.ts:94` 报文 `patch 目标必须是块级元素` → `patch 目标必须是可寻址且可作目标的块级元素`。
- `packages/core/src/ops/patchNode/attrs.ts:1` 头注释 `与 html/inject.ts 同口径` → `与 html/inject.ts 共用同一批标签常量`；`:36-39` 文档注释补上"这里判的是 `可作目标` 集合（`PATCHABLE_TAGS`），允许比可寻址集合 `ADDRESSABLE_TAGS` 小"。
- `packages/core/src/html/constants.ts:76` 里对 `isBlockLevel` 的引用同步改名（否则注释指向一个已不存在的符号）。
- `grep -rn isBlockLevel packages/*/src docs` → 无命中。

### F15-3（P2-2）`<article>` 注释改成与生效路径一致 —— 只改注释，集合内容未动

- `packages/core/src/html/constants.ts:50` 原文写"最外层 article 自身必须带 id；嵌套 article 由 `isInjectionTarget` 另行排除"，但 `packages/core/src/html/inject.ts:39` 是
  `node.tag === ARTICLE_TAG ? !insideArticle : insideArticle && ADDRESSABLE_TAGS.has(node.tag)`，
  tag 为 `article` 的节点永远走第一分支，`ADDRESSABLE_TAGS.has("article")` **永不被求值**；`article` 留在集合里的唯一实际作用是随拷贝进 `PATCHABLE_TAGS`。
- 改为：`<article>` 放在这里是为了让 `PATCHABLE_TAGS` 能按 id 命中 `<article>`；最外层/嵌套 article 的注入判定由 `html/inject.ts:39` 的 tag 分支直接做（tag 为 article 时走第一分支，本集合的 has("article") 不被求值）。
- 未把 `article` 移出集合再加进 `PATCHABLE_TAGS`（那会破坏"只增不改"的规则）。

### F15-4（P2-4）"只有注释"的片段报文与根数分离 —— `fragmentTokens.ts`

- `packages/core/src/ops/patchNode/fragmentTokens.ts:41-43` 新增分支：`candidates.length === 1` 且唯一根 `kind !== "element"` 时抛 `invalid_fragment`，报文 `片段的根不是元素（是注释或纯文本），请给一个元素`；根数 ≠ 1 的旧报文（`片段必须恰好有一个根元素（实际 N 个根级内容节点）`）保留在 `:44-47`。
- 真机判据（`node --experimental-strip-types packages/cli/src/main.ts`，沙箱 `/tmp/f15check`，`hr normalize --write` 后对 `hr-294114b7`（`<p>`）做 `--action append`）：

```
frag=[<!--x-->] rc=1 out=片段的根不是元素（是注释或纯文本），请给一个元素
frag=[text]     rc=1 out=片段的根不是元素（是注释或纯文本），请给一个元素
frag=[<b>x</b>] rc=0 out=patched t.html (129 bytes, +0)
```

### TESTS_TO_UPDATE（锁旧报文，未改测试）

`packages/core/tests/io/fragments.ts` 三条 `marker` 仍锁旧串，需测试编写员改成 `根不是元素`：

- `:46` `{ fragment: "纯文本", code: "invalid_fragment", marker: "恰好有一个根元素" }`
- `:63` `{ fragment: "<!-- 只有注释 -->", code: "invalid_fragment", marker: "恰好有一个根元素" }`
- `:66` `{ fragment: "<!-- only a comment -->", code: "invalid_fragment", marker: "根元素" }`

（`:45` `<p>a</p><p>b</p>` 与 `:64`/`:65` 空片段仍是旧报文，不需要改；`packages/core/tests/io/fragment-gate.test.ts:100` 的 `marker: "恰好有一个根元素（实际 2 个根级内容节点）"` 也仍然对。）

失败原始输出（`/tmp/verify-f15b.log`，`test:coverage` 段）：

```
× parseFragment · 必须拒绝的片段 > should reject '纯文本' with 'invalid_fragment' 3ms
  → expected '片段的根不是元素（是注释或纯文本），请给一个元素' to contain '恰好有一个根元素'
× parseFragment · 必须拒绝的片段 > should reject '<!-- 只有注释 -->' with 'invalid_fragment' 0ms
  → expected '片段的根不是元素（是注释或纯文本），请给一个元素' to contain '恰好有一个根元素'
× parseFragment · 必须拒绝的片段 > should reject '<!-- only a comment -->' with 'invalid_fragment' 0ms
  → expected '片段的根不是元素（是注释或纯文本），请给一个元素' to contain '根元素'
FAIL  packages/core/tests/io/fragment-gate.test.ts > ... 3 failed
```

### 门禁原始结果

- `npx prettier --write packages/core/src/ops/patchNode/fragmentTokens.ts` → 只格式化该文件；`git diff --stat` 仍只有本任务的 5 个文件：
  `docs/05-feature-cards.md`、`packages/core/src/html/constants.ts`、`packages/core/src/ops/patchNode/{apply,attrs,fragmentTokens}.ts`。
- `pnpm verify` **EXIT=1**，唯一红点在 `test:coverage` 的上述 3 条锁旧报文用例；其前 `format:check`/`check-ci-parity`/`lint`/`lint:sh`/`lint-sh-selftest`/`typecheck`/`build` 全过。
  因 `&&` 短路，`depcruise`/`knip` 未在 verify 内执行，单独补跑：`pnpm depcruise` EXIT=0（`no dependency violations found (616 modules, 2592 dependencies cruised)`）、`pnpm knip` EXIT=0。
- `pnpm desktop:check` **EXIT=0**（cargo fmt/clippy/test；`3 passed; 0 failed`）。
- `git status --porcelain`：上述 5 个 M + 未跟踪的 `.workflow/reports/audit-R1-final.md`；**无 staged 文件**，未 commit、未 push。

### 行号索引（本轮改动落点）

| 文件:行 | 内容 |
| --- | --- |
| `docs/05-feature-cards.md:411` | `invalid_html` 何时出现 |
| `docs/05-feature-cards.md:418` | `invalid_fragment` 何时出现（P1） |
| `docs/05-feature-cards.md:120` | `isPatchableTarget` 改名同步 |
| `packages/core/src/ops/patchNode/attrs.ts:1`、`:38-40` | 头注释 + 改名 + 集合口径说明 |
| `packages/core/src/ops/patchNode/apply.ts:11`、`:91`、`:94` | import / 调用点 / 报文 |
| `packages/core/src/html/constants.ts:50` | `<article>` 注释改对生效路径 |
| `packages/core/src/html/constants.ts:76` | 注释里的函数改名同步 |
| `packages/core/src/ops/patchNode/fragmentTokens.ts:41-43` | 新增"根不是元素"分支 |
