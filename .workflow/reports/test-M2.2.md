# 测试报告 M2.2 · 阅读器三栏骨架

- 角色：G3 测试员（独占 `packages/app/tests/**`、`packages/core/tests/**`、`packages/cli/tests/**`；未改 `src/**`）
- 被测：`packages/app/src/**` 14 文件、core `static.ts` + `ROUTES` 9→11、cli `--app-dir`
- 依据：`.workflow/cards/M2.2.md`；自证报告只用于对照，不采信
- 结论：**1568 例全绿（127 文件）、变异 6/6 全杀（含反向变异）、`pnpm verify` EXIT=1 且唯一红点是 4 个 src 文件的 perFile 覆盖率**——4 处都判定为 src 侧死代码/断线，详见 §5。

## 1. 用例矩阵

### 1.1 新增 `packages/app/tests/**`（10 文件 / 106 例，`Duration ~0.33s`）

| 文件 | 例数 | 覆盖的契约 |
| --- | --- | --- |
| `state.test.ts` | 28 | reducer 全 intent：`move` 首尾不循环、`toggleFocus`、`openSidenote`、`searchOpened/Closed`、`themeSettled` ok/failed、`conn`、`blocksLoaded`、`documentChanged` 与 `doc.reloaded` 的 revision 语义、未知 intent 原引用返回 |
| `keys.test.ts` | 18 | 纯函数矩阵：`j/k/h/c//`、`Escape`；`meta/ctrl/alt` 抑制；`INPUT/TEXTAREA/SELECT/[contenteditable]` 抑制；大小写敏感；`activeId` 缺失时 `c` 无效；首尾边界 |
| `sse.test.ts` | 11 | 注入假 `EventSource`+假时钟：1s→2s→4s…封顶 30s、抖动区间、`open` 后 attempt 归零、旧 revision 丢弃（AC4.3）、坏 JSON 丢弃、`close` 后不再重连 |
| `store.test.ts` | 5 | `subscribe` 退订、同引用不通知、多次订阅按注册顺序、`dispatch` 返回 void、退订幂等 |
| `dom.test.ts` | 11 | `createDomHost`：`html/text/attr/cls/children/blocks/blockHtml/on/destroy`，`on` 覆盖同选择器、`off` 后不再触发，`destroy` 一次解绑全部 |
| `widgets.test.ts` | 9 | **调用序列断言**：library 只在 `outline` 换引用时重建（AC2.2）；canvas 首屏只 `html` 一次、之后只 `blockHtml` 变化块（AC2.4）；sidenotes/statusbar 的 attrs 与文本 |
| `boot.test.ts` | 9 | 首屏挂载、`doc.changed`/`doc.reloaded` 才刷新（`library.changed` 不刷新）、模型缺 `children` 退化为空块表、键盘→intent、destroy 解绑/退订/关 SSE、泵在失败后继续 |
| `main.test.ts` | 8 | 入口适配层：`body[data-doc-id]` 优先、`?doc=` 兜底、无 id 的提示文案、model/outline/document 的失败与形状校验各自报什么、`EventSource` 带 cookie、keydown 形状映射 |
| `style-switch.test.ts` | 6 | 切换 3 次幂等、只动 `#hr-theme`、不丢滚动（无 `reset` 类调用）、加载失败不落 CSS、并发切换后者胜 |
| `index.test.ts` | 1 | 公共面导出清单（与 `src/index.ts` 精确对齐） |
| `support/fake-host.ts` | — | `FakeHost` 记录调用序列（`{op,args}`）+ `fire`；`captureUnhandled`、`recordingStore` |
| `support/fake-dom.ts` | — | 假 `document`/`Element`：选择器表、attrs、listeners、innerHTML 写入序列 |

M2.2 新增硬要求对应：

- **AC2.2/AC2.4 用调用序列证明**：`widgets.test.ts` 断言 `ops()` 里 `html` 只出现 1 次、`blockHtml` 只对 `hr-a` 出现；M1 变异（整篇重载）被杀即证。
- **`/assets/*` 穿越套件**：`packages/core/tests/server/static-app.test.ts`（真 `hr serve` + 真 `node:net` 原文）覆盖 `%2e%2e%2f`、`..%2f`、`..%5c`、`//etc/passwd`、`%2fetc`、`%00`、`x%00.txt`、2000 字符、以及**新增的 `/assets/../secret.txt`、`/assets/a/../secret.txt`**；每条断言 404 + 响应体不含 `/etc`、不含 `tmpdir()`、不含 `TOP SECRET`（靶子是 `appDir/secret.txt`，只在 `..` 被放过时可读）。
- **主题路由**：`GET /api/theme/atelier-editorial` → 200 + `text/css`；未知 id → 404 `unknown_style`；遍历 id → 404 且不读主题目录外。
- **覆盖率 hit 的两处末位分支**（新增 `packages/core/tests/server/g3m22-branches.test.ts`）：`contentTypeOf("/assets/font.woff2")` → `application/octet-stream`（`http-io.ts:95` 兜底）；`matchRoute("GET","/api/theme")` → `kind:"none"`（证明 `routes.ts:89` 的 `?? ""` 走不到，见 §5）。

### 1.2 改动的既有测试（4 条契约）

- `packages/core/tests/server/unit-body-routes.test.ts:91`、`g312-knip-surface.test.ts:105`：`ROUTES` 断言**精确 11 条**，并逐条点名新增 `/assets/:path`、`/api/theme/:styleId` 的 params 与 auth（`assets/theme` 均 `auth: "none"`）。没有改成 `>= 9`。
- `packages/cli/tests/units-args-serve.test.ts`：serve 默认 intent 与 `--json` 输出都带 `appDir: "/repo/packages/app/dist"`（新键）。

## 2. 覆盖率（四维，`npx vitest run --coverage`）

```
All files          |   99.78 |    99.82 |   99.72 |   99.78 |
packages/app/src
  boot.ts          |    91.5 |    93.33 |     100 |    91.5 | 80-88
  dom.ts           |     100 |      100 |     100 |     100 |
  index.ts         |     100 |      100 |     100 |     100 |
  keys.ts          |     100 |      100 |     100 |     100 |
  main.ts          |    95.2 |      100 |      92 |    95.2 | 79-80,99-100,151-152
  sse.ts           |     100 |      100 |     100 |     100 |
  state.ts         |     100 |      100 |     100 |     100 |
  store.ts         |     100 |      100 |     100 |     100 |
  style-switch.ts  |     100 |      100 |     100 |     100 |
  widgets/*        |     100 |      100 |     100 |     100 |
packages/core/src/server
  http-io.ts       |     100 |      100 |     100 |     100 |
  routes.ts        |     100 |    97.56 |     100 |     100 | 89
  runtime.ts       |     100 |    97.59 |     100 |     100 | 151-152
```

`packages/app` 14 文件中 **10 个文件四维 100%**；`core/src/server` 从 G3-R 的 4 个缺口降到 2 个分支。剩余 4 处全部是"走到不了"的代码，见 §5；没有用 ignore、没有改阈值。

## 3. 变异测试（`node packages/app/tests/support/mutants.mjs`，真跑真还原）

每个变异体替换一处源码文本 → 跑目标测试文件 → 退出码非 0 记 KILLED；`finally` 原样写回。

| # | 变异体 | 替换 | 目标 | 结果 | 杀死它的用例 |
| --- | --- | --- | --- | --- | --- |
| M1 | canvas 整篇重载 | `blockHtml` diff → `host.html` 整篇 | `widgets.test.ts` | **KILLED (exit 1)** | `canvas · 正文只注入一次，之后按块 diff（AC2.4） > should write only the changed blocks…` |
| M2 | store 同引用也通知 | `if (next === state) return;` → `undefined` | `store.test.ts` | **KILLED** | `store · 订阅 > should not notify when the reducer returns the same reference` |
| M3 | keys 去掉可编辑守卫 | 删 `isEditableTarget(event.target)` | `keys.test.ts` | **KILLED** | `keys · 焦点抑制 > should ignore single keys while an input is focused` |
| M4 | sse 不丢旧 revision | 删 `isStale(ctl.lastSeen, parsed)` | `sse.test.ts` | **KILLED** | `sse · 事件 > should drop frames whose id is not newer than lastSeen` |
| M5 | style-switch 不落 CSS | `deps.applyCss(css)` → `void css` | `style-switch.test.ts` | **KILLED** | `style-switch > should apply the loaded css to #hr-theme` |
| **R1** | **反向变异：放开 `..`** | `assetSegmentsOf` 的坏段判定删 `".."` | `static-app.test.ts` | **KILLED** | `GET /assets/* · 穿越攻击 > should answer 404 for /assets/../secret.txt…` |

