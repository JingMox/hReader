# G2 审计 · M2.2（阅读器三栏骨架，零依赖手写 DOM）

- 审计对象：`git status` 中未提交的 M2.2 改动（`packages/app/**` 新增 1163 行、`packages/core/src/server/static.ts` 88 行、`{routes,handlers,http-io,runtime,server,contracts}.ts`、`packages/cli/src/**` 的 `--app-dir`、`knip.json`、`vitest.config.ts`）
- 唯一验收依据：`.workflow/cards/M2.2.md`（20 条 AC + 8 条预设裁定 + §0 三条分层规则）
- 审计方式：全量读码 + 真子进程 `hr serve` + `curl` 实测 + 仓库门禁实跑（`typecheck`/`lint`/`format:check`/`knip`/`depcruise`/`test:coverage`）
- 只读：除本报告外未修改、未提交任何仓库文件；探针产物全部落在 `/tmp`（`/var/folders/.../T/m22/`）

## 0. 结论

**G2: FAIL** — 4 条 P0（其中 2 条门禁直接红、1 条 SSE 全量丢弃、1 条 `--app-dir` 完全不可用），10 条 P1，11 条 P2。

关键点：AC 表里的"代码存在"与"链路真的通"是两件事。M2.2 最核心的两条活链路（`doc.changed` → 增量更新、`--app-dir` → 静态托管）**都断在最后一米**，而门禁（`pnpm verify`）当前是红的——`.workflow/reports/impl-M2.2.md` 的自证与实测不符。

---

## 1. P0（阻断合并）

### P0-1 · SSE 事件 100% 被客户端丢弃：`doc.changed` 链路整体死掉（AC2.4/AC4.1/AC4.3）

- `packages/app/src/sse.ts:63-66`
  ```ts
  const id: unknown = Reflect.get(value, "id");
  const type: unknown = Reflect.get(value, "type");
  const payload: unknown = Reflect.get(value, "payload");
  if (typeof id !== "number" || typeof type !== "string") return undefined;
  ```
  客户端要求 `id` 在 **`data:` 的 JSON 里**且是 number。
- 服务端从来没有把 `id` 放进载荷，只放帧头：`packages/core/src/server/event-ring.ts:79-80`
  ```ts
  `id: ${frameTokenOf(String(event.id), note)}\ndata: ${payloadLine({ ...event.payload, type: event.type }, note)}\n\n`
  ```
- 后果：`parseOf` 恒 `undefined` → `deliverOf`（`packages/app/src/sse.ts:85-88`）恒早退 → `handlers.onEvent` 永不触发 → `packages/app/src/boot.ts:140` 的 `doc.changed` 分支永不进入。AC2.4 的增量更新、AC4.1 的事件消费、AC4.3 的 revision 丢弃在真实浏览器里**全是死代码**（单测能过是因为测试自己造了带 `id` 的载荷）。
- 服务端已把 id 放在帧头，而客户端声明的 `MessageEventLike.lastEventId`（`packages/app/src/sse.ts:16`）**从未被读取**——这正是承载帧头 id 的字段，也是最省事的修法：`sse.ts:108-110` 把整个 `event` 传进 `deliverOf`，用 `event.lastEventId` 做 `lastSeen`。
- 实测证据（真 `hr serve` + `curl -sN /api/events`，改文件后 2s）：
  ```
  $ od -c sse.txt
  :   r e a d y \n \n  r e t r y :   2 0 0 0 \n  i d :   0 \n  d a t a :   { " t y p e " : " r e a d y " } \n \n
  i d :   1 1 \n  d a t a :   { " d o c I d " : " d o c . h t m l " , " p a t h " : " / p r i v a t e / v a r ...",
  " r e v i s i o n " : " 0 0 e 3 0 a 1 0 7 e c 0 9 f 7 9 " , " c h a n g e d N o d e s " : [ " h r - a " ] ,
  " t y p e " : " d o c . c h a n g e d " } \n \n
  ```
  → `data:` JSON 里没有 `id` 键。**契约断裂，不是环境问题。**
- 补充：`READY_FRAME`（`event-ring.ts:74`）的 `id: 0` 与 `isStale`（`sse.ts:51`，`lastSeen` 初值 0）叠加，即使修好 id 来源，`id: 0` 那一帧也会被丢——目前无害（`ready` 不带业务），但改 `lastSeen` 初值为 `-1` 更稳。

### P0-2 · `--app-dir` 完全不可用：词法器不认识这个 flag，五处管线是死代码（裁定 #6）

- `packages/cli/src/tokens.ts:11-21` 的 `VALUE_FLAGS` 里**没有** `--app-dir`：
  ```ts
  const VALUE_FLAGS: ReadonlySet<string> = new Set([
    "--action", "--allow-host", "--html", "--html-file", "--max-bytes",
    "--port", "--visual", "--tone", "--workspace",
  ]);
  ```
  而 `packages/cli/src/args.ts:242` 把它列进 `unusedFlag` 白名单、`:254` 读 `raw.values.get("--app-dir")`、`:262` `resolve(cwd, appDir ?? "packages/app/dist")`，`packages/cli/src/run.ts:98`、`packages/cli/src/commands/serve.ts:16,30`、`packages/core/src/server/runtime.ts:249-257` 一路透传，`packages/cli/src/usage.ts:24,61` 还把它写进帮助。
- 实测：
  ```
  $ node --experimental-strip-types packages/cli/src/main.ts serve ws/doc.html --port 0 --json --workspace ws --app-dir app
  stderr: 未知参数：--app-dir
  用法： … hr serve <file> [--port <n>] [--allow-host <h>] [--app-dir <dir>] [--json]   ← 帮助里明明有这个 flag
  ```
  exit 2。裁定 #6（"`hr serve` 通过 `--app-dir` 指向该目录"）无法执行；`packages/app/package.json` 新增的 `build` 脚本产物只能靠 CWD 恰好是仓库根才能被托管。
- 修法一行：`tokens.ts:14` 后加 `"--app-dir"`。**但必须补一条"flag 在 `VALUE_FLAGS`/`unusedFlag`/`usage` 三处一致"的守护测试**——同一个 flag 有 3 个登记点，正是这次漏点的结构性原因。

### P0-3 · `pnpm depcruise` 红（EXIT=10，10 条违规）

```
$ pnpm -s depcruise ; echo $?
  error no-undeclared-external-dep: packages/app/tests/dom.test.ts → vitest …
  … 10 条同形 …
x 10 dependency violations (10 errors, 0 warnings). 299 modules, 1217 dependencies cruised.
10
```
- 根因：`packages/app/package.json`（diff 只加了 `scripts.build` 与 `exports`）没有声明 `vitest`；`packages/app/tests/*.test.ts` 共 10 个文件 import 了 `vitest`。
- 卡片 §4 要求 `pnpm verify` **EXIT=0**。当前 `verify` 第 5 步即失败（`typecheck`/`lint`/`format:check`/`knip` 我实测均为 0，见附录）。
- 注意与"零新增依赖"的关系：`vitest` 已是根 devDependency，在 `packages/app` 里补一条声明**不是新依赖**，属声明修补；但 `packages/app/package.json` 的改动仍应走协调者（卡 §0 描述其形状）。

