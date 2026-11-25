# 已知缺陷登记表（KD）

> 存在的唯一理由：仓库里有一批**已确认、尚未修**的缺陷。它们的测试用 `it.fails` 钉住（断言"坏行为确实发生"），所以套件是绿的、但缺陷是真的。
> 没有登记就会变成"绿得可疑"——这是 M2.2 栽过的跟头。本表就是防它复活的那把锁。

## 规则（从 M2.2 起生效）

1. **新功能卡内禁止新增 `it.fails`。** 发现缺陷 → 写进审计报告 → 要么当轮修，要么登记本表并由协调者排期。
2. 每条 `it.fails` 必须带行内标记 `// KD-nn`，且本表有同号行。**没有标记的 `it.fails` 就是违规**。
3. `packages/core/tests/known-defects-registry.test.ts`（测试员维护）做三件事：
   - 扫全仓 `it.fails`，每条必须解析出 `KD-nn`；
   - 每个 `KD-nn` 必须在本表出现；
   - **总数不得超过表头 `CAP`**（只减不增）。要加就必须先经协调者批准并下调别的条目。
4. 修掉一条：删 `it.fails` 的用例 → 改成 `it` 的**正向断言** → 从本表删行 → 下调 `CAP`。**不许**只是删行。

**CAP = 8**（M2.2 冻结基线 10；M4.7 R3 退掉 KD-07、本轮修掉 KD-06 后各下调 1）

## 登记

| ID | 缺陷（一句话） | 钉住的测试 | 归属卡 | 状态 |
| --- | --- | --- | --- | --- |
| KD-01 | 模型派生丢 NBSP / D2 折叠 | `packages/core/tests/model.test.ts:132` | M2.4 债清卡 | 待修 |
| KD-02 | 模型派生 D1 边界 | `packages/core/tests/model-derive.test.ts:79` | M2.4 | 待修 |
| KD-03 | latin run 计数偏差 | `packages/core/tests/outline-text.test.ts:81` | M2.4 | 待修 |
| KD-04 | 多 `<article>` 只取首个 | `packages/core/tests/outline-structure.test.ts:230` | M2.4 | 待修 |
| KD-05 | 截断切坏孤悬组合符 / ZWJ 家族 | `packages/core/tests/read-node-truncate.test.ts:131`、`:168` | M2.4 | 待修 |
| KD-08 | 鉴权边界（见测试注释） | `packages/core/tests/server/auth.test.ts:68` | M2.4 | 待修 |
| KD-09 | `--json` 下 usage 信封形状不一致 | `packages/cli/tests/run.test.ts:142` | M2.4 | 待修 |
| KD-10 | 空 `--html-stdin` 未报错 | `packages/cli/tests/run.test.ts:163` | M2.4 | 待修 |

> KD-07（EOF 截断挂住）已于 M4.7 R3 退表：缺陷不再成立——半截请求 3ms 内回 `HTTP/1.1 400`（Node 内置 `clientError` 的 Parse Error 抢先，`chunksOf` 的 408 分支线上不可达），用例已由 `it.fails` 转成 `wire-http.test.ts` 的正向 `it`（断言 400 + 耗时 < 1000ms）。
>
> `CAP` 与表行数必须一致（同一条目若有多处 `it.fails`，只算 1 条，其余用 `// KD-nn` 指向同一行）。

## M2.3 · 设计边界与已排期项（2026-11-14；**不是 KD 行**，无 `it.fails`）

> 为什么另立一节而不是加进登记表：本表的一条 = **有 `it.fails` 钉住的已确认缺陷**，而规则 1 明确禁止新功能卡内新增 `it.fails`。下面三条是"已接受的设计边界/已排期的改进"，它们的性质是**声明**而非**缺陷证据**，混进表里既会把 `CAP` 挤爆（10 → 13），也会让"表的行数 = 当前欠的债"这个语义失效。编号用 `L-`（Limit），与 `KD-` 分开数。