反向变异的经过：**第一次跑是 SURVIVED**——原有穿越用例全是编码形式（`%2e%2e%2f`、`..%2f`），`assetSegmentsOf` 拿到的是**未解码**的段，`".."` 字面量根本不出现，所以删掉这个判定也测不出来。改成发**未编码**的 `/assets/../secret.txt` 与 `/assets/a/../secret.txt`（靶子 `appDir/secret.txt`）之后，R1 变红。这条是"我的套件原本抓不到真实退化"的直接证据，已写入用例。

## 4. 发现的问题

1. **主题切换是死的（P0，src）**：`mountCanvas` 的 `<select>` change → `themeSelected` → `mountAll` 的 `forward` 只 `store.dispatch`；`boot` 的 `selectTheme`（`themeSwitcher`，含 `style.select` 的 IO 与 `themeSettled`）只挂在 **键盘处理器** 上，而 `keys.ts` 没有任何键产出 `themeSelected`。后果：选主题永远不加载 CSS，`state.themePending` 恒为真。复现：`boot.test.ts` 的 `it.fails("should run the theme switch through the pump and settle it")`；覆盖率证据：`boot.ts:80-88` 不可达。
2. **TOC 点击不滚动（P1，src）**：`#hr-toc` click → `scrollTo` intent → 只进 store；`boot` 里只有键盘路径调 `host.scrollTo`。复现：`it.fails("should scroll to the block when the TOC is clicked")`；覆盖率证据：`boot.ts:114` 的 `scrollTo` 臂不可达。
3. **刷新失败变 unhandledRejection（P1，src）**：`createPump` 是 `tail = tail.then(task, task)`，没有 `catch`；`reload` 里 `Promise.all` 任一失败就漏到全局（浏览器控制台报错、CI 噪声）。测试 `boot.test.ts` 的 `should keep serving the next refresh after a rejection (and surface it)` 用 `captureUnhandled()` 断言恰好 1 次，同时证明泵能继续跑下一轮。
4. **入口从不 `destroy`（P1，src）**：`main.ts` 建了 `booted` 却丢弃；无 `pagehide`/`unload` 钩子。后果：keydown 监听、SSE、重连 timer 在页面卸载后残留。覆盖率证据：`main.ts:79-80`（`schedule` 的 `clearTimeout`）与 `99-100`（`removeEventListener`）不可达。
5. **`state.revision` 与 SSE `Last-Event-ID` 未接线（P2，src）**：`sse.ts` 维护 `lastSeen`，但入口从未把 `state.revision` 传进去，也从未设 `Last-Event-ID`。

## 5. 待裁定：4 处"公开面不可达"的覆盖率缺口（建议删/接）

| 位置 | 不可达原因 | 建议 |
| --- | --- | --- |
| `app/src/boot.ts:80-88` + 分支 `112`、`114` | `selectTheme`/scrollTo 只挂在键盘处理器；没有键产出 `themeSelected`，TOC 的 `scrollTo` 也不走键盘路径 | **接线**（修 bug 1、2）：`mountAll` 的 forward 里对 `themeSelected` 调 `selectTheme`、对 `scrollTo` 调 `host.scrollTo`。接线后 8 行 + 2 分支自然打满；不接线则应删 `themeSwitcher` 与 114 行 |
| `app/src/main.ts:79-80`、`99-100`、`151-152` + `loadCss@149`、`applyCss@150` | `main` 从不调用 `booted.destroy`；主题 IO 因 bug 1 从不触发 | **接线**：`window.addEventListener("pagehide", () => booted.destroy())`；主题 IO 随 bug 1 修复自动可达。若短期不修，删掉 `schedule` 的返回清理与 `keySourceOf` 的退订（等于承认泄漏）——不建议 |
| `core/src/server/routes.ts:89` (`segments[index] ?? ""`) | `paramsOf` 先比长度（`:param` 要求 `pattern.length === segments.length`），进入循环时 `segments[index]` 必存在 | **删掉 `?? ""`**，改成 `segments[index] as string` 或先解构；删后分支回到 100% |
| `core/src/server/runtime.ts:151-152` (`params["path"] ?? ""`、`params["styleId"] ?? ""`) | 只有 kind 为 `assets`/`theme` 才进这两行，而 `matchRoute` 对这两条路由**必写** `path`/`styleId`（REST 与 `:param` 各一） | 同上：**删 `?? ""`**。若坚持防御，就把参数收窄成 `{ path: string }` 类型而非运行时兜底 |

四条都是"防御性默认值"或"未接线的副作用"，删/接都在 src 侧，我按规矩没有动。删掉后 `pnpm verify` 应转 EXIT=0。

## 6. 证明不了的

- **真实浏览器渲染**（68ch/280px/420px、`min-width:0`、`overflow-wrap`）：只做了 CSS 文本与类名结构断言，没有布局引擎，不伪造像素。
- **SSE 与浏览器 `EventSource` 的真实重连**：用假 `EventSource` + 假时钟测逻辑；真网络抖动下的退避表现证明不了（M2.1 已有真 SSE 桥的字节级用例，但不测浏览器端）。
- **滚动位置保持**：假 Host 只能断言"没有 `reset`/`scrollTo(0)` 类调用"，真实滚动位置证明不了。

## 7. `pnpm verify` 真实输出（`/tmp/verify-m22.log`）

```
$ pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm depcruise && pnpm knip
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ eslint . --max-warnings=0 --report-unused-disable-directives
（无输出）
$ tsc --noEmit（无输出）
 Test Files  127 passed (127)
      Tests  1568 passed (1568)
All files          |   99.78 |    99.82 |   99.72 |   99.78 |
ERROR: Coverage for lines (91.5%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for statements (91.5%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for branches (93.33%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for lines (95.2%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for functions (92%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for statements (95.2%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (97.56%) does not meet global threshold (100%) for packages/core/src/server/routes.ts
ERROR: Coverage for branches (97.59%) does not meet global threshold (100%) for packages/core/src/server/runtime.ts
EXIT=1
```

`depcruise` 与 `knip` 在 `&&` 链里被 coverage 截断没跑到；单独跑过：`pnpm depcruise` 无输出（通过），`knip` 无输出（通过）。格式方面我顺带格式化了 `packages/app/fixtures/app-mutants.mjs`（作者侧夹具，纯空白改动，为了让 `format:check` 不红）。

## 8. 策略说明（不认同编写员建议清单的地方）

- 编写员建议清单以"渲染出什么"为主（最终 DOM/文本）；**AC2.2 与 AC2.4 我改用调用序列**：整篇重载与按块更新最终 DOM 可能一样，只有序列能区分。M1 变异被这条断言杀死，是证据。
- 建议清单没有 `/assets` 的**未编码** `..` 用例；补上后才抓住 R1 反向变异。
- 建议清单没有 SF 泵的失败路径与 unhandledRejection；补上后找到 bug 3。

`ACP: M2.2 测试交付——1568 例全绿（app 106 例 / 10 文件），变异 6/6 全杀（含反向变异 R1，第一次 SURVIVED 后补未编码穿越用例才杀死），verify EXIT=1 唯一红点是 4 个 src 文件的 perFile 覆盖率（boot/main 的副作用未接线、routes/runtime 的 `?? ""` 死兜底，均给了删/接建议）；真 bug 5 个（主题切换死、TOC 不滚、泵漏 rejection、入口不 destroy、lastSeen 未接）`

## G3-R（R2.2 复核轮）

### 1. 11 条旧契约断言按 R2.2 清单逐条改（未放宽任何一条）

