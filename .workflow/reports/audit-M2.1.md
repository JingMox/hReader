G2: FAIL — 1×P0 / 4×P1 / 13×P2

# M2.1 审计（本地 Daemon + SSE 同步桥）

## 0. 快照与范围

- 被审：`packages/core/src/server/**` 17 文件 1729 行、`packages/cli/src/commands/serve.ts`（37 行）、`packages/cli/src/{args,run,output,usage,exit-codes}.ts` 增量、`packages/core/src/hr-error.ts` 新增 5 码（`too_many_clients`/`unauthorized`/`forbidden_origin`/`daemon_already_running` + `unknown_style` 沿用）。
- 审计前后 `shasum packages/core/src/server/*.ts` 两次一致（17 行一致，未改源码）。
- 探针全部走真 socket：`/tmp/m21a/{h.mjs,h2.mjs,sse3.mjs,p1-auth,p2-path,p3-http,p4-sse,p5-echo,p6b,p7b,p8-watch2,p9-conc,p10-ann,p11-clients,p12-inject}.mjs`；服务端真子进程：`HOME=/tmp/m21a/home node packages/cli/src/main.ts serve /tmp/m21a/ws/doc.html --workspace /tmp/m21a/ws --port 0 --json`（pid 91465，port 59219）。
- 判据 = `.workflow/cards/M2.1.md` §1 D3–D10 + §2 AC1–AC5。

## 1. P0

### P0-1 并发 `POST /api/annotation` 静默丢写：5 个请求全部 201，最终只存 1 条

`packages/core/src/server/handlers.ts:229-247`：

```ts
const appendWithLock = async (ctx, target, input, lockMs) => {
  const html = decodeUtf8(await bytesOf(ctx, target), target.realPath);   // ← 锁外读
  return busy(() =>
    runLocked(target, ctx.deps, { lockTimeoutMs: lockMs }, async () => {
      const outcome = appendAnnotation(html, input, `an_${nonce().slice(0, 8)}`); // ← 用陈旧 html
      if (outcome.changed) await writeAtomic({ path: target.realPath, ... });
```

紧上一行注释（`handlers.ts:228`）写着「先算新文本再抢锁写：纯拼接不需要锁；锁里只做"写一次"」——这句是错的：`appendAnnotation` 是"读当前 `hr-meta` → 追加 → 整篇重写"，属典型读-改-写，锁保护不到"读"就毫无意义。违反 D9「同一文档的写请求串行化」。

复现（`/tmp/m21a/p10-ann.mjs`，5 个并发请求）：

```
$ node p10-ann.mjs
statuses: [201,201,201,201,201]
meta found: true
annotations stored: 1 ["note-1"]
```

`ws/ann.html` 里只剩 `note-1`，另外 4 条批注永久丢失，而 4 个客户端都收到了 201（谎报成功）。定级理由：静默数据丢失 + 谎报成功 + 直接违反 D9；且这是 M2.3 批注功能的地基。

## 2. P1

### P1-1 同一 `doc.changed` 事件里的 `revision` 有两套口径，watcher 那套永不等于 REST

- `packages/core/src/server/runtime.ts:79`：`revision: revisionOf(encodeUtf8(JSON.stringify(input.model)))` —— **模型 JSON 的哈希**
- `packages/core/src/server/handlers.ts:126`、`:132`、`:143`：`revision: revisionOf(after)` / `revisionOf(doc.bytes)` —— **文件字节的 sha256 前 16**
- 自有写入走 `noteWriterOf`（`runtime.ts:166`，用字节哈希），外部改动走 `publishChanged`（模型哈希）——**同一个事件类型的同一个字段有两种含义**。

实测（`/tmp/m21a/p8-watch2.mjs`：外部整篇重写 → 事件；随后 `GET /api/doc/doc.html/model`）：

```
doc.html full rewrite frames: 2
  id: 10 data: {"type":"doc.changed", ..., "revision":"f745159b5b6…"}
REST revision: d7c659ccea4ce265
```

同一文档状态，事件报 `f745159b…`，REST 报 `d7c659cc…`，永不相等。任何用 revision 做"我是不是最新"判断的客户端（`docs/03` 同步桥设计）会永远判否。