| ID | 内容 | 定级 | 处置 |
| --- | --- | --- | --- |
| L-01 | `annotation-basis.ts:163-167` 的同位置兜底用 `previousFlat.findIndex` + `currentFlat[index]`，且 `sameSlotAs`（`annotation-basis.ts:48`）只比 `tag` + `depth`、不比文本。在块**之前**插删同 tag 同深度的兄弟，会指向另一块却判"重识别成功" → 给用户看错误块的 diff（虽标 `degraded:true` + `reason:"block_reidentified"`）。 | P2（按卡片 D.4 字面合规） | 重构卡 R-5：兜底加文本相似度阈值（如首 64 字符共同前缀 ≥ 50%），不达标降为 `block_missing`。 |
| L-02 | `data-hr-id` 为**内容派生**（`inject.ts:111-112` 的 seed = tag + 同标签兄弟序 + 文本前 64 字符 + 子树 digest），编辑会让 id 漂移；而批注 `nodeId` **不做落盘迁移**（`annotation-ops.ts:67` 的 `rewriteOf` 只重写 meta，原样保留 `nodeId`），全靠读时重识别兜底。 | P2（设计事实，非缺陷） | 已在 `docs/05` 与 `.workflow/cards/M2.3.md` 写成声明：M2 未发布，无迁移义务；发布前必须重新评估（R-6）。 |
| L-03 | `wiring-static.test.ts` 的 `isDeferred` 原正则 `\sdisabled(?:[\s=/>]|$)` 对 `type="hidden"` 的 `input` 误报（它在 `INTERACTIVE_TAGS` 里但用户看不见）。 | P2（测试规则误报） | **已于 2026-11-14 当轮修掉**：`type="hidden"` 排除出交互元素集合；`aria-disabled="true"` 与 `disabled` 同等待遇。保留此条仅作"静态规则会误报"的先例记录。 |
| L-04 | `Host.focus`（`packages/app/src/dom.ts:53,141,159-161`）在 src 里**零调用点**（仅 `dom.test.ts:71-75` 自测）：`/` 快捷键改成写 `#hr-hint` 提示后，焦点缝成了死 seam。 | P3（死 seam，不影响行为） | 下一卡二选一：收回接口（连带删 `dom.test.ts` 对应用例）或留给"搜索真正启用"时用。**不许无限期挂着**——每多挂一卡就多一处"看起来有用"的假接口。 |
| L-05 | diff 响应体里两个**线上零消费**字段：①`reason`（`contracts.ts:58`）——app 侧 `guard.ts:63-70` 的 `isDiffResponse` 连它都没列，用户看到的那句话实际来自 `degradedReason`；服务端只在 `annotation-replies.ts:162` 用它的**存在性**（`basis.reason !== undefined`）算 `degraded`。②`originNodeId`（`contracts.ts:53`）——`grep originNodeId packages/*/src` 只有 core 内部 + `annotation-replies.ts:158` 透传，app 零读取。 | P3（线上死字段，不造成错误行为） | 下一卡三选一：**真读**（app 用 `originNodeId` 做"原本属于哪块"）、**标注**"仅审计用"并写进 `contracts.ts` 注释、或**删掉**。禁止长期维持"传了没人用"——KD 的教训就是字段验了不用就等于没验。 |
| L-06 | `AnnotationDiffBody.revision`（`packages/core/src/server/contracts.ts`）app 侧**零读取**：`guard.ts:60-74` 的 `isDiffResponse` 连形状都不校验，`notes-wire.ts:42-52` 的 `fetchDiff` 返回类型与 `notes-state.ts:219` 的 `diffShown` 都不含它。 | P3（潜在竞态护栏未被使用） | **本卡不删**（删掉等于扔掉唯一的过期响应判据）。下一卡二选一：app 用 `revision` 丢弃"比 `doc.changed` 先到的过期 diff"，或删字段。**不许第三次记成"仅审计用"**。 |
| L-07 | `AnnotationDiffBody.before` / `.after` app 侧零读取（app 只渲染 `chunks`）。 | P3（契约自证输入，非死字段） | **保留**，理由已落 `contracts.ts` 注释：core 侧靠 `rebuild(chunks) === after` 证明 `chunks` 不丢字节，删了就是孤证。这条不算待办，算"已裁定保留"，除非将来出现真正消费方。 |
| L-08 | wire 契约**没有键集锁**：C1 之后仍可能悄悄新增第三个零消费字段（`reason`/`originNodeId` 就是这样一路漏过来的，靠人肉逐字段排查才抓到）。 | P2（整类回归的口子） | 下一卡：对每个 wire 响应体加 `expect(Object.keys(body).sort()).toStrictEqual([...])` 键集锁（或引入 zod schema 并让 `guard.ts` 用它解析）。**这是把"零消费字段"从人审变成机审的唯一办法。** |

## M3.1 · 残留风险与已裁定的设计边界（2026-11-14，写者交付时自报 + 协调者裁定）