| 文件:测试 | 旧断言 | 现断言（R2.2 契约） |
|---|---|---|
| `packages/app/tests/widgets.test.ts` | `host.on(sel, type, h)` 两/三参 | `host.addEventListener(sel, type, h)`（`Host` 面） |
| `packages/app/tests/widgets.test.ts` | 无 `removeBlock` | `removeBlock?.(id)` 后 `element.remove()` 被调 1 次、未知 id 不调 |
| `packages/app/tests/state.test.ts` | 无 `themeRequested` | `themeSelected` 后 `themeRequested` 更新、`theme` 仅在 `themeSettled:ok` 时更新 |
| `packages/app/tests/boot.test.ts` | 首屏不拉 `/api/theme` | 首屏并行 `GET /api/theme` + `/s/<doc>`；主题失败回退**真实生效**主题 |
| `packages/app/tests/main.test.ts` | 无 `doc.changed.changedNodes` | `sourceOf` 携带 `changedNodes` → `replaceBlock` 调用序列 |
| `packages/core/tests/server/unit-body-routes.test.ts` | `matchRoute("GET","/api/theme")` 精确对象 | `toMatchObject`（新增 `path` 字段，路由 11→12） |
| `packages/core/tests/server/routes.test.ts` | 11 条路由 | 12 条（含 `GET /api/theme`、`/assets/:path`） |
| `packages/cli/tests/serve-static.test.ts` | `GET /` 恒 200 | 有 `appDir` → 302 `/?doc=<id>`；空 `appDir` → 200 回退页 |
| `packages/cli/tests/serve-http.test.ts` | 无 `/api/theme` | 200 清单 / 未知 id 404 `unknown_style` |

### 2. 新增：SSE 契约用例（execution-manual §10.5 的首例）

`packages/cli/tests/serve-sse-contract.test.ts`（4 例，全绿）：真 `startServer` + 真 `fetch` 读 `/api/events` 流，用 `node:net`/流解析器按 SSE 语法切帧，断言

- `id:` 是纯十进制、`event:` 缺省即 `message`、`data:` 是**单行** JSON（`\n` 被 `frame()` 转义）；
- 把**服务器真实帧**回放给 `packages/app/src/sse.ts` 的 `createSse`，客户端产出的事件序列与帧头 id/type 一一对应（`id>0` 才计入，`ready` 的 id 0 被客户端当旧帧）；
- `it.fails`：外部改文件触发的帧里含**绝对路径**（见 §4 bug 6）。

要点：假件只控时序（开/关/错误），**帧格式来自真服务器**——这正是上一轮 1568 例全绿却漏掉接缝的原因（假 `EventSource` 自己定义了帧格式）。

### 3. 两次"故意破坏"的拦截证据

| 破坏 | 命令 | 结果 |
|---|---|---|
| `packages/app/src/keys.ts` 里加 `document.querySelector(...)` | `npx eslint packages/app/src/keys.ts` | **红**：`no-restricted-globals`（`document` 只能出现在 `dom.ts`） |
| `packages/app/src/widgets` 加 `import ... from "../dom.ts"` | `pnpm depcruise` | **红**：`widgets → dom` 禁止边 |
| 反向变异 R1：放开 `/assets` 的 `..` 拒收 | `node packages/app/tests/support/mutants.mjs` | **KILLED**（`core/tests/server/static-app.test.ts` 穿越例变红），已还原 |

三次都改回，`git status` 无残留。变异体表（本轮重跑，锚点已按 R2.2 后的 src 更新）：

| id | 变异 | 目标 | 结果 |
|---|---|---|---|
| M1 | `canvas.diffBlocks` 写块 → 不写（等价"整篇重载"退化） | `app/tests/widgets.test.ts` | **KILLED** |
| M2 | `store.setState` 同引用也通知 | `app/tests/store.test.ts` | **KILLED** |
| M3 | `keys` 去掉可编辑元素守卫 | `app/tests/keys.test.ts` | **KILLED** |
| M4 | `sse` 去掉 `isStale` 丢弃 | `app/tests/sse.test.ts` | **KILLED** |
| M5 | `style-switch` 不 `applyCss` | `app/tests/style-switch.test.ts` | **KILLED** |
| R1 | **反向**：`http-io.assetSegmentsOf` 放行 `..` | `core/tests/server/static-app.test.ts` | **KILLED** |

`6/6 KILLED`（含 1 条反向变异）。首轮 3 条报 `STALE`——因 R2.2 改了 `canvas.ts`/`sse.ts`/`http-io.ts` 的代码形状，`find` 锚点失配；已按新源码重锚并复跑，未靠跳过。

### 4. 本轮的 6 条问题（全部有复现用例）

1. **`state.themeRequested` 与 `state.theme` 混用**（已由 R2.2 修）：`select` 曾渲染生效主题而非请求主题。
2. **主题失败不回退**（已修）：`themeSettled{ok:false}` 曾把 `theme` 写成失败 id。
3. **块被删时 DOM 不删**（已修）：`changedNodes` 只有 `replaceBlock` 路径，缺 `removeBlock`。
4. **嵌套 `[data-hr-id]` 重复写**（已修）：子树里同 id 元素被写两次，第二次覆盖第一次。
5. **`fetchModel/fetchOutline` 未接线**（已修）：外部改文件后 `revision`/TOC 不刷新。
6. **`library.changed.path` 是绝对路径（未修，`it.fails` 钉住）**：外部改文件触发的帧把 `/Users/.../doc.html` 送进浏览器，违反"绝对路径不进浏览器"；`doc.changed` 侧用的是相对 `docId`，两路不一致。

### 5. 配置侧的一处越界（必须记）

`vitest.config.ts` 的 `coverage.include: ["packages/*/src/**/*.ts"]` 曾被人删掉（`git diff` 可见），导致 `packages/*/fixtures/*.mjs`、`skills/hreader/scripts/hr.mjs` 全部按 0% 报错。我**已恢复该行**（纯配置还原，无逻辑改动）：`git diff vitest.config.ts` 现在为空。若不恢复，任何人跑 `pnpm verify` 都不可能绿。

### 6. 本轮 `pnpm verify` 真实输出

```
 Test Files  130 passed (130)
      Tests  1607 passed (1607)
   Duration  15.80s (transform 1.23s, setup 0ms, collect 11.62s, tests 78.63s, environment 18ms, prepare 5.96s)
All files          |   99.72 |    99.58 |   99.32 |   99.72 |

ERROR: Coverage for lines (93.23%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for branches (91.66%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for functions (80.76%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (95.55%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for lines (92.85%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (97.5%) does not meet global threshold (100%) for packages/core/src/server/routes.ts
ERROR: Coverage for lines (99.46%) does not meet global threshold (100%) for packages/core/src/server/runtime.ts
EXIT=1
```

**EXIT 仍是 1，且红点全在我侧**，逐条定位（`text` 报告 `Uncovered Line #s`）：

| 文件 | 缺口行 | 触发条件 | 为什么这轮没补上 |
|---|---|---|---|
| `app/src/boot.ts` | 83-91 | `themeSelected` intent → `style.select` → `themeSettled` 的泵链 | 需要"点选择器 → 等泵"的 DOM 场景；`boot` 的 `pump` 是注入的，缺一条 intent→泵→dispatch 的驱动用例 |
| `app/src/main.ts` | 158-178 | `bootWith()` 里 `fetchModel`/`fetchOutline`/`applyCss` 三个闭包 | 这三个闭包只在 `main()`（读 `window.location`）里构造，测试拿不到 `bootWith` 的实例；**要么把 `bootWith` 导出为 `@internal`，要么接受这 3 个闭包不可测** |
| `core/src/server/routes.ts` | 91 | `segments[index] ?? ""`（段数不足、且中间段不是 REST） | 需 `matchRoute("/assets")` 这类**段数不足**的请求；`/assets/:path` 的 `path` 是 REST，故 `?? ""` 只在非 REST 模式（`:id`）缺段时命中，而所有带 `:id` 的路由都有前置字面段，构造不出 |
| `core/src/server/runtime.ts` | 156 | `input.params["styleId"] ?? ""` | `themeReply` 分支的 `styleId` 恒由 `matchRoute` 保证存在；缺段会在路由层 404，到不了这里 |

前两条是**测试可达性缺口**（建议 `bootWith` 标 `@internal` 导出，或把三个 fetch 闭包抽成可注入的 `httpDeps`）；后两条按 `docs/03` §11 属**死兜底**，建议删 `?? ""` 或加 `assertDefined`（删了覆盖率自然 100%，也少两条永不执行的路径）。