### P1-2 外部"新增节点"不可见 → 不发事件（AC4 的"文件被外部修改 → 推 doc.changed"不成立）

`packages/core/src/server/runtime.ts:77-78`：

```ts
// 只有 mtime/格式抖动的"重写"不该刷屏：内容没变就不发事件。
if (previous !== undefined && changedNodes.length === 0) return;
```

模型只收录带 `data-hr-id` 的元素（`packages/core/src/model/derive.ts:84` 只校验根 id），外部新增的 `<p>` 没有 id → `diffNodes` 返回空 → 被当成"内容没变"吞掉。

```
$ node /tmp/m21a/p8-watch2.mjs
other.txt (library.changed) frames: 2      ← 目录级事件正常
doc.html full rewrite frames: 2            ← 整篇重写（id 消失）有事件
doc.html append frames: 1                  ← 只有 ready，零事件
```

即：`appendFileSync(…,"<p>again</p>\n")` 这种最普通的外部编辑，浏览器**完全收不到** `doc.changed`。注释把"没有 id 级差异"当成"内容没变"，是错误的等价。

### P1-3 属性变化永远不进 `changedNodes`（AC4 明确要求"属性变化"）

`packages/core/src/server/diff-nodes.ts:11-12`：

```ts
/** 模型里没有属性：改属性（如主题色）不会出现在 `changedNodes` 里，见报告"已知限制"。 */
const differs = (before, after) => before.text !== after.text || before.tag !== after.tag || before.component !== after.component;
```

实测（`/tmp/m21a/p7b.mjs` B 段：`<article` → `<article aria-label="q2"`）：`B attr-only frames: 1`（只有 `ready`），零 `doc.changed`。AC4 写的是"新增/文本变化/属性变化"，§1 没有对应裁定可以豁免——注释里的"已知限制"不是裁定。

### P1-4 `noteSelfWrite` 回声窗口是死代码，AC4 声称的"200 ms 内吞掉"没有任何实现

```
$ grep -rn "noteSelfWrite" --include=*.ts packages/ | grep -v tests
packages/core/src/server/watcher.ts:12:  readonly noteSelfWrite: (path: string) => void;
packages/core/src/server/watcher.ts:84:    noteSelfWrite: scheduler.note,
```

只有接口与实现，**生产代码零调用**；而 `packages/core/src/server/runtime.ts:161` 注释断言「自己的写直接广播（watcher 的回声窗口会吞掉同一路径）」。

实测上回声目前被 `publishChanged` 的空 diff 早退"碰巧"吞掉（`/tmp/m21a/p5-echo.mjs`：3 次 patch → 恰好 3 帧 `id: 3/4/5`，无重复），但这条路依赖 `noteWrite` 里*异步* `modelOfPath`（`runtime.ts:167-172`）能在 100 ms 去抖内完成；慢盘/大文档下会重复推送同一改动。AC4 的 200 ms 回声窗口 = 零实现 + 一句假注释。

## 3. P2