| ID | 内容 | 定级 | 处置 |
| --- | --- | --- | --- |
| L-09 | `packages/mcp-server/src/tools/target.ts` 自己 `readFile` 文本做读侧路径校验（realpath + 拒绝 `..`）：core 只公开了写侧入口 `patchFile`，没有公开的"读文本"入口，于是同一类路径校验在两处（core 写侧 + 本包读侧）。 | P2（同一事实两处拼写） | 下一卡：core 导出读侧入口（如 `readFileText(deps, file)`，内部复用已有路径校验），本包改为引用。**在此之前不许再在适配层加第二处路径校验。** |
| L-10 | `packages/mcp-server/src/ui.ts` 复制了 `~/.hreader/daemon.json` 的落点约定：core 未导出该路径常量。这是 `readStyleSource`（M3.1 §5.1）刚以同一理由否掉的病在三小时后再现。 | P2（同一事实两处拼写） | 下一卡：core 导出 `daemonStatePath(deps)`；本包改为引用。当前本包内该拼写**已收敛为一处**，并用 `grep -rn "daemon.json" packages/` 自证。 |
| L-11 | `resources/read` 的错误码到不了宿主：MCP SDK 把 handler 抛出的异常统一成 JSON-RPC `-32603` + message，`HrError.code` 只能进服务端 stderr。故本包删掉了"`catch` → 重抛 `HrError`"这层（包了也传不出去，只多一条不可测分支）。 | P3（协议层限制，非本仓缺陷） | 接受现状，不做处理。若将来要求"资源错误也带 code"，只能改走 `contents` 里塞结构化错误文本——**那要用户拍板改协议语义，不算 bug 修复。** |
| L-12 | `hr_read_node` 把 `nodeId` 直接拼进 CSS 选择器 `[data-hr-id="…"]`，schema 未做字符白名单。当前成立依赖一个外部事实：core 生成的 id 恒为 `[a-z0-9-]`（`inject.ts` 的内容派生规则）。 | P3（信任 core 生成规则） | 下一卡：`nodeId` 入参加 `^[a-z0-9-]+$` 白名单并给用例——**适配层不该把"上游的生成规则"当作安全边界**，这条和 `L-09` 同源。 |
| L-13 | `packages/mcp-server/src/tools/target.ts` 镜像了 core 的 `isInside`/`isInsideOrSelf`（逐字等价 + 注释指向 `packages/core/src/io/paths.ts:29-37`）。事实：`isInsideOrSelf` **已从 `io/paths.ts:36` export**，缺的只是 barrel——`packages/core/src/index.ts` 对它 0 命中。 | P2（同一事实两处拼写；`L-09`/`L-10` 同病第三例） | 最小改动是 core barrel 加一行导出（**零逻辑改动**），适配层改为 `strict = candidate !== base && isInsideOrSelf(base, candidate)`。排 M3.2 第一件事：这是消除"第四份路径策略"的唯一结构性办法，注释挡不住漂移（本轮已漂移一次）。 |
| L-14 | `assertInsideWorkspace`（`target.ts:46-56`）判定与随后的 `mkdir`/`writeFile` 之间是 TOCTOU 窗口：判定后被换 symlink 即可穿过。 | P3（与 core `resolveTarget` 同口径：判一次、随后写） | 接受，不做。要真关只能上 `O_NOFOLLOW`/`openat` 级别原语，等出现真实威胁再动。 |
| L-15 | workspace 恒等于 `process.cwd()`（`packages/mcp-server/src/cli.ts:27` `workspaceRoot: process.cwd()`），**无 `--workspace`、无 initialize 参数可指定**。宿主从 `/` 或 `$HOME` 启动 → `/etc/*` 就在"工作区内"。本卡只修文案（六个工具 description 明写"工作区 = 服务器启动时的 cwd"+ 启动时向 stderr 打 `workspace=<绝对路径>`），行为未动。 | P1→P2（语义欺骗由文案消除，边界本身仍由宿主 cwd 决定） | M3.2：加 `--workspace` 或经 initialize params 协商；两者都要在工具描述里同步，且**协商失败必须拒绝启动**而不是退回 cwd。 |
| L-16 | bundle 的 `new Function` 与 `require` shim 不同命：ajv 生成器用 `new Function(self, scope, source)`（`dist/main.js:10387`）编译校验函数，**函数体看不到模块作用域的 `const require`**，而 banner 的 `const require = __cr(import.meta.url)` 只覆盖 CJS 互操作。当前不炸是因为六个工具都没有 `outputSchema`，SDK 的 `AjvJsonSchemaValidator` 只构造不编译（编译路径**不可达**）。 | P2（宿主侧未通电的暗雷） | **上 `outputSchema`/结构化输出之前必须处理**：改为 `external:["ajv","ajv-formats"]` 并声明为真 `dependencies`，或确认 SDK 不为本服务器启用 validator。trigger 是"第一次出现 `outputSchema`"，不是"某天看起来不对"。 |
| L-17 | knip 的 `packages/mcp-server.entry` 只有 `src/index.ts`（`knip.json:41-42`），真正 `bin` 的源 `src/main.ts` 靠 `tests/cli.test.ts:150` 的 `await import("../src/main")` 传递可达。绿得合法，但"产物入口源码有覆盖"挂在一条测试的副作用上。 | P2（覆盖依据是巧合） | 下一卡：`entry` 加 `src/main.ts`，同批把 `L-13` 做掉。 |
| L-18 | 风格解析曾有**两份**：`resources/read` 合并了 core 的 `BUILTIN_STYLES`，而 `apply-style.ts:36` 的 `visualOf` + `toneOf` 只走 `nodeStyleDeps(workspace)` 的文件系统（`styles/atelier-editorial/` 只有 `theme.css`、无 `meta.json`）→ 预设 id 三条出口全"未知的视觉风格"。 | P0（AC-2/AC-7 硬失败） | **本轮已修**（收成一处 `resolveStyle(id)`，三出口共用）。保留作"同一策略两份实现"第四例案卷：`L-09`/`L-10`/`L-13`/`L-18` 同一个病，判据是「同一事实是否只拼写一处」。 |
| L-19 | `cli.ts` 无 `process.on("SIGTERM")`：收到 SIGTERM 直接以 `-15` 退出，无清理钩子。实测（4 个时点杀，每次按快照文件名里的 sha256 前缀校验完整性）**无脏状态**：`writeAtomic` 保证快照整数，`find .hreader -name '*.lock' -o -name '*.tmp*'` 为空。 | P3（无数据损坏，仅退出不优雅） | 不修。要优雅退出是产品选择，不是缺陷；若将来接 daemon 托管，再统一做"退出前 flush + 解除锁"。 |
| L-20 | `workspace=/` 时 `stderr` 只有一行 `workspace=/`，**没有任何警示**（`cd / && node main.js` 后 `/etc/hosts` 就在工作区内，实测可读）。工具描述已写明"工作区 = 启动时 cwd"，所以不再是欺骗，但宿主从 `/`/`$HOME` 误启时零提醒。 | P2（正确性的最后一道提示） | M3.2 与 `L-15` 同批：workspace 落在 `/`、`$HOME` 或其祖先时向 stderr 打 `WARNING`（附当前值 + 提示用 `--workspace`）。 |
| L-21 | **仓库外 `hr_apply_style` 对全部预设 100% 死**。三个内置预设 `inheritsVisual` 均为 `"atelier-editorial"`，`applyStyle` 只从盘上读 `<stylesRoot>/atelier-editorial/theme.css`（`contracts.ts:71`）；`STYLES_ROOT` 由 `import.meta.url` 推仓库根，bundle 拷出仓库后指向不存在的目录。实测：`cp dist/main.js /tmp/installsim/` + `hr_apply_style {visualId:"atelier-editorial"}` → `[unknown_style]`。 | P1（**交付形态**，非本卡 AC：仓库内正常且 `private: true`） | **本卡只修"说假话"**（F4：`style_root_missing` + 启动 stderr WARNING，哨兵用 `styles/atelier-editorial/theme.css` 的真实存在性）。结构性问题**硬触发条件**：①`packages/mcp-server/package.json` 的 `private` 改 `false`；②M3.2(Pi) / M3.3(DSH) 任一宿主在仓库外首次运行。正解是 core 导出"由调用方传锚点 URL"的 stylesRoot 解析（要动冻结面），或构建期把 `styles/` 纳入产物——**两者都不许在本卡做**。 |
| L-22 | **性能用例在并行负载下会抖**：`packages/core/tests/read-node.test.ts:261` 的 1MB 读取用例阈值是自校准的 `60 * slowdown`（约 480ms），整链 `pnpm verify` 与其它包测试并行时实测到 `512.7ms (slowdown 8.0x)` → 红；单跑该文件 `350ms / 429ms` 通过。属 CI 噪声，非代码回归。 | P3（门禁抖动，不是产品缺陷） | 不修（改阈值 = 把噪声藏起来）。**处置口径**：单条红先重跑该文件；只有"空闲复跑仍红"才当回归查。若要根治，正解是给这条用例 `{ sequential: true }` 或按 CPU 核数放大阈值预算——留到有人真被它挡两次时再做。 |
| L-23 | **跨进程写锁未验**：`core` 的 `runLocked` 是同进程锁（`locks/<sha1>.lock`），两个 server 进程同时写同一文档是否互斥未验证。`concurrency.test.ts` 只覆盖同进程两请求。 | P2（M3.1 单实例场景不触发） | 不实现 `flock`。硬触发条件：宿主侧出现多实例（M3.2 Pi / M3.3 DSH 任一允许同时开两个 server）时必修，正解是锁文件加 `O_EXCL` 原子创建或 `flock`，并配跨进程用例。 |
| L-24 | `errors.ts` 的 `errnoCodeOf` 对 **`AbortError`**（DOMException：`name="AbortError"`、`code=20` 数字、无 `syscall`）会落到 `internal`。当前不可达：本包**没有任何 fs 调用传 `signal`**（`grep signal packages/mcp-server/src` 为空）。 | P3（不可达） | 不修。触发条件写死：**第一次给 fs 调用加 `AbortSignal`**（例如超时取消）时，`errnoCodeOf` 必须同时认 `name === "AbortError"` → `io_failure`。 |
| L-25 | **MCP 面没有 `hr_undo`**：六个工具（outline/read_node/create_doc/patch_node/apply_style/resolve_annotation）里没有撤销，`hr_undo` 调用返回 `Tool hr_undo not found`。core 有 undo（`historyDirOf`/快照链），app 侧也有；**宿主（模型）无法撤销自己的编辑**。 | P2（不是本卡 AC：AC-2 只列六个工具；AC-9 只要求"断言快照确实产生"） | 不实现。触发条件：M3.2(Pi)/M3.3(DSH) 产品侧裁定"宿主可撤销"时，作为新卡加 `hr_undo`（加工具 = 加一份契约 + 测试 + 覆盖率，不许顺手塞进本卡）。 |
| L-26 | **`hr_resolve_annotation` 漏了 core 错误翻译**（`tools/resolve-annotation.ts:24-41` 无 `.catch(coreFailureOf)`）：core 的 patch 管线错误文案带绝对路径（`io/paths.ts` 的 `realpath时路径不存在：<abs>`），而 `humanMessageOf` 在 F8.2 后不再折 → 对不存在的 `filePath` 调用时**绝对路径直接泄给宿主**；且 ENOENT 未映射 `not_found`，其余五个工具都映射了。**"同一政策两份实现"第六例**（`L-09`/`L-10`/`L-13`/`L-18`/`L-26` 同一判据：同一事实是否只拼写一处）。 | P1（错误路径下绝对路径外泄 + 码不一致；happy path 不炸） | **已修（F9.1，2026-11-15）**：`resolve-annotation.ts:32-40` 补 `.catch(coreFailureOf)`；core 的"批注不存在"本就抛 `HrError("not_found")` 且无 `cause`，无误折风险。用例由 `codeOf(result) !== ""`（空断言）收紧为精确单码。G2-R6 复核通过。 |
| L-27 | **`elidedOf` 双根误折**：模式无左边界，`reduce` 顺序 `[cwd, real]`，当 `realpath(cwd)` 把 `cwd` 作为**后缀**包含时（macOS `/var/folders/x` → `/private/var/folders/x`），先折 `cwd` 命中 `real` 串中段：`/private/var/folders/x/doc.html` → `/privatedoc.html`（畸形串 + 残留 `/private` 半截绝对路径）。CI 绿是因为 `cwd === realpath(cwd)` 时不返回双根。 | P2（默认环境无影响；暴露时性质等同 L-23 泄露） | **已修（F9.2，2026-11-15）**：最长优先排序（`[...roots].sort((a,b) => b.length - a.length)`），比加左边界改动小。审计员补证：前缀关系（`cwd=/a/b`、`real=/a/b/c`）与后缀关系（macOS `/var` ⊂ `/private/var`）都被排序兜住。 |

