# M2.3 审计（G2 · 第一轮全量）

- 审计对象：`git status` 中 M2.3 未提交改动（新增 `packages/core/src/annotations/**`、`ops/{annotationOps,revertOp}.ts`、`server/{annotation-replies,write-replies}.ts`、`packages/app/src/{notes,notes-state,notes-wire,wiring,flash,io}.ts` + `widgets/{selection,diffview,blocks-text}.ts`；修改 `server/{routes,handlers,runtime,status}.ts`、`app/src/{boot,main,state,keys,dom,guard,widgets/sidenotes}.ts`、`cli/src/exit-codes.ts`、`hr-error.ts`、`index.ts`）
- 依据：`.workflow/cards/M2.3.md`（20 AC + 8 条预设裁定 + §0 分层）与 `docs/05` §6
- 方式：全量读码 + `bun` 直接打 core 真实现（`/tmp/m23/probe1.ts`，不经测试）+ 真 `hr serve` + `curl`（`/tmp/m23/http.sh`）+ 门禁实跑
- 只读：未修改任何被审文件、未 commit；探针与工作区全在 `/tmp/m23/`
- **快照时点 10:03**：审计期间测试员在并行写 `packages/app/tests/notes-boot.test.ts`、`packages/core/tests/annotations/**`（10:01 后出现），下文门禁红已按 mtime 归因，不混算

---

## P0

### P0-1 · M2.3 的浏览器接线在真页面里整段不可达（模板缺 10 个锚点）

`packages/app/static/index.html` 一共只有 20 个 id，**没有任何 M2.3 锚点**：`#hr-note-btn` / `#hr-note-draft` / `#hr-note-submit` / `#hr-note-cancel` / `#hr-notes-pending` / `#hr-notes-resolved` / `#hr-diff-chunks` / `#hr-diff-status` / `#hr-diff` / `#hr-note-editor` 全部不存在，也没有任何代码动态创建它们。

写侧全都指向这些不存在（或永不存在）的选择器：

- `packages/app/src/wiring.ts:20-21` `host.children(\`${parent} #hr-notes-pending\`, …)` / `#hr-notes-resolved`
- `packages/app/src/wiring.ts:26-27` `#hr-diff-chunks` / `#hr-diff-status`
- `packages/app/src/notes-wire.ts:85,101,107` `host.on(\`${ROOT} #hr-note-btn|#hr-note-cancel|#hr-note-submit\`, …)`
- `packages/app/src/boot.ts:184-185` `host.cls(\`${ROOT} #hr-note-editor\`…, )`、`#hr-diff`
- `packages/app/src/notes-wire.ts:83-88` 读 `[data-hr-annotation]`（卡片从未渲染出来）

而 `packages/app/src/dom.ts:104`（`on` 的实现）是**绑定期**求值：`const element = found(root, selector); if (element === undefined) return () => undefined;` —— 找不到就返回空 unbinder，**即使元素后来出现也永不绑定**；`children`/`cls`/`text` 同样是 `found(...)` 后静默跳过（`dom.ts:104,121,135,139,145,163`）。

证据：