| # | 位置 | 问题 | 实测 |
|---|---|---|---|
| 1 | `packages/core/src/server/http-io.ts:26` | `JSON_HEADERS` 没有 `x-content-type-options`，`jsonOf`/`errorReply` 全走它 → 401/403/404/405/413 与 302 全缺 `nosniff`（AC5「所有响应都带」不成立） | `nosniff=undefined` ×7 例 |
| 2 | `packages/core/src/server/http-io.ts:72` | 超 1 MiB 返回 **400**，AC3 要 **413** | `1.1MiB body → HTTP/1.1 400`，体 `请求体超过 1048576 字节` |
| 3 | `packages/core/src/server/handlers.ts:100` | 非法路径字符与超长路径落到 500 且报文含绝对路径 | `/s/doc.html%00.png → 500 {"code":"io_failure","message":"realpath失败：/private/tmp/m21a/ws/…"}`；`/s/`+8192×"a" → 500 同类 |
| 4 | `packages/core/src/server/auth.ts:17` | 重复 `Host` 被接受（RFC 7230 §5.4 要求 400）：Node 只留第一个，`hostAllowed` 无从察觉 | `Host: 127.0.0.1:P` + `Host: evil.com` → **200**；反序 → 403 |
| 5 | `packages/core/src/server/contracts.ts:12-13` + `packages/cli/src/commands/serve.ts:28-29` | `projectRoot`/`stylesRoot` 传了但 `src/server/**` 零引用（死参数） | `grep -rn projectRoot packages/core/src/server` → 仅 contracts |
| 6 | `packages/core/src/server/hub.ts:23,24` | `removeClient`/`clientCount` 无生产调用（`on("close")` 里直接 `map.delete`） | `grep -rn removeClient packages/core/src` → 仅定义 |
| 7 | `packages/core/src/server/daemon.ts:76-83` | chmod/rename 失败时**不删 tmp**（catch 只重抛） | 代码直读；与 M1.5「不留 tmp」相悖 |
| 8 | `packages/core/src/server/daemon.ts:3,79` | `chmod` 直接 `import ... from "node:fs/promises"`，同文件其余 IO 都走 `deps.fs` → 测试无法注入 | 代码直读 |
| 9 | `packages/core/src/server/server.ts:105` | `createServer()` 未设 `headersTimeout`/`requestTimeout`；声明 100 字节只发 2 字节 → 连接悬挂 | 1.2 s 无响应（Node 默认 300 s） |
| 10 | `packages/core/src/server/runtime.ts:100-103` | 卡里没有 `doc.error` 事件；删除活动文件时推送，客户端无法区分"被删/读失败" | `id: 8 data: {"type":"doc.error","path":"/private/tmp/m21a/ws/doc.html"}` |
| 11 | `packages/core/src/server/server.ts:40` | cookie 值 = 主 token 本体，D5 要的是独立"随机 32B"会话值；主令牌因此长期驻留浏览器 | `Set-Cookie: hr=QSuaY-fM…`（= daemon.json 里的 token） |
| 12 | `packages/core/src/server/event-ring.ts:37-40` + `hub.ts:66` | 新客户端（无 `Last-Event-ID`）回放整环最多 256 条**历史**事件 | 无 `Last-Event-ID` → 9 帧（含进程早期 `doc.changed`） |
| 13 | `packages/core/src/server/handlers.ts:80` | `homeReply` 把 `docId` 不转义拼进 HTML 文本节点（URL 侧有 `encodeURIComponent`，文本侧没有） | 文件名含 `<`/`&` 时注入标签（CSP `default-src 'none'` 挡脚本） |

另记两条注释口径问题（不单列级别，归 #13 同类）：`packages/core/src/server/annotation.ts:129` 写「`changed` 恒为真」，实现是 `changed: next !== html`（`:147`）；`packages/core/src/server/handlers.ts:50` 注释「写锁等不到就回 409」，实际 `busy` 映射为 503（`status.ts:29`，符合 D9）。

## 4. 独立复算（自跑数字）

**鉴权/Host/Origin/CSRF 矩阵**（`/tmp/m21a/p1-auth.mjs`）

| 输入 | 结果 |
|---|---|
| `Host: 127.0.0.1:<port>` + 无 cookie → `/healthz` | 200（AC5 ✓） |
| `Host: localhost`（无端口） | 403 `forbidden_origin` |
| `Host: 127.0.0.1:1`（端口错） | 403 |
| 无 `Host` | 400（Node 解析器） |
| `Host` 两个（ok 在前） | **200**（见 P2-4） |
| `Origin: http://127.0.0.1:<port>.evil.com` | 403 |
| `/` 无 cookie | 401 `unauthorized` |
| `/s/doc.html?t=<token>` | 302，`Location: /s/doc.html`（**不含 token**，D5 ✓）+ `Set-Cookie` |
| `/s/doc.html?t=bad` | 401 |
| `POST /api/patch` 有 cookie 无 `X-HR-CSRF` | 403 |
| `POST /api/patch` 有 CSRF 头无 cookie | 401 |
| `GET /api/patch` | 405 `allow: POST` |

**路径穿越矩阵**（`/tmp/m21a/p2-path.mjs`，全部带 cookie）

`%2e%2e%2fetc%2fpasswd` → 403｜`%2e%2e/%2e%2e/etc/passwd` → 404（URL 规范化）｜`../../etc/passwd` → 404｜`%252e%252e%252f…` → 404（**不二次解码**）｜`..%5c..%5cwindows` → 404｜`..%EF%BC%8Fetc`（全角） → 404｜`%2Fetc%2Fpasswd` → 403｜`link.html → /tmp/m21a/victim.txt`（符号链接越界） → **403 `path_outside_workspace`，victim 未被读**｜`/api/doc/link.html/model` → 403。越界防线有效。