| L-28 | `elidedOf` 的 `escapeRegExp` 每次调用都对根串跑一遍正则替换，且 `sort` 每次新建数组。`roots` 恒为 1–2 个、错误路径不是热路径，**实测无影响**。 | P3（性能无关紧要处） | 不修。若将来错误折叠进入批量路径（一次请求折上百条），再改为模块级缓存或一次性 `replaceAll`。 |
| L-29 | `tool-schemas` 的"description 长度 > 20 且不是 `x: type` 复述"是**启发式哨兵**，不是契约：`"filePath nodeId htmlContent"`（25 字符、无冒号）能漏过。它能杀死"空串 / 过短 / 参数复述 / `description===name`"这类明显退化，证不了"说明了何时用"。 | P3（非契约，别在卡片里写成"已保证描述质量"） | 不修。真要保证质量只能人审；保留它作为退化哨兵，判据写成"能杀死明显退化"而非"保证质量"。 |
| L-30 | **Pi 扩展的手抄类型面（`HreaderUi`/`HreaderContext`/`HreaderCommandOptions`/`HreaderPi`，`packages/pi-extension/pi-hreader.ts`）没有任何编译器在看着它。** 本该 `import type { ExtensionAPI, ExtensionCommandContext, … } from "@earendil-works/pi-coding-agent"`，但装它会让 `pnpm typecheck` 红（`dist/core/tools/find.d.ts(7,108): error TS2694: Namespace 'path' has no exported member 'PlatformPath'`、`@google/genai/.../genai.d.ts(4465,32): error TS2552: Cannot find name 'RequestInfo'`；本仓 `lib: ["ES2023"]`、`types: []`、`skipLibCheck: false`），并拖入 111 包、触发 `ERR_PNPM_IGNORED_BUILDS` 使 `pnpm install` 退 1。签名照 `pi-coding-agent@1.5.2` 的 `dist/core/extensions/types.d.ts:83-91 / 233-241 / 1214 / 1228` 手抄，**原文已贴进该文件注释块**。这是 `L-13` 判据（同一事实是否只拼写一处）的第八例。 | P2（类型漂移只能靠手工门发现；运行期真错会直接抛，不会静默错数据） | 补偿：①`scripts/smoke-pi-extension.ts` 用 `pi -e packages/pi-extension/pi-hreader.ts` 真加载一次并断言 2 命令 + 3 工具注册（手工门，不进 CI）；②**硬触发条件**：`pi-coding-agent` 若修复自身 d.ts 依赖、或提供无三方依赖的 types 入口，则装为 devDependency、删本地窄接口。不许因为"反正有注释"就放着不升级。 |
| L-31 | **`packages/pi-extension/pi-hreader.ts` 单文件 1200 行（结卡时实测，`max-lines` 上限即 1200，**零余量**），同时背 8 个变化理由**（daemon 发现、docId 推导、URL 拼接、SSE 解码、订阅重连、三工具、批注引流、`/hr-style`+回显净化）——按 `docs/04` §5.3.1（"单文件只有一个变化理由"）字面判 **P1**。**不修的理由**：AC-1 要求"零本地 `import`、能从 `~/.pi/agent/extensions/` 裸加载"，拆模块与之直接冲突（审计已给出 6 模块拆分方案，见 `M3.2-G2R2-audit.md` ④）。**曾撞到上限**：F5 为了塞进 1200 行，写者把回显拆成 `const echo` + 单行 `notifyOf` 并压掉两处空行/注释折行。（2026-11-25 复核：`max-lines` 闸门已随 `8a97ce5` 删除，“加一行会红”不再成立；债务本体是行数与 8 个变化理由，见 L-46。） | P2（可读性债，不是正确性缺陷；`max-lines: 1200` 已裁定，卡 §7 记明） | 不修。**硬触发条件**：①Pi 支持多文件扩展（`pi -e <dir>` 或官方 bundle 机制）；②AC-1 放宽为"允许相对 import"；③规模继续膨胀到不可 review（现 1216 行：2026-11-25 复审为它加 12 行 daemon 重启恢复逻辑，机械上限已随 `8a97ce5` 删除）。任一触发即按审计的 6 模块方案拆。 |
| L-32 | **样式变更不进撤销栈：`packages/core/src/style/apply-file.ts` 全文没有任何 `writeSnapshot` 调用**（`writeSnapshot` 只在 `packages/core/src/io/patch-file.ts:36` 与 `packages/core/src/ops/annotation-ops.ts` 两处），所以 `hr_patch_node` → `hr_apply_style` → 一次 undo 会**把正文和样式一起回退**（快照是 patch 前的写前字节），第二次才是 `nothing_to_undo`。同时 `packages/core/src/ops/revert-op.ts:2` 的注释「patch / style / 批注共用同一条快照链」**对 style 是失实的**（对批注属实）——这是 `L-13` 判据（同一事实是否只拼写一处）的第十例：注释宣称了一条代码没有兑现的保证。M3.4 交付时按真实语义钉了用例，并在 `docs/05` M3.4 使用建议里警示。 | P2（`undo` 仍能把文件还原到合法状态，只是粒度比注释宣称的粗；不会丢用户数据——`revertLast` 走的是写前字节，不是猜测） | **[2026-11-25 已修 · t3/audit-core-sanitize-undo]**：`applyToFile` 写前 `writeSnapshot`、写后 `pruneSnapshots`，样式应用与 patch 共用快照链，一次 undo 只退样式那一步；`undo-chain.test.ts` 两条用例钉住。原裁定：不修（M3.4 的 D6 禁止改 core）——本卡已动撤销链，命中硬触发条件①，按登记修法落地。语义定案：换样式占一个撤销台阶。**硬触发条件**：①任何卡要动 `applyFile` 或撤销链；②用户报「换完样式撤销一次把正文也撤了」；③M4.1 style 萃取器写 `style.yaml` 若复用 `applyFile`。 |
| L-34 | **`dist/styles` 缺失时错误文案不提 `dist/styles`。** `stylesRootOf`（`packages/dsh-bundle/src/index.ts`）在 `dist/styles` 不在时回落到仓库 `styles/`；两者都没了（打包安装后是常态）就只剩内置 `BUILTIN_STYLES` 与用户/项目风格可查，而 `unknown_style` 的文案只列「内置预设、`<workspace>` 的项目风格、`~/.hreader/styles`」——用户照文案排查会一无所获。M3.3 G3-R1（测试员，2026-11-16）发现。 | P2（失败是显式的：必报 `unknown_style`，不静默错数据；只是不可操作、误导排查） | 不修（M3.3 卡不许改 core，且改文案须与资源回落链同源）。**复现**：`rm -rf packages/dsh-bundle/dist/styles && mv styles /tmp/styles.bak && node -e 'import("./packages/dsh-bundle/dist/index.js").then(m=>m.apply(fakeCtx,{styleId:"atelier-editorial"}))'`（用完 `mv /tmp/styles.bak styles`）。**修法（须同一条 commit 一起做）**：把两级回落（`dist/styles` → 仓库 `styles/`）写进错误消息，并给 `tests/dist.test.ts` 补一条"两级都缺时文案点名 `dist/styles`"的用例。**硬触发条件**：①任何卡要动 `stylesRootOf` 或 `promptOf` 的错误文案；②出现"装完插件所有 styleId 都未知"的用户报告；③发布流程改 `files` 字段。
| L-35 | **`tests/drift.test-d.ts` 只挡类型层漂移，挡不住语义漂移。** 改名 / 删字段 / 新增必填字段会红，但 `order` 撞位（与宿主侧其它 section 同值）、`name` 新约束这类**语义**漂移对双向赋值不可见；它们只有 `scripts/smoke-dsh.ts` 兜底，而它不进 CI。M3.3 终审（2026-11-16）发现。 | P3（本包只传静态串，`order` 只与自身 renderer 比较；宿主侧 order 冲突时才致命） | 不修。**消除条件**：宿主侧出现 `order` 冲突的真实案例时，把 `smoke-dsh.ts` 的 `order` 断言搬进 CI（或在 `drift.test-d.ts` 补与 `SECTION_ORDERS` 的数值比对）。 |
| L-36 | **LLM 输出非确定性 → CI 里没有真回归保护**，只有 `fixtures/llm/*.json` 的回放；真模型换代（或改 `prompt.ts` 的 prompt）后回放不再代表今天的输出，而 CI 仍会绿。M4.1 F4（2026-11-17）登记。 | P2（回放失真时失败是静默的：测试仍通过，只是不再证明模型行为） | 不修（属 D12 的成本取舍：真调用预算 ≤10 次/卡）。**硬触发条件**：①换 `--model` 默认值或网关；②改 `packages/core/src/style/extract/llm/prompt.ts` 的提示词；③出现“模型明明返回了建议但 dropped 全空/全丢”的报告。**修法**：按 `fixtures/llm/README.md` 重录，并让先红的 `packages/cli/tests/style-extract-llm.test.ts`（`extract-llm` 回放用例）与 `fixtures/llm/*.json` 同一次 commit 落地。 |
| L-37 | **统计层的句数判定有两头偏差。** 判定在 `packages/core/src/style/extract/paragraphs.ts:148-153` 的 `isAsciiPeriodEnd`（`.` 后跟空白或行尾算句末）与 `:155` 的 `TERMINATORS`（`。！？!?…`，`；` 不算）。**多计**：英文缩写（`e.g. `、`Dr. `）、点后带空格的编号（`3. 5`、`1. ` 列表序）都被切开。**少计**：`；` 连写的长句、无标点的长段各只算一句。短文本（<3 段）上两头偏差都更明显，`max_paragraph_sentences` 因此可能偏高也可能偏低。M4.1 F4（2026-11-17）登记。 | P3（偏差方向不定但可复现，且用户可手工改 `style.yaml` 的 `rhythm`） | 不修（本卡定的是“单篇中文阅读页”语料契约）。**消除条件**：出现非中文/新闻短讯语料的用户报告，或 `rhythm.maxParagraphSentences` 被指“太松/太紧”的真实案例；届时把判定换成 `Intl.Segmenter` 的 `sentence` 粒度，并补英文缩写与分号长句两条用例。 |

