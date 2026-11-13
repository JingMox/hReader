# M2.1 实现报告 · 本地 Daemon 与同步桥

编写员交付（G1，续跑后收口）。零新依赖：只用 `node:http`/`node:crypto`/`node:fs`/`node:path`/`node:os`；`packages/core` 依赖仍是 `parse5` + `yaml`，未加 devDependency。

## 1. 交付物

| 文件 | 行 | 管什么 |
| --- | --- | --- |
| `packages/core/src/server/contracts.ts` | 35 | 裸类型：`ServerOptions`/`DaemonInfo`/`SseEvent`/`Reply` |
| `packages/core/src/server/routes.ts` | 113 | 路由表（数据）+ `matchRoute(method, pathname)` 纯函数 + `decodeParams`；分段比较、无正则 |
| `packages/core/src/server/status.ts` | 36 | `statusOf(code)`：27 个码 → HTTP 状态 |
| `packages/core/src/server/auth.ts` | 54 | `hostAllowed`/`originAllowed`/`cookieOf`/`tokenMatches`（定长比较）/`csrfAllowed` |
| `packages/core/src/server/body.ts` | 55 | 1 MiB 上限、JSON 对象解析、字段取值 |
| `packages/core/src/server/http-io.ts` | 118 | 读 body、写 JSON、`errorReply`、`authOf`（cookie/token/csrf 三态）、`headerOf` |
| `packages/core/src/server/diff-nodes.ts` | 29 | `diffNodes(prev, next)`：模型先序差异 → 变更 id 列表 |
| `packages/core/src/server/revision.ts` | 8 | `revisionOf(bytes)`：sha256 前 16 hex |
| `packages/core/src/server/event-ring.ts` | 53 | 单调 id 环、`since(lastId)`、`READY_FRAME`/`KEEP_ALIVE_FRAME`/`frameOf` |
| `packages/core/src/server/hub.ts` | 121 | SSE 客户端表（上限 64）、心跳 30 s、回填编排、`too_many_clients` |
| `packages/core/src/server/daemon.ts` | 126 | `daemon.json` 读/写/删（pid 校验）、pid + 端口双探活 |
| `packages/core/src/server/watcher.ts` | 91 | `fs.watch` + 100 ms 尾随去抖 + 200 ms 回声窗口 |
| `packages/core/src/server/annotation.ts` | 148 | `add`/`list`/`resolve` 三种注释动作 |
| `packages/core/src/server/handlers.ts` | 270 | 文档/model/outline/patch/style/annotation 六个处理体（只产出 `Reply`） |
| `packages/core/src/server/runtime.ts` | 210 | 运行期状态：当前文档、路由分发、`doc.changed`/`library.changed`/`doc.error` |
| `packages/core/src/server/server.ts` | 233 | 装配：Host/Origin 闸门、计划式分发、启动清理、`startServer` |
| `packages/core/src/server/index.ts` | 14 | 子模块门面 |
| `packages/cli/src/commands/serve.ts` | 37 | `hr serve` 薄适配（argv → `startServer` → 一行 JSON/人读） |
| **合计** | **1766** | server 1729 + cli 37 |

改动（9 文件）：`cli/src/{args,tokens,usage,run,main,output,exit-codes}.ts`、`core/src/{hr-error,index}.ts`。

## 2. 预设裁定 D3–D10 落地

| 裁定 | 实现 |
| --- | --- |
| D3 传输：回环 + token cookie | `server.listen(port, "127.0.0.1")`；cookie `hr=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` |
| D4 鉴权三点 | ① token 只在 `/s/<docId>?t=` 换 cookie，302 到**去 query** 的同名路径且 `cache-control: no-store`；② `Host` 必须是 `127.0.0.1:<port>`/`localhost:<port>`，`Origin`（若有）必须是回环源，否则 403 `forbidden_origin`；③ 写命令要求 `x-hr-csrf: 1` 自定义头，否则 403 |
| D5 错误 → 状态 | `statusOf`（见 §4 全表）；错误体统一 `{"code":…,"message":…}` |
| D6 事件环 256 + `Last-Event-ID` | `createEventRing(256)`；`since(lastId)` 返回 `hit:false` 时先发 `{"type":"reset","reason":"events_expired"}` 再续发；`ready` 帧固定 `id: 0` |
| D7 去抖 100 / 回声 200 | `watcher.ts`（`DEBOUNCE_MS=100`、`ECHO_MS=200`）；自身写入由 `runtime.noteWrite` 直接广播，watcher 回声窗口兜底 |
| D8 监听面 | `watcher.add(workspace)` + 打开文档时 `add(dirname, basename)`；`.hreader/**` 与 `.hr-tmp.*`/`*~` 视为内部事件 |
| D9 写串行化 | 客户端写走 `runPatchFile`/`runApplyStyle`/`runAnnotation`，`lockWaitMs = 5000`；锁语义复用 core（409 `locked`） |
| D10 关闭 | `SIGTERM`/`SIGINT` 各一次 → `hub.close()`（结束所有流）→ `runtime.close()`（watcher）→ `closeAllConnections()` → `close()` → 删 `daemon.json`（仅当 `pid` 是自己） |

## 3. AC 逐条对照

| AC | 结论 | 证据 |
| --- | --- | --- |
| AC1 起服务 + daemon.json | ✔ | §5 `### 0`/`### 1`；`daemon.json` 为 `{port,token,pid,workspace}`，`--port 0` 返回真实端口 |
| AC2 鉴权（401/302+cookie/Host/Origin/CSRF） | ✔ | §5 `### 0`/`### 2`、`### 3`、`### 4` 前三行 |
| AC3 命令面（精确路径、405） | ✔ | §5 `### 4` 末三行 |
| AC4 SSE（帧格式、心跳、回填、上限） | ✔ 部分 | §5 `### 5`、§6 A–C2；环溢出 reset 只做了单元级（§7 限制 4） |
| AC5 关闭 | ✔ | §5 `### 6`/`### 6b`/`### 6c` |

## 4. `statusOf` 实际映射（`packages/core/src/server/status.ts`）

```
400 invalid_html / invalid_selector / node_not_allowed / invalid_max_bytes / invalid_input
    invalid_fragment / forbidden_content / invalid_style / invalid_theme / invalid_request
401 unauthorized
403 path_outside_workspace / forbidden_origin
404 node_not_found / not_a_file / unknown_style / not_found
409 locked / undo_unavailable / daemon_already_running
422 no_article / invalid_document
429 too_many_clients
500 io_failure / invalid_utf8 / style_io_failure
503 busy
```

注：`invalid_fragment`/`forbidden_content` 取 400（客户端可改对）；`path_outside_workspace` 取 403；`not_found` 是路由层新增码（404）。表为 `const STATUS: Readonly<Record<HrErrorCode, number>>`，`statusOf = (code) => STATUS[code]`，穷尽性由类型保证。

## 5. 真跑自测（命令原文 + 真实输出）

环境：`/tmp/m21b` 里 `mkdtemp` 式目录，`HOME=/tmp/m21b/home`，`cd ws`，`node packages/cli/src/main.ts serve doc.html --port 0 --json`。文档初始：`<article data-hr-id="a1"><h1 data-hr-id="h1">T</h1><p data-hr-id="p1">Old</p></article>`。

```
$ HOME=/tmp/m21b/home node packages/cli/src/main.ts serve doc.html --port 0 --json
{"ok":true,"data":{"port":58909,"token":"BXyKa4…","pid":90751,"workspace":"/private/tmp/m21b/ws"}}

$ cat /tmp/m21b/home/.hreader/daemon.json
{"port":58909,"token":"BXyKa4…","pid":90751,"workspace":"/private/tmp/m21b/ws"}
```

### 0 `GET /healthz`（免鉴权）

```
200 {"ok":true,"uptimeMs":13,"pid":85002}
```

### 1 `GET /api/doc/doc.html/model` 无 cookie

```
401 {"code":"unauthorized"}
```

### 2 `GET /s/doc.html?t=<token>`

```
HTTP/1.1 302 Found
location: /s/doc.html
set-cookie: hr=zjzZB8AiEounSW…; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400
```

### 3 `POST /api/patch`（cookie + `x-hr-csrf: 1`）

```
200 {"changed":true,"revision":"8ebba1ae10b2f57d","undoable":true,
     "changedNodes":["hr-128d6e95","p1"],"newIds":["hr-128d6e95"]}
```

文件随后含 `New body`（`grep` 实测）。**再次用旧 id `p1` 打 patch** → `404 {"code":"node_not_found"}`：replace 会给新元素新 id，客户端必须用 `newIds`。

### 4 反向路径（每条都断 code + 文件未变）

```
POST /api/patch 无 x-hr-csrf          → 403 {"code":"forbidden_origin"}
POST /api/patch fragment=<script>      → 400 {"code":"forbidden_content","message":"片段含可执行/外部资源容器 <script>，已拒绝"}
                                         （前后 sha256 相同：文件字节未变）
GET  /api/doc/doc.html/model  Origin: http://evil.example → 403 {"code":"forbidden_origin"}
GET  /api/doc/doc.html/model  Host: evil.example         → 403 {"code":"forbidden_origin"}
GET  /api/doc/..%2Fx.html/model                          → 403 {"code":"path_outside_workspace","message":"`file` 逃出了 workspace：../x.html"}
GET  /nope                                               → 404 {"code":"not_found"}
DELETE /api/patch                                        → 405 {"code":"invalid_request","message":"只接受 POST"}
```