**HTTP 解析**（`/tmp/m21a/p3-http.mjs`）

重复 `Content-Length` → 400｜`TE: chunked` + `Content-Length` → 400｜`TE: chunked` 单独（体 `{}`）→ 400 缺 `docId`（正常解码）｜`GET` 带体 → 200｜HTTP/1.0 → 200｜管线化 2 请求 → 2 个响应｜坏 JSON → 400｜`Content-Length: 100` 只发 2 字节 → 无响应（悬挂，见 P2-9）｜9 KiB 头 → 200｜1.1 MiB 体 → 400（见 P2-2）。

**SSE**（`/tmp/m21a/sse3.mjs` + p7b/p11/p12）

- 首帧 `retry: 2000` / `id: 0` / `data: {"type":"ready"}` ✓（AC4）。
- `id:` 单调：观测序列 1,2,3,4,5,8,9,10,36，无回退。
- `Last-Event-ID`：`1`→补 8 帧；`4`→补 5 帧；`0`/缺失→9 帧；`abc`→按 0 处理（9 帧）。
- **注入**：文件名 `evil\nid: 999\ndata: {"type":"fake"}.html` → 原始帧 `"docId":"evil\\nid: 999\\ndata: {\"type\":\"fake\"}…"`，`JSON.stringify` 转义生效，**未产生伪造帧**（帧行首仍是 `id: <n>`）。
- 连接数：开 66 个 → 第 67 个 `429 {"code":"too_many_clients","message":"SSE 客户端已满（上限 64）"}`；全部断开后新连接 200（无泄漏）。

**并发**（`/tmp/m21a/p9-conc.mjs`）：20 个并发 patch 同一文档 → 20×200、20 个互不相同的 revision、20 处改动全在、文件仍 1 个 `<article>`/20 个 `<p>`，耗时 561 ms。**写串行化（patch 路径）有效**——P0-1 的丢写只出在 annotation 路径。

**启动/关闭**：`daemon.json` `-rw-------`（0600），workspace 存 realpath `/private/tmp/m21a/ws`；第二个 `hr serve` → `{"ok":false,"code":"daemon_already_running","message":"已有 daemon 在 127.0.0.1:59219 运行"}` exit 2；`SIGTERM` → 进程退出、`daemon.json` 被删（目录空）、端口 `ECONNREFUSED`、活动期 `lsof -p` 19 个 fd。

## 5. 未覆盖 / 说明

- **端口被独占（EADDRINUSE）**未独立复现：`daemon.json` 存在时先命中 `ensureNoDaemon`（`server.ts:135-146`）返回 `daemon_already_running`，到不了 `bindErrorOf`；两者同为 exit 2，行为无差异但路径未验证。
- 卡 AC1 要求"已在运行 → `invalid_invocation`"，实现新增了 `daemon_already_running`（exit 2 / HTTP 409）——语义等价、报文更准，记为 P2 级文档差异（未单列行）。
- `impl-M2.1.md` 自证的 56 项未逐条复核；本报告所有结论均来自上列 `/tmp/m21a/*.mjs` 自跑输出。

ACP: 审 17 文件 1729 行 + CLI 37 行；自跑 12 个探针（真 socket + 真子进程 daemon，pid 91465/port 59219）；1×P0 = annotation 并发丢写（5→1，全 201）；4×P1 = 事件 revision 双口径、外部新增节点零事件、属性变化零事件、回声窗口死代码；13×P2 见 §3；防线有效项：Host/Origin/CSRF 矩阵、路径穿越/符号链接越界全拒、SSE 帧注入抵抗、patch 并发串行化、SIGTERM 清理。

## G2-R（M2.1 返工复审：R1 修 P0/P1 + R2 加成帧上限与超时）

G2-R: FAIL — 7 条 CLOSED / 1 条部分 OPEN（P1-3）/ **2 条新 P1** / 3 条新 P2