```
$ grep -o 'id="[^"]*"' packages/app/static/index.html | sort -u | tr '\n' ' '
id="hr-canvas" id="hr-conn" id="hr-controls" id="hr-doc" id="hr-focus-label" id="hr-lib-title"
id="hr-library" id="hr-notes-body" id="hr-notes-title" id="hr-notes" id="hr-root" id="hr-search-label"
id="hr-search" id="hr-shortcuts" id="hr-statusbar" id="hr-theme-label" id="hr-theme-select"
id="hr-theme" id="hr-toc-title" id="hr-toc" id="hr-version"

$ grep -rn "hr-notes-pending\|hr-note-btn\|hr-note-draft\|hr-diff-chunks" --include=*.ts --include=*.html packages/
packages/app/src/wiring.ts:20:  host.children(`${parent} #hr-notes-pending`, specs.pending);
packages/app/src/wiring.ts:26:  host.children(`${parent} #hr-diff-chunks`, diffSpecsOf(view));
packages/app/src/notes-wire.ts:85:  host.on(`${ROOT} #hr-note-btn`, "click", …)
（其余全是"写"，零个"声明"）
```

⇒ AC5.1（划词→按钮→输入框→提交）、AC5.2（右栏两组）、AC5.3（点卡滚动+标灰）、AC4.4（diff 面板）在真实应用里**全部是死码**；实现员自证里的 "AC5.1–5.5 全部接线" 只体现在函数存在性上，没有一条能通过真实 DOM 到达。

### P0-2 · `w`（Revert）永不触发撤销：dispatch 与副作用的顺序把守卫变成恒假

`packages/app/src/boot.ts:264,267`：

```ts
store.dispatch(intent);          // 264 —— reduceDiff 已把 diff.open 关掉
…
wired?.after(intent);           // 267 —— 副作用在 dispatch 之后
```

`packages/app/src/notes-wire.ts:172` 的守卫是 `if (intent.kind === "diffAccepted" && store.get().diff.open) revert();` —— 此刻 `diff.open` 已被 `notes-state.ts:171-173` 置为 `closedDiff`，**恒为 false**，`revert()` 永不执行。

后果：AC4.4 要求 "Accept 仅关闭 diff 视图、Revert 调 `POST /undo`"，实际是"唯一的键只关闭视图，撤销在 UI 上没有任何入口"（`revertOf` 只有这一个调用点）。同时 `keys.ts:35` 把 `w` 命名为 `diffAccepted` 而语义是 Revert，命名与行为相反。

---

## P1

1. **`resolveAnchor` 把 prefix/suffix 当过滤器而非消歧器**（`packages/core/src/annotations/anchor.ts:59-60`（`fitsContext` 在 `:34-42`））：`fitting` 为空即 `anchor_lost`，即使 `exact` **唯一命中**。探针（`/tmp/m23/probe1.ts`）：

   ```
   ①唯一命中                     {"ok":true,"start":6,"end":10}
   ④开头改一个字(引用本身完好)      {"ok":false,"reason":"anchor_lost"}      ← 卡 AC1.2 要求命中
   ④'引用前文变了、唯一命中        {"ok":true,"start":11}                  （只有 suffix 侧对得上才侥幸过）
   前缀越界(命中在文首)            {"ok":false,"reason":"anchor_lost"}
   ```
   AC1.2 的顺序是"优先 `exact` 唯一命中 → 多处命中才用 prefix/suffix 消歧"，实现反了；用户只要在引用前改一个字，批注就整条失效。

2. **`lost` 在整篇文本里搜索，不按批注所在块**（`packages/core/src/server/annotation-replies.ts:34-40`）：`doc = { text: 所有节点文本 join, nodeIds: 所有 id }`，`resolveAnchor` 于全篇匹配。实测：把 `hr-1` 的正文改成 `The quick zebra leaps.`（其锚点 suffix `" brown"` 已消失），因为 `hr-2` 仍是同一句，接口回

   ```
   GET /api/doc/doc.html/annotations → lost = []        ← 应为 ["an-8ad812e0","an-8fa6720d"]
   ```

   ⇒ AC1.3/AC3.4 `lost` 在同句复用（标题、重复段落、列表项）时永不生效，AC5.3 的"锚点失效"标灰也跟着失效。

3. **批注 id 只有毫秒粒度，同位置同句写第二条会被拒**（`packages/core/src/annotations/model.ts:46-53`，`createdAt` 进哈希但只到 ms；`ops/annotationOps.ts:97` 冲突即 `fail`）。注入冻结时钟（仓库测试的常规做法）实测：

   ```
   add#1 id = an-f8b9c9be
   add#2 抛错 → invalid_payload | 批注 id 冲突，请稍后重试
   真时钟连写 3 条 → an-56b35b37 an-a2aca20b an-4cf974cf（三条三 id ✓）
   ```
   AC §2-7 的验收"同一位置同一句话写两条批注要得到两个 id"在注入时钟下必然失败；真机双击提交同 ms 也会 400。

4. **写路由用 body 里的 `docId`，路径里的 `<docId>` 是装饰**（`packages/core/src/server/write-replies.ts:30,35`、`annotation-replies.ts:44-56`）。实测：

   ```
   POST /api/doc/doc.html/annotations  body={"docId":"other.html",…}  → 201 {"id":"an-3c3ec834"}
   $ grep nodeId doc.html   → "hr-1" "hr-1"      （无 hr-o1）
   $ grep nodeId other.html → "hr-o1"            （写进了 URL 里没提到的文件）
   ```
   AC3.1 的地址是 `POST /api/doc/<docId>/annotations`，实际寻址靠 body；路径侧既不做存在性检查也不做穿越检查（`params.docId` 在写路径上完全没被读）。

5. **草稿输入与乐观渲染都没接线**：`noteChanged` / `noteSubmitted` 两个 intent **全仓零发送点**（`grep -rn "noteChanged\|noteSubmitted" packages/app/src` 只命中 `notes-state.ts` 的定义与 reducer）。后果 ①`noteDraft` 恒为 `""`，`notes-wire.ts:109` 的 `state.noteDraft.trim() === ""` 直接 return，提交按钮永远无效；②"乐观渲染"不存在——`submittedOf`（`notes-state.ts:101-110`）、`withConfirmed`、`withoutOptimistic`（`notes.ts:65-75`）没有一个是可达路径，AC5.1 的"乐观渲染 + 失败回滚"实际是"成功后 reload 才有卡"。

6. **`previousTextOf` 未注入 → 真 UI 的 diff 恒"无变化"，且用的是另一套近似算法**：`packages/app/src/main.ts:242-245` 只传 `{io, fetchAnnotations, textOf}`；`notes-wire.ts:120` `const before = deps.previousTextOf?.(id) ?? after;` ⇒ `coarseDiff(before, after)` 立即 `before === after` 返回全 `same`（`notes.ts:107`）。AC4.4 要的 `ins`/`del` 在真页面上永远是空。另外浏览器侧用的是 `coarseDiff`（掐头去尾，`notes.ts:103-116`），**不是** AC4.1 指定的 `diffText`——core 的字符级 LCS 在生产代码里零调用点。

7. **`withLost` 零调用点 + `load()` 丢弃服务端 `lost[]`**：`notes-wire.ts:195` `store.dispatch({ kind:"annotationsLoaded", list: loaded.annotations })` 没有把 `loaded.lost` 传下去，`notes-state.ts:82-88` 的 `withLost` 因此永远不被调用（`grep -rn withLost packages/app/src` 只有定义）。AC5.3 的 `data-hr-lost` 标灰与"锚点失效"文案不可达。

8. **`diffText` 的 20k 保护形同虚设（上限内的代价是 1.5 GB）**：`packages/core/src/annotations/diff.ts:10,95` 判定是 `> 20_000`，恰好 20 000 仍走 `lcsDiff`，`new Uint32Array((n+1)*(m+1))` = **1 526 MB**。实测（bun 真跑）：

   ```
   LCS 1000×1000 →  4 ms（表   3.8 MB）
   LCS 3000×3000 → 15 ms（表  34.4 MB）
   LCS 6000×6000 → 54 ms（表 137.4 MB）
   20000×20000 → Uint32Array 1600160004 字节 = 1526 MB，且 degraded === false
   20001 输入 → degraded = true（上限判定本身在分配之前 ✓，不是"先算矩阵再判"）
   ```
   顺序是对的（AC4.2 的点名问题不存在），但"保护"允许一次 1.5 GB 分配；且 `diffText` 无生产调用点（只在 `annotations/index.ts:5`、`core/src/index.ts:76` 转出）⇒ 目前是库面风险，不是线上 DoS。

9. **选区判定用"节点"冒充"块"，且反向拖拽静默丢**（`packages/app/src/widgets/selection.ts:29,33,105`）：`crossBlock: anchor !== selection.focusNode`——同一块内含 `<strong>`/`<em>` 时跨内联元素选择会被判成跨块（AC §2-4 的提示只盖住"真跨块"）；`start/end` 直接取 `anchorOffset/focusOffset`（**文本节点内偏移**）去切 `blockText`（**整块文本**），带内联标记的块锚点偏移全错。反向拖拽（focus 在 anchor 前）时 `clamped(end, start, …)` 把 end 抬到 start ⇒ `exact === ""` ⇒ `{kind:"empty"}`，用户从右往左选中批注永远无效。`notes-wire.ts:189-192` 又把 `crossBlock`/`empty` 直接丢弃，无任何提示。

10. **`nodeId`/`id` 字面插进选择器，且 `found()` 不兜异常**：`packages/app/src/flash.ts:36` `[data-hr-id="${id}"]`（`id` 来自 SSE `changedNodes`）、`packages/app/src/notes-wire.ts:84-88` `[data-hr-id="${card.nodeId}"]` / `[data-hr-annotation="${id}"]`（来自文件内 meta 与 HTTP 响应）、`packages/app/src/dom.ts:121` `blockHtml`。`dom.ts:88` `found = root.querySelector(selector) ?? undefined` 无 `try/catch`：一个含 `"`/`]` 的 nodeId 会让 `querySelector` 抛 `SyntaxError`（在 click/SSE 回调里 = 未捕获），或把选择器改写成任意别的元素。