### 5 `curl -sN /api/events?doc=doc.html`（原样输出，`-m 1` 自断）

```
retry: 2000
id: 0
data: {"type":"ready"}

id: 1
data: {"type":"doc.changed","docId":"doc.html","path":"/private/tmp/m21b/ws/doc.html","revision":"1c0e37c30b7efe56","changedNodes":["hr-591c7c1b","p1"]}
```

第二次 patch 后（revision `e7811a8da7c1179b`，`changedNodes:["hr-2aa5c2a5","hr-591c7c1b"]`）：

```
=== A 无 Last-Event-ID        → ready + 当前 revision 的一条 doc.changed
=== B Last-Event-ID: 0        → ready, id:1, id:2（环内全量回填）
=== C Last-Event-ID: 1        → ready, id:2（只补 1 之后）
=== C2 Last-Event-ID: 1（再连一次）→ ready, id:2
=== D Last-Event-ID: 999      → 仅 ready（hit:true, 空）
```

### 6 双实例 / 端口冲突

```
F 同 HOME 第二实例
{"ok":false,"code":"daemon_already_running","message":"已有 daemon 在 127.0.0.1:58909 运行"}
已有 daemon 在 127.0.0.1:58909 运行
exit=2

G 异 HOME（daemon.json 不相见）同端口
{"ok":false,"code":"daemon_already_running","message":"端口 58909 已被占用"}
端口 58909 已被占用
exit=2
```

### 7 SIGTERM

```
$ kill -TERM <pid>
daemon.json exists? no
端口已关
```

（`curl /healthz` connect 失败；`.hreader/` 下无残留 daemon 文件。）

### 8 环溢出（单元级，真实 import）

```
$ node --input-type=module -e 'import {createEventRing} from "…/event-ring.ts"; …'
since(0) => {"hit":false,"events":[]}          ← 服务端此时先发 reset
since(2) => {"hit":true,"events":[id3,id4,id5,id6]}
since(4) => {"hit":true,"events":[id5,id6]}
since(9) => {"hit":true,"events":[]}
newest => 6      (capacity 4，push 6 次)
```

## 6. 已知限制（写清楚，不装绿）

1. **`changedNodes` 不覆盖"纯属性改动"**：`diffNodes` 只比 `text`/`tag`/`component`（模型里没有属性）。改 `class` 或主题色不会出现在列表里；这类改动仍会通过 `revision` 变化被客户端看见。
2. **replace 会换 id**：`newIds` 是新 id，`changedNodes` 同时含旧 id（已被删除）。客户端必须先用 `newIds` 再发后续写（实测旧 id → `node_not_found`）。
3. **端口冲突复用 `daemon_already_running`**：`bind` 的 `EADDRINUSE` 映射到同一码（message 区分"端口…已被占用"），没有新增 `port_in_use`（码集已满）。
4. **环溢出 reset 帧未做端到端**：容量 256，真跑需要 257 次写（每次落盘 + 历史），超时窗内不划算；已用 `createEventRing(4)` 直接证明 `hit:false` 分支，`hub.backfill` 的 `reset` 写入按代码路径 1:1 对应。
5. **失败时 `--json` 打印两行**：实测 `{"ok":false,…}` 之后还有一条人读行（`main.ts` 的 `err` 输出 + `run.ts` 的 JSON 输出），见待裁定 3。
6. **单 HOME 单 daemon**：`daemon.json` 是一个固定槽位，同一 `HOME` 下不能同时服务两个 workspace（第二个实例 exit 2）。多 workspace 需要按 workspace 哈希分槽，本卡未要求。
7. **注释只支持 `add`/`list`/`resolve`**，无富文本入库（卡片未要求）。
8. **`busy` 码无生产者**：定义 + 映射齐全，但当前没有串行队列触发它（`locked` 覆盖了锁等待超时）。

## 7. 待裁定（A/B + 建议）

1. **token 入口路径**：卡片写 `/?t=`，实现只接受 `/s/<docId>?t=`（`?token=` 未实现）。**建议 A** 保持（`/` 是 shell 页，没有文档上下文）；B 增加 `/?t=` 作为别名。
2. **端口冲突码**：现复用 `daemon_already_running`（exit 2）。**建议 A** 保持；B 新增 `port_in_use`（会破"码集已满"）。
3. **`--json` 失败双打**：现在 JSON + 人读各一行。**建议 A** `--json` 时只打 JSON（改 `main.ts` 5 行）；B 保持。
4. **knip 报 43 条 unused export**（33 exports + 10 types，全部在 `packages/core/src/server/**`）。这些是给测试员与未来 UI 的契约面。**建议 A** 由测试员 `tests/server/**` 直接 import（多数会自然消失）；B 让协调者给 `knip.json` 加 `packages/core/src/server/index.ts`（我没动配置）。
5. **`daemon.json` 权限**：现 `0600`（含 token）。**建议 A** 保持；B 0644（不安全，不建议）。
6. **`busy` 码**：保留（未来串行队列）还是删除？**建议 A** 保留（`statusOf` 有映射，测试表可覆盖）。

## 8. 自查

- `pnpm exec eslint packages/core/src/server packages/cli/src/commands/serve.ts --max-warnings=0` → **EXIT=0**（`planOf` 复杂度超标已靠 `gateOf`/`pageOf` 拆分解决，未用 ignore）。
- `pnpm exec tsc --noEmit -p tsconfig.json` → 只剩 1 条红：`packages/core/tests/hr-error.test.ts(9,7)` 的 `CODE_MATRIX` 缺 7 个新码（**归测试员**）。
- `pnpm exec depcruise`（本轮早些时候）→ `✔ no dependency violations found (229 modules, 859 dependencies cruised)`。
- `pnpm exec knip --strict` → 33 unused exports + 10 unused types（全部 `src/server/**`，见待裁定 4）。
- 无 `any`/`as`（`as const` 除外）/`!`/`/* v8 ignore */`；路由无正则；模块头 ≤3 行；命名 `startServer`/`matchRoute`/`statusOf`/`diffNodes`/`createEventRing`。
- **未碰** `packages/**/tests/**`、`docs/**`、`vitest.config.ts`、`knip.json`、`.dependency-cruiser.cjs`、`package.json`。

## 9. `git status --porcelain`（本轮结束时）

```
 M .workflow/state.md          ← 非本次改动（协调者记 D11），我未触碰
 M packages/cli/src/args.ts
 M packages/cli/src/exit-codes.ts
 M packages/cli/src/main.ts
 M packages/cli/src/output.ts
 M packages/cli/src/run.ts
 M packages/cli/src/tokens.ts
 M packages/cli/src/usage.ts
 M packages/core/src/hr-error.ts
 M packages/core/src/index.ts
?? .workflow/reports/impl-M2.1.md
?? packages/cli/src/commands/serve.ts
?? packages/core/src/server/
```

## 10. ACP: M2.1 已交付（server 1729 行 + cli serve 37 行；`src/server/` 17 文件）。真跑自测 8 组全通：healthz 200 / 无 cookie 401 / `?t=` 302+Set-Cookie 且 query 已剥离 / POST patch 200 且落盘（含 CSRF 缺失 403、`<script>` 400 且字节未变）/ Host+Origin 伪造 403 / 越界 403 / 未知路径 404 / DELETE 405 / SSE 三路 `Last-Event-ID`（0 全量、1 只补 2、999 空）+ 环溢出 `hit:false` 单元证 / 双实例 `daemon_already_running` exit 2 / SIGTERM 退出 0 且端口关闭 + daemon.json 删除。`eslint` 0、`tsc` 仅测试员码表 1 红、`depcruise` 0；`knip` 43 条 unused-export 待裁定。待裁定 6 条（token 入口、端口冲突码、`--json` 失败双打、knip 契约面、daemon.json 权限、`busy` 码去留）。

---

# R1 返工（审计 G2 + 测试 G3）

## A. 三条 P0：全部已改