### P0-4 · `pnpm test:coverage` 红（EXIT=1，4 个文件不达 perFile 100%）

```
$ pnpm -s test:coverage ; echo $?
ERROR: Coverage for lines (91.5%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for statements (91.5%) … packages/app/src/boot.ts
ERROR: Coverage for branches (93.33%) … packages/app/src/boot.ts
ERROR: Coverage for lines (95.2%) … packages/app/src/main.ts
ERROR: Coverage for functions (92%) … packages/app/src/main.ts
ERROR: Coverage for statements (95.2%) … packages/app/src/main.ts
ERROR: Coverage for branches (97.56%) … packages/core/src/server/routes.ts
ERROR: Coverage for branches (97.59%) … packages/core/src/server/runtime.ts
1
```
- 未覆盖行恰好是**功能真的没被跑到**的地方，不是"少写测试"：`boot.ts` 80-88 = `themeSwitcher` 的 IO 体（`packages/app/src/boot.ts:79-88`），`main.ts` 151-152 = `applyCss`（`packages/app/src/main.ts:150-152`）。见 P1-2（首屏主题从不加载）。
- 卡片 §4："四维覆盖 100%（`packages/app` 也要进覆盖范围）"。当前 app/src 汇总 97.29/99.31/97.75/97.29。

---

## 2. P1（合并前应修）

### P1-1 · `GET /` 拿不到 docId，浏览器打开就是死页面

- `packages/core/src/server/static.ts:62-75` `indexReply(ctx, docId)` 收了 `docId` 却**完全没用**（只 `join(ctx.appDir,"index.html")` 回字节）；`runtime.ts:151` 传给它的 `options.docId` 因此被丢弃。对比 `fallbackHome`（`static.ts:55-59`）是用了 docId 的。
- `packages/app/static/index.html:9` 的 `<body>` 没有 `data-doc-id`、页面无内联脚本；`packages/app/src/main.ts:130-135` `docIdOf()` 先读 `body[data-doc-id]` 再读 `?doc=`，两者都空 → `main.ts:165-168` 渲染"没有指定文档：用 /?doc=<docId> 打开"。
- 实测：
  ```
  $ curl -s -H "Cookie: hr=$T" http://127.0.0.1:$P/ 
  200 text/html; cache-control: no-store
  <!doctype html><meta charset="utf-8"><div id="hr-root"></div><script type="module" src="/assets/main.js"></script>
  ```
  即：daemon 明明在服务 `doc.html`，用户点开 `/` 得到的是"没有指定文档"。
- 另外这条改动**静默改写了 M2.1 冻结契约**（`static.ts:50-54` 的注释自己写着"带 cookie 访问 `/` 得 200 + docId 链接"，`wire-http.test.ts` 靠 `appDir===""` 走 fallback 才没红）。建议：`indexReply` 在 `appDir` 有效时 `302 /?doc=<encodeURIComponent(docId)>`，或由 `assetReply` 之外的地方注入 `data-doc-id`（后者与 §0 裁定 #3 的 innerHTML 禁令冲突，302 更干净）。

### P1-2 · 首屏主题从不加载（AC5.1 只做了"切换"，没做"初始"）

- `packages/app/static/index.html:10` 是空的 `<style id="hr-theme"></style>`；全仓**没有任何**在 boot 时调用 `style.select(DEFAULT_THEME, …)` 的代码：`packages/app/src/boot.ts:74-89` 的 `themeSwitcher` 只由 `themeSelected` intent 触发（`:112`），`main.ts` 也没在 `bootWith` 之前 `loadCss`。
- 覆盖率为证：`boot.ts:80-88`（该 IO 体）与 `main.ts:151-152`（`applyCss`）**零覆盖**。
- 后果：`/api/theme/atelier-editorial` 的 CSS 在首屏不生效，用户必须先手动动一次下拉。`packages/app/static/styles.css` 只有骨架与少量变量（`:5-10`），不含主题正文样式。
- 修法：`boot()` 里首次 `pump` 一次 `style.select(state.theme, "")`（`style-switch.ts:25` 的 `id === applied` 分支会让它幂等）。

### P1-3 · `THEMES` 硬编码含幽灵项 `manuscript`，与服务器真值脱钩（AC5.2 精神）

- `packages/app/src/main.ts:43` `const THEMES: readonly string[] = ["atelier-editorial", "manuscript"];`，`:44` 又硬编码 `DEFAULT_THEME`。
- 实际内置主题只有一个：
  ```
  $ ls styles/
  atelier-editorial
  ```
  选 `manuscript` → `GET /api/theme/manuscript` → 404 `unknown_style` → `themeSettled ok:false`。下拉里挂着一个必然失败项。
- 主题清单应由服务器提供（例如 `GET /api/theme` 或复用 `/api/doc/<id>/model` 里的主题字段），至少不该在 JS 里手抄一份。

### P1-4 · 主题切换失败时 state 与 DOM 失同步（下拉显示与真实 CSS 不一致）

- `packages/app/src/state.ts:157-165`：
  ```ts
  if (intent.kind === "themeSelected") {
    return state.themePending || state.theme === intent.theme
      ? state
      : { ...state, themePending: true, theme: intent.theme };
  }
  if (intent.ok || state.theme !== intent.theme) return { ...state, themePending: false };
  return { ...state, themePending: false, theme: "atelier-editorial" };
  ```
  - A 切换进行中再选 B：reducer 因 `themePending` 直接返回原 state（`:160-163`），但 IO 早已在 `boot.ts:81` 起跑 → B 的 CSS 被应用，`themeSettled{B, ok:true}` 走 `:164` 分支 → `state.theme` 停在 **A**，DOM 是 **B**。
  - 失败兜底写死 `"atelier-editorial"`（`:165`），而不是"回到上一次真正应用的 CSS"（`style-switch.ts:22` 的 `applied` 明明知道答案）；若用户此前在 `manuscript`，失败后 state 变成 atelier 而 CSS 仍是 manuscript。
- 另：`<select>` 的 `value` 在 `themeSettled` 后**从不回写**（`canvas.ts:42-54` 的 `update` 只碰 `#hr-doc` 的 class），失败时下拉停在一个没生效的主题上。

### P1-5 · `/assets/<长段>` 回 500 而非 404（AC1.3 违约）

- `packages/core/src/server/static.ts:35-42`：只有 `isMissing(error)` 映射 404，其余一律 `HrError("io_failure")` → 500。
- 长度闸门在 `packages/core/src/server/http-io.ts:101` `MAX_ASSET_PATH = 512`（**总长**），而单段文件名上限约 255（ENAMETOOLONG），于是 256..512 段全落在"越过闸门、又被内核拒绝"的窗口里。
- 实测（真 serve）：
  ```
  seg=500 urllen=508 → 500  {"code":"io_failure","message":"服务端暂时不可用"}
  seg=506 … seg=512   → 500
  seg=513             → 404  （此时总长 >512 被 assetSegmentsOf 拦下）
  ```