审计前后 `shasum packages/core/src/server/*.ts`（18 文件）两次一致（`/tmp/m21a/snap-before.txt`）。本轮全部用 `/tmp/m21a/*.mjs` 直连真 socket + 真子进程 daemon（`HOME=/tmp/m21a/home3 HR_DEBUG=1 node packages/cli/src/main.ts serve /tmp/m21a/ws/w3.html --workspace /tmp/m21a/ws --port 0 --json`，port 56722 / pid 8326），**未用 `pnpm test` 作判据**。

### 1. 上轮 1×P0 + 4×P1

| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| P0-1 | 并发 `POST /api/annotation` 丢写（5→1，全 201） | **CLOSED** | `p-ann2.mjs`：`statuses: 201,201,201,201,201` / `annotations stored: 5 [1,4,2,5,3]`。`handlers.ts:236-253` 读→改→写整段在 `runLocked` 内，锁外不再有 `bytesOf` |
| P1-1 | `doc.changed` 的 revision 与 REST 两套口径 | **CLOSED** | `p-rev.mjs`：`resp.revision: 6de5a7e11f8f5220` = `file sha: 6de5a7e11f8f5220`；`runtime.ts:83-88` 事件 revision 也只来自 `revisionOf(fs.readFile(...))`，且事件门控改为"字节变了"而非"模型有差异" |
| P1-2 | 外部新增节点不可见 / 不发事件 | **CLOSED** | `p-watch5.mjs`：外部插入 `<p data-hr-id="hr-p9">` → `{"changedNodes":["hr-p9"]}`；删除两个 `<p>` → `["hr-p1","hr-p2"]` |
| P1-3 | 属性变化不进 `changedNodes` | **部分 OPEN** | 事件现在会发（`p-attr.mjs`：只改 `<article class="x"→"y">` → `{"revision":"cd3c3901…","changedNodes":[],"type":"doc.changed"}`），但 `changedNodes` 是空数组——`diff-nodes.ts:10` 自己写着「模型里没有属性…见报告"已知限制"」。AC4 要求"属性变化"可被客户端识别；`[]` 与"没有节点变化"不可区分。定级：P1 降为 **P2（文档化已知限制）**，但 AC4 的口径仍不成立 |
| P1-4 | `noteSelfWrite` 回声窗口是死代码 | **CLOSED** | `runtime.ts:179` 真的调了；`p-rev.mjs` 一次 API patch 只产生 **1** 帧 `doc.changed`（若回声未吞会 2 帧） |

### 2. 本轮指定复验项

| 项 | 判定 | 实测 |
|---|---|---|
| 错误细节泄漏（`invalid_html`/`invalid_json`/IO 错） | **CLOSED** | `p-err.mjs` 7 个向量：`/s/nonexist.html`、`/api/doc/nonexist.html/model`、`docId=../../etc/passwd`、`docId=/etc/passwd`、`%2e%2e%2f..%2fetc%2fpasswd`、非 HTML 文件 → 响应体 `leaked=[]`（无 `/tmp`、`/private`、`tsconfig`、`at `、`file:`），报文形如 `{"code":"not_a_file","message":"realpath时路径不存在：[路径已隐藏]"}`。`HR_DEBUG=1` 的 CLI stderr 仍打印完整路径（`读取时路径不存在：/tmp/m21a/ws/nonexist.html`）✓ 运维可用 |
| SSE 帧注入 | **CLOSED** | `p-sse6.mjs`：`data-hr-id="evil\nid: 999\ndata: {\"type\":\"fake\"}"` → 帧内 `\n` 被 `JSON.stringify` 转义，`frames: 0` 伪造帧；`p-sse4.mjs` 的 `Last-Event-ID: 1\nevent: hacked\ndata: {}` → `has 'event: hacked'? false`。`event-ring.ts:69` 的 `id:` 只来自内部数值计数器，合法 id 不被改写 |
| 请求走私面 | **CLOSED** | `p-smug.mjs`：`TE: chunked`+`CL` → 400｜`TE: gzip` → 400｜`TE: chunked, chunked` → 400｜`CL: 5, 5` → 400｜小写 `transfer-encoding` → 400（`http-io.ts:110-118` 的 `guardOf`） |
| `Host` 原文比较 | **CLOSED** | `Host: 127.0.0.1:1` → 403｜`Host: localhost`（无端口）→ 403｜无 `Host`（HTTP/1.0）→ 403｜双 `Host` → **400**（上轮为 200 接受，`auth.ts:21-30` 不再 `split(":")`）｜`Origin: http://127.0.0.1:<port>.evil.com` → 403 |
| R2 成帧上限 | **部分** | `t3-limits.mjs`（`timeouts:{headersMs:400,bodyMs:400,idleMs:400}`）：半截体（`CL:100` 只发 3B）→ **408 @409ms**｜头块 20 KiB → **431 @2ms**｜chunk-size 行 2 KiB → **400 @2ms**｜单 chunk 声明 9 MiB → **408 @402ms**（被体超时兜住，不是 400，可接受但状态码与裁定不符）｜2 MiB 体 → **EPIPE/连接被关**，1.1 MiB → **413** `{"code":"invalid_request","message":"请求体超过 1048576 字节"}`（上轮 400，P2#2 CLOSED） |
| 超时可配置 + unref | **CLOSED** | `limits.ts:11-17` 三档全部来自 `timeouts`，`server.ts:140-146` 落到 `headersTimeout`/`requestTimeout`/`maxHeaderSize`；`limits.ts:42,53` 与 `hub.ts:105` 的定时器都 `unref()`；`close() took 2ms`（`t3-limits.mjs`） |
| `daemon.ts` 两处分支删除是否改行为 | **CLOSED（但见新 P1-2）** | `writeDaemonOf` 的 tmp 清理分支保留了（`daemon.ts:81-85`，P2#7 CLOSED）；`closerOf` 现在 `closeAllConnections()` 后 `await shutdown()`——"δ 延迟退出"的**宽限期已消失**，见下 |
| `frame()` 引入后 hub 回放一致 | **CLOSED** | `hub.ts:58-68` 的 `backfill` 与 `publish` 走同一个 `frameOf(event, note)`；`resetFrameOf` 不带 `id:`（按 SSE 规范不回退 `lastEventId`） |