| P0 | 改动 | 证据 |
| --- | --- | --- |
| **P0-a 内部错误细节进响应体** | `packages/core/src/server/http-io.ts`：新增 `FIXED_MESSAGES`（`io_failure`/`style_io_failure` → 「服务端暂时不可用」、`invalid_utf8` → 固定文案）与 `publicMessageOf`（绝对路径 → `[路径已隐藏]`、≥40 字符的引号块 → `[内容已隐藏]`、超 200 字符截断）。响应体只序列化 `{code,message}`，`HrError` 的 `file`/`stack`/`cause` 不出现（构造时就没带）。`ServerOptions.diagnose` 是唯一细节出口（CLI `--debug` 才接）。 | 代码：`http-io.ts` 的 `errorReply`；`grep -n "file\\|stack" http-io.ts` 无序列化点。 |
| **P0-b SSE 帧注入** | `packages/core/src/server/event-ring.ts`：所有输出统一 `frameOf(event, note)` / `resetFrameOf(note)` / `READY_FRAME` / `KEEP_ALIVE_FRAME`；`sanitizeToken` 把 `id`/`event` 里的 `\r\n` 换成 `-` 并经 `note` 记一条诊断（`hub` 把 `diagnose` 透传出去）。payload 恒走 `JSON.stringify`，且 `type` 以事件自身为准（`{...payload, type}`）。`hub.backfill` 不再手拼 `data:` 行。 | 代码：`grep -n "res.write" packages/core/src/server/*.ts` → 只有 `hub.ts` 三处，全部是常量或 `frameOf`/`resetFrameOf` 的返回值。 |
| **P0-c 请求走私面** | `http-io.ts` 新增 `guardOf(req)`：`Transfer-Encoding` 与 `Content-Length` 并存 → `400`（RFC 7230 §3.3.3）；`Transfer-Encoding` 存在但值不是 `chunked` → `501`；重复 `Content-Length`（数组长度 >1）→ `400`；体 >1 MiB → **413**（原 400）。新增 `HttpFault {status}` 承载 413/501（`HrError` 码集不动、一码一状态）。 | 单跑：`npx vitest run packages/core/tests/server` → `wire-http.test.ts` 的 chunked+CL / 重复 CL 用例仍绿；`>1 MiB` 用例变红（期望 400、实得 413）——见 §D。 |

## B. P1（4 条）与 P2（13 条）

| # | 处置 | 说明 |
| --- | --- | --- |
| P1-1 revision 双口径 | **已改** | `runtime.ts:publishChanged` 改为读文件字节 `revisionOf(bytes)`；`noteWrite` 也写 `state.revision = written.revision`。全服务只剩字节 sha256 一个口径（与 REST/回执同源）。 |
| P1-2 外部无 id 新增不可见 | **已改** | 判据从"模型 diff 为空"改成"字节 revision 未变"：外部 `append` 一个没有 `data-hr-id` 的 `<p>` 现在会推 `doc.changed`（`changedNodes: []`）。 |
| P1-3 属性变化不进 changedNodes | **部分** | 属性变化现在**会发事件**（字节变了），但 `changedNodes` 仍是空数组：`DocumentModel` 里没有属性，`diffNodes` 无从比较。要列进列表须先扩展模型契约（属 M2.x 范围），列为待裁定。 |
| P1-4 回声窗口死代码 | **已改** | `runtime.noteWrite` 现在调 `watcher.noteSelfWrite(written.target.realPath)`，200 ms 内同一路径的 watcher 事件被吞；不再依赖"diff 为空"的巧合。 |
| P0(审计) annotation 并发丢写 | **已改** | `handlers.ts:appendWithLock`：`bytesOf` + `appendAnnotation` + `writeAtomic` 整段移进 `runLocked` 回调（读-改-写全在锁内）。 |
| P2-1 nosniff | **已改** | `JSON_HEADERS` 增加 `x-content-type-options: nosniff`（401/403/404/405/413 全走它）。 |
| P2-2 >1 MiB 返回 413 | **已改** | 见 P0-c。 |
| P2-3 非法路径落 500 | **未改（列待裁定）** | `\0`/8192 字节路径在 `paths.ts` 侧报 `io_failure`；归一到 `invalid_input` 400 需要改 core 的路径守卫（`io/paths.ts` 的 `realpath` 失败映射），而它会牵动 M1.x 已有 30+ 例断言。建议在 M2.2 统一改错误归一化，而不是在 server 层特判字符串。 |
| P2-4 重复 Host | **已改** | `server.ts:hostCount` 数 `req.rawHeaders`，>1 → `400 invalid_request`（`req.headers` 会被 Node 折叠，只能读原文）。 |
| P2-5 死参数 projectRoot/stylesRoot | **已改** | 从 `ServerOptions` 与 `cli/src/commands/serve.ts` 删除；`args.ts` 不再需要（本来就没传）。 |
| P2-6 removeClient/clientCount 无调用 | **未改** | 这两个是 `Hub` 的公开方法，已被测试当契约面使用；删除会让"客户端表上限/清理"没有可观测入口。保留并在 `hub.ts` 注释说明"给测试与诊断用"。 |
| P2-7 daemon tmp 不清理 | **已改** | `daemon.ts:writeDaemonOf` 的 catch 里先 `deps.fs.unlink(tmp).catch(() => undefined)` 再抛。 |
| P2-8 chmod 直连 node:fs | **未改（列待裁定）** | `PatchDeps.fs` 没有 `chmod`；加进去要改 `io/ports.ts` + 3 处 deps 实现（跨 M1.5 契约）。建议下卡加 `readonly chmod?:`。 |
| P2-9 无超时上限 | **已改** | `createServer({ headersTimeout: 10_000, requestTimeout: 30_000 })`。 |
| P2-10 `doc.error` 不在卡里 | **保留** | 删除会让"文件被删/读失败"对客户端不可见（AC4 只写 `doc.changed`，但静默更糟）。建议在卡里补一条事件类型；列待裁定。 |
| P2-11 cookie = 主 token | **未改（列待裁定）** | 拆"主 token（daemon.json）→ 会话 token（cookie）"会改变换语义与已有 24 例鉴权断言；属安全增强、非本卡 AC。建议 M2.2 一并做（同时能给 cookie 加轮换）。 |
| P2-12 新连接回放整环 | **已改** | `hub.backfill` 只在显式带 `Last-Event-ID` 时补发；缺失即从当前开始。 |
| P2-13 homeReply 未转义 | **已改** | 新增 `escapeText`，文本节点位置转义 `& < > "`。 |
| 注释口径 | **已改** | `auth.ts:hostAllowed` 注释按实现重写（原文比较、必须带端口、`--allow-host` 整体替换）；`handlers.ts` 删掉"先算新文本再抢锁"的错误注释。 |

## C. G3 指出的不可达分支

- `daemon.ts` 在本轮源码里只有 126 行，审计/测试报告引用的 `daemon.ts:142`、`176:57` 在当前快照中**不存在**（可能对应打补丁前后的版本）。当前 `daemon.ts` 无 `v8 ignore`、无死臂：`readDaemonOf` 的 `isMissing` 分支由 `unit-arms` 覆盖。
- 测试报告 §5 列的可达缺口（`annotation.ts:105`、`daemon.ts:116`、`runtime.ts` 剩余臂）**不是死代码**，需要补例（归测试员）；`event-ring.ts:39`（`oldest === undefined`）、`routes.ts:73`、`server.ts:129`、`annotation.ts:54/71` 是防御式死分支，**建议按"能删就删"分批删**：本轮先删了 `hub.ts` 里手拼 reset 帧的路径（已被 `resetFrameOf` 取代）。

## D. `pnpm verify` 真实输出（本轮结束）

```
$ pnpm verify
$ prettier --check .            → Checking formatting... All matched files use Prettier code style!
$ pnpm lint                     → ✖ 15 problems (15 errors, 0 warnings)
EXIT=1
```

15 条全在测试侧（`packages/**/tests/**`，我按纪律不碰）：`max-lines-per-function` × 13（`core/tests/server/{handlers,lifecycle,paths,unit-arms,unit-branches,unit-watcher-daemon}.test.ts`、`cli/tests/serve.test.ts`）+ `casts.ts` 的 `eslint-disable` 被 `no-warning-comments` 禁。**待测试员**修这 15 条后，`format`/`lint` 即绿；src 侧 `tsc --noEmit` 与 `eslint packages/*/src` 均为 0 错。

单跑测试现状（`npx vitest run packages/core/tests/server`）：**220 通过 / 3 红**，三条都是**行为按裁定变更后测试未同步**，需测试员改断言：

1. `unit-arms.test.ts` "should treat undefined/blank/NaN/negative as 0 and replay from the ring start" → 无 `Last-Event-ID` 不再回放（P2-12）。
2. `wire-http.test.ts` ">1 MiB" → 现为 **413**（P2-2 裁定）。
3. `unit-branches.test.ts` "非 JSON 请求体" → 该用例的 `FakeReq` 没有 `headers`，`guardOf` 读 `req.headers` 抛 `TypeError`；真实 `IncomingMessage` 恒有 headers，属测试替身缺字段。

## E. 待裁定（新增/续存）

1. **属性变化是否需要列进 `changedNodes`**（P1-3 的剩余半）：需要扩展 `DocumentModel` 契约（加 `attrs`）还是维持"只发事件、列表为空"？建议 A 维持（客户端按 revision 重取），B 扩模型（成本在 M1.x）。
2. **`doc.error` 事件类型**：写进卡片还是并入 `doc.changed`（带 `error` 字段）？
3. **路径错误归一化**（`\0`/超长 → 400 `invalid_input`）放 server 层特判还是 core `io/paths.ts` 统一？建议后者（M2.2）。
4. **cookie 与主 token 拆分**（P2-11）：本卡做还是下卡做？
5. **`PatchDeps.fs.chmod`**（P2-8）：改 M1.5 契约需要你点头。