- 修法：`assetSegmentsOf` 加单段长度上限（≤255），或把 `ENAMETOOLONG`/`EINVAL` 一并当 404。AC1.3 原文就是"未知 `/assets/*` → 404（不是 500）"。

### P1-6 · §0 三条分层规则在仓库里**一条都不可执行**（用户重点 #1）

- `.dependency-cruiser.cjs` 里 `grep -n "packages/app"` **零命中**（全文没有一条规则提到 app）；`eslint.config.mjs` 里 `no-restricted-globals` / `no-restricted-syntax` / `packages/app` **全部零命中**。
- 卡 §0 原文："**分层规则（depcruise 必须能表达，必要时加规则）**"。现状是三条规则**只靠注释宣称**：
  - 规则 1（`widgets/**` 不 import `dom.ts` 实现）：depcruise **能表达**，规则还没写。可行写法（需 `tsPreCompilationDeps`）：
    ```js
    { name: "app-widgets-only-host-interface", severity: "error",
      from: { path: "^packages/app/src/widgets" },
      to: { path: "^packages/app/src/dom\\.ts", dependencyTypesNot: ["type-only"] } }
    ```
  - 规则 2/3（`keys/state/style-switch` 不碰 `document`/`window`/`fetch`/`EventSource`；只有 `main/boot/dom` 可碰）：depcruise **表达不了**（全局标识符不是模块边），必须用 ESLint `no-restricted-globals` + 针对 `{main,boot,dom}.ts` 的 override，**目前没有**。
  - 卡 §3 同时规定 `.dependency-cruiser.cjs` "要加规则先问" → 现状是"卡要求必须能表达，但改它要批准"，必须走一次协调，否则这条 AC 永远无法闭环。
- **本次实测三条规则在代码上确实成立**（不是注释宣称）：`grep -rn "window|globalThis|fetch\(|EventSource|document\." packages/app/src` 去掉 `main.ts`/`dom.ts` 后只剩注释行；`document.` 仅出现在 `main.ts`/`dom.ts`。即：今天是对的，但一次回归就能悄悄破掉，无人报警。

### P1-7 · SSE 载荷把工作区绝对路径发给浏览器（M2.1 P0-1 的复发面）

- 实测帧（上文 P0-1 的 od 输出）：
  `data: {"docId":"doc.html","path":"/private/var/folders/.../ws/doc.html","revision":"00e3…","changedNodes":["hr-a"],"type":"doc.changed"}`
- 来源：`packages/core/src/server/runtime.ts:94` 与 `:211` 的 `path: input.target.realPath`。
- 这与 M2.1 P0-1 是同一类泄漏（HTTP 侧已用 `packages/core/src/server/http-io.ts:40-45` `publicMessageOf` 把绝对路径抹成 `[路径已隐藏]`），但 SSE 侧没有抹。不是 M2.2 引入，但 M2.2 恰好把这条流接进了浏览器。修法：载荷里去掉 `path`（`docId` 已够客户端用）。

### P1-8 · `doc.changed` 后模型/大纲/`revision` 永远是启动时快照（AC4.3 守卫失效）

- `packages/app/src/main.ts:157-158`：
  ```ts
  fetchModel: async () => await Promise.resolve(model),
  fetchOutline: async () => await Promise.resolve(outline),
  ```
  闭包捕获的是 `main()` 首屏那次响应；`boot.ts:91-101` 的 `reloadOf` 每次 `doc.changed` 都调它们，拿回同一份快照。
- 后果：(a) 左栏 TOC 外部编辑后永不刷新；(b) `documentChanged` 的 `revision` 恒为首屏值 → `sse` 的"revision 落后则丢弃"（AC4.3）拿一个冻结值比较，等于失效；(c) AC2.3 的"当前可见块在 TOC 中高亮"只能在旧大纲上高亮。
- 修法：`fetchModel`/`fetchOutline` 改成真的发请求（`fetchJsonOf` 已有），或 `reload` 只重取 `/s/<docId>` 时同步刷新 `state.revision`。

### P1-9 · 块被删除时 DOM 不删（AC2.4 的"只更新受影响的块"只覆盖"改"，不覆盖"增删"）

- `packages/app/src/widgets/canvas.ts:44-47`：
  ```ts
  if (next.documentHtml !== "" && next.documentHtml !== injected) {
    for (const [id, markup] of host.blocks(next.documentHtml)) host.blockHtml(id, markup);
    injected = next.documentHtml;
  }
  ```
  只做"新文档里存在的 id → 写入"。旧文档里有、新文档里没有的块**永远留在 DOM 里**（外部编辑删段落 → 屏幕上仍显示）。服务端其实已经给出 `changedNodes`（实测帧里有 `["hr-a"]`），客户端完全没用。
- 顺带两个小问题：`injected` 存的是整篇字符串（`canvas.ts:41`），比较整篇；`host.blocks` 用的是临时 `<div>` 解析（`dom.ts:84-91`），嵌套 `[data-hr-id]` 时外层 innerHTML 会包含内层，内层块被写两遍。
- AC2.4 的核心风险（"不许整篇重载、丢滚动位置"）**确实守住了**：`dom.ts:96` 写入前比较 `element.innerHTML !== markup`，未变的块不重写。这部分给编写员记一功——但"只更新受影响的块"应改成按 `changedNodes` 驱动 + 补删除分支。

### P1-10 · `sse.ts` 的四处 `Reflect` 用一个已有类型守卫就能消掉（可读性裁定）

用户判定标准是"能用带类型的窄辅助函数表达就是 P1"。这里**完全能**，而且守卫函数本项目已经写过：

- `packages/app/src/sse.ts:63-65` 用 `Reflect.get(value,"id"/"type"/"payload")` 绕过 `unknown`→`object` 之后的属性访问；`packages/app/src/main.ts:109-110` 已有同形守卫 `const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;`。把它提到公共小模块（如 `packages/app/src/guard.ts`）后：
  ```ts
  if (!isRecord(value)) return undefined;
  const id = value["id"]; const type = value["type"]; const payload = value["payload"];
  ```
  可读性、类型安全、与 `main.ts` 的一致性三赢。
- `packages/app/src/sse.ts:53-57` `plainCopy`（`Object.keys` + `Reflect.get` 手抄）在有守卫后就是 `{ ...value }`，5 行 → 1 行。
- `packages/app/src/dom.ts:12` 的注释还写着"真实 target 用 `Reflect` 适配"，但 `dom.ts` **已不再使用 `Reflect`**（`grep -n Reflect packages/app/src/dom.ts` 只命中该注释）→ 注释与实现不一致，删掉该句。
- 结论：`Reflect` 在 M2.2 里**没有一处是必需的**，全部属于"为绕 `no-as` 找的替代语法"，与用户第一诉求（可读性）相悖。

---

## 3. P2（可后续修，共 11 条）