### L-33 · undo 的快照无新鲜度校验（可被"自洽旧快照"回滚）

**发现**：M3.4 G3-R1（测试员，2026-11-16）。`packages/core/src/io/history.ts:38-40` 的 `latestOf` 只按**文件名**排序取最新，哈希只用于证完整性（`undo.ts` 比对 sha256 一致才写回），不证**新鲜度**。因此若有人手工放入一份"内容自洽 + 文件名时间戳更新"的旧快照，`hr_undo` 会 `code=ok` 静默把文件回滚到那份旧内容。

**为什么不立即修**：能写 `.hreader/history/` 的人本来就能直接改正文，威胁模型上不构成额外提权；且 undo 的正确语义就是"信任我自己的历史目录"。属于**已知限制**而非可利用漏洞。

**修法（若将来做）**：快照名里带上"父快照哈希"形成链，或在 `.hreader/history/` 存一份 append-only 的单调序号 + 最后写入时间，`latestOf` 校验序号连续性。

**M3.4 已登记的相邻缺陷**：`L-32`（`applyFile` 不写快照 + `revertOp.ts:2` 注释对 style 失实）。

## L-38 · `extractStyle` 传错参数键名会抛裸 `TypeError`（M4.1 §11.10 裁定：不修）

**现象**：`extractStyle({ corpora: [...] })`（正确键名 `corpus`）会在 `packages/core/src/style/extract/paragraphs.ts:123` 的 `flatMap` 上抛 `TypeError: Cannot read properties of undefined`，而不是 `HrError`。违反"裸异常即 P0"。