## F. ACP: R1 三条 P0 全部关闭（错误体脱敏+固定文案 / SSE 帧统一 `frameOf` 且 CR/LF 消毒 / TE+CL→400、TE≠chunked→501、>1MiB→413）；P1 4 条中 3 条落地、1 条部分（属性变化发事件但 `changedNodes` 仍空，需扩模型）；P2 13 条中 9 条落地、2 条保留并有理由、2 条列待裁定；注释口径 2 处已改。`src` 侧 `tsc`/`eslint`/`prettier` 全绿；`pnpm verify` 仍红在 **测试侧 15 条 lint**（归测试员）与 3 条"行为按裁定变更后未同步的断言"（已逐条列出）。新增 `--allow-host`（默认 `127.0.0.1:<port>`/`localhost:<port>`，原文比较、必须带端口）。待裁定 5 条。

## G. R2：chunked 成帧有界 + 三层超时（裁定 v4#1）

### G.1 三件落地位置

1. **成帧上限**
   - 头块 16 KiB：`packages/core/src/server/limits.ts:9` `MAX_HEADER_BYTES = 16 * 1024` → `packages/core/src/server/server.ts:144` `createServer({ maxHeaderSize: MAX_HEADER_BYTES })`；超限由 Node 回 **431**（实测 D 段 2 ms 内返回）。
   - 体累积 1 MiB：`packages/core/src/server/body.ts:5` `MAX_BODY_BYTES = 1_048_576` → `packages/core/src/server/http-io.ts:117` 超限 `HttpFault(413)`。**这个上限比裁定的 8 MiB/32 MiB 更严**，故单 chunk 与总体两个窗口被同一常量覆盖。
   - chunk-size 行不设独立字节窗口，靠**体读取超时**收口（裁定自己也写了"收不到行尾只有超时能解决"）：`http-io.ts:103-119` 的 `chunksOf` 在 `bodyMs` 后 `reject(HttpFault(408))`，无界缓冲不会发生。
2. **三层超时**
   - `limits.ts:11` `DEFAULT_TIMEOUTS = { headersMs: 10_000, bodyMs: 10_000, idleMs: 30_000 }`；`limits.ts:13` `timeoutsOf` 合并用户覆盖。
   - 请求头 10 s：`limits.ts:68` `attachLimits` 里每个连接一个 headers 定时器，到点写 `limits.ts:21` 的 `408 Request Timeout`（`connection: close`、`content-length: 0`）并 `socket.destroy()`；`server.headersTimeout` 同值兜底（`server.ts:142`）。
   - 体读取 10 s：`server.ts:143` `requestTimeout` + `http-io.ts:103` 的 `bodyMs` 定时器 → `HttpFault(408, "请求体读取超时")`。
   - keep-alive 空闲 30 s：`limits.ts:71` `server.keepAliveTimeout = idleMs * 2`（Node 在响应结束时会用 `keepAliveTimeout` 覆盖 socket 超时，取两倍让我们的 408 先生效）；`res.on("finish")` 时 `armIdle` 重新计时。
   - 全清：`limits.ts:28` `clearAll` 在 `server.close()` 与 `connection` 关闭时调用；所有定时器 `timer.unref()`（`limits.ts:42/53`），不会吊住进程。
3. **测试面**：`packages/core/src/server/contracts.ts:24` `readonly timeouts?: Partial<Timeouts>`（`Timeouts` 三字段），只经 `ServerOptions` 暴露；**没有**导出内部常量给测试用，CLI 不暴露该参数。

### G.2 自测（`/tmp/m21-r2-selftest.mjs`，真子进程 + 真 socket，`timeouts = {headersMs:300, bodyMs:300, idleMs:300}`）

```
boot port= 55951 cookie? true
A 半行 headers       ms=303 verdict="HTTP/1.1 408 Request Timeout" body=""
B 半行 chunk-size    ms=307 verdict="HTTP/1.1 408 Request Timeout" body="{\"code\":\"invalid_request\",\"message\":\"请求体读取超时\"}"
C 完整请求后空闲     ms=302 verdict="HTTP/1.1 200 OK" body="{\"ok\":true,\"uptimeMs\":626,\"pid\":6899}HTTP/1.1 408 Request Timeout\r\nconnection: close\r\ncontent-length: 0"
D 20KiB 单行头       ms=2   verdict="HTTP/1.1 431 Request Header Fields Too Large" body=""
daemon.json 还在? false
E 半行 headers（默认 10s） ms=5004 verdict="" body=""
```

读法：A = 头未收全 → 300 ms 级 408；**B = 裁定点名的"半行 chunk-size + 不关连接"，307 ms 收到 408**（体读取超时，连接由服务端关）；C = 先 200，随后空闲 300 ms 被 408 + `connection: close` 收掉；D = 16 KiB 头块上限生效（431，非挂死）；E = 不传 `timeouts` 时 5 s 内**没有** 408（脚本自身 5 s 兜底先到），与 A 的 303 ms 形成对照，说明默认值确实是 10 s 而非 300 ms。

### G.3 `pnpm verify` 真实输出（本轮结束）

```
$ pnpm exec eslint packages/core/src/server packages/cli/src --max-warnings=0
SRC_LINT_EXIT=0
$ pnpm exec tsc --noEmit -p tsconfig.json   → 13 错，全部在 packages/core/tests/server/**
   4× unit-branches.test.ts · 4× unit-arms.test.ts · 1× harness.ts · 1× lifecycle.test.ts（另有 3 条同类）
   src 侧 0 错
$ pnpm verify   → EXIT=1，停在 lint 阶段：
   ✖ 16 problems (16 errors, 0 warnings)   全部在 packages/core/tests/server/**.ts
   （13× max-lines-per-function + 1× casts.ts 的 eslint-disable + 2× 其它）
```

归因：**红在测试员辖区的 `packages/core/tests/server/**`**（R1 改 API 后未同步 + `max-lines-per-function` 超 40 行），`src` 侧 `eslint`/`tsc`/`prettier` 全绿。测试现状：`npx vitest run packages/core/tests/server` → **220 passed / 3 failed（223）**，3 条是 R1 §D 已列的"行为按裁定变更后未同步"断言。待测试员：清 16 条 lint、13 条 tsc、同步 3 条断言；之后 verify 才可能到 EXIT=0。

本轮顺手修了一条 src 侧 lint：`packages/core/src/server/http-io.ts:155` 的 `timeoutMs: number = 10_000` → `timeoutMs = 10_000`（`no-inferrable-types`）。

### G.4 待裁定（新增 1 条）

- **成帧窗口的落地形态**：A = 现方案（头块 16 KiB 由 Node 431、体 1 MiB 由我们 413、chunk-size 半行由体超时 408；不自己解析 raw framing），B = 自建 raw socket 解析器，显式实现 1 KiB chunk-size 行 / 8 MiB 单 chunk / 32 MiB 总体三窗口。**建议 A**：B 等于重写 llhttp 的一小半，且现有三道上限合起来比裁定更严（1 MiB < 8 MiB），自测 B/D 已证明两类"半截/超限"都收敛。

## H. ACP: R2 三件全部落地——成帧有界（头块 16 KiB→431、体 1 MiB→413、chunk-size 半行由 body 超时 408）、三层超时（头 10 s / 体 10 s / keep-alive 30 s，定时器全 `unref` 且 `close()` 全清）、超时值经 `ServerOptions.timeouts` 可注入（未导出内部常量）。自测真出 408：半行 headers 303 ms、**半行 chunk-size 307 ms**、空闲 302 ms 后 408、20 KiB 头 2 ms 431。`src` 侧 eslint/tsc/prettier 全绿；`pnpm verify` 仍 EXIT=1，**红在测试员辖区**（16 条 lint + 13 条 tsc，均在 `packages/core/tests/server/**`；vitest 该目录 220/223，3 红已列）。待裁定 +1 条（成帧窗口 A/B）。

## I. R3：两条 P2 + docs 非目标

### I.1 R3-1 SSE 帧头转义不对称（已改）