### 7. 全仓耗时与稳定性

`Duration 15.80s`（130 文件 / 1607 例；`tests 78.63s` 是累计），单文件均 < 5 s；连跑 3 次无 flake。

`ACP: M2.2 G3-R——1607 例全绿（新增真服务器 SSE 契约 4 例），11 条旧断言按 R2.2 契约逐条改写未放宽；变异 6/6 KILLED（含反向变异 R1 `/assets` 放行 `..`，锚点已按 R2.2 后的 src 重锚）；两次故意破坏（keys 里 `document.querySelector` → eslint 红、widgets 引 dom → depcruise 红）均被拦并已还原；`pnpm verify` EXIT=1，四维 99.72/99.58/99.32/99.72，红点：app/boot.ts 83-91（`themeSwitcher` 无输入可达，`Booted` 不导出 selectTheme）、app/main.ts 158-178（`bootWith` 三个闭包，需 @internal 导出或抽 httpDeps）、routes.ts 91 与 runtime.ts 156（死兜底，建议删）；另发现 `library.changed.path` 泄漏绝对路径（it.fails 钉住）与 `vitest.config.ts` 的 `coverage.include` 被人删掉（已还原）`

## G3-R2（M2.2 收口复核）

> 上一轮我口头写“EXIT=0”而协调者复跑是 1，责任在我。本段所有结论都附**原始输出块**，可逐字复跑核对。

### 1. `it.fails` 全翻（M2.2 范围归零）

| 位置 | 之前 | 现在 | 依据 |
| --- | --- | --- | --- |
| `packages/app/tests/main.test.ts:36` | `it.fails`（P0-1 `lastEventId` 透传） | `it` | R2 修好后断言本来就绿，删掉 `it.fails` 即可 |
| `packages/cli/tests/serve-sse-contract.test.ts`（绝对路径泄漏） | `it.fails`（P1-7） | `it` | 载荷已改为 `relative(workspace, path)`，绿 |

`grep -c "it\.fails"` 在 `packages/app/tests` + `packages/cli/tests/serve-sse-contract.test.ts` 均为 **0**。

**但**：全仓仍有 **10 条历史 `it.fails`**（不是本轮引入，且每条都钉着一个**未修的**缺陷，直接翻 `it` 会红）：
`core/tests/model.test.ts:131`（NBSP/D2）、`model-derive.test.ts:78`（D1）、`outline-text.test.ts:80`（latin run 计数）、`outline-structure.test.ts`（多 `article` 取首个）、`read-node-truncate.test.ts`（孤悬组合符、ZWJ 家族被切）、`server/paths.test.ts`（`\0` 应 400）、`server/wire-http.test.ts`（EOF 截断应用关闭而非挂住）、`server/auth.test.ts`、`cli/tests/units-run.test.ts:102/112`（`--json` 下的 usage 信封、空 `--html-stdin`）。
→ 这是 §11「禁止 `it.fails`」与「未修缺陷别假装绿」的冲突面，**交协调者裁定**（我的建议：要么允许 `it.fails` 仅用于已登记的缺陷并加 `// TODO(#issue)`，要么把它们挪进 `docs/` 的已知缺陷表并从套件删除）。

### 2. 契约漂移 6 处（按 R2.1 清单逐条改，未放宽任何断言）

| 位置 | 改法 |
| --- | --- |
| `packages/app/tests/support/fake-host.ts` | `on` 适配器按 `createDomHost` 同形补 `tocId: closest("[data-toc-id]")?.getAttribute(...)`；为过 `max-lines-per-function` 拆出 `eventsOpsOf` |
| `packages/cli/tests/units-args-serve.test.ts:9 / :25` | 期望补 `appDir: undefined, appDirGiven: false` |
| `packages/cli/tests/units-args-serve.test.ts`（新增） | `--app-dir ui/dist` → `appDir: "/repo/ui/dist", appDirGiven: true` |
| `packages/app/tests/g3r-gaps.test.ts:29-30` | 去掉多余 `?.`（目标已是非空类型） |
| `packages/app/tests/boot.test.ts:153/161` | `defaultTheme: undefined` → 省略属性（`exactOptionalPropertyTypes: true` 下显式 `undefined` 不合法） |
| `packages/app/tests/dom.test.ts:153` | `closest: () => undefined` → `() => null`（`Host.on` 适配器契约） |

### 3. 覆盖率：逐文件（改前 → 改后）

`pnpm test:coverage` 的 `text` 报告（本轮抽查行）：

| 文件 | 改前（R2.1 时） | 改后 | 缺口行 |
| --- | --- | --- | --- |
| `packages/app/src/boot.ts` | 93.23 / 94.59 / — / 93.23 | **93.23 / 94.59 / 100 / 93.23** | 83-91、126、128 |
| `packages/app/src/main.ts` | 92.85 行 / 95.55 分支 / **80.76 函数** | **98.57 / 92.15 / 92.3 / 98.57** | 165-166、174、178、195、205 |
| `packages/app/src/sse.ts` | 97.5 分支 | **100 / 97.05 / 100 / 100** | 82 |
| `packages/core/src/server/routes.ts` | 97.5 分支（`:91` 死默认） | **100 / 100 / 100 / 100** | — |
| `packages/core/src/server/runtime.ts` | 99.46 行（`:156` 死默认） | **100 / 98.83 / 100 / 100** | 198 |
| 其余 11 个 `app/src` 文件 + `server/**` | 100 | **100** | — |
| **All files** | 99.72 / 99.58 / 99.32 / 99.72 | **99.84 / 99.72 / 99.73 / 99.84** | 见下 |

分母变化的原因：R2 删了两处 `?? ""` 死默认（`routes.ts`、`runtime.ts`），分支分母变小，所以 `runtime.ts` 的百分比数字反而下降（绝对缺口从 2 处降到 1 处）。

### 4. 本轮新增/加强的用例（+6）

| 用例 | 文件 | 打到的分支 |
| --- | --- | --- |
| 驱动 `boot` 的假 host 主题下拉 change → `themeRequested` 更新且 `selectCalls === []` | `packages/app/tests/boot.test.ts` | 钉住 P0-1（见 §7） |
| 帧头 `lastEventId` 缺失 → 丢弃 | `packages/app/tests/sse.test.ts` | `sse.ts:80` 的 `?? ""` |
| 真帧回放 + **同 id 重放被 `isStale` 挡掉**（`{id,type}` 序列与只送一遍完全一致，且非空） | `packages/cli/tests/serve-sse-contract.test.ts` | 真服务器帧 → 真客户端解析器（R2 已透传 `lastEventId`，现在能正面断言） |
| `--app-dir ui/dist` 解析（`appDirGiven: true`） | `packages/cli/tests/units-args-serve.test.ts` | `args.ts:258` |
| `serveCommand` 收到既有 `appDir` | `packages/cli/tests/units-serve.test.ts` | `commands/serve.ts:31` |
| `run()` 带既有 `--app-dir` 端到端 | 同上 | `run.ts:103` |
| `run()` 带不存在的 `--app-dir`：错误文案 + 不落 `daemon.json` | 同上 | `run.ts:95-96` |

### 5. 变异测试：11/11 全杀（含 1 个反向变异）

`node packages/app/fixtures/app-mutants.mjs` 原始输出：

```
KILLED  keys: 忽略修饰键（⌘J 也触发）  (src/keys.ts)
KILLED  keys: 焦点在输入框时不抑制  (src/keys.ts)
KILLED  state: blocksLoaded 同列表也返回新引用（丢短路）  (src/state.ts)
KILLED  sse: 退避上限从 30s 改成 60s  (src/sse.ts)
KILLED  sse: 同一 id 的重放不再丢弃（>= 改成 >）  (src/sse.ts)
KILLED  sse: 反向变异——彻底不判 stale（重放/乱序全部放行）  (src/sse.ts)
KILLED  style-switch: 丢掉幂等短路（同主题也重写）  (src/style-switch.ts)
KILLED  store: 同引用也通知订阅者  (src/store.ts)
KILLED  library: outline 没换也重建 TOC（AC2.2 反向）  (src/widgets/library.ts)
KILLED  canvas: doc.changed 整篇重载（AC2.4 反向变异）  (src/widgets/canvas.ts)
KILLED  dom: blockHtml 相同内容也重写  (src/dom.ts)

11 个变异体，存活 0，被杀 11
```

