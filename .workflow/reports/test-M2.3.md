# test-M2.3 · G3 复核（测试侧）

> 角色：测试员（只写 `packages/*/tests/**` 与 `packages/core/fixtures/**`）。本报告记录 G3 轮的全部真跑证据。
> 结论先行：**用例 154 文件 / 1899 例全绿；变异 8/8 全杀（含 3 个反向变异）；`pnpm verify` 红在覆盖率四维的 14 个文件上，全部是 `src` 侧不可达的防御臂**（下附逐行判定与删法），因此 EXIT=1。

## 1. 本轮按 §7 的 18 条裁定重写的用例

| 裁定 | 测试改动 | 落点 |
| --- | --- | --- |
| #1 diff 挪服务端 | 删掉“app 里算 diff”的断言；`/notes/<an>/diff` 只断言渲染服务端 chunk | `packages/app/tests/notes-wire-branches.test.ts`、`packages/core/tests/server/annotations-diff-route.test.ts` |
| #2 `hr undo` | 新增 9 例：参数/`--json` 信封/无历史/写盘还原 | `packages/cli/tests/units-undo.test.ts` |
| #3 id 语义反转 | 原“字节级重复要报错”改为“同位置同句两条 → 两个 id” | `packages/core/tests/annotations/ops.test.ts` |
| #4 `lost` 按块判定 | 同句在别块不能救活 + 其中一块被改的区分用例 | `packages/core/tests/server/annotations-payload-routes.test.ts` |
| #5 anchor 顺序 | `exact` 唯一命中直接采用、多命中才用 prefix/suffix、`ambiguous` 为返回态 | `packages/core/tests/annotations/anchor-order.test.ts` |
| #6 `before`/`after` 两相 | `w` 撤销走“真 before → dispatch → after”，直接测出恒假守卫 | `packages/app/tests/notes-wire-two-phase.test.ts` |
| #7 `anchors.ts` 自检 | 模板缺锚点 → `#hr-statusbar` + `console.error` | `packages/app/tests/anchors.test.ts` |
| 其余 | 路由 16→17、命令 5→6、构造器 7→9、meta 落 `<article>` 内、`CODE_MATRIX` 去 `anchor_lost`、diff 上限改**格子数 800 万**（两侧各一条） | `unit-body-routes` / `units-output` / `units-args` / `index.test.ts` / `unit-annotation` / `diff-edges` |

## 2. 用例与四维

- `npx vitest run`：**154 文件 / 1899 例，全绿**（0 skip / 0 todo / 0 `it.fails`）。
- 覆盖率（`pnpm test:coverage`，v8 + perFile 100）**未过**：见 §4 的逐行清单，14 个文件红。

## 3. 变异表（全部真跑：改 `src` → 跑用例 → 还原；脚本 `/tmp/mut.sh`）

| 变异体 | 改动 | 结果 | 杀死它的用例 |
| --- | --- | --- | --- |
| M1 锁超时不生效 | `packages/core/src/io/lock.ts` `const deadline = deps.clock.now().getTime() + input.timeoutMs;` → `* 10` | **KILLED**（1 failed / 18 passed） | `packages/core/tests/io/lock.test.ts` · `should report locked once the deadline passes` |
| M2 history 用“重新序列化”而非原字节 | `packages/core/src/io/history.ts` 写快照前 `TextDecoder→replaceAll("\r\n","\n")→TextEncoder` | **KILLED**（1 failed / 8 passed） | `packages/core/tests/io/undo-bytes.test.ts` · `should restore CRLF byte for byte` |
| M3 rename 前不删 tmp | `packages/core/src/io/atomic.ts` 的 `await unlinkQuiet(...)` → `continue` | **KILLED**（4 failed / 10 passed） | `packages/core/tests/io/atomic.test.ts`、`packages/core/tests/io/kill.test.ts` |
| M4 `changed:false` 仍写盘 | `packages/core/src/io/patchFile.ts` `if (!outcome.changed) {` → `&& false` | **KILLED**（1 failed / 23 passed） | `packages/core/tests/io/patch-actions.test.ts` · `should report changed:false … and touch nothing` |
| M5 `root` replace 丢 `<article>` 属性 | `packages/core/src/ops/patchNode/apply.ts` 去掉 `isRoot ? inner : full` 三分支 | **KILLED**（2 failed / 18 passed） | `packages/core/tests/io/patch-actions.test.ts` |
| R1 id 种子去掉 `createdAt` | `packages/core/src/annotations/model.ts` 材质数组删 `input.createdAt` | **KILLED**（1 failed / 81 passed） | `packages/core/tests/annotations/ops.test.ts` |
| R2 `resolveAnchor` 唯一命中改“取首个” | `packages/core/src/annotations/anchor.ts` `starts.filter(fitsContext)` → `starts` | **KILLED**（2 failed / 65 passed） | `packages/core/tests/annotations/anchor-order.test.ts` |
| R3 `before`/`after` 合回单相 | `packages/app/src/notes-wire.ts` 守卫 `intent.kind !== "revert" \|\| scope.store.get().diff.open` → `\|\| true` | **KILLED**（1 failed / 5 passed） | `packages/app/tests/notes-wire-two-phase.test.ts` · `should refuse w while the diff panel is closed …` |