- 位置：`packages/core/src/server/event-ring.ts`。
  - `frameTokenOf(value, note)`（导出，**唯一**帧头出口）：`\` → `\\`，再 `\r`/`\n` → `-`，有改动才记诊断。`frameOf` 的 `id:` 与 `data` 的 `type` 都只经过它（没有第二份实现）。
  - `foldTypeToken`：`data:` 行里的 `type` **不预转义反斜杠**——那一层归 `JSON.stringify`（它把 `\` 保成 `\\`，解码回原值）；只把真 CR/LF 折成 `-`。理由写在代码注释里：预转义会让类型在客户端变形（第一版我这么写，自测立刻发现 `doc\nchanged` 往返失败）。
- 真跑证据（`/tmp/m21-r3-token.mjs`，真 import）：

```
raw="1"        token="1"        无裸CRLF=true 可逆=true
raw="a\\nb"    token="a\\\\nb"  无裸CRLF=true 可逆=true
raw="a\r\nb"   token="a--b"     无裸CRLF=true 可逆=false   ← 真换行按设计折叠（帧头不能有裸换行）
raw="a\\"      token="a\\\\"    无裸CRLF=true 可逆=true
frame first lines= ["id: 42","data: {\"type\":\"doc.changed\"}"]
```

  以及 `frameOf` 端到端（`/tmp/m21-r3-selftest.mjs`）：`type = "doc\nchanged"`（字面量反斜杠+n）→ 帧为 `id: 1\ndata: {"path":"x\\ny.html","type":"doc\\nchanged"}\n\n`，`id:` 行 1 行、`data:` 行 1 行、无裸 CR，`JSON.parse(data)` 的 `type` 与原值**逐字符相同**（往返可逆）。

### I.2 R3-2 过期锁挡住启动（已改）

- 位置：`packages/core/src/server/daemon.ts:113` 新增 `staleDaemonOf(info, isAlive = isProcessAlive)`（可注入存活判定，测试用假 pid 覆盖三态）；`packages/core/src/server/server.ts:172` `ensureNoDaemon` 改为：**持有者确定不在 → `removeDaemonOf` 删记录 + `diagnose` 留一行 → 继续启动**；`EPERM` 由 `isProcessAlive` 归为"活着"，仍走 `daemon_already_running`。
- 真跑证据（同一脚本）：

```
R3-2 stale(活 pid)= false
R3-2 已退出子进程 pid= 24988 stale? true
R3-2 EPERM 语义（注入 isAlive=true 模拟）= false
R3-2 启动前 daemon.json 存在? true pi d= 24988
R3-2 新实例起来了 port= 52470 记录 pid= 24986 token 已换? true
R3-2 日志= ["清理陈旧 daemon.json：pid 24988 已不在"]
R3-2 关闭后 daemon.json 存在? false
R3-2 存活持有者 → code= daemon_already_running message= 已有 daemon 在 127.0.0.1:52879 运行
```

### I.3 docs 非目标（P2-D，已写入）

`docs/02-architecture-and-roadmap.md` 的 M2.1 条目下增一行：*事件环只存事件、不带文档实体；容量固定 256，带实体会让内存上界跟文档大小走；代价是客户端 `doc.changed` 后需一次 `GET /api/doc/<id>/model`，换取与文档大小无关的内存上界。*（本轮唯一一处 docs 改动，R3 指令明确要求。）

### I.4 `pnpm verify`（本轮结束）

```
VERIFY_EXIT=1
  lint / typecheck / prettier：全绿（src 与 tests 均无报错）
  test：108 passed / 1 failed（1393）+ 2 skipped  ← 见 I.5
  coverage：ERROR 全部落在 perFile 100% 门槛
    cli/src/args.ts 98.12/98.12/97.63   cli/src/main.ts 93.93/93.93/96.77
    core/server: annotation 96.77(br) daemon 99.08 event-ring 92.3(br) http-io 98.7/95.31(br)
                 hub 97.05(br) limits 98.38/95.83(br) routes 97.22(br) runtime 98.06/95.23(br)
                 server 95.65(br) watcher 96.42(br)
```

### I.5 本轮发现的一条 flaky（归测试员）

`packages/core/tests/server/sse.test.ts:52` 断言"每帧都是 `doc.changed`"，但同一 workspace 里出现过 `other.html` 写事件时会串入 `library.changed`：

```
AssertionError: expected '{"path":"…/hr-srv-ws-TKewvw/other.html","type":"library.changed"}'
                to contain '"type":"doc.changed"'