1. **`innerHTML` 写入点 3 处，裁定 #3 说"只允许两处"**：`packages/app/src/dom.ts:86`（临时 `<div>` 解析）、`dom.ts:96`（`blockHtml`）、`dom.ts:116`（`html`）。我认为 `:86` 可辩护（游离节点、不进活动文档），但需要一个明确裁定，否则下次审计还得吵。
2. **`host.attr` 不做 equal-check**：`packages/app/src/dom.ts:107-113` 与 `text`（`:102-105` 有比较）不对称，`statusbar.ts:23,26` 每次 dispatch 都 `setAttribute` → AC2.2"只写有变化的节点"在属性维度不成立。加一行比较即可。
3. **顶层无错误兜底**：`packages/app/src/main.ts:175` `void main();`，而 `main.ts:105,117,119` 会 `throw` → 未处理拒绝、白屏、零提示。建议 `.catch(e => host.text("#hr-doc", COPY.canvasEmpty + 细节))`。
4. **`isRecord` 接受数组**：`packages/app/src/main.ts:109-110` 未排除 `Array.isArray`，`isModelResponse`/`isOutlineResponse` 的守卫强度弱于字面含义。
5. **退避定时器可叠加**：`packages/app/src/sse.ts:99-107` 第二次 `error` 会覆盖 `ctl.cancel` 而不取消已排的定时器；`opened.setOpen`（`:95-98`）成功后也不取消挂起的 `cancel` → 可能同时存在两条 `EventSource`。建议 `cancel?.()` 后重设，并在 `setOpen` 里清账。
6. **`/assets/` 的 404 响应体与其它 404 不一致**：`static.ts:80` 走 `notFound("资源路径不合法")`，而 `/assets/`（空 `path`）实际命中 `http-io.ts:105` 的空串拒绝后由路由层回 `{"code":"not_found"}`（无 `message`）。实测：`/assets/` → `{"code":"not_found"}`，`/assets/nope.js` → `{"code":"not_found","message":"资源不存在"}`。
7. **坏 `%` 编码回 400 而非 404**：`/assets/%zz` → 400 `invalid_request`（`routes.ts:114-124 decodeParams` 的 `ok:false`）。AC1.2 字面只要求穿越类 404，这属可实现的两说；建议在卡里写明"畸形转义 → 400"。
8. **`COPY` 三条死文案**：`packages/app/src/widgets/copy.ts:4,9,17`（`appTitle`/`canvasEmpty`/`searchPlaceholder`）全仓零引用（实测逐 key 计数）。
9. **`packages/app/src/index.ts` 是只给测试看的公共面**：不在卡 §0 的文件清单里，`knip.json` 新 entry 也只列了 `src/main.ts` 与 `scripts/*.mjs`，它只靠 `packages/app/package.json` 的 `exports` 活着。裁定 #7 明确"`src/` 里不许有只在测试用的导出（死代码即 P1）"——请协调者裁定：是保留为包的公共面，还是按 `@internal` 先例收窄。
10. **`vitest.config.ts:28-33` 两行冗余**：`include` 里新增的 `"packages/app/src/**/*.ts"` 已被 `"packages/*/src/**/*.ts"` 覆盖；`exclude: ["packages/app/src/**/*.d.ts"]` 对应的文件不存在。且该文件与 `knip.json` 按卡 §3 属"配置改动归协调者批准"。
11. **`fetchModel`/`fetchOutline` 的 `async () => await Promise.resolve(x)`**：`packages/app/src/main.ts:157-158` 三重包装（既是 P1-8 的病灶，也是明显的 lint 味道，`@typescript-eslint/await-thenable` 类规则没开）。

---

## 4. 与卡片的流程偏差（需协调者裁定，非代码缺陷）

| 项 | 卡 §3 原文 | 实际改动 |
|---|---|---|
| `packages/core/tests/**` | "**不可改**：`packages/core/tests/**`…（测试员独占）" | 改了 2 个：`g312-knip-surface.test.ts`（`toHaveLength(9)`→`11`）、`unit-body-routes.test.ts`（拆用例 + 加两条新路由断言） |
| `packages/core/src/server/*` 可改范围 | 只允许 `{routes,handlers,http-io}.ts` | 还改了 `contracts.ts`、`runtime.ts`（+58）、`server.ts`（`homeReply` 摘除） |
| `knip.json` / `vitest.config.ts` | "**不可改**…（配置改动归协调者批准）" | 两个都改了 |

两处测试改动本身是"路由 9→11"的合理后果（不是跳测试、不是弱化断言），但路径不合规：应走"测试员改"或"协调者批准"。**建议**：在 PR 描述里补一条追溯批准，而不是回滚（回滚会让门禁更红）。

---

## 5. AC 逐条判定

| AC | 判定 | 依据 |
|---|---|---|
| AC1.1 `GET /` 返回 index.html、无内联脚本 | **通过（字面有偏差）** | `packages/app/static/index.html` 无内联 `<script>`；但还有 `<link rel=stylesheet>`（`:7`）、`<style id="hr-theme">`（`:10`）与整段骨架，与"仅含 `#hr-root` 与 script"字面不符——属 §0 裁定 #3 允许的"一次性骨架"，建议卡里合并两句 |
| AC1.2 路径穿越 → 404 | **通过** | 实测 `../`、`%2e%2e/`、`..%2f`、`%2e%2e%2f`、`..%5c`、`%00` 全 404；`../` 被 WHATWG URL 归一到 `/SECRET.txt` 后路由不匹配仍 404；无越界读取 |
| AC1.3 未知 `/assets/*` → 404（不是 500） | **不通过** | 见 **P1-5**：256..512 字符段 → 500 `io_failure` |
| AC1.4 `cache-control: no-store` + `nosniff` | **通过** | 实测 200 响应头：`x-content-type-options: nosniff` + `cache-control: no-store`（`static.ts:20-23`） |
| AC2.1 store 三方法 + 退订 + 同引用不通知 | **通过** | `store.ts:13-31`，`:19` `if (next === state) return` |
| AC2.2 `update` 只写有变化的节点 | **部分** | `text`（`dom.ts:102-105`）/`blockHtml`（`:96`）/`html`（`:116`）都有比较；`attr`（`:107-113`）没有 → P2-2 |
| AC2.3 TOC 由 outline 生成、点击派 `scrollTo`、当前块高亮 | **代码成立，运行时不刷新** | `library.ts:31-33` 点击、`:43` 高亮；但大纲是启动快照 → **P1-8** |
| AC2.4 整体注入一次、`doc.changed` 只更新受影响块 | **实质不通过（链路断）+ 部分实现** | 链路断见 **P0-1**；删除分支缺失见 **P1-9**；"不整篇重载/不丢滚动"这一半成立（`dom.ts:96` 比较后写块） |
| AC2.5 右栏静态占位、不伪造数据 | **通过** | `sidenotes.ts:8-9`，`copy.ts:8` "本章有 0 条批注（M2.3 启用）" |
| AC2.6 三栏栅格 / 68ch / 1100px / min-width:0 / overflow-wrap | **通过** | `static/styles.css:24`（`var(--hr-side)`=280px）、`:32-33`、`:62`、`:107-109`；`transition` 仅 `background 100ms`（`:68`），合裁定 #2 |
| AC3.1 j/k/h/c///Esc 与 `scrollTo`/`focus` | **通过** | `keys.ts` 全键矩阵 + `boot.ts:112-115` |
| AC3.2 焦点在输入控件时不触发 | **通过** | `keys.ts` 的 `target` 判定（覆盖率 100%） |
| AC3.3 `keys.ts` 纯函数、不读 document | **通过** | 全文件无 `document`/`window`（grep 实测） |
| AC4.1 消费 `/api/events`、容忍未知类型 | **实质不通过** | 见 **P0-1**：所有帧被丢 |
| AC4.2 退避 1s×2 上限 30s + 抖动 + 重置 | **通过（逻辑）** | `sse.ts:41-48`、`:95-98` 重置；定时器叠加见 P2-5 |
| AC4.3 落后 revision 丢弃 | **实质不通过** | 见 P0-1（收不到帧）+ P1-8（比较基准是冻结值） |
| AC5.1 下拉列内置主题、只换 `<style>` 的 textContent | **部分** | `main.ts:151` 确实只写 `#hr-theme` 的 textContent；但首屏不加载（**P1-2**）、下拉含幽灵项（**P1-3**）、失败态错位（**P1-4**） |
| AC5.2 CSS 来自 `/api/theme/<id>`、未知 → 404 `unknown_style`、不许内联 | **通过** | 实测 `/api/theme/atelier-editorial` → 200 `text/css`；`/api/theme/nope-xyz` → 404 `{"code":"unknown_style"}`；CSS 从磁盘读（`style/theme.ts:44`），未内联进 JS；`/api/theme/%2e%2e%2fetc` → 400 `invalid_style`（`style/id.ts:7-14` 白名单拦下） |