**为什么不修**：这是 **TypeScript 静态边界**——`extractStyle` 的入参类型 `ExtractStyleInput` 只声明 `corpus`，写错键名在 `pnpm typecheck` 就红；运行期守卫（`assertCorpus`）需要构造一个 TS 不可能产生的对象才能触发，属于"不可由真实输入触发的守卫"，写它只能靠 `as unknown as` 的自造测试养活。取舍：宁可留裸异常，也不留养测试的假守卫。

**若将来需要**：只有当 `extractStyle` 被 JS 宿主（无 TS）直接调用时才值得加守卫；届时在 `extract/index.ts` 入口做一次 `Array.isArray` + `typeof` 检查并抛 `invalid_input`。
### L-34 · 多 `<article>` / 嵌套 `<article>` 在 extract 路径被拒（P2，F2 处理）
`packages/core/src/style/extract/paragraphs.ts` 的 `withArticle` 只兜"零个 article"；多个或嵌套 article 会走到 `packages/core/src/html/derive.ts:70-79` 抛 `invalid_document`（"文档里有多个 <article>：模型只能有 1 个顶层 article"）。新闻列表页、评论嵌套页这两类真实"另存为"形态都落在这里。
现状口径：`hr style extract` 的输入契约 = 单篇阅读页；多 article 直接拒是**可接受的最小行为**，但文案对"我把列表页存下来了"的读者不可操作（它说"模型只能有 1 个顶层 article"，没告诉他该存单篇）。
F2 要做的：要么按"article 数量最多者 + 相邻"选主，要么把文案改成"这份 HTML 里有 N 个 article，请只保存单篇文章页"。