### 3. 返工引入的新问题

#### P1-NEW-1 空闲超时把 `HTTP/1.1 408` 直接灌进已完成的 keep-alive 连接（协议级串话）
`packages/core/src/server/limits.ts:40`（同一模式在 `:51`、`:57`）：

```ts
const timer = setTimeout(() => { timers.idle.delete(socket); if (!socket.destroyed) socket.end(TIMEOUT_FRAME); }, idleMs);
```

`armIdle` 在 `res.finish` 之后布防（`limits.ts:77-79`），所以触发时**响应已经写完了**，`socket.end()` 又在同一连接上追加一整条响应。

复现：`node /tmp/m21a/t4-raw.mjs`
```
idle keep-alive RAW="HTTP/1.1 200 OK\r\n…\r\n\r\n{"ok":true,"uptimeMs":7,"pid":9374}HTTP/1.1 408 Request Timeout\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"
```
客户端在**没有发请求**的情况下收到第二个响应。HTTP/1.1 客户端（以及任何做管线化的中间件）会把它当成下一个请求的响应 → 响应错位；`socket.end()` 还与 Node 自己的写缓冲竞争，字节可能交织。另外同一条响应头里出现 `Keep-Alive: timeout=0`（`idleMs*2 = 800ms` 取整秒）。定级 P1：不改数据，但会静默污染客户端状态机，且只有在空闲 30s 后才暴露（默认值下很难被测试打到）。

#### P1-NEW-2 `close()` 用 `closeAllConnections()` 硬切，in-flight 写请求拿不到任何响应
`packages/core/src/server/server.ts:219`：`parts.server.closeAllConnections()` 直接放在 `shutdown()` 之前。

复现：`node /tmp/m21a/t5-shutdown.mjs`（发 `POST /api/patch` 头 + 半个体，300ms 后 `close()`）
```
in-flight request during close(): client got "" after 9ms
```
客户端得到的是连接被掐断（无 4xx/5xx、无 JSON）。如果该请求已经越过 `writeAtomic`，写已落盘但客户端只知道"网络错误"——重试即重复操作（patch 不是幂等时就是双写）。上轮 P1 要的是"退出要快"，R2 把宽限期整个删掉后变成"无法区分是否生效"。定级 P1。