### 8 条预设裁定

| # | 裁定 | 判定 |
|---|---|---|
| 1 | 不做虚拟 DOM/diff 算法，widget 自己 update | **通过** |
| 2 | 不做动画（仅 `color`/`background` 100ms） | **通过**（`styles.css:68`） |
| 3 | `innerHTML` 只允许两处 | **偏差**：实际 3 处（P2-1），需裁定 |
| 4 | `addEventListener` + 显式解绑，不挂自定义属性存状态 | **通过**：`dom.ts:132-150` 登记 unbinder，`:155-160` `destroy` 全部解绑；状态在各 widget 闭包里，不在 DOM 属性上 |
| 5 | 文案集中 `widgets/copy.ts`、中文 | **通过**（3 条死文案见 P2-8） |
| 6 | `tsc -p packages/app` + `hr serve --app-dir` | **不通过**：`--app-dir` 不可用（**P0-2**） |
| 7 | 无 bundler ⇒ `src/` 不许只在测试用的导出 | **待裁定**（P2-9） |
| 8 | 图标用文字/Unicode | **通过** |

### `Host` 接口最小性 / 完整性（用户重点 #2）

11 个方法，全部在 `dom.ts` 有真实 DOM 实现，且全部至少有一个 widget/boot 调用点（逐方法实测计数）：

| 方法 | 实现 | 调用点 |
|---|---|---|
| `text` | `dom.ts:102-105` | 10（library/canvas/sidenotes/statusbar/main） |
| `attr` | `dom.ts:107-113` | 3（sidenotes/statusbar） |
| `html` | `dom.ts:114-117` | 1（`canvas.ts:26`，AC2.4 整体注入） |
| `cls` | `dom.ts:118-120` | 4（canvas/sidenotes/library） |
| `children` | `dom.ts:80-83` | 3（TOC/主题下拉） |
| `blocks` | `dom.ts:84-91` | 1（`canvas.ts:45`） |
| `blockHtml` | `dom.ts:94-97` | 1（`canvas.ts:45`） |
| `on` | `dom.ts:132-150` | 2（`canvas.ts:35`、`library.ts:31`） |
| `focus` / `scrollTo` / `destroy` | `dom.ts:121-127`、`:155-160` | 各 1（`boot.ts:115`/`:114`/`:154`） |

无"为测试预留"的死方法。widget 侧一律用 `parent: string` + 选择器（`canvas.ts:17`、`sidenotes.ts:7`），**没有**从 `parent` 直接拿 `Element`，也没有出现 `any`/`as`/`!`（全文件 grep 实测）。这一项是本次改动里质量最高的部分。

---

## 6. 证据命令汇总（可复跑）

```bash
# 门禁
pnpm -s typecheck ; echo $?          # 0
pnpm -s lint      ; echo $?          # 0
pnpm -s format:check ; echo $?       # 0
pnpm -s knip      ; echo $?          # 0
pnpm -s depcruise ; echo $?          # 10  ← P0-3
pnpm -s test:coverage ; echo $?      # 1   ← P0-4（127 文件 / 1568 用例全绿，覆盖率阈值不过）

# 分层事实（关键：排除 main.ts/dom.ts 后无全局引用）
grep -rn "window\|globalThis\|fetch(\|EventSource\|document\." packages/app/src --include=*.ts \
  | grep -v "^packages/app/src/main.ts" | grep -v "^packages/app/src/dom.ts"
grep -n "packages/app" .dependency-cruiser.cjs ; echo $?   # 1（零命中）← P1-6
grep -n "no-restricted-globals\|no-restricted-syntax" eslint.config.mjs ; echo $?  # 1

# --app-dir（P0-2）
node --experimental-strip-types packages/cli/src/main.ts serve ws/doc.html --port 0 --json --workspace ws --app-dir app
# → stderr: 未知参数：--app-dir

# 起真服务（静态 + 主题 + 路径穿越）
cd /tmp/m22/cwd && node --experimental-strip-types <repo>/packages/cli/src/main.ts \
  serve ../ws/doc.html --port 0 --json --workspace ../ws
P=<port>; T=<token>
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: hr=$T" "http://127.0.0.1:$P/assets/main.js"      # 200
curl -s -H "Cookie: hr=$T" "http://127.0.0.1:$P/assets/%2e%2e%2fSECRET.txt"                          # 404 资源路径不合法
curl -s -H "Cookie: hr=$T" "http://127.0.0.1:$P/assets/$(python3 -c 'print("a"*500)')"               # 500 ← P1-5
curl -s -H "Cookie: hr=$T" "http://127.0.0.1:$P/api/theme/nope-xyz"                                  # 404 unknown_style
curl -sN -H "Cookie: hr=$T" "http://127.0.0.1:$P/api/events" | od -c                                 # data 里没有 id ← P0-1

# 主题清单真值（P1-3）
ls styles/            # atelier-editorial（没有 manuscript）
```

---

G2: FAIL
ACP: 上下文 67K/700K (9%)，7 个压缩块（236K 原文 → 16K 摘要）；本轮探针 `/tmp/g2r2/{probe-toc.ts,probe-served.ts,served/}`，`packages/app/dist` 已按备份字节级还原（`77cafc46…`）

---

## G2-R（复核 R1 的 14 条裁定；只验 4 条 P0 + 2 个新面）

> 环境：干净 daemon（`pkill -f "packages/cli/src/main.ts serve"; rm -f ~/.hreader/daemon.json`）。首轮复核有过一次**假红**：我自己探针起的 daemon 让 `pnpm test:coverage` 出现 2 条 `daemon_already_running`（exit 2）失败；杀掉后 130 文件 / 1607 用例全绿。下面所有结论都取自干净环境。