## L-39 · 禁词表已 NFC，正文没有（命中会漏，不会误报；M4.1 F4 登记，P2，不修）

**现象**：`packages/core/src/style/words.ts` 的 `foldOf` 逐码元做 `NFKC` + 小写，但 NFKC 不把"`e` + 组合重音 U+0301"合成为 `é`——它只在**已有预组合字符**时才动。`packages/core/src/style/spec.ts:214` 的 `uniqueWordsOf` 已把**词表**归一为 NFC，正文没走这一步。于是从 PDF / 某些 macOS 复制来的分解形正文（`e`+U+0301）匹配 `é` 这类禁词时**整条漏掉**：只漏报，不会误报（不会把正常文本判成命中）。

**为什么不修**：修它要给 `Folded.source` 提供"归一后下标 → 原文下标"的映射，而 NFC 合成会**改变长度**（2 个码元 → 1 个），逐码元记的 `source` 表与 `lint` 的 `offset`（块内字符偏移，用户拿去改的位置）会整体错位。正确做法是先按 NFC 分片再构造分段映射，属于重写 `words.ts` 偏移层的活，超出本卡（M4.1 定的是"单篇中文阅读页"语料契约）。

**若将来需要**：把 `foldOf` 改成"按 `Intl.Segmenter` 的 grapheme 切分后逐段 NFC"，`source` 改成区间表（每段记 `[原文起, 原文止)`），`lint.ts:60` 的 `offsetsOf` 取段起点；补用例：正文 `e`+U+0301 命中 `é` 一条、命中 `offset` 落在原文字符位置。