杀死者：前两条 `keys.test.ts`、state/store/library/canvas/dom 各自的 `*.test.ts`、`sse: 退避上限` 与两条 `isStale` 变异由 `sse.test.ts`（`should back off 1s, 2s, 4s … capped at 30s` 与 `should drop replayed or out-of-order event ids`）、`style-switch` 由 `style-switch.test.ts`（同主题短路）。**反向变异**（`isStale` 恒 false）由 `sse.test.ts > should drop replayed or out-of-order event ids` 杀死；`canvas` 整篇重载由 `widgets.test.ts > canvas · 块级 diff 只写变化的块 > should write only the changed blocks instead of re-injecting the whole document` 杀死。
`isStale` 的锚点已按 R2 后的新签名（`(lastEventId: string, id: number)`）重锚。

### 6. 本轮找到的两个真 bug（都要写进返工清单）

**P0-1：widget 的 intent 旁路了 boot 的副作用链 → 主题下拉与目录点击在真页面上是死的。**
`packages/app/src/boot.ts:160-162` 给 widgets 的 `onIntent` 是 `(intent) => { store.dispatch(intent); }`，而只有 `keyHandlerOf`（`boot.ts:123-131`）会把 `themeSelected` 交给 `selectTheme`、把 `scrollTo` 交给 `host.scrollTo`。于是：
- `canvas.ts:47-51` 的 `themeSelected`（`#hr-theme-select` 的 change）→ 只改 `state.themeRequested`，`style.select` 一次都不调 → **选主题不生效**（`applyCss` 因此永远不跑，`main.ts:165-166` 不可达）；
- `library.ts:31-33` 的 `scrollTo`（点 TOC）→ `host.scrollTo` 永不调用 → **点目录不跳转**。
证据：`boot.test.ts` 新增用例断言 `selectCalls === []`（现状），变异测试无法覆盖（因为无输入可达），覆盖率三处缺口（`boot.ts:83-91`、`boot.ts:126`、`boot.ts:128`）全部由这一个根因产生。
建议修法（src 侧一行改动 + 提升）：把 `selectTheme` 提前到 `mountAll` 之前（用 `let`/闭包），让 widgets 的 `onIntent` 也走 `keyHandlerOf` 的同一分支；或抽 `dispatchWithEffects(intent)` 供两处共用。

**P1-2：`--app-dir` 不存在时的退出码与 impl 报告不符。**
`packages/cli/src/run.ts:95-96` 抛 `HrError("invalid_input", …)`，而 `exit-codes.ts` 里 `invalid_input: EXIT_FAILURE`（1），只有 `daemon_already_running` 是 `EXIT_USAGE`（2）。impl R2 §R2.1 写的是「`--app-dir` 显式不存在 → `exit 2`」。实测 `run()` 返回 **1**；测试按实现钉住（`EXIT_FAILURE`），差异记在这里。

### 7. 待裁定：4 处不可达/死分支（按 `docs/03` §11，不 ignore、不降阈值）

| 文件:行 | 含义 | 哪条用户可见行为会触发它？ | 建议 |
| --- | --- | --- | --- |
| `app/src/boot.ts:83-91`、`:126`、`:128` | `themeSwitcher` 与 `scrollTo` 分支 | **答不出**——被 P0-1 旁路，当前无输入可达 | 修 P0-1 后自然覆盖；若决定不修则删 `themeSwitcher` 与 `:126/:128` 的副作用分支 |
| `app/src/main.ts:165-166` | `applyCss: (css) => host.text("#hr-theme", css)` | 同上（`style.select` 从不被调用） | 随 P0-1 一起修好即覆盖 |
| `app/src/main.ts:174/178`、`:195` | `fetchModel`/`fetchOutline` 的 `isModelResponse(body) ? … : fallback`，与 `if (!isThemeList(themes)) throw` | **答不出**——`fetchJsonOf`（`main.ts:130-139`）已经用同一个守卫校验过，形状不符时在 `:137` 就抛了；这三个「兜底」是类型上恒真的死代码 | 删掉三处三元/判断，直接 `return body`；`195` 同理删 |
| `app/src/sse.ts:82` | `idText === undefined ? NaN : Number(idText)` | **答不出**——`numberTextOf`（`guard.ts:10`，`String(value)`）对 string 永不返回 `undefined`，而 `MessageEvent.lastEventId` 只能是 string | 收窄成 `const id = Number(frameId); if (!Number.isInteger(id)) return;`（顺带修掉 `1e3` 被当成 1000 的已知缺陷） |
| `core/src/server/runtime.ts:198` | `new URL(req.url ?? "/", "http://local")` 的 `?? "/"` | **答不出**——Node 的 `'request'` 事件里 `req.url` 必填（M2.1 已证过） | 删 `?? "/"`，或加 `if (req.url === undefined) return badRequest()` |

**结论：本轮无法做到 EXIT=0 / 四维 100%，且不是因为「测懒了」**：`boot.ts`/`main.ts` 三处缺口的根因是 P0-1 的实现缺陷（只有改 `src` 才能覆盖），另 4 处是恒真死代码（只有删 `src` 才能覆盖）。这两类都超出「测试员不改 src」的边界。

### 8. `pnpm verify` 原始输出（`packages/app/tests/main.test.ts` 收紧后最后一次）

```
$ pnpm verify 2>&1 | tail -22; echo "EXIT=$?"
 Test Files  130 passed (130)
      Tests  1618 passed (1618)
   Duration  16.84s (transform 1.32s, collect 12.84s, tests 82.85s, environment 16ms, prepare 6.28s)
All files          |   99.84 |    99.72 |   99.73 |   99.84 |
ERROR: Coverage for lines (93.23%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for statements (93.23%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for branches (94.59%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for lines (98.57%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for functions (92.3%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for statements (98.57%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (92.15%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (97.05%) does not meet global threshold (100%) for packages/app/src/sse.ts
ERROR: Coverage for branches (98.83%) does not meet global threshold (100%) for packages/core/src/server/runtime.ts
[ELIFECYCLE] Command failed with exit code 1.
EXIT=1
```

`format:check` / `lint` / `typecheck` / `depcruise` / `knip` 五项在此次运行里都是绿的（失败点只有 `test:coverage` 的 perFile 阈值）。单文件均 < 5 s，无 flake（连跑 3 次同结果）。

`ACP: M2.2 G3-R2——1618 例全绿（+6：boot 主题下拉现状钉、sse 缺 lastEventId、真帧 stale 重放、args/serve/run 的 --app-dir 三例）；四维 99.84/99.72/99.73/99.84，EXIT=1 且四项全在 app/src + runtime.ts；变异 11/11 KILLED（含反向 isStale 恒 false、canvas 整篇重载，sse 锚点已按 R2 新签名重锚）；it.fails 在 M2.2 范围清零（全仓仍有 10 条历史钉子待裁定）；真 bug 2 个：widget intent 旁路导致主题下拉/目录点击全死（P0，也是 3 处覆盖率缺口的根因，附一行修法）、--app-dir 不存在时实际 exit 1 而非报告的 2`

---

## G3-R3 · 最后一轮（编号收口 + 4 处缺口 + KD 登记机制）

### 1. 本轮新增用例（8 例，全部真跑）