#### P2-NEW-1 `headersMs > bodyMs` 会让 `createServer` 抛 RangeError 并带栈退出
`packages/core/src/server/limits.ts:13-17` 允许三档独立覆盖，`server.ts:142-143` 原样透传给 `http.createServer`；Node 要求 `headersTimeout <= requestTimeout`。

复现：`node /tmp/m21a/t1-rt.mjs`
```
h=10000 r=10000 -> ok
RangeError [ERR_OUT_OF_RANGE]: The value of "headersTimeout" is out of range. It must be <= requestTimeout.
```
`packages/core/src/server/contracts.ts:3` 的注释恰恰建议「测试传 50 ms」——只传 `{ bodyMs: 50 }` 就必然崩。建议 `timeoutsOf` 里夹紧（`headersMs = min(headersMs, bodyMs)`）并在 contracts 注释写明约束。

#### P2-NEW-2 单 chunk 超 8 MiB 落到 408 而非 400
见上表；`limits.ts:8` 注释说"体上限在 `body.ts`（1 MiB），总体由 `requestTimeout` 兜住"——声明 9 MiB 的 chunk 确实被兜住（402ms 断开），但状态码是 408 而不是裁定里的 400。注释是对的，裁定没落地。

### 4. 注释口径抽查（`limits.ts` / `body.ts` / `event-ring.ts` / `http-io.ts`）

- `event-ring.ts:60`「帧里的 `id`/`event` 一旦含 CR/LF 就能伪造出下一帧」→ `sanitizeToken` 实际作用在 **payload 的 `type` 字段**，而 `id:` 行只来自数值计数器：注释描述的位置不对（真正挡住注入的是 `JSON.stringify`），属"注释自我认证"。
- `limits.ts:70`「Node 会在响应结束时把 socket 超时改回 `keepAliveTimeout`」——与 P1-NEW-1 同源，注释描述的现象成立，但由此推出的"我们的 408 计时器先生效"正是串话的原因。
- `body.ts:1`「不读 socket」/ `limits.ts:1`「不碰路由、不碰业务」/ `http-io.ts:1` 的职责句全部与实现一致（这三条是真的）。

### 5. 独立复算（自跑数字）

- 并发批注：5 并发 → 5 条落盘（上轮 1 条）
- revision 一致性：REST `6de5a7e11f8f5220` == 文件 `sha256[:16]` == 事件 `revision`
- 事件数：一次 API patch = 1 帧；一次外部写入 = 1 帧 `doc.changed`（属性-only 亦发 1 帧，`changedNodes:[]`）
- 超时矩阵：408@409ms（半体）/ 431@2ms（头 20 KiB）/ 400@2ms（chunk-size 2 KiB）/ 408@402ms（9 MiB chunk）/ 413（1.1 MiB 体）/ `close()` 2ms
- 未复现：`library.changed` 与 `doc.changed` 双发（仅在跨探针复用 daemon 状态时见过一次，fresh daemon 三次独立复跑均为单帧，记为**不可复现**，不定级）

### 6. 结论

R1/R2 把上轮的 1×P0 与 4×P1 实质修掉了 3 条半：P0-1、P1-1、P1-2、P1-4 CLOSED，P1-3 只到"能发事件、`changedNodes` 为空"。指定复验的 4 个攻击面（错误细节 / SSE 注入 / 走私 / Host）全部 CLOSED。但 R2 新引入的超时/关闭路径带来 **2 条新 P1**：`limits.ts` 在已完成的响应后追加 408 帧（协议串话），`server.ts:219` 硬切 in-flight 请求（客户端无法判断是否生效）。这两条都在"默认 30s / 进程收到信号"的低频路径上，但都属静默错误，建议在 M2.2 前修掉。

ACP: 复验 M2.1 返工：自跑 9 个探针（`/tmp/m21a/{p-ann2,p-rev,p-err,p-sse4,p-sse6,p-smug,p-watch5,p-watch6,p-attr}.mjs` + `t1-rt/t3-limits/t4-raw/t5-shutdown`），18 个 server 文件 `shasum` 前后一致；7 CLOSED / 1 部分（P1-3）/ 2 新 P1（idle 408 串话、closeAllConnections 硬切）/ 3 新 P2（headersMs>bodyMs 崩、9MiB chunk 落 408、注释口径）；未跑 `pnpm verify`（测试员在改 `tests/**`）。