## L-46 · `max-lines` 与 M3.2 AC-1（单文件扩展）死锁（R2-F17，2026-11-19）

**死锁（2026-11-25 复核修正）**：`docs/05-feature-cards.md:139` 要求 `packages/pi-extension/pi-hreader.ts` 零本地 import、能 `pi -e <dir>` 裸加载（无打包步骤）⇒ 全部错误文案只能塞进这一个文件。本条原记载"eslint.config.mjs:180 的 `max-lines: 1203` 每加一个错误码就要抬一格"——**该闸门已在 `8a97ce5`（2026-11-24，"对齐 Vite/Vitest 通行规范"）连同 max-lines/max-params/complexity 一起删除**，`docs/04:84` 明写"不设行数硬上限"。因此"抬数字"机制已不存在；残留的是 L-31 的可读性债本体（单文件 1200+ 行、8 个变化理由）。拆模块与 AC-1 仍冲突（`M3.2-G2R2-audit.md:71` 判"现在拆 = 违约"）。

**出口仍是两条**：①给扩展加打包步骤（esbuild → 单产物）后按审计的 6 模块方案拆；②把文案表从扩展里挪出去（需构建期注入）。历史抬帽记录（闸门删除前的台账）：

- 2026-11-19 · R2-F17 · `duplicate_id`（`1203 → 1204`）。
- 2026-11-25 · R2 交叉复审 · 订阅重连补 daemon.json 重读（daemon 重启恢复），文件 1204 → 1216 行；已无机械上限，行数增长仍受 L-31 拆分触发条件约束。

## L-40 · 打印管线的递归遍历在深嵌套文档上抛裸 `RangeError`（R2 复审登记，P3，不修）

**现象**：`packages/renderer-html/src/print-html.ts` 的 `findElement`/`textOf`/`rewrittenChildrenOf`/`reservedIdsOf` 都是**递归**遍历；`hr export`/`hr pdf`/`hr png` 的输入是用户自己的 HTML（没有深度上限），一份 ~90k 层嵌套 `<div>`（约 1 MiB，远在 4 MiB 产物上限之内）就会让 `hr export` 以 `RangeError: Maximum call stack size exceeded` 退出——不是 `HrError`，走不到 run.ts 的错误码映射。实测（同形态递归、纯 JS 对象）：10 万层即溢。

**为什么不修**：①core 的热路径遍历（`serializeHtml`）已是显式栈迭代，说明"深文档"这个形状在设计视野内，但输入侧 `hr import`/`normalize` 会先做骨架平衡与重写，深嵌套文档到不了打印层就先在别处抛 `HrError`——能流到 `print-html` 的深文档只有"本就规整但极深"这一种形态，真实文档里没有。②改成迭代遍历要动五个 walker，收益是换一种崩溃形态（`RangeError` 裸栈 → `HrError("invalid_document")`），不救任何真实用户。

**若将来需要**：在 `printHtmlReportOf` 入口给 `parsed.root` 过一次显式栈的深度测量（一次迭代遍历即可），超过阈值（如 2048 层）抛 `invalid_document`——比在五个 walker 里各自改迭代便宜，且把崩溃提前成可读的错误码。

## 已定：不是缺陷（2026-11-19 结案）

- **`port_in_use`(exit 2) 与 `daemon_already_running`(exit 1) 并存**：`docs/05:449-450` 明写两个码两种情形（端口被别人占 vs 本机的 daemon 已在跑）。审计两轮都提过"是不是漂移"，结论是**设计如此**，不得合并。R2-07 结案。