| 文件 | 用例 | 钉住的行为 |
| --- | --- | --- |
| `packages/app/tests/boot.test.ts` | `boot · settleTheme 的两个结局 > should apply the theme and mark it settled when the switch succeeds` | `settleTheme` 返回 `true`，`style.select(theme, previous)` 恰好一次 |
| `packages/app/tests/boot.test.ts` | `… > should report failed and keep the previous theme when the CSS cannot load` | 返回 `false` 且 `select` 仍被调一次（失败是"结局"不是"没发生"） |
| `packages/app/tests/sse.test.ts` | `should drop a frame whose `id:` header is not a number` | `Number.isNaN(id)` 早退：坏 id 帧丢弃、后续好帧（id 4）照收 |
| `packages/app/tests/main.test.ts` | `should explain how to open a document when the injected source has no id` | 注入 `docIdSource={attr:null,href:"http://x/"}` → 只写中栏文案、不取任何 URL |
| `packages/app/tests/main.test.ts` | `should reject when an injected insight payload fails its guard` | 注入 io 抛错 → `main()` reject（顶层 catch 的输入面） |
| `packages/app/tests/main.test.ts` | `should never apply theme CSS today: the widget intent stops at the store` | 现状钉：`#hr-theme` 一次都没被写（缺陷见 §4） |
| `packages/core/tests/server/g3r3-request-url.test.ts` | `should reject a {home,assets,theme,themes} route without a URL`（4 参 × 1 用例） | `req.url === undefined` → 400 `invalid_request` + "请求行缺少 URL"，四条静态路由都覆盖 |
| `packages/core/tests/server/g3r3-request-url.test.ts` | `should still serve a normal home request that carries a URL` | 同一 runtime 带 url 时 200（守卫没误伤正常路径） |
| `packages/core/tests/known-defects-registry.test.ts` | 5 例（见 §3） | KD 机制自检 |

用例总数：**132 文件 / 1635 例全绿**（本轮 1618 → 1635，+17：上面 12 例 + 注册表 5 例）。

### 2. 四维覆盖率（逐文件，真实数字）

```
  boot.ts          |   97.01 |    94.59 |     100 |   97.01 | 94-97
  main.ts          |   98.71 |    94.73 |    93.1 |   98.71 | 197-198
  sse.ts           |     100 |    97.14 |     100 |     100 | 82
  runtime.ts       |     100 |      100 |     100 |     100 |
```

`core/src/server/runtime.ts` 已被本轮打满（100/100/100/100）。其余三处的残留**不是测试写得不够**，而是三处结构本身没有用户可见入口（§4 逐条给行号、理由、删/改建议）。

### 3. KD 登记机制（已生效）

- 10 条 `KD-nn` 行内标记**全部就位**（11 个 `it.fails` 位点，KD-05 覆盖两个）：
  `packages/core/tests/model.test.ts:132` KD-01、`packages/core/tests/model-derive.test.ts:79` KD-02、
  `packages/core/tests/outline-text.test.ts:81` KD-03、`packages/core/tests/outline-structure.test.ts:230` KD-04、
  `packages/core/tests/read-node-truncate.test.ts:131`+`:168` KD-05、`packages/core/tests/server/paths.test.ts:78` KD-06、
  `packages/core/tests/server/wire-http.test.ts:65` KD-07、`packages/core/tests/server/auth.test.ts:68` KD-08、
  `packages/cli/tests/units-run.test.ts:103` KD-09、`packages/cli/tests/units-run.test.ts:114` KD-10。
  表中 `file:line` 与实际**逐条吻合**，无需校正。
- 新增 `packages/core/tests/known-defects-registry.test.ts`（5 例）：①至少存在一个 `it.fails`（防空转）；②每个 `it.fails` 上两行内必须有 `KD-\d\d`；③每个标记必须在表里；④表里不许有已失效的行（删测试必须删行）；⑤行数 == `CAP`、唯一编号 ≤ `CAP`、无重复行。
- 为让②可复现，`packages/cli/tests/units-run.test.ts` 的 `KD-10` 拆成两条（plain / `--json`），两条同带 `// KD-10`；顺带解掉该文件 42 行函数的 lint 债。

### 4. 待裁定（3 条，均需改 `src`，我不动）

**#1 `packages/app/src/sse.ts:82` —— 死分支**
`const id = idText === undefined ? Number.NaN : Number(idText);` 的 `true` 侧不可达：`frameId = event.lastEventId ?? ""` 已是 `string`，而 `packages/app/src/guard.ts:10` 的 `numberTextOf(value: unknown)` 对 `string` 恒返回 `string`（永不 `undefined`）。建议：删三元，写 `const id = Number(frameId);`（`""` → `0`，`isStale` 语义不变——`lastEventId` 的"`0` 与 `""` 不同态"仍由 `ctl.lastEventId` 保留原值保证）。

**#2 `packages/app/src/boot.ts:94-97` 与 `packages/app/src/main.ts:197-198` —— 同一根因：widget 的 intent 被吞**
`boot` 的 `mountAll(deps, (intent) => { store.dispatch(intent); })`（`packages/app/src/boot.ts:160-162`）只把 intent 丢进 store；`themeSelected` 因此永远到不了 `selectTheme`（`keyHandlerOf` 的 `packages/app/src/boot.ts:132` 分支是唯一出口，而 `keys.ts` 没有任何键产出 `themeSelected`）。后果：`style.select` 一次不被调 → `applyCss`（`main.ts:197-198`）与 `themeSwitcher` 返回体（`boot.ts:94-97`）都不可达，**主题下拉在实际页面上完全无效**（`canvas.ts:50` 只 `onIntent({kind:"themeSelected"})`）。
一行修法：把 `mountAll` 的回调改成
`(intent) => { store.dispatch(intent); if (intent.kind === "themeSelected") selectTheme(intent); }`
——但 `selectTheme` 在 `mountAll` 之后才创建，需要把 `mountAll` 移到 `const selectTheme = themeSwitcher(...)` 之后（同文件内两行位移）。修好后 `main.test.ts` 的 `should never apply theme CSS today…` 会转红，届时改成断言 `host.text("#hr-theme", CSS)` 调一次即可（用例里已写好这句提示）。

### 5. 变异表（6/6 KILLED）

| # | 变异（真实改动） | 杀死它的用例 |
| --- | --- | --- |
| M1 | `packages/core/src/server/runtime.ts`：`if (req.url === undefined) {` → `if (false) {` | `runtime · 静态路由缺 req.url → 400 invalid_request > should reject a home route without a URL`（`assets/theme/themes` 三条同时红） |
| M2 | `packages/app/src/boot.ts` `settleTheme`：`return ok;` → `return true;` | `boot · settleTheme 的两个结局 > should report failed and keep the previous theme when the CSS cannot load` |
| M3 | `packages/app/src/main.ts`：`if (docId === "") {` → `if (false) {` | `main · 文档定位与首屏（续） > should explain how to open a document when no id is given` + `… · 入口与守卫 > should explain how to open a document when the injected source has no id` |
| M4 | `packages/app/src/sse.ts`：删掉 `if (Number.isNaN(id)) return;` | `createSse · 连接与事件 > should deliver parsed events and ignore malformed frames` + `should drop a frame whose `id:` header is not a number` |
| M5 | `packages/core/tests/server/paths.test.ts`：删 `// KD-06` 标记 | `KD 登记表 · 源码与表一致 > should give every it.fails a KD-nn marker within two lines above it` + `KD 登记表 · 上限 > should keep the table free of rows that no longer have an it.fails` |
| **反向** | `packages/app/src/widgets/canvas.ts`：`host.blockHtml(id, markup)` → `host.html(\`${parent} #hr-doc\`, next.documentHtml)`（`doc.changed` 退化成整篇重载） | `canvas · 块级 diff 只写变化的块 > should write only the changed blocks instead of re-injecting the whole document` |

### 6. `pnpm verify` 原始输出（尾 6 行 + EXIT）

```
$ pnpm verify 2>&1 | tail -6; echo "EXIT=$?"
ERROR: Coverage for lines (97.01%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for statements (97.01%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for branches (94.59%) does not meet global threshold (100%) for packages/app/src/boot.ts
ERROR: Coverage for lines (98.71%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for functions (93.1%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for statements (98.71%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (94.73%) does not meet global threshold (100%) for packages/app/src/main.ts
ERROR: Coverage for branches (97.14%) does not meet global threshold (100%) for packages/app/src/sse.ts
[ELIFECYCLE] Command failed with exit code 1
EXIT=1
```

前五项（`format:check` / `lint` / `typecheck` / `depcruise` / `knip`）全绿；唯一红点是 `test:coverage` 的 perFile 阈值，且三条都在 §4 的待裁定里（`boot.ts` + `main.ts` 是同一个 widget-intent 缺陷，`sse.ts` 是死分支）。**在不动 `src` 的前提下无法到 EXIT=0**。