---

## P2

1. `packages/app/src/boot.ts:211-217` + `264-267`：`wired` 是 `const`（TDZ），`dispatchIntent` 在 `mountAllWithNotes` 期间就可能被 widget 调用；任何 mount 期同步 dispatch 都会 `ReferenceError`（当前恰好没有，属脆弱）。
2. 校验失败的码不统一：缺 `nodeId` → `{"code":"invalid_request","message":"缺少字符串字段 \`nodeId\`"}`、`start` 非整数 → `invalid_request`，而 AC3.1 明写 `invalid_payload`（只有 `anchor` 缺失那支走 `invalid_payload`，`annotation-replies.ts:57-66`）。
3. `annotation-replies.ts:130-152` 的 `undoReply` 复制了 `ops/revertOp.ts:14-19` 的 `undo_unavailable → nothing_to_undo` 映射且**不用** `revertLast`；`revertLast` 的 revision 用硬编码 `.slice(0, 16)`（`revertOp.ts:29`）而不是 `REVISION_CHARS`，两处算法漂移。
4. `ops/annotationOps.ts:76` `const written = next[next.length - 1]`：resolve/reopen 返回的 `annotation` 是数组末条，不是被改的那条（HTTP 只回 `revision`，故当前无外显，`AnnotationWriteResult.annotation` 语义是错的）。
5. `ops/annotationOps.ts:142-155` `reopenAnnotation` 不清 `resolvedAt`/`resolutionNote` ⇒ 出现 `status:"pending"` 却带归档时间的卡（AC5.2 分组与展示会打架）。
6. `annotations/diff.ts:77-90` `paragraphDiff` 每段都补 `"\n"`：退化结果重拼比原文长——实测 20001 字符输入 → 重拼 40004 字符（`+20003`），且纯插入一行会让其后全部行变成 `del`+`ins`。
7. `annotations/store.ts:104-108` `insertAt` 用 `html.lastIndexOf("</body>")`：正文里出现字面 `</body>`（代码块/示例）时 meta 会插进 `<article>` 内，从第二次写入起 AC2.5 就不再成立。
8. `server/status.ts:34-36` 新增 `anchor_lost: 409`，但全仓无任何 `throw new HrError("anchor_lost")`（锚点失败是返回值）——为凑 `HrErrorCode` 矩阵而存在的死码。
9. `packages/app/src/guard.ts:12-30` `isAnnotationList` 只校验 `Array.isArray(value["annotations"])` 就断言了元素的完整形状（`id: string` 等未逐一检查）——守卫在说谎，`data-hr-annotation` 可能拿到非字符串。
10. 卡面 AC2.3 写"`hr undo` 能回滚"，但 CLI 里没有 `undo` 子命令（`packages/cli/src/commands/` 只有 outline/patch/read/serve/style；`grep -rn undo packages/cli/src` 只命中 `exit-codes.ts` 的码表）。撤销只有 HTTP `POST …/undo` 与 `revertLast`，卡的 CLI 表述无对应实现（需裁定是改卡还是补命令）；另 `reopenAnnotation` 有实现、无路由（实现员 §5-4 已自报）。
11. 流程：`packages/app/src/boot.ts` 实测 277 行、`widgets/sidenotes.ts` 77 行，与实现报告 §1 的 "346 行 / +61" 不符——自证里的行数不可作为审计依据。