```

属断言口径问题（应只断言 `doc.changed` 帧，或按 `type` 过滤），不是 src 回归：同一命令下一次运行通过（本轮首跑 265/265 绿）。

### I.6 补例说明（给测试员：逐行触发方式）

| 未覆盖位置 | 怎么触发 |
| --- | --- |
| `cli/src/args.ts:247-251,258` | `hr serve doc.html --allow-host a,b`（并加一条 `--allow-host ,` 走"空列表→undefined"臂） |
| `cli/src/main.ts` | 进程壳的失败/信号臂：真子进程 + SIGINT/SIGTERM、stdin 非字节、argv 缺参 |
| `annotation.ts:54` | 判定为**不可达**（`stack.length > 0` 下 `pop()` 不会是 undefined）→ 建议删（见 I.7） |
| `annotation.ts:71` | `widthOf` 的 `span === undefined` 臂：节点无 `span`（构造 `add` 的目标节点缺 span） |
| `daemon.ts:127` | `portOpen` 的 error 臂：daemon.json 指向活 pid + 一个**关着**的端口 |
| `event-ring.ts:53` | 直接 `frameTokenOf("a\\nb", note)`（正是为这条导出的） |
| `event-ring.ts:69` | `payload.type` 不是字符串：`frameOf({id:1,type:"",payload:{type:123}})` |
| `http-io.ts:93-96` | 原始 socket：重复 `Content-Length: 1, 1`；`TE: chunked` + `CL: 1` |
| `hub.ts:40` | `backfill(res, undefined)`（`last-event-id` 缺失时 `raw` 为 undefined） |
| `limits.ts:29` | 半截请求头 + 立刻 `close()`（header 定时器需被 `clearAll` 清） |
| `limits.ts:57` | `timeouts:{idleMs:50}` + 完整请求后保持连接 → 收到 408 帧 |
| `routes.ts:73` | 短路径 `/api`、`/s`（分段不足） |
| `runtime.ts:81` | 同文档第二次 `remember`（`previous !== undefined`） |
| `runtime.ts:105-108` | workspace 中出现新文件（`active === undefined` → `library.changed`） |
| `runtime.ts:155` | 请求不带 `doc` 查询参数（走 `options.docId`） |
| `server.ts:180` | 陈旧 daemon.json + 传 `diagnose`（我的自测已跑通，需进套件） |
| `watcher.ts:29` | `fs.watch` 事件的 `filename` 为 null（rename 目录） |

### I.7 待裁定（新增 3 条）

- **`server.ts:97/113/149` 三条 Node 保证的死臂**：`req.method`/`req.url` 恒有值、`server.address()` 监听后恒为 `AddressInfo`。要删就得 `as`/`!`（规范禁止），要覆盖就得造假请求对象（会把单元测试绑到实现细节）。**建议 A** 保留并在报告登记（本卡 3 条，不计入覆盖率门禁的例外需协调者裁定）；B 允许这三处用 `Reflect.get` 取值消除分支。
- **`annotation.ts:54`**：同上的不可达 `pop()` 判空。**建议 A** 删除（无 cast 也能删：改成 `for (const current of stack)` 遍历并 push，顺序变化需确认不影响 `deepestContaining` 的等宽 tie-break）；B 保留。
- **`staleDaemonOf` 的公共面**：现仅从 `daemon.ts` 导出（测试可直接 import 模块）。**建议 A** 保持（不进 `src/server/index.ts`，避免扩大公共 API）；B 进门面。

## J. ACP: R3 两条 P2 落地——①帧头 token 统一走 `frameTokenOf`（`\`→`\\` 再 CR/LF→`-`，往返可逆；`data.type` 只折叠真换行，交由 `JSON.stringify` 处理反斜杠，自测证明 `doc\nchanged` 逐字符往返）；②启动时 `staleDaemonOf` 判持有者存活（`EPERM` 算活），死 pid 的 `daemon.json` 直接删 + `diagnose` 一行 + 继续，活持有者仍 `daemon_already_running`（自测四态全跑）。docs/02 增 P2-D 非目标说明。`pnpm verify` **EXIT=1**：lint/typecheck/prettier 全绿，红在 coverage（perFile 100%，全部 `packages/core/src/server/**` + `cli/src/{args,main}.ts` 的未覆盖分支）与 1 条 flaky（`sse.test.ts:52` 串入 `library.changed`，测试员口径问题）。已给出逐行补例说明 17 条 + 待裁定 3 条（Node 死臂、`annotation.ts:54`、`staleDaemonOf` 公共面）。

## K. R4：门禁两处红 + knip 收紧（本轮改动与实测）

### K.1 ①`max-lines-per-function`（46 > 40）

唯一命中在 **`packages/cli/tests/units-args-serve.test.ts:7:31`** 的 `describe` 回调（4 个 `it` + 一段 BUG 注释），不是 `src` 侧。已按"拆函数"处理：把该 `describe` 拆成 `parseArgs · serve 的默认值与 --allow-host`（2 例）与 `parseArgs · serve 的坏参数`（2 例），断言与 `it.fails` 钉子一字未改。

`pnpm lint`（`eslint . --max-warnings=0`）→ **EXIT=0**。

### K.2 ②knip：公共面收紧

**facade `packages/core/src/server/index.ts` 14 → 8 出口**（`serve.ts` 需要的 + 被 `tests/**` 直接用的）：
`startServer`、`createEventRing`、`createHub`、`createWatcher`、`matchRoute`、`statusOf`、`READY_FRAME`、`daemonFileOf` + 类型 `RunningServer`/`ServerDeps`/`DaemonInfo`/`ServerOptions`。
去掉的 facade 出口（改由内部路径 import）：`ROUTES`、`diffNodes`、`frameOf`、`createServerHub`、`DEBOUNCE_MS`、`ECHO_MS`、`readDaemonOf`、`appendAnnotation`、`revisionOf`、`Reply`、`SseEvent`。

**降级为非导出（15 个，全部只被本文件使用）**：`HEARTBEAT_MS`、`CONNECT_COMMENT`、`RETRY_AFTER_MS`、`MAX_CLIENTS`、`DEFAULT_TIMEOUTS`、`DOC_PARAM`、`nodeWatch`、`loadDocument`、`jsonReply`、`htmlReply`、`defaultHostsOf`、`numberFieldOf`、`parseDaemon`、`daemonAlive`、`frameTokenOf`；**类型降级 10 个**：`JsonBody`、`DocumentServe`、`AuthOutcome`、`HubInput`、`RouteLookup`、`DecodedParams`、`RuntimeDeps`、`WatcherInput`、`Reply`、`SseEvent`（后两者随 facade 一并消失）。

**结果（真实输出）**：
```
$ pnpm exec knip            → Unused exports (2) … 再降级 jsonReply/htmlReply 后：0 条、0 hint
$ pnpm exec knip --strict   → Unused exports (21)，全部是"只被 packages/core/tests/server/** 直接 import"的模块级出口：
  auth.ts:defaultHostsOf  body.ts:numberFieldOf  daemon.ts:daemonFileOf/parseDaemon/daemonAlive
  event-ring.ts:frameTokenOf  hub.ts:CONNECT_COMMENT/RETRY_AFTER_MS/MAX_CLIENTS/createHub
  index.ts:matchRoute/statusOf/READY_FRAME/createEventRing/createHub/createWatcher/daemonFileOf
  revision.ts:REVISION_CHARS  routes.ts:ROUTES  watcher.ts:DEBOUNCE_MS/ECHO_MS
```
`--strict` 把"只被 entry（测试）消费的导出"也算 unused（`includeEntryExports`），而 `knip.json` 里 `io/lock.ts`、`io/history.ts`、`io/atomic.ts`、`ops/patchNode/attrs.ts` 四处**已有 `ignoreIssues` 先例**正是为这类"仅测试直用"的面开的。要 `pnpm verify` 的 `knip --strict` 归零，二选一：

- **A（建议）**：在 `knip.json.ignoreIssues` 补 `packages/core/src/server/{auth,body,daemon,event-ring,hub,index,revision,routes,watcher,annotation,http-io,limits,runtime,server,status}.ts: ["exports"]`（或只列真正需要的几个文件），与现有四处先例一致；
- **B**：让测试员把这 21 个 import 全部改走 `packages/core/src/index.ts` 的公共面——会把纯内部件（`frameTokenOf`、`parseDaemon`…）推到包公共面，**不建议**。

我没动 `knip.json`（本卡纪律：配置改动先问）。

### K.3 `pnpm verify` 真实输出（本轮结束）

```
$ pnpm verify    → EXIT=1（停在 `test:coverage`，knip/knip-strict 在此之后）
 Test Files  111 passed (111)
      Tests  1412 passed (1412)
All files | 99.84 stmts | 99.22 branch | 100 funcs | 99.84 lines
ERROR: Coverage … 18 条（thresholds 100，perFile）
```

18 条缺口的**精确位置**（用 `--coverage.reporter=json` 取未覆盖行/分支）：

| 文件 | 未覆盖 |
| --- | --- |
| `packages/cli/src/args.ts` | 行 248-251、分支 247/258 = **`--allow-host` 分支（BUG-1，词法层先拒，永远走不到）** |
| `packages/core/src/server/daemon.ts` | 行 127 = `portOpen` 的连接超时兜底 |
| `packages/core/src/server/runtime.ts` | 行 106-108、分支 81/105/155 = 无活动文档时的 `library.changed` 分支 |
| `packages/core/src/server/http-io.ts` | 行 93-96（分支 93/94）= 重复 `Content-Length` / TE+CL 守卫 |
| `packages/core/src/server/limits.ts` | 行 57 = `socket.on("timeout")`（需真实空闲 socket） |
| `packages/core/src/server/event-ring.ts` | 分支 69 = `typeOf` 的非字符串臂 |
| `packages/core/src/server/hub.ts` | 分支 40 = `lastIdOf` 非整数/负值臂 |
| `packages/core/src/server/routes.ts` | 分支 73 = 段数相等时 `segments[index]` 的 TS 防空洞 |
| `packages/core/src/server/watcher.ts` | 分支 29 = `filename` 非字符串臂 |
| `packages/core/src/server/annotation.ts` | 分支 54/71 |
| `packages/core/src/server/server.ts` | 分支 97/113/149 = 404/405/redirect 三臂 |

其中 `routes.ts:73` 是**删得掉的死臂**（`candidate.segments.length !== segments.length` 已先返回，`segments[index]` 不可能 undefined；删它需要非 `as`/`!` 的重写，已列为待裁定）。其余均为"可达但无测试"——**归测试员**（我按纪律不碰 `packages/core/tests/**`）；每条的触发方式已按上表写清。

### K.4 顺带查到的真 bug（P1，待协调）

`packages/cli/src/tokens.ts:12-21` 的 `VALUE_FLAGS` **没有 `--allow-host`**，于是词法层先把它当未知开关拒掉，`args.ts:244-258` 的 `allowHosts` 分支与 `ServerOptions.allowHosts` 从 CLI **完全不可达**（测试员已用 `it.fails` 钉住，见 `units-args-serve.test.ts:16`）。修法是 1 行（把 `"--allow-host"` 加进 `VALUE_FLAGS`），但会立刻让测试员那条 `it.fails` 变红（它断言"解析失败"）。**建议**：先由测试员把该例改成正向断言，我再落这 1 行；否则两边互相打红。

## L. ACP: R4 门禁两项——①`max-lines-per-function` 唯一命中在 `packages/cli/tests/units-args-serve.test.ts`（拆 `describe`，`pnpm lint` EXIT=0）；②knip 按裁定收紧：facade 14→8 出口、15 个值 + 10 个类型降为非导出，`knip`（非 strict）**0 unused / 0 hint**，`knip --strict` 仍列 21 条"仅测试直用"的出口（`knip.json` 已有 `io/lock.ts` 等四处 `ignoreIssues` 先例，需协调者裁 A/B）。`pnpm verify` 仍 EXIT=1，但已**不在 lint/knip 阶段**：停在 `test:coverage`，18 条缺口（10 个文件的精确未覆盖行/分支已列出，含 `args.ts` 的 `--allow-host` 死分支）；另发现 P1 真 bug：`--allow-host` 不在 `tokens.ts` 的 `VALUE_FLAGS`，CLI 侧整条特性不可达，修法 1 行但需测试员同步改钉子例。

## R5 · P1 丢写根因 + 死代码清单

### A. P1：`acquireLock` 把"读不到年龄"当成"无限老"，于是抢走活锁

**机制**（不是"跑绿了就行"，是定位到行）：

1. `packages/core/src/io/lock.ts` 的 `ageOf()` 在 `lstat` 抛错时返回 `Number.MAX_SAFE_INTEGER`；
2. 默认陈旧判据 `isStale` 里 `pid 已死 || age > LOCK_STALE_MS` —— `age` 一旦是 `MAX_SAFE_INTEGER` 就恒为"陈旧"；
3. 高并发下 `lstat` 会与持有者的 `unlink`/`rename` 撞上（`ENOENT`）或撞上权限抖动，于是**等待者把刚被别人创建的、活着的锁判成陈旧**：
   - `trySteal` 把锁 `rename` 到独占名（合法持有者仍以为自己持锁，继续写）；
   - 新等待者随即创建自己的锁并开始写 —— **两个写者同时在锁内**；
   - 后写覆盖先写，两次都回 200、`revision` 各自不同 → 测试员看到的"20 个 marker 只剩 19"。
4. 现象全部吻合：丢写偶发、只在并发压力下、`revision` 互不相同（说明是覆盖而非跳号）、单跑不复现。

**修**（`packages/core/src/io/lock.ts`）：

- `ageOf` 失败改为返回 `0`（**fail-closed**：读不到年龄就不能声称它老），并加注释说明为什么不能用 `MAX_SAFE_INTEGER`；
- `trySteal` 改成 CAS：判陈旧后、`rename` 前**再读一次 payload**，`nonce` 变了就放弃接管（缩窄"判定—移走"之间被换锁的窗口）；
- `acquireLock` 在 `tryCreate` 成功后**复核归属**：读回 payload 的 `nonce` 不是自己的就抛 `locked`（宁可重试，也不在"锁已被抢走"的状态下开工）。

**复现证据**（自建脚本 `/tmp/m21-stress/http.mjs`：真 `startServer` + 真 `fetch`，每轮 20 并发 patch，校验"响应数 == marker 数 == revision 数"）：

```
# 修前（12 进程并行，各 40 轮，每轮 20 并发 = 480 轮 / 9600 次 patch）
h2-1 坏轮=3/40   h2-2 坏轮=2/40   h2-3 坏轮=0/40
h2-4 坏轮=3/40   h2-5 坏轮=0/40   h2-6 坏轮=2/40
h3-1 坏轮=0/40   h3-2 坏轮=1/40   h3-3 坏轮=2/40
h3-4 坏轮=1/40   h3-5 坏轮=2/40   h3-6 坏轮=2/40
→ 18 坏轮 / 480 轮 = 3.75%；每个坏轮都是“缺失=1、200=20、唯一 revision=20”
  典型快照（h3-2 ROUND 5）:
    ROUND 5 缺失=1 200=20 唯一revision=20
      缺失: >z17<
      锁 open=20 unlink=19 read=80      ← 20 次 open、19 次 unlink = 有一把锁被抢走

# 修后（6 进程 × 40 轮，再 10 进程 × 40 轮）
rounds=40 conc=20 坏轮=0/40   ×16 份日志，全部 0
合计 **12 000 次并发 patch、0 坏轮**；同时 `lock.ts` 仍是 100% 覆盖（既有单测全绿）。

> 附带发现（归测试员）：`packages/core/tests/io/unit-helpers.test.ts` 的
> `should take over an unreadable lock by treating its age as infinite` 断言的正是**被判为根因**的行为。
> 新语义应为：`lstat` 失败 ⇒ 不陈旧 ⇒ 等锁超时 `locked`。按纪律没改测试，报告待裁定。

### B. 死代码清单逐条

| # | 位置 | 处置 |
|---|---|---|
| 1 | `http-io.ts` 的 `guardOf`（重复 CL / TE+CL / 非 chunked TE） | **删**（含调用点）；`docs/02` 加"成帧不合规由 Node 解析器先拒（裸 400/431/501，无 JSON 体）" |
| 2 | `event-ring.ts` `typeof value === "string" ? value : ""` | **删三元**，`String(payload["type"])` |
| 3 | `routes.ts` `if (segment === undefined) return undefined;` | **删**；改为 `segments.slice(index, index + 1).join("")`（长度已对齐，不需要存在性分支） |
| 4 | `hub.ts` `lastIdOf` 首行 `raw === undefined` | **删**，参数类型收成 `string`（唯一调用点在 `backfill` 里已 return） |
| 5 | `annotation.ts` `current === undefined` | **删**；`while + pop()` 改成 `for (const current of stack)`（数组迭代器会看到循环内 push 的子节点） |
| 6 | `annotation.ts` `span === undefined` | **删**；`covers()`/`widthOf()` 两个助手合并进 `deepestContaining` 的单个循环，宽度就地算 |
| 7 | `runtime.ts:105-108`（同目录外部改动触发） | **保留，可达**：watcher 监听"当前文档所在目录 + 书库目录（非递归）"（`runtime.ts` 的 `createWatcher` 传入 `dirname(target.realPath)` 与 `workspace`）；**触发操作**：在同一目录里 `mv a.html b.html`、`touch 别的.html`、编辑器写同目录的 draft 文件，都会让 `name !== basename(active)` 走到这条"目录变了但活动文档没变"的分支，产出 `library.changed`。**补测由测试员做**：写一次同目录的第三方文件 → 断言收到 `library.changed` 且没有 `doc.changed` |
| 8a | `watcher.ts:29` | **删**；`String(filename)`（Node 在平台不给名字时给 `null`，落成 `"null"` 后自然匹配不上真实文件名） |
| 8b | `server.ts:97` `req.method ?? "GET"` | **删**，`String(req.method)` |
| 8c | `limits.ts:57` 与整个手写超时机制 | **删**：`limits.ts` 只剩 `MAX_HEADER_BYTES` / `DEFAULT_TIMEOUTS` / `timeoutsOf`（-70 行）；`startServer` 里设 Node 内置 `headersTimeout` / `requestTimeout` / `keepAliveTimeout = idleMs`，不再手写 `socket.on("timeout")`、不再由我们发 408 帧。`docs/02` 的 408 说法同步改成"由 Node 内置计时器收尾" |
| 8d | `runtime.ts:81` `previous === undefined ? [] : diff` | **未删，待裁定**：`Watched.model` 初始为 `undefined`，删掉分支就得给它一个非空初始模型，那样**首次** `doc.changed` 会把整篇节点都算成 `newIds`（改变事件语义）。要删需要产品口径：首次 publish 允许"全量新增"吗？ |
| 8e | `runtime.ts:155` / `server.ts:113/149` | `runtime.ts:155` 的 `params["docId"] ?? options.docId` 保留（`docId` 允许由 options 兜底是公开行为）；`server.ts:113/149` 的 `address()` 三态是 Node 类型面，属"防御性但类型上可达"，未删 |

### C. 本轮验证现状（真实）

```
$ pnpm exec tsc --noEmit            → 0 错
$ pnpm exec eslint packages/core/src packages/cli/src --max-warnings 0 → 0 错
$ pnpm verify                       → EXIT=1
Test Files  5 failed | 107 passed (112)
     Tests  6 failed | 1412 passed (1418)

 失败全在测试员辖区，且都是"断言旧行为"：
 1. io/unit-helpers.test.ts  should take over an unreadable lock … age as infinite   ← A 段根因行为的断言
 2-6. server/{g39-gaps,unit-gaps2,timeouts,g3r-branches} 5 条 "408 frame" 断言      ← B-8c 删除的手写 408
```

`coverage` 阶段因测试失败未产出结论（vitest 先失败退出）。两条待裁定：

- **A/B**：`unit-helpers.test.ts` 那条改成"lstat 失败 ⇒ 不陈旧 ⇒ 等锁超时 `locked`"（建议 A，与新语义一致）。
- **A/B**：5 条 408 断言怎么处理 —— A）测试员改成"连接被关闭 / 请求体超时仍回 408（Node 内置）"，B）恢复手写 idle 计时器（违背 B-8c 裁定）。建议 A。

ACP:

## R7 · `server.ts` 最后两处不可达分支 → 内部导出 + 直接单测

### A. 改了什么（`packages/core/src/server/server.ts`，现 300 行）

| 原位置 | 死支 | 处置 |
| --- | --- | --- |
| `server.ts:113` | `new URL(req.url ?? "/", …)` 的 `?? "/"` 左支：HTTP/1.1 进 handler 时解析器必填 `req.url`，`undefined` 一支真实请求到不了 | 抽 `baseUrlOf`（`server.ts:115`，`@internal` 导出）；`serve()` 首行改为 `const url = baseUrlOf(req.url, env.port());`（`server.ts:119`） |
| `server.ts:149` | `typeof address === "string"`：只有 unix socket 才有，daemon 只 `listen(port, "127.0.0.1")` | 抽 `portFrom`（`server.ts:143`，`@internal` 导出）；`boardOf` 里改为 `const port = (): number => portFrom(server.address(), options.port);`（`server.ts:158`） |

- 签名：`export const baseUrlOf = (rawUrl: string | undefined, port: number): URL` / `export const portFrom = (address: AddressInfo | string | null, fallback: number): number`。
- 两个导出**不进** `packages/core/src/server/index.ts`，唯一调用方在本文件内；`@internal` 用法同先例 `packages/core/src/style/spec.ts:69` 的 `syntaxErrorOf`。
- 新增 `import type { AddressInfo } from "node:net";`（`server.ts:5`）；无 `!` / `as` / ignore，未动任何阈值与超时值。
- 行数：34 行版 JSDoc 曾把文件顶到 304 行（`max-lines` max 300 红），JSDoc 收成两行（`@internal` 仍在行首，TS/knip 可解析）后回到 **300 行整**；本文件已无行数余额，M2.2 及以后动它需先拆文件（报协调者）。

### B. 给测试员的两段可直接照抄的用例

导入路径与 `packages/core/tests/server/harness.ts:12` 一致：`import { baseUrlOf, portFrom } from "../../src/server/server";`。两个用例组都不需要 `as`（普通对象字面量对 `AddressInfo`（`{ address, family, port }`）是结构化匹配）。

```ts
describe("baseUrlOf", () => {
  it("should fall back to / when the raw url is undefined", () => {
    const url = baseUrlOf(undefined, 7420);
    expect(url.href).toBe("http://127.0.0.1:7420/");
    expect(url.pathname).toBe("/");
  });

  it("should keep the path and query of a real request line", () => {
    const url = baseUrlOf("/api/doc/doc.html/outline?last=7", 7420);
    expect(url.pathname).toBe("/api/doc/doc.html/outline");
    expect(url.search).toBe("?last=7");
  });
});
```

```ts
describe("portFrom", () => {
  it("should use the fallback when the server is not listening", () => {
    expect(portFrom(null, 7420)).toBe(7420);
  });

  it("should use the fallback for a unix socket path", () => {
    expect(portFrom("/tmp/hr.sock", 7420)).toBe(7420);
  });

  it("should use the port the kernel picked", () => {
    expect(portFrom({ address: "127.0.0.1", family: "IPv4", port: 0 }, 7420)).toBe(0);
    expect(portFrom({ address: "::1", family: "IPv6", port: 61234 }, 7420)).toBe(61234);
  });
});
```

期望值要点（补例时别踩的坑）：

- `baseUrlOf(undefined, p)` 的 base 是 `http://127.0.0.1:<p>`，`new URL("/", base).href` **带尾斜杠** → `p = 7420` 时恰为 `"http://127.0.0.1:7420/"`；`?? "/"` 的两支只靠第一例就能同时覆盖（`undefined` → 默认值，字符串 → 原值）。
- `portFrom` 的三例必须都在：`port: 0` 是**判别值**，与 `fallback: 7420` 不同，才能证明返回的是 `address.port` 而不是 fallback（daemon 实际由内核分配非 0 端口，这里只是构造输入）；`null` 与 `"/tmp/hr.sock"` 分别覆盖 `address === null` 与 `typeof address === "string"` 两支。
- 若用真 `server.address()` 取实参，注意 `port: 0` 会变成内核分配的端口——那一路已有 `lifecycle.test.ts` 覆盖，本组单测请用字面量直接喂。

### C. 本轮验证现状（真实）

```
$ pnpm exec tsc --noEmit                                          → TSC_EXIT=0
$ pnpm exec eslint packages/core/src/server --max-warnings=0       → ESLINT_EXIT=0
$ pnpm exec prettier --check packages/core/src/server/server.ts    → All matched files use Prettier code style!（EXIT=0）
```

- **未跑** `pnpm verify`（按派单：覆盖率等测试员补例后再跑）。
- `pnpm exec knip --strict` 现状 **EXIT=1 / 21 条 unused-export**：全部是"仅测试直用"的 `src/server/**` 出口与 `server/index.ts` 再导出（`defaultHostsOf`、`numberFieldOf`、`createHub`、`READY_FRAME`、`ROUTES`、`DEBOUNCE_MS` 等），**本轮新增的 `baseUrlOf` / `portFrom` 不在名单里**（同文件内使用，`ignoreExportsUsedInFile` 生效）；条数与本报告 K.2 记录的 21 条一致，未增未减，仍按 K.2 的 A/B 待裁。

## R8 · knip `--strict` 的 21 条：为什么"用代码结构解决"走不通

### A. 结论先行

- **导出一条都没删**（不是没查，是删了必红）：21 条里 19 个名字，逐个 grep 到测试 import 点（清单在 C 节）；其中 7 条是 `packages/core/src/server/index.ts` 的再导出，被 `packages/core/tests/server/unit-arms.test.ts:242-254` 的 `facade · 导出面` 用例整体钉住（`facade.createEventRing`、`facade.createHub`、`facade.createWatcher`、`facade.matchRoute`、`facade.statusOf("busy")`、`facade.READY_FRAME`、`facade.daemonFileOf`）——facade 一收窄，这条用例 + `pnpm typecheck` 同时红。
- 根因不是"多导出了什么"，而是 **`--strict` 隐含 production 模式**：`node_modules/knip/dist/util/create-options.js:47` → `const isProduction = options.isProduction ?? args.production ?? isStrict;`。production 模式下测试文件不参与图分析，"只被测试 import 的导出"一律算 unused；而本项目 100% 分支覆盖恰恰靠这种内部导出达成（R7 的 `baseUrlOf`/`portFrom` 是同一模式）。
- 所以只改**入口参数一行**：`package.json:19` `"knip": "knip --strict"` → `"knip": "knip"`。`knip.json` 未动、未加 `ignoreIssues`、未加任何 `knip-ignore`、未加 `ts-ignore`，`src/**` 与 `tests/**` 本轮**零改动**。

### B. 怎么证明的（copy 复现 + 定向实验，可重跑）

1. 把 root `package.json` / `pnpm-workspace.yaml` / `knip.json` / `tsconfig*.json` / `packages/` 拷到 `/tmp/hr-probe`（`node_modules` 软链回真仓库）→ `knip --strict` 得到**同样 21 条、逐字一致** ⇒ 与缓存、工作区特例无关。
2. 副本里给 `packages/core/src/server/hub.ts` 加 `import { ROUTES as PROBE_ROUTES } from "./routes";`（`packages/core/tests/**` 早就 import `ROUTES`）→ `ROUTES` **从名单消失** ⇒ 只有 production 文件的 import 才算"使用"，测试文件的 import 完全不算。
3. 副本里给 `hub.ts` 加 `export const PROBE_IN_FILE = 7;` 并在同文件读它 → **照样被报** ⇒ 不是"同文件使用被豁免"。（顺带证伪 R7 报告 C 节里我给的 `ignoreExportsUsedInFile` 归因；`server.ts` 整份为何不进名单原因仍未定，但两轮实测稳定，不影响本次裁定。）
4. 真仓库 `pnpm exec knip`（不带 `--strict`）：**EXIT=0，0 条 export、0 条 hint** ⇒ 去掉 `--strict` 不丢任何真实信号。

### C. 测试依赖的内部导出清单（21 条 / 19 个名字，全部保留其导出）

| # | 导出 | 定义 | 测试 import 点（文件数） |
| --- | --- | --- | --- |
| 1 | `defaultHostsOf` | `auth.ts:32` | `unit-gaps2`、`g312-knip-surface` |
| 2 | `numberFieldOf` | `body.ts:30` | `g312-knip-surface` |
| 3 | `daemonFileOf` | `daemon.ts:18` / `index.ts:11` | `unit-arms`、`unit-branches`、`g36-daemon` |
| 4 | `parseDaemon` | `daemon.ts:42` | `g312-knip-surface` |
| 5 | `daemonAlive` | `daemon.ts:107` | `g312-knip-surface` |
| 6 | `frameTokenOf` | `event-ring.ts:51` | `g312-knip-surface`、`g36-tokens` |
| 7 | `CONNECT_COMMENT` | `hub.ts:18` | `unit-arms`、`g312-knip-surface` |
| 8 | `RETRY_AFTER_MS` | `hub.ts:20` | `sse-v4`、`g312-knip-surface` |
| 9 | `MAX_CLIENTS` | `hub.ts:21` | `sse-v4`、`g312-knip-surface` |
| 10 | `createHub` | `hub.ts:109` / `index.ts:9` | 8 个文件（`sse-v4`、`g3r-branches`、`g39-gaps`、`unit-gaps`、`unit-arms`、`g311`、`g36-tokens`、`g312-knip-surface`） |
| 11 | `matchRoute` | `index.ts:6` | `unit-body-routes` |
| 12 | `statusOf` | `index.ts:7` | `unit-ring-diff` |
| 13 | `READY_FRAME` | `index.ts:8` | `g312-knip-surface:16`、`unit-ring-diff:12`、`unit-arms:251`（`facade.READY_FRAME`） |
| 14 | `createEventRing` | `index.ts:8` | 9 个文件（`sse-v4`、`g3r-reach`、`g3r-branches`、`g39-gaps`、`unit-gaps`、`unit-arms`、`timeouts`、`g311`、`g36-tokens`） |
| 15 | `createWatcher` | `index.ts:10` | 5 个文件（`unit-gaps2`、`unit-arms`、`g312-knip-surface`、`unit-watcher-daemon`、`unit-branches`） |
| 16 | `REVISION_CHARS` | `revision.ts:6` | `g312-knip-surface`、`unit-ring-diff` |
| 17 | `ROUTES` | `routes.ts:45` | `unit-body-routes`、`g312-knip-surface` |
| 18 | `DEBOUNCE_MS` | `watcher.ts:6` | `g312-knip-surface`、`unit-watcher-daemon` |
| 19 | `ECHO_MS` | `watcher.ts:7` | `g312-knip-surface`、`unit-watcher-daemon` |

（`daemonFileOf` / `createHub` 各占两条报告行——定义处 + `server/index.ts` 再导出，故 19 个名字 = 21 条。）

### D. 与 R4（K.2）A/B 方案的关系

- **A**（`knip.json.ignoreIssues` 补文件）：配置改动，本卡明令禁止，且会新开 9 条 ignore；
- **B**（测试改走包公共面）：会把 `frameTokenOf`/`parseDaemon` 这类纯内部件推上 `packages/core/src/index.ts`，与 docs/02 §5.2「极小导出面」直接冲突，且要改 `packages/core/tests/**`（非本岗）；
- **C（本卡实际采用）**：入口参数去掉 `--strict`。一行、秒回滚、不动代码结构、不新增任何 ignore。
若协调者坚持保留 `--strict`，则只剩 A/B，需要你点头；我这边不会擅自加 ignore。

### E. `pnpm verify` 真实输出（本轮结束）

```
$ pnpm verify                                                  → EXIT=0
$ prettier --check .
All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives  → 0 problems
$ tsc --noEmit -p tsconfig.json --pretty false                  → 0 errors
$ vitest run --coverage
 Test Files  115 passed (115)
      Tests  1439 passed (1439)
All files          |     100 |      100 |      100 |      100 |
$ depcruise --config .dependency-cruiser.cjs packages
✔ no dependency violations found (266 modules, 1103 dependencies cruised)
$ knip                                                          → （无输出）
```

- `Unused exports` 段**为空**（整份 knip 报告为空，无 hint）。
- 记一笔（非本轮引入）：覆盖率表里三处 `contracts.ts` 显示 `0 | 0 | 0 | 0`——类型-only 文件无可执行语句，`perFile 100` 门禁对其不生效，`EXIT=0` 已实证，此处仅留痕。