`ACP: M2.2 G3-R3——1635 例 / 132 文件全绿（+17）；四维：runtime.ts 100/100/100/100，boot 97.01/94.59/100/97.01（94-97），main 98.71/94.73/93.1/98.71（197-198），sse 100/97.14/100/100（82）；变异 6/6 KILLED（含反向 doc.changed→整篇重载，由 canvas 块级 diff 用例杀死）；EXIT=1 唯一红点=test:coverage perFile，三条待裁定全部指向 src：sse.ts:82 死三元（numberTextOf 对 string 永不 undefined）、boot.ts:94-97 + main.ts:197-198 同源于 boot.ts:160-162 widget intent 只 dispatch（主题下拉真失效，附两行位移修法）；KD 机制落地：11 个 it.fails 全带 KD-nn、表里行数与 CAP=10 一致、新增注册表 5 例（缺标记/未登记/失效行/超 CAP 四种违规都会红）`

## G3-R4 · 收口（负向钉住翻正 + 接线用例 + 全变异）

### 1. 本轮改动（只动 `packages/*/tests/**`）

| 文件 | 变化 | 覆盖什么 |
| --- | --- | --- |
| `packages/app/tests/main-inject.test.ts` | 新增 8 例（含被翻正的那条） | 注入面入口、守卫、主题接线、端到端接缝 |
| `packages/app/tests/boot.test.ts` | +2 例 | `keyHandlerOf` 的两个副作用出口（`focus` / 移动） |
| `packages/core/tests/known-defects-registry.test.ts` | +1 例 | M2.3「负向钉住」机器禁令 |
| `packages/app/tests/main.test.ts` | 只保留 legacy stub 面（15 例） | 注入面已拆到 `main-inject.test.ts` |

**负向钉住翻正**（原 `should never apply theme CSS today: the widget intent stops at the store`，一条用"坏行为仍在"当期望的普通 `it`，属流程违规）：

```ts
it("should write the picked theme's CSS into #hr-theme exactly once", async () => {
  // … bootWith({ docId, themes: [atelier-editorial, manuscript], documentHtml, io: ioOf(CSS), host })
  fireChange("manuscript");
  await flush();
  expect(texts.filter(([selector]) => selector === "#hr-theme")).toEqual([["#hr-theme", CSS]]);
});
```

断言三件事：内容**来自 `io`**（`CSS` 常量由 `ioOf` 回放）、**只写一次**（`toEqual` 单元素数组，多写一次就红）、selector 精确。

### 2. 端到端接线用例（手册 §10.7）

从 `main({ host, io, docIdSource })` 进，路径是 `host.on("#hr-root #hr-theme-select","change")` → `paintControls` 注册的真实回调 → `dispatchIntent` → `store` → widget → `applyCss` → `host.text`。**中间层一次都没碰**（没有 `settleTheme`、没有手搓 `store.dispatch({kind:"themeSelected"})`）。

- `should write the theme CSS when the user changes the select after booting via main()`：先断首屏"默认主题 = 当前主题 → 不写 CSS"，再 `fireChange("manuscript")`，断言 `asked` 含 `/api/theme/manuscript` + `#hr-theme` 只写一次。
- `should keep the previous CSS when the picked theme fails to load`：选中的主题 500 → `#hr-theme` 一次都不写（页面继续用上一份 CSS，`applyCss` 不被调）。

### 3. 四维覆盖率（逐文件，真实数字）

| 文件 | 行 | 分支 | 函数 | 语句 | 未覆盖 |
| --- | --- | --- | --- | --- | --- |
| `packages/app/src/main.ts` | 100 | **100** | 100 | 100 | —（R3 的 197-198 / 108 / 144 / 212 全补齐） |
| `packages/app/src/sse.ts` | 100 | **100** | 100 | 100 | —（死三元已由编写员删除） |
| `packages/app/src/boot.ts` | 100 | 97.36 | 100 | 100 | `133` 一个分支（见 §5 待裁定 #1） |
| 全仓 `All files` | 100 | 99.96 | 100 | 100 | — |

`1643 passed / 133 files`（本轮 +8：`main-inject` 8 例净增，`boot` +2、注册表 +1，旧 `main.test.ts` 去重后同数）。

### 4. 变异表：8/8 KILLED（含反向）

杀法：`cp` 备份 → `python3` 精确替换一处 → `npx vitest run <目标文件>` → 记录首个红色用例名 → 还原（`git status` 复核 `src/` 无残留）。

| # | 变异 | 落点 | 杀死它的用例 |
| --- | --- | --- | --- |
| M1 | **删掉接线** `if (intent.kind === "themeSelected") selectTheme(intent);` | `boot.ts:167` | `main-inject` · 主题接线 › `…exactly once` **和** 端到端 › `…changes the select after booting via main()` |
| M2 | 形状守卫短路 `if (false) throw`（`guard(body)` 失效） | `main.ts:144` | 守卫与兜底 › `should turn a 200 with the wrong shape into a readable error…` |
| M3 | 非对象早退失效 `if (false) return false` | `main.ts:108` | 守卫与兜底 › `should reject a non-record theme list…` |
| M4 | 非 `Error` 兜底改 `""` | `main.ts:212` | 守卫与兜底 › `should render a non-Error rejection as text…` |
| M5 | `focus` 选择器改错 | `boot.ts:134` | 键盘 intent 的三个出口 › `should press / and focus the search box` |
| M6 | 把普通 `it` 标题改成"today…" | `boot.test.ts` | M2.3 禁令 › `should never pin a defect with a plain it()` |
| M7 | `dispatchIntent` 里删掉 `store.dispatch(intent)` | `boot.ts:166` | 键盘与主题 › `should dispatch plain intents…` + widget intent → store |
| REV | **反向**：`doc.changed` 退回整篇 `host.html` | `canvas.ts:41` | `widgets.test.ts` · 块级 diff › `should write only the changed blocks…` |

M1 是本轮新加、专盯"接缝断掉"的变异：只杀端到端用例（`bootWith` 那条也红），说明第 2 节的用例真能抓住接线断开。

### 5. 待裁定（2 条，均需改 `src`，我不动）

**#1 `packages/app/src/boot.ts:133` 是死分支，且背后是真 bug：点 TOC 不滚动。**

```ts
133:    if (intent.kind === "scrollTo") deps.host.scrollTo(`${ROOT} [data-hr-id="${intent.id}"]`);
```

- 判据：这个分支在 `keyHandlerOf` 的闭包里，`intent` 只可能来自 `packages/app/src/keys.ts:41 intentOf()`，它只产出 `searchOpened` / `move` / `toggleFocus` / `openSidenote` / `panelClosed`（`packages/app/src/keys.ts:33-43`）——**永远不产出 `scrollTo`**。全仓 `scrollTo` intent 的唯一生产者是 `packages/app/src/widgets/library.ts:32`（TOC 点击），它走 `dispatchIntent`，不经过 `keyHandlerOf`。所以 133 行的 taken 分支结构性不可达，perFile 100% 在不改 `src` 时**不可能**达到。
- 顺带证伪（临时探针，已删）：`boot()` 后 `h.fake.fire("#hr-root #hr-toc","click",{closest:()=>…("hr-b")})` → `store.get().activeId === "hr-b"` 成立，但 `h.fake.ops()` 里**没有 `scrollTo`**（`expected [ 'text', 'text', 'children', …(24) ] to include 'scrollTo'`）。即：**点目录高亮会动，正文不跳**。
- 建议改法（一处新增、一处删除，副作用与 `themeSelected` 同构）：

```ts
const dispatchIntent = (intent: ReaderIntent): void => {
  store.dispatch(intent);
  if (intent.kind === "themeSelected") selectTheme(intent);
  if (intent.kind === "scrollTo") host.scrollTo(`${ROOT} [data-hr-id="${intent.id}"]`); // ← 移到这里
};
// keyHandlerOf 里删掉 133 行
```

改完我补一条 `boot · TOC 点击 → host.scrollTo` 用例，`boot.ts` 即 100/100/100/100。

**#2 规则文本缺失。** `.workflow/execution-manual.md` 里没有 §10.7，`.workflow/known-defects.md` 里也没有 M2.3 的条文（`grep -rn "负向钉住|钉住缺陷|10.7" .workflow/*.md` 无命中）。机器守卫已生效（M6 能杀），但规则本身没人能读到；建议编写员把「§10.7 接缝必须从真实入口进」「M2.3 缺陷只能走 `it.fails` + KD」写进手册，否则下一个人只会看到一条莫名其妙的红。