---

## 通过项（有实证，非"看起来对"）

| 项 | 证据 |
|---|---|
| 纯函数纪律 | `grep -rn "Date\.now\|new Date(\|randomUUID\|Math\.random" packages/core/src/annotations/ packages/core/src/ops/annotationOps.ts packages/core/src/ops/revertOp.ts` → 0 命中；`annotations/**` 只 import 纯模块（唯一外部是 `../io/digest` 的 `sha256Hex`，`io/digest.ts:3` 仅 `node:crypto`，无 fs） |
| AC2.5 正文零字节 | 真文件写入后 `<article>…</article>` 区间逐字节相同；剥掉 meta 后全文件差异字节数 = `0`（214 → 384 字节，差值全在 meta 内） |
| AC2.2/2.3 原子写 + undo 严格逆序 | 实跑 `POST …/undo` ×4：`200 ca436e48` → `200 72570ae4` → `200 b94e3248` → `409 nothing_to_undo`；第 3 次 undo 把文件恢复到首次批注前 |
| AC4.1 chunk 语义 | `abc→axc` = `same a / del b / ins x / same c`；`aab→ab` 相邻同类已合并；零长度 chunk = false |
| AC3.5 单一漏斗 | 16 条路由全部经 `packages/core/src/server/server.ts:93-110` 的 `gateOf`（重复 Host / Host / Origin）+ `authOf`；实测无 cookie → `401`，无/错 Origin 或跨站 → `403 forbidden_origin`；路径穿越 `GET /api/doc/..%2F..%2Fetc%2Fpasswd/annotations` → `403 path_outside_workspace`，报文**已脱敏**（``message":"`file` 逃出了 workspace：..[路径已隐藏]"``），M2.1 P0-1 未复发 |
| `note` 无 `innerHTML` | `widgets/sidenotes.ts:44-58` 全程 `text:`（`textContent` 语义）；实测写入 `a</script><img src=x onerror=alert(1)>\u0000\nb` → meta 内为 `<\/script>`，回读 `note` 逐字符相同（含 NUL） |
| 未知 anId / 不可撤销 | `POST …/annotations/an-deadbeef/resolve` → `404 {"code":"not_found"}`；空历史 undo → `409 {"code":"nothing_to_undo"}` |
| 脏载荷防空 | `flash.ts:14-27` `changedNodesOf` 对 `{}`/`[]`/非法 JSON 回 `[]`；`notes-wire.ts:189-192` 非 `annotate` 意图直接丢弃 |