### P0-1 · **未关闭**（浏览器里 `doc.changed` 仍然 100% 丢弃）

帧格式改对了，但**客户端的适配层仍旧把 `id` 丢掉**：

- `packages/app/src/sse.ts:78-81`：`id` 只来自 `event.lastEventId`，`NaN` 即 `return`（丢弃）。
- `packages/app/src/main.ts:58-80`：唯一的真实适配器 `sourceOf` 把事件**重包成 `{ data: event.data }`**，`lastEventId` 根本没往下传；`BrowserEventSource`（`main.ts:42-50`）的类型里也没有这个字段。于是 `numberTextOf(undefined)` → `undefined` → `id = NaN` → 每帧都丢。
- 具名监听是死代码：服务器帧**没有 `event:` 行**（`packages/core/src/server/event-ring.ts:80` 只发 `id:`/`data:`），`sse.ts:111-113` 注册的 `doc.changed`/`doc.reloaded`/`library.changed` 永不触发；唯一活的路径是 `sse.ts:110` 的 `message` + `body["type"]`。实测真帧（`curl -sN /api/events`）：
  `: ready` / `retry: 2000` / `id: 0` / `data: {"type":"ready"}` / `id: 2` / `data: {"docId":"doc.html","revision":"94cd829da93f794b","changedNodes":["hr-b"],"type":"doc.changed"}`

**证据（真帧喂真解析器）** `/tmp/m22r/probe-sse-client.mjs` 直接 import `packages/app/src/sse.ts`：

```
A) main.ts 现状（只转 data）:   listeners: message,doc.changed,doc.reloaded,library.changed   onEvent: []
B) 补 lastEventId（一行之差）:  listeners: message,doc.changed,doc.reloaded,library.changed   onEvent: [{"id":2,"type":"doc.changed"}]
```

作者自己也知道：`packages/app/tests/main.test.ts:36` 是 `it.fails("should reload on a named frame with a frame-header id")`；`packages/cli/tests/serve-sse-contract.test.ts` 的 `replayThroughSse` 注释写着"`lastEventId` 按帧头给（`main.ts` 的适配层正是在这里丢了 id）"——契约测试自己把 `lastEventId` 塞进去，**绕开了**缺陷所在的那一层，正是卡片 §6 尾注"契约测试必须对着真服务器帧验；P0-1 就是这么漏过去的"点名的场景。

修法（一处）：`main.ts:61-64` 改成 `listener({ data: event.data, lastEventId: event.lastEventId })`，并把 `BrowserEventSource.addEventListener` 的 listener 类型补上 `lastEventId?: string`；随后把 `main.test.ts:36` / `serve-sse-contract.test.ts` 的那条 `it.fails` 翻成 `it`。

### P0-2 · **部分关闭**（`--app-dir` 能跑，但没有校验、且默认值破坏 M2.1 冻结契约）

- 正向（**通过**）：`--app-dir packages/app/dist`（cwd=仓库根）→ `GET /` = **302 `location: /?doc=doc.html`**；`/assets/main.js` = 200 `text/javascript; charset=utf-8`；`/?doc=doc.html` = 200 `text/html`。
- **无校验**：`--app-dir /tmp/m22r/nope` → 进程正常启动（`{"ok":true,...}`，无报错文案）；`GET /` 302 → `/?doc=` 落到 `{"code":"not_found","message":"应用未构建：缺少 index.html"}`，`/assets/main.js` 404。任务里要求的"不存在/相对路径的报错文案"**不存在**（`packages/cli/src/args.ts:262` 只做 `resolve`，不看 `existsSync`）。
- **默认值回归**：`args.ts:262` `resolve(cwd, appDir ?? "packages/app/dist")` 让 `appDir` 永远非空，而 `packages/core/src/server/static.ts:89` 的 M2.1 冻结兜底（200 最小首页）条件是 `ctx.appDir === ""`（`server.ts:256`/`runtime.ts:272` `options.appDir ?? ""`）。实测 cwd=`/tmp/m22r` 且**不给** `--app-dir`：`GET /` 302 → `{"code":"not_found","message":"应用未构建：缺少 index.html"}` —— M2.1 冻结的 200 兜底经 CLI 已不可达。
- 相对路径：`--app-dir packages/app/dist`（cwd=仓库根）200；从别的 cwd 给相对路径按 cwd 解析（`../../Users/…/dist` 也 200），语义一致。缺值：`参数 --app-dir 缺少取值` + usage。
### P0-3 · **关闭**（正向 0 违规 + 反向可执行）

- `pnpm -s depcruise` → `✔ no dependency violations found (305 modules, 1245 dependencies cruised)`，**EXIT=0**。
- 反向：给 `packages/app/src/widgets/library.ts` 加 `import { createDomHost } from "../dom.ts";` → `error widgets-use-host-interface: packages/app/src/widgets/library.ts → packages/app/src/dom.ts`，`x 1 dependency violations (1 errors, 0 warnings)`，**EXIT=1**；已复原（`sha1sum -c` → `OK`，`b88f5cd3bbdc9b118d14ae099e60d72b01509783`）。
- 规则本身（`.dependency-cruiser.cjs:74-80`）用 `dependencyTypesNot: ["type-only"]`，`type Host` 不会被误伤——口径正确。
- **但 §0 的第 2、3 条规则仍不可执行**：`grep -c no-restricted-globals eslint.config.mjs` = **0**，且 `eslint.config.mjs` 在 `git status` 里是**未修改**。卡片 §6 裁定 #4 原文"`eslint.config.mjs` 对 `src/{keys,state,style-switch,sse,store,guard}.ts` 加 `no-restricted-globals`……**规则写进配置才算 AC 达成**"。现状只是"源码恰好干净"（`grep -rn "window\.\|document\.\|fetch(\|EventSource\|globalThis" packages/app/src` 只命中 `main.ts`/`dom.ts`），任何人都能一秒破掉而无红灯。→ 上一轮 P1-6 **只关 1/3**。

### P0-4 · **未关闭**（覆盖率红，EXIT=1）

`pnpm -s test:coverage`（干净环境）：`Test Files 130 passed (130)` / `Tests 1607 passed (1607)`，但 **EXIT=1**，5 个文件四维不达 100%：

| 文件 | 未达维 | 未覆盖行 | 归属 |
|---|---|---|---|
| `packages/app/src/boot.ts` | lines/stmts 93.23、branch 91.66 | `83-91` | `themeSwitcher` 的 IO 体 |
| `packages/app/src/main.ts` | lines 92.85、funcs 80.76、branch 95.55 | `72-174`、`176-178` | `sourceOf` + fetch 适配（= P0-1 病灶所在层） |
| `packages/core/src/server/routes.ts` | branch 97.5 | `91` | `segments[index] ?? ""` 的右半边（证明是死默认值，见新面 B） |
| `packages/core/src/server/runtime.ts` | lines/stmts 99.46、branch 95.4 | `156` | `staticOf` 的 switch 分支点（V8 标在 `case "assets"` 标签行；`static-app.test.ts:135` 确实 `GET /assets/app.js`，属**分支计数未满**，不是整条没测） |
| `packages/core/src/server/static.ts` | branch 94.59 | `56`、`131` | `BAD_NAME` 右半边、重复主题 id 的 `continue` |