**8/8 全杀**，其中 R1/R2/R3 是要求的三条反向变异，**全部按预期变红**。

## 4. 覆盖率四维红：14 个文件、逐行判定

> 全部用 `node` 读 `coverage/coverage-final.json` 的 `b`（分支臂计数）定位。判定标准：能否从**公开入口**构造输入走到该臂。

### 4.1 真·不可达（建议删代码，不是补测试）

| 文件:行 | 臂 | 为什么不可达 | 建议 |
| --- | --- | --- | --- |
| `packages/app/src/boot.ts:158,159` | `defaultSchedule` 的 `clearTimeout(handle)` 两条语句 | `flashChanged` 丢弃了返回的 cancel（`packages/app/src/boot.ts:170` 附近），没有任何调用点，语句计数为 0 | 删 `Schedule` 的 cancel 返回值，或让 `boot` 在 `destroy`/重放时真的调用它 |
| `packages/app/src/main.ts:246-252` | `notes.fetchDiff` lambda 的 4 条语句 + 1 个函数 | **P0-1（新发现，见 §5）**：`keySourceOf`（`packages/app/src/main.ts:186-195`）构造 `KeyLike` 时**不转发 `shiftKey`**，而 `diffShortcutOf`（`packages/app/src/keys.ts:33`）要求 `event.shiftKey === true` → 真实浏览器里 Shift+D 永远产不出 `diffToggled`，这个 lambda 生产路径不可达 | 补 `shiftKey: event.shiftKey === true`（`main.ts:56-63` 的 `KeyboardLike` 也要加字段） |
| `packages/app/src/main.ts:288:27` | `window.location.href` 臂 | 已由 `install(null, "http://x/?doc=from-href")` 覆盖 | — |
| `packages/app/src/measure.ts:55` | `selection.focusNodeParent ?? null` 右臂 | `SelectionLike.focusNodeParent?: …` 可选，但同一表达式的 `anchorNode.parentElement` 是**必填**，`?.` 右臂只能靠类型洞（`undefined` 赋给必填字段）到达 | 两处改同口径（都 optional），或删 `?.` 用必填类型 |
| `packages/app/src/notes-wire.ts:146` | `state.diff.nodeId ?? ""` 右臂 | `diffShown` 是唯一把 `open` 置真的 intent，它必带 `nodeId`；`diffToggled` 只关不开 | 删 `?? ""`，让 `DiffState.nodeId` 在 `open:true` 时为必填 |
| `packages/app/src/widgets/sidenotes.ts:53` | `lostLabel(annotation.lost) ?? ""` 右臂 | 外层三元已用 `lostLabel(...) === undefined` 过滤，再 `?? ""` 是死代码 | 删 `?? ""`，改为把 `lostLabel` 的结果先存局部变量 |
| `packages/core/src/annotations/anchor.ts:49` | `candidates[0] ?? 0`（`closestOf` 初值） | 调用点 `closestOf(fitting, …)` 已保证 `fitting.length > 0` | 删 `?? 0`，改 `candidates[0] as number` 或让函数收非空数组类型 |
| `packages/core/src/annotations/anchor.ts:63` | `starts[0] ?? 0` | 上一行已 `if (starts.length === 1)` | 同上 |
| `packages/core/src/annotations/store.ts:33` | `queue.shift()` 的 `undefined` 检查 | `while (queue.length > 0)` 保证 `shift()` 必返回元素 | 改 `const node = queue.shift(); if (node === undefined) break;` → `const node = queue.shift() ?? root;` 类的等价写法，或直接 `queue.shift() as HtmlNode` |
| `packages/core/src/ops/annotationOps.ts:49` | `anchor.exact.length > ANCHOR_LIMITS.exact` | `normalizeAnchor`（`packages/core/src/annotations/model.ts:81-88`）已按 500 **截断**，此处再判超长为真·死分支 | 删这行；超长输入改在 `normalizeAnchor` 里报 `invalid_payload` |
| `packages/core/src/ops/annotationOps.ts:87` | `next[next.length - 1]` 的 `undefined` 分支 | `next` 刚 `push` 过至少一条（上面已保证写入），末元素必存在 | 用局部变量持有 `written` 再 push |
| `packages/core/src/server/annotation.ts:118` | `anchor?.span === undefined` 真臂 | `elementsOf` 递归后**隐式元素也带 span**（`innerStart=innerEnd=0`），`elementsOf(doc).filter(article).at(-1)` 与 `body` 必非空 | 删该臂；顺带修 `packages/core/src/server/annotation.ts:113-124` 对**无 article/body 片段**的落点（实测 `<p>x</p>` 会把 meta 插到 offset 0，见 §5 P0-3） |
| `packages/core/src/server/write-replies.ts:41` | `params["anId"] ?? ""` 右臂 | 路由 `annotationResolve` 的模式强制含 `:anId` 段，匹配成功必有该键 | 删 `?? ""` |
| `packages/core/src/server/runtime.ts:202,203` | `params["docId"] ?? options.docId` 右臂 | `annotationDiff` 路由必含 `:docId` 段 | 删 `?? options.docId` |