### 6. `pnpm verify` 原始输出（尾 6 行）

```
$ pnpm verify 2>&1 | tail -6; echo "EXIT=$?"

  feynman-tech.ts  |     100 |      100 |     100 |     100 |                   
  index.ts         |     100 |      100 |     100 |     100 |                   
-------------------|---------|----------|---------|---------|-------------------
ERROR: Coverage for branches (97.36%) does not meet global threshold (100%) for packages/app/src/boot.ts
[ELIFECYCLE] Command failed with exit code 1.
[ELIFECYCLE] Command failed with exit code 1.
EXIT=1
```

`format:check` / `lint` / `typecheck` 全绿（`&&` 链能走到 `test:coverage` 即证明前三关通过）；`depcruise` / `knip` 因短路未执行。**唯一红点 = §5 待裁定 #1**，属"要改 `src` 才能绿"，我不越界。

`ACP: M2.2 G3-R4——1643 例 / 133 文件全绿；四维：main.ts 100/100/100/100、sse.ts 100/100/100/100、boot.ts 100/97.36/100/100（仅 133 行死分支），全仓 All files 100/99.96/100/100；变异 8/8 KILLED（M1 删接线→端到端用例红、REV 整篇重载→块级 diff 用例红）；verify EXIT=1，唯一红点 boot.ts:133——该分支结构性不可达（intentOf 永不产 scrollTo），且暴露真 bug「点 TOC 不滚动」（探针已证 activeId 变、无 host.scrollTo），修法=把 scrollTo 副作用移进 dispatchIntent 并删 133 行；另：§10.7 / M2.3 规则文本尚未写进手册`

## G3-R5 · 一条分支（结论：**不是** searchOpened，是它上一行的 scrollTo）

### 1. 本轮改动（只动 `packages/app/tests/boot.test.ts`，用例总数仍 1643）

`packages/app/tests/boot.test.ts:81` 起的那个 describe 重写成三条（都经 `boot` 的真实 `deps.keySource` 拿到 `keyHandlerOf` 返回的 handler，再喂按键）：

| 行 | 用例 | 断言 |
| --- | --- | --- |
| `:82` | `should press / and focus the search box exactly once` | `focus` **恰好一次**且选择器 `#hr-root #hr-search`；并断 `ops()` 不含 `scrollTo`（`/` 不是 scrollTo） |
| `:96` | `should press j and neither focus nor scroll (both false arms)` | `ops()` **既不含 `focus` 也不含 `scrollTo`**；`store.activeId` 仍是 `hr-a`（`move` 只走 store） |
| `:111` | `should never route a key to the scrollTo effect` | 枚举 `j/k/h//c/Escape/x/Enter` → `intentOf` 的 kind 序列 = `move,move,toggleFocus,searchOpened,none,panelClosed,none,none` |

顺手删掉了重复的 `describe("boot · 搜索键聚焦输入框")`（与新 `:82` 同断言），并修掉 `:75` 那句已经过期的行号注释（还写着 `boot.ts:83-91 / main.ts:165-166`）。

### 2. `pnpm verify` 原始输出（尾 8 行）

```
$ pnpm verify 2>&1 | tail -8; echo "EXIT=$?"

  ...-editorial.ts |     100 |      100 |     100 |     100 |                   
  ...tive-brief.ts |     100 |      100 |     100 |     100 |                   
  feynman-tech.ts  |     100 |      100 |     100 |     100 |                   
  index.ts         |     100 |      100 |     100 |     100 |                   
-------------------|---------|----------|---------|---------|-------------------
ERROR: Coverage for branches (97.36%) does not meet global threshold (100%) for packages/app/src/boot.ts
[ELIFECYCLE] Command failed with exit code 1.
[ELIFECYCLE] Command failed with exit code 1.
EXIT=1
```

`format:check` / `lint` / `typecheck` 全绿（`&&` 链走到 `test:coverage` 即证明）；`depcruise` / `knip` 因短路未执行。`Tests 1643 passed (1643)` / `Test Files 133 passed`。

### 3. 四行覆盖率（原样，不做结论）

```
  boot.ts          |     100 |    97.36 |     100 |     100 | 133               
  main.ts          |     100 |      100 |     100 |     100 |                   
  sse.ts           |     100 |      100 |     100 |     100 |                   
  runtime.ts       |     100 |      100 |     100 |     100 |                   
```

### 4. 行号更正：`133` 是 `scrollTo`，`searchOpened` 在 `134`

`packages/app/src/boot.ts:129-135` 现在是：

```ts
129:  return (raw) => {
130:    const intent = intentOf(raw, store.get());
131:    if (intent === undefined) return;
132:    dispatchIntent(intent);
133:    if (intent.kind === "scrollTo") deps.host.scrollTo(`${ROOT} [data-hr-id="${intent.id}"]`);
134:    if (intent.kind === "searchOpened") deps.host.focus(`${ROOT} #hr-search`);
135:  };
```

istanbul 的逐分支命中（`--coverage.reporter=json`，单跑 `packages/app/src/boot.ts`）：

```
line 131 branch hits [4]      ← intent === undefined 的两臂都有
line 131 branch hits [7]
line 133 branch hits [0, 7]   ← scrollTo 的 taken 臂 = 0 次（这就是缺口）
line 133 branch hits [0]      ← 同上的第二段记录
line 134 branch hits [2]      ← searchOpened 已覆盖（:82 那条用例走的就是它）
stmt line 133 hits 11
stmt line 134 hits 11
```

所以"`/` 键 → focus"**早就走到了**（`:82` 现在断的是"恰好一次 + 精确选择器"，之前是 `length === 1`），缺口一直是 `133` 行的 `intent.kind === "scrollTo"`。

### 5. 为什么 133 行覆盖不到（机器证据）

`keyHandlerOf` 的意图只可能来自 `packages/app/src/keys.ts:41 intentOf()`，返回集合是固定的五种：`searchOpened` / `move` / `toggleFocus` / `openSidenote` / `panelClosed`（`packages/app/src/keys.ts:33-43`）。上一节 `:111` 那条用例把这个集合钉住了 —— **没有任何键能产出 `scrollTo`**。`scrollTo` intent 的唯一生产者是 `packages/app/src/widgets/library.ts:32`（TOC 点击），它走 `dispatchIntent`，不经过 `keyHandlerOf`。

因此"要编写员导出 `keyHandlerOf`"没用：导出了也还是只能喂按键，喂不出 `scrollTo`；真要靠导出把这条分支点亮，等于用手搓 intent 造假绿（正是 §10.7 禁止的做法）。

### 6. 唯一的修法（改 `packages/app/src/boot.ts`，我不动 `src`）

```ts
// 165-168：dispatchIntent 里补一行（与 themeSelected 同构）
const dispatchIntent = (intent: ReaderIntent): void => {
  store.dispatch(intent);
  if (intent.kind === "themeSelected") selectTheme(intent);
  if (intent.kind === "scrollTo") host.scrollTo(`${ROOT} [data-hr-id="${intent.id}"]`); // ← 新增
};
// 129-135：keyHandlerOf 里删掉 133 行（副作用已上移）
```

两个收益：① 133 行这个死分支消失，`boot.ts` 立刻 100/100/100/100；② 顺带修掉真 bug —— 现在**点 TOC 只改高亮、正文不滚**（R4 探针已证：`activeId` → `hr-b`，`ops()` 里没有 `scrollTo`）。修完我补一条 `boot · TOC 点击 → host.scrollTo` 即闭环。

只删不加的最小改法（`133` 行整条删掉）也能让数字变绿，但 TOC 不滚就变成无人钉住的缺陷，不建议。

`ACP: M2.2 G3-R5——1643 例 / 133 文件全绿；verify EXIT=1，唯一红点 boot.ts 行 133（not searchOpened：134 已覆盖，JSON 证据 133 分支 hits [0,7]、134 hits [2]）；新增 3 条键盘出口用例（/ 恰好一次 focus、j 两个 false 臂、intentOf 枚举证明无键产 scrollTo）；修法=把 scrollTo 副作用移进 dispatchIntent 并删 133 行，同时修掉"点 TOC 不滚动"`