- `pnpm verify` 的脚本里含 `test:coverage`（`package.json`），所以"`pnpm verify` EXIT=0 / 1578 例"**不可复现**：实际 1607 例、EXIT=1。
- `grep -rc "v8 ignore" packages` = **0**（这一条通过，没有靠忽略注释凑数）。
### 新面 A · `Host.on` 的扩张：**窄适配成立，但留下一个 DOM 概念**

- 实际签名是**三参**不是四参：`packages/app/src/dom.ts:30-34` `on: (selector, type, handler: (target: TargetLike) => void) => () => void`；`TargetLike` = `{ closest?, value? }`（`dom.ts:13-16`）。任务描述里的 `(selector, target, type, handler)` 与代码不符，按代码判。
- widget 侧只碰这两个成员：`widgets/canvas.ts:48-52` 读 `target.value`；`widgets/library.ts:31-34` 用 `target.closest?.("[data-toc-id]")?.getAttribute("data-toc-id")`。**没有**任何 widget 从 `parent` 拿 `Element`（`parent` 是选择器字符串，`boot.ts:48` `ROOT = "#hr-root"`），也没有 widget import `dom.ts` 之外的 DOM 类型。
- 判定：`TargetLike` 是结构类型、最小（两成员），不是 `Element`，属于**窄适配**；但 `library.ts:32` 把"CSS 选择器 + 属性取值"这套 DOM 语义搬进了 widget，这是整个 `Host` 里最后一处 DOM 概念。若要彻底，`Host` 加 `tocIdOf(target)` / `onAction(selector, handler: (id) => void)` 即可，不必改 `TargetLike`。
- 最小性/完整性：12 个方法**都有**真实适配器实现**且**有 widget/boot 调用点（`text` 9、`attr` 4、`html` 1、`cls` 4、`children` 3、`blocks` 1、`blockHtml` 1、`removeBlock` 1、`on` 2、`focus` 1、`scrollTo` 1、`destroy` 1），无"为测试预留"的死方法。
- 一处收紧建议：`dom.ts:29` `removeBlock?:` 是可选，调用点 `canvas.ts:36` 用 `host.removeBlock?.(id)` —— Host 实现少写一个方法就静默不删块，而删块是裁定 #8 的硬要求；改成必选。
- 主题 CSS **没有内联**：`/api/theme/atelier-editorial` 回 `text/css`（真实文件内容），客户端经 `main.ts:164` `host.text("#hr-theme", css)` 写入；`Host` 里没有 `setStyleText`（任务里提到的这个方法不存在，等价能力走 `text`）。
### 新面 B · 类型收窄没有写出新的不可达路径，但留了两处死默认值

- `packages/core/src/server/routes.ts:80-84` 的守卫（`restAt === -1 ? pattern.length !== segments.length : segments.length <= restAt`）保证进入 `:91` 的每个 `index` 都 `< segments.length`，因此 `const actual = segments[index] ?? ""` 的 `?? ""` **不可达**（覆盖率也正好把 `:91` 标成未覆盖分支）。今天安全；一旦有人放宽长度守卫，`wanted.startsWith(":")` 会把 `""` 悄悄登记成参数值，而下游 `?? ""` 无法区分"没有这个键"和"值是空串"。
- `packages/core/src/server/runtime.ts:157/159` 的 `params["path"] ?? ""` / `params["styleId"] ?? ""` 同理不可达（rest 分支 `return` 时已写 `path`；`:styleId` 必经赋值）。就算真触发也是**fail-closed**：`assetSegmentsOf("")` → `undefined` → 404（`packages/core/src/server/http-io.ts:107`），`loadThemeCss("")` → `unknown_style` 404。
- 复跑验证（真 `hr serve` + `curl --path-as-is`，全部无绝对路径泄漏）：`/assets/main.js` 200；`%2e%2e`、`..%2f`、`%2e%2e%2f`、`..%5c`、`a%00b.js`、`//etc/passwd`、`a/../../../../etc/passwd` 全 404；300/600 字符段 → 404 `资源路径不合法`（G2 的 500 已修，**P1-5 关闭**）；`%zz`、`%E0%A4%A` → 400 `invalid_request`；`/api/theme/nope-xyz` → 404 `unknown_style` 且消息里是 `~[路径已隐藏]`。
- SSE 载荷 `path` 已从 `doc.changed` 删除（真帧只剩 `docId`/`revision`/`changedNodes`/`type`）；但 `packages/cli/tests/serve-sse-contract.test.ts:215` 的 `it.fails("should never leak an absolute path in a watcher-driven payload")` 说明 **`library.changed` 仍带工作区绝对路径** → 上一轮 P1-7 只关一半。

### G2-R 结论

| 项 | 判定 | 一句话 |
|---|---|---|
| P0-1 SSE 具名帧/`id` | **未关闭** | `main.ts:58-80` 仍丢 `lastEventId`，真帧喂真解析器 → 0 事件；作者用 `it.fails` 钉住 |
| P0-2 `--app-dir` | **部分关闭** | 能跑（302 + 200），但无校验；默认值让 M2.1 的 200 兜底经 CLI 不可达 |
| P0-3 depcruise | **关闭** | 正向 EXIT=0；反向加一行 import 即 `widgets-use-host-interface` EXIT=1；eslint 那条规则仍缺（§0 只关 1/3） |
| P0-4 覆盖率 | **未关闭** | 1607 例全绿但 EXIT=1，5 文件不达 100% |
| 新面 A `Host` 扩张 | 通过（附 2 条收紧建议） | `TargetLike` 是窄适配；`library.ts:32` 仍带 DOM 语义；`removeBlock?` 应改必选 |
| 新面 B 类型收窄 | 通过（附 1 条清理建议） | 无新不可达路径，两处 `?? ""` 是可证明的死默认值 |

G2-R: **FAIL**（P0-1、P0-4 未关闭；P0-2 部分关闭 + M2.1 冻结契约回归）

ACP: 上下文 67K/700K (9%)，7 个压缩块（236K 原文 → 16K 摘要）；本轮探针 `/tmp/g2r2/{probe-toc.ts,probe-served.ts,served/}`，`packages/app/dist` 已按备份字节级还原（`77cafc46…`）

## G2-R2（终检：R5 副作用收敛 · TOC 真滚 · 覆盖率为真 · KD 机制）

### 1. 三处副作用收敛进 `dispatchIntent` —— **通过**