## 门禁（快照 10:03，含并行改动归因）

```
pnpm -s typecheck  → EXIT=2，2 条错误，全在测试员 10:01 后新建的文件：
                     packages/app/tests/notes-boot.test.ts:59   （io.json 泛型，在飞）
                     packages/core/tests/annotations/ops.test.ts:217 （targetId 已不在 PatchFileInput）
                     src/ 下 0 条错误
pnpm -s test       → 4 failed | 1718 passed (1722) / 139 文件
                     其中 2 条（units-run「serve 的 stop 注入」、g3r-reach:72 端口占用退出码）
                     是我自己起的探针 daemon 触发的全局单例拒绝，pkill 后复跑即绿 —— 假红，已排除
                     真红 1 条：packages/app/tests/main.test.ts:26 首屏 IO 顺序里没有
                     GET /api/doc/<id>/annotations（实现报告 §R0 已归测试员）
                     另 1 条在测试员在飞文件里
```
⇒ 卡 §4 的"`pnpm verify` EXIT=0"在当前快照**不成立**；实现员"6 道门全绿"的自证与实测不符（他自报 EXIT=2，实测 typecheck/test 都还有红，但红全在测试侧，且部分是测试员在飞）。

## AC 逐条

| AC | 判定 | 依据 |
|---|---|---|
| 1.1 形状/id/截断 | ✅ | `model.ts:27-29,46-53,62-88`；探针 id 稳定可复现，1ms 差异即不同 id（但见 P1-3） |
| 1.2 exact→context→fuzzy | ⚠️ | 矩阵 6/11 例与卡不符（P1-1）：唯一命中被上下文否决 |
| 1.3 orphaned / anchor_lost | ⚠️ | `orphaned` 正确（探针 ③）；`lost` 汇总错误（P1-2） |
| 2.1 meta 唯一真相源 | ✅ | 读写只在 `store.ts`，`annotationOps` 负责落盘 |
| 2.2 原子写 + doc.changed | ✅ | `writeAtomic` + 快照；实跑 201 + revision 与 GET 一致；未新增事件类型 |
| 2.3 undo 链 | ✅ | 实跑严格逆序 + 409（见上表）；但"`hr undo`"子命令不存在（P2-10） |
| 2.4 脏 meta 容错 | ✅ | 非 JSON / 非对象 / 非数组 → 空 + 1 条；未知字段合并 1 条；非法 status → pending |
| 2.5 正文不动 | ✅ | 逐字节 0 差异（见上表） |
| 3.1 POST 新增 | ⚠️ | 201 + `{id,revision}` ✓；`docId` 取自 body 而非路径（P1-4）；部分 400 用 `invalid_request`（P2-2） |
| 3.2 POST resolve | ✅ | 200 `{revision}`；未知 id → 404 |
| 3.3 POST undo | ✅ | 200 / 409 `nothing_to_undo` 实测 |
| 3.4 GET 列表 | ⚠️ | 形状 ✓，`lost` 判定错（P1-2） |
| 3.5 复用中间件 | ✅ | 401/403/穿越全过同一漏斗，报文脱敏 |
| 4.1 chunk 合并 | ✅ | 探针 |
| 4.2 20k 退化 | ⚠️ | 判定在分配前 ✓、`degraded` ✓；但上限内 1.5 GB（P1-8），退化重拼不守恒（P2-6） |
| 4.3 闪烁 | ⚠️ | `flash.ts` 逻辑对（注入 `schedule`、2000ms、canceller），但 `changedNodes` 选择器未转义（P1-10）、模板无 `#hr-diff` 之外无影响；未在真浏览器验证 |
| 4.4 Diff/Accept/Revert | ❌ | 面板容器不存在；`w` 不撤销（P0-2）；无 Accept/Revert 按钮；before=after（P1-6） |
| 4.5 Diff 不改正文 | ✅ | `renderDiff` 只写 `#hr-diff-*`（但该容器不存在，故是"空操作达标"） |
| 5.1 划词→提交 | ❌ | 按钮/输入框/`noteChanged`/乐观卡全不可达（P0-1、P1-5） |
| 5.2 右栏两组 | ❌ | `#hr-notes-pending|resolved` 不存在（P0-1） |
| 5.3 点卡滚动/标灰 | ⚠️ | 滚动代码存在（`notes-wire.ts:88-92`），卡片渲染不出来；`lost` 不可达（P1-7） |
| 5.4 `c` 键真实提交 | ⚠️ | `openSidenote → afterOf` 路径正确（`notes-wire.ts:174-178`），但编辑器不可见、草稿恒空 |
| 5.5 `Shift+D` / `w` | ❌ | diff 恒"无变化"，`w` 不撤销 |

## 证伪/教训

- **不要用"函数存在"代替"路径可达"**：实现员 §R0 的接线表每一条都能 grep 到代码，但 10 个 DOM 锚点一个都不存在——`Host.on` 的**绑定期求值**让"先渲染后绑定"也救不回来。审计这类接线时第一件事应该是 `grep id=` 模板。

## G2: FAIL

P0 × 2（P0-1 模板缺锚点导致 AC5.x/AC4.4 全不可达；P0-2 `w` 永不撤销）、P1 × 10、P2 × 11；纯函数纪律、AC2.5 正文零变化、undo 严格逆序、路由单一漏斗与路径脱敏这四项有实证通过。

ACP: 上一轮 M2.2 终检 `G2-R2: PASS`；本轮 M2.3 首审快照 10:03（实现文件 09:30–09:48 稳定，测试员 10:01 后在飞），探针 `/tmp/m23/{probe1.ts,http.sh,ws/}`，daemon 已 `pkill`，`packages/app/dist` 未触碰，仓库仅新增本报告。