### 4.2 疑为 v8 remap 伪影（已写最小复现，仍计 0）

| 文件:行 | 臂 | 证据 |
| --- | --- | --- |
| `packages/core/src/server/annotation-replies.ts:45` | `block?.text ?? ""` 的右臂 | 单文件跑 `annotations-payload-routes.test.ts`（含 ghost 用例，已断言落盘 `nodeId === "hr-ghost"`、`lost.length === 1`）时 `b[7] = [0]`；即该臂在**确实执行**的情况下仍记 0 |
| `packages/core/src/annotations/diff.ts:43,44,46,55,64,68,71,90,94` | LCS 表的 `?? 0` / 字符取值的 `?? ""` | 索引全部落在 `table`/字符串边界内（`i+1 ≤ before.length`、`j+1 ≤ after.length`），矩阵用例（含空串/单字符/CRLF/纯换行）全过后仍计 0 |

### 4.3 汇总（`pnpm test:coverage` 的 ERROR 行原文）

```
ERROR: Coverage for lines (99.01%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for statements (99.01%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for lines (97.89%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for functions (96.77%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for statements (97.89%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (98.55%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (95.65%) does not meet global threshold (100%) for packages/app/src/measure.ts
ERROR: Coverage for branches (98.71%) does not meet global threshold (100%) for packages/app/src/notes-wire.ts
ERROR: Coverage for branches (95%) does not meet global threshold (100%) for packages/app/src/widgets/sidenotes.ts
ERROR: Coverage for branches (92.59%) does not meet global threshold (100%) for packages/core/src/annotations/anchor.ts
ERROR: Coverage for branches (76.31%) does not meet global threshold (100%) for packages/core/src/annotations/diff.ts
ERROR: Coverage for branches (97.82%) does not meet global threshold (100%) for packages/core/src/annotations/store.ts
ERROR: Coverage for branches (95.34%) does not meet global threshold (100%) for packages/core/src/ops/annotationOps.ts
ERROR: Coverage for branches (97.67%) does not meet global threshold (100%) for packages/core/src/server/annotation-replies.ts
ERROR: Coverage for branches (98.3%) does not meet global threshold (100%) for packages/core/src/server/annotation.ts
ERROR: Coverage for branches (97.7%) does not meet global threshold (100%) for packages/core/src/server/runtime.ts
ERROR: Coverage for branches (95.83%) does not meet global threshold (100%) for packages/core/src/server/write-replies.ts
```

## 5. 待裁定（`src` 侧缺陷，测试侧无权改）

- **P0-1 真实键盘路径丢 `shiftKey`**（新，阻断 AC5.3 全链路）：`packages/app/src/main.ts:186-195` 的 `listener` 只转发 `key/metaKey/ctrlKey/altKey/target`；`packages/app/src/main.ts:56-63` 的 `KeyboardLike` 甚至没有 `shiftKey` 字段。后果：`packages/app/src/keys.ts:33` 的 `diffShortcutOf` 恒不成立 → Shift+D 在浏览器里无效、`packages/app/src/main.ts:246-252` 的 `fetchDiff` 生产路径不可达、diff 面板永远打不开。**建议**：`KeyboardLike` 加 `readonly shiftKey?: boolean`，`listener` 里补 `shiftKey: event.shiftKey === true`，并加一条 `main.test.ts` 用例（我已在 `packages/app/tests/notes-wire-branches.test.ts:20` 留了 `toggleDiff` 走 harness 的 `shiftD`，可直接复用）。
- **P0-2 `defaultSchedule` 的 cancel 从未被调用**：`packages/app/src/boot.ts:155-160` 返回的 cancel 在 `flashChanged` 处被丢弃，闪光的定时器无法取消（页面 `destroy` 后仍可能写 DOM）。建议删掉 cancel 语义或接到 `destroy`。
- **P0-3 片段文档的 meta 落点漂移**：`packages/core/src/server/annotation.ts:113-124` 对隐式元素给 `span.innerStart = span.innerEnd = 0`，导致 `appendAnnotation("<p>x</p>", …)` 把 `<script id="hr-meta">` 插到 **offset 0**（我已用探针实测并回退，未把该行为写进断言）。同一根因使 `annotation.ts:118` 的兜底臂不可达。
- **P0-4 `hr annotate/resolve/diff` 三命令仍缺**：`packages/cli/src/commands/` 只有 `{outline,patch,read,serve,style,undo}`；`packages/cli/src/usage.ts:3` 的 `COMMAND_NAMES` 是 6 项。卡 §7 只点名了 `undo`，但 M2.3 的验收面里有批注命令，需要裁定是否本轮交付。
- **新旧 meta 双轨**：legacy `appendAnnotation`（`packages/core/src/server/annotation.ts`，经 `packages/core/src/server/handlers.ts:230`）写 `{id,targetId,comment,status}` 并插在 `<article>` 末尾；新 `writeAnnotations`（`packages/core/src/annotations/store.ts:114`）写 `{version,annotations:[…]}`。`parseAnnotationOf`（`packages/core/src/annotations/model.ts:135`）读 legacy 记录会丢批注。