- 定义 `packages/app/src/boot.ts:162-166`：`store.dispatch(intent)` + 仅两个分支 `themeSelected → selectTheme`、`searchOpened → host.focus`。
- 调用点**只有两处**：`packages/app/src/boot.ts:167`（`mountAll(deps, dispatchIntent)`）、`:183`（`keyHandlerOf(store, dispatchIntent)`）。`grep -rn dispatchIntent packages/app/src` 其余命中全是注释与参数声明，无新入口。
- ① 无重复：`packages/app/src/keys.ts:37-45` 的 `intentOf` 能产出的 kind 只有 `searchOpened/move/toggleFocus/openSidenote/panelClosed`，**不含** `themeSelected`/`scrollTo`，所以键盘路径对这两个副作用结构性不可达；TOC 的滚动唯一发生在 `packages/app/src/widgets/library.ts:35`，`dispatchIntent` 里没有 `scrollTo` 分支（`grep -rn "scrollTo" packages/app/src` 只有 `state.ts` 的 reduce、`dom.ts:138` 的实现、`library.ts:35` 的调用）。`host.focus` 全仓只有 `boot.ts:165` 一处。
- ② 实测次数：`/tmp/g2r2/probe-toc.ts`（真 `createDomHost` + 真 `mountLibrary` + 假 Document）→ `scrollIntoView` **1 次** `["hr-b:start"]`、intents **1 条**；随后 `widget.update()` 再跑一遍仍为 1 次（不重复滚）。
- ③ 序列类型仍窄：`packages/app/src/state.ts:38-64` 的 `ReaderIntent` 是 12 个字面量 kind 的封闭联合，`dispatchIntent(intent: ReaderIntent)` 未引入任何 `meta`/`unknown`；`grep -rn ": any\|unknown" packages/app/src` 的 `unknown` 全在 IO 边界（`guard.ts`、`sse.ts:59`、`main.ts:107-143`），`any` 为 0。

### 2. TOC 点击真的会滚 —— **通过（用服务器真发出去的产物验的）**

- 真 `hr serve`（`node --experimental-strip-types packages/cli/src/main.ts serve doc.html --app-dir <abs>/packages/app/dist --port 7799 --json`）：`GET /` → `302 location: /?doc=doc.html`；`/assets/widgets/library.js` → `200 text/javascript; charset=utf-8`，1692 字节，含 `tocId` ×3、`host.scrollTo` ×1。
- 把**服务端取回的那两个文件**（`/tmp/g2r2/served/dom.js`、`served/widgets/library.js`）直接喂 `bun`：`SCROLLED: ["hr-b:start"] | INTENTS: [{"kind":"scrollTo","id":"hr-b"}]`。链路 `library.ts:31` 点击 → `dom.ts:144-166` 适配器解析 `tocId` → `host.scrollTo` → `dom.ts:138` `scrollIntoView({block:"start"})` 完整成立且只一次。
- 注：`packages/app/dist` 我在验证前是 **13 Nov 15:15** 的旧产物（源码 14 Nov 09:13），先备份→`pnpm -C packages/app build`（EXIT=0）→验证→按备份还原，`find dist -type f | xargs shasum | shasum` 复原为 `77cafc46…`。**若验收只 `hr serve` 不重 build，浏览器拿到的是 R5 之前的旧 JS**（dist 被 `.gitignore:2` 忽略，属本地产物，记为流程提示，不计代码缺陷）。

### 3. 覆盖率 100% 不是"删出来的" —— **通过**

- `pnpm -s test:coverage`：**EXIT=0**，`Test Files 133 passed (133)`、`Tests 1643 passed (1643)`，四维全 100%（`lines 7185/7185`、`statements 7185/7185`、`functions 751/751`、`branches 2911/2911`）。
- 分支**变多而不是变少**：实现者 09:15 那份 `coverage/coverage-summary.json` 是 `branches 2907/2907`，我复跑后 `2911/2911`（+4），说明本轮是"补测到 100%"而非"把分支删掉"。原有 5 个红文件的 branch 分母都不为 0：`packages/app/src/main.ts` 67、`boot.ts` 36、`packages/core/src/server/routes.ts` 40、`runtime.ts` 87、`static.ts` 40；`widgets/library.ts` 10。
- 无忽略：`grep -rn "v8 ignore" packages | wc -l` = **0**；`istanbul ignore`/`c8 ignore` = 0；`vitest.config.ts:28-39` 只有 `include: packages/*/src/**/*.ts` + `perFile: true` + 四维 100，无 `exclude`、无阈值下调，`git diff vitest.config.ts` 为空。
- `git diff --stat -- packages/app/src` 为**空**（该目录整包未跟踪，git 拿不到基线）；改用体量对比：G2 首审时 14 文件 1163 行 → 现在 15 文件 1290 行（新增 `guard.ts`、`widgets/copy.ts`，`dom.ts` 181→175 行是 `tocId` 收敛的结果）。净增，不存在"整段删除换取 100%"。

### 4. KD 机制 —— **通过（"28" 这个前提是 grep 假象）**

- 真实 `it.fails(` 调用点只有 **11 处**（`grep -rn "it\.fails(" packages --include=*.ts`，排除注册表自身）：KD-01×1、02×1、03×1、04×1、**05×2**、06×1、07×1、08×1、09×1、10×1 —— 与 `.workflow/known-defects.md:22-31` 的 10 行表、`CAP = 10`（`:16`）完全对齐；11 处**全部**带 `// KD-nn` 标记（就近上方 3 行内），未标记 0 条。
- "28" 的来源：`grep -rn "it\.fails" packages --include=*.ts | wc -l` = 28，其中 17 条是**不含 `(` 的散文/字符串**（如 `packages/core/tests/read-node.test.ts:136`「这条从 it.fails 转正」、`known-defects-registry.test.ts:25` 的 `NEEDLE` 构造、`:66` 的用例标题）。仓库里**没有**"18 条 `HrErrorCode` 矩阵用 `it.fails`"这回事（`grep -rn it.fails packages/core/tests/*error*` 无命中）—— 该前提不成立，但对齐本身是对的。
- 注入验证（`packages/core/tests/html-balance.test.ts:9`，`it(` → `it.fails(`，不加标记）→ `npx vitest run packages/core/tests/known-defects-registry.test.ts`：**2 failed / 4 passed**，`should give every it.fails a KD-nn marker…` → `"problem": "缺少 // KD-nn 标记"`；`should keep the unique KD count at or below CAP` → `expected 11 to be less than or equal to 10`（未标记站点的 `undefined` 也计入 unique，多一道网）。复原后 `shasum -c` → `OK`（`47129afa…`），该文件 `it.fails(` 计数回到 0。
- 注册表非空转：`:66` `should find at least one it.fails (otherwise this guard is vacuous)` + `:97` 反向查"表里有行但代码没钉子" + `:109` `rows.length === cap`。

| 项 | 判定 |
| --- | --- |
| 1 副作用收敛（次数/入口/类型） | 通过 |
| 2 TOC 真滚（服务器产物实跑） | 通过 |
| 3 覆盖率非删除/非 ignore | 通过 |
| 4 KD 机制可拦截新增 | 通过（"28" 前提需更正为 11） |

G2-R2: **PASS**（无非阻塞 P0/P1；仅一条流程提示：`packages/app/dist` 是 13 Nov 旧产物，验收须先 `pnpm -C packages/app build`）

ACP: 上下文 67K/700K (9%)，7 个压缩块（236K 原文 → 16K 摘要）；本轮探针 `/tmp/g2r2/{probe-toc.ts,probe-served.ts,served/}`，`packages/app/dist` 已按备份字节级还原（`77cafc46…`）