## 6. `pnpm verify` 原始输出（尾部）

```
$ pnpm verify > /tmp/verify.log 2>&1; echo "EXIT=$?"; tail -6 /tmp/verify.log
EXIT=1
ERROR: Coverage for branches (97.67%) does not meet global threshold (100%) for packages/core/src/server/annotation-replies.ts
ERROR: Coverage for branches (98.3%) does not meet global threshold (100%) for packages/core/src/server/annotation.ts
ERROR: Coverage for branches (97.67%) does not meet global threshold (100%) for packages/core/src/server/runtime.ts
ERROR: Coverage for branches (95.83%) does not meet global threshold (100%) for packages/core/src/server/write-replies.ts
[ELIFECYCLE] Command failed with exit code 1.
[ELIFECYCLE] Command failed with exit code 1.
```

> 说明：`format:check` / `lint` / `typecheck` / `build` / `depcruise` / `knip` 六步全绿；唯一的红是 `test:coverage` 的四维阈值，全部落在 §4 的 `src` 侧臂上。
> 若用卡里写的 `pnpm verify 2>&1 | tail -6; echo "EXIT=$?"`，`$?` 取到的是 `tail` 的状态（0）——这里改用重定向 + `${PIPESTATUS[0]}` 口径，如实报 1。

## G3-R4 · 收尾（一行 lint 红）

- 改了什么：把 `describe("main · 划词监听")` 里那个 43 行 `it` 的前半段提到 `packages/app/tests/support/selection-fixture.ts` 的 `submitNoteWithSelection({ respond, load, draft? })`（与 `guarded.ts` 同风格：夹具函数、无 `as`），`it` 只留两条断言；顺手把 `main-stubs.ts` 里 `Reflect.get(...)` 的 `any` 收成 `methodOf/bodyOf`（`isRecord` 收窄）。
- 真实输出：

```
$ npx eslint packages/app/tests/main.test.ts packages/app/tests/support/selection-fixture.ts packages/app/tests/support/main-stubs.ts
npm warn Unknown project config "prefer-workspace-packages". …
ESLINT_EXIT=0

$ npx vitest run packages/app/tests/main.test.ts
 ✓ packages/app/tests/main.test.ts (21 tests) 513ms
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

- 已知剩余（本轮按禁令未复跑 verify）：`packages/app/src/main.ts:248-251` 的 `notes.fetchDiff` lambda 仍 0 覆盖，唯一原因见 §5 **P0-1**：`main.ts:187-196` 的 `keySourceOf` 不转发 `shiftKey`（`KeyboardLike` 也无该字段），Shift+D 在真实监听器里恒不成立。修法是一行：`shiftKey: event.shiftKey === true`（`packages/app/src/keys.ts:16` 的 `KeyboardLike` 已声明该字段）+ `packages/app/src/main.ts:56-63` 的 `KeyboardLike` 补 `readonly shiftKey?: boolean`。修好后可直接用 `packages/app/tests/main.test.ts` 里现成的 `stubs.keyHandlers[0]({ key: "d", shiftKey: true })` 补端到端例（已留好 `seedNotesSurface`/`selectInBlock` 夹具）。
- 其余两项已 100%：`packages/app/src/measure.ts`（`anchorNode: null` + 焦点侧有块的两例已覆盖）、`packages/core/src/html/span.ts`（新文件 `packages/core/tests/html/span-of.test.ts`，3 例：有区间 / 缺 `span` / `undefined`）。

ACP:
