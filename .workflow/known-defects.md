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

**CAP = 10**（M2.2 冻结基线）

## 登记

| ID | 缺陷（一句话） | 钉住的测试 | 归属卡 | 状态 |
| --- | --- | --- | --- | --- |
| KD-01 | 模型派生丢 NBSP / D2 折叠 | `packages/core/tests/model.test.ts:132` | M2.4 债清卡 | 待修 |
| KD-02 | 模型派生 D1 边界 | `packages/core/tests/model-derive.test.ts:79` | M2.4 | 待修 |
| KD-03 | latin run 计数偏差 | `packages/core/tests/outline-text.test.ts:81` | M2.4 | 待修 |
| KD-04 | 多 `<article>` 只取首个 | `packages/core/tests/outline-structure.test.ts:230` | M2.4 | 待修 |
| KD-05 | 截断切坏孤悬组合符 / ZWJ 家族 | `packages/core/tests/read-node-truncate.test.ts:131`、`:168` | M2.4 | 待修 |
| KD-06 | `\0` 在路径里应 400 而非 404 | `packages/core/tests/server/paths.test.ts:78` | M2.4 | 待修 |
| KD-07 | EOF 截断时应"应用关闭"却挂住 | `packages/core/tests/server/wire-http.test.ts:65` | M2.4 | 待修 |
| KD-08 | 鉴权边界（见测试注释） | `packages/core/tests/server/auth.test.ts:68` | M2.4 | 待修 |
| KD-09 | `--json` 下 usage 信封形状不一致 | `packages/cli/tests/units-run.test.ts:103` | M2.4 | 待修 |
| KD-10 | 空 `--html-stdin` 未报错 | `packages/cli/tests/units-run.test.ts:114` | M2.4 | 待修 |

> `CAP` 与表行数必须一致（同一条目若有多处 `it.fails`，只算 1 条，其余用 `// KD-nn` 指向同一行）。

## M2.3 · 设计边界与已排期项（2026-11-14；**不是 KD 行**，无 `it.fails`）

> 为什么另立一节而不是加进登记表：本表的一条 = **有 `it.fails` 钉住的已确认缺陷**，而规则 1 明确禁止新功能卡内新增 `it.fails`。下面三条是"已接受的设计边界/已排期的改进"，它们的性质是**声明**而非**缺陷证据**，混进表里既会把 `CAP` 挤爆（10 → 13），也会让"表的行数 = 当前欠的债"这个语义失效。编号用 `L-`（Limit），与 `KD-` 分开数。

| ID | 内容 | 定级 | 处置 |
| --- | --- | --- | --- |
| L-01 | `annotation-basis.ts:163-167` 的同位置兜底用 `previousFlat.findIndex` + `currentFlat[index]`，且 `sameSlotAs`（`annotation-basis.ts:48`）只比 `tag` + `depth`、不比文本。在块**之前**插删同 tag 同深度的兄弟，会指向另一块却判"重识别成功" → 给用户看错误块的 diff（虽标 `degraded:true` + `reason:"block_reidentified"`）。 | P2（按卡片 D.4 字面合规） | 重构卡 R-5：兜底加文本相似度阈值（如首 64 字符共同前缀 ≥ 50%），不达标降为 `block_missing`。 |
| L-02 | `data-hr-id` 为**内容派生**（`inject.ts:111-112` 的 seed = tag + 同标签兄弟序 + 文本前 64 字符 + 子树 digest），编辑会让 id 漂移；而批注 `nodeId` **不做落盘迁移**（`annotationOps.ts:67` 的 `rewriteOf` 只重写 meta，原样保留 `nodeId`），全靠读时重识别兜底。 | P2（设计事实，非缺陷） | 已在 `docs/05` 与 `.workflow/cards/M2.3.md` 写成声明：M2 未发布，无迁移义务；发布前必须重新评估（R-6）。 |
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
| L-18 | 风格解析曾有**两份**：`resources/read` 合并了 core 的 `BUILTIN_STYLES`，而 `applyStyle.ts:36` 的 `visualOf` + `toneOf` 只走 `nodeStyleDeps(workspace)` 的文件系统（`styles/atelier-editorial/` 只有 `theme.css`、无 `meta.json`）→ 预设 id 三条出口全"未知的视觉风格"。 | P0（AC-2/AC-7 硬失败） | **本轮已修**（收成一处 `resolveStyle(id)`，三出口共用）。保留作"同一策略两份实现"第四例案卷：`L-09`/`L-10`/`L-13`/`L-18` 同一个病，判据是「同一事实是否只拼写一处」。 |
| L-19 | `cli.ts` 无 `process.on("SIGTERM")`：收到 SIGTERM 直接以 `-15` 退出，无清理钩子。实测（4 个时点杀，每次按快照文件名里的 sha256 前缀校验完整性）**无脏状态**：`writeAtomic` 保证快照整数，`find .hreader -name '*.lock' -o -name '*.tmp*'` 为空。 | P3（无数据损坏，仅退出不优雅） | 不修。要优雅退出是产品选择，不是缺陷；若将来接 daemon 托管，再统一做"退出前 flush + 解除锁"。 |
| L-20 | `workspace=/` 时 `stderr` 只有一行 `workspace=/`，**没有任何警示**（`cd / && node main.js` 后 `/etc/hosts` 就在工作区内，实测可读）。工具描述已写明"工作区 = 启动时 cwd"，所以不再是欺骗，但宿主从 `/`/`$HOME` 误启时零提醒。 | P2（正确性的最后一道提示） | M3.2 与 `L-15` 同批：workspace 落在 `/`、`$HOME` 或其祖先时向 stderr 打 `WARNING`（附当前值 + 提示用 `--workspace`）。 |
| L-21 | **仓库外 `hr_apply_style` 对全部预设 100% 死**。三个内置预设 `inheritsVisual` 均为 `"atelier-editorial"`，`applyStyle` 只从盘上读 `<stylesRoot>/atelier-editorial/theme.css`（`contracts.ts:71`）；`STYLES_ROOT` 由 `import.meta.url` 推仓库根，bundle 拷出仓库后指向不存在的目录。实测：`cp dist/main.js /tmp/installsim/` + `hr_apply_style {visualId:"atelier-editorial"}` → `[unknown_style]`。 | P1（**交付形态**，非本卡 AC：仓库内正常且 `private: true`） | **本卡只修"说假话"**（F4：`style_root_missing` + 启动 stderr WARNING，哨兵用 `styles/atelier-editorial/theme.css` 的真实存在性）。结构性问题**硬触发条件**：①`packages/mcp-server/package.json` 的 `private` 改 `false`；②M3.2(Pi) / M3.3(DSH) 任一宿主在仓库外首次运行。正解是 core 导出"由调用方传锚点 URL"的 stylesRoot 解析（要动冻结面），或构建期把 `styles/` 纳入产物——**两者都不许在本卡做**。 |
| L-22 | **性能用例在并行负载下会抖**：`packages/core/tests/read-node.test.ts:261` 的 1MB 读取用例阈值是自校准的 `60 * slowdown`（约 480ms），整链 `pnpm verify` 与其它包测试并行时实测到 `512.7ms (slowdown 8.0x)` → 红；单跑该文件 `350ms / 429ms` 通过。属 CI 噪声，非代码回归。 | P3（门禁抖动，不是产品缺陷） | 不修（改阈值 = 把噪声藏起来）。**处置口径**：单条红先重跑该文件；只有"空闲复跑仍红"才当回归查。若要根治，正解是给这条用例 `{ sequential: true }` 或按 CPU 核数放大阈值预算——留到有人真被它挡两次时再做。 |
| L-23 | **跨进程写锁未验**：`core` 的 `runLocked` 是同进程锁（`locks/<sha1>.lock`），两个 server 进程同时写同一文档是否互斥未验证。`concurrency.test.ts` 只覆盖同进程两请求。 | P2（M3.1 单实例场景不触发） | 不实现 `flock`。硬触发条件：宿主侧出现多实例（M3.2 Pi / M3.3 DSH 任一允许同时开两个 server）时必修，正解是锁文件加 `O_EXCL` 原子创建或 `flock`，并配跨进程用例。 |
| L-24 | `errors.ts` 的 `errnoCodeOf` 对 **`AbortError`**（DOMException：`name="AbortError"`、`code=20` 数字、无 `syscall`）会落到 `internal`。当前不可达：本包**没有任何 fs 调用传 `signal`**（`grep signal packages/mcp-server/src` 为空）。 | P3（不可达） | 不修。触发条件写死：**第一次给 fs 调用加 `AbortSignal`**（例如超时取消）时，`errnoCodeOf` 必须同时认 `name === "AbortError"` → `io_failure`。 |
| L-25 | **MCP 面没有 `hr_undo`**：六个工具（outline/read_node/create_doc/patch_node/apply_style/resolve_annotation）里没有撤销，`hr_undo` 调用返回 `Tool hr_undo not found`。core 有 undo（`historyDirOf`/快照链），app 侧也有；**宿主（模型）无法撤销自己的编辑**。 | P2（不是本卡 AC：AC-2 只列六个工具；AC-9 只要求"断言快照确实产生"） | 不实现。触发条件：M3.2(Pi)/M3.3(DSH) 产品侧裁定"宿主可撤销"时，作为新卡加 `hr_undo`（加工具 = 加一份契约 + 测试 + 覆盖率，不许顺手塞进本卡）。 |
| L-26 | **`hr_resolve_annotation` 漏了 core 错误翻译**（`tools/resolveAnnotation.ts:24-41` 无 `.catch(coreFailureOf)`）：core 的 patch 管线错误文案带绝对路径（`io/paths.ts` 的 `realpath时路径不存在：<abs>`），而 `humanMessageOf` 在 F8.2 后不再折 → 对不存在的 `filePath` 调用时**绝对路径直接泄给宿主**；且 ENOENT 未映射 `not_found`，其余五个工具都映射了。**"同一政策两份实现"第六例**（`L-09`/`L-10`/`L-13`/`L-18`/`L-26` 同一判据：同一事实是否只拼写一处）。 | P1（错误路径下绝对路径外泄 + 码不一致；happy path 不炸） | **已修（F9.1，2026-11-15）**：`resolveAnnotation.ts:32-40` 补 `.catch(coreFailureOf)`；core 的"批注不存在"本就抛 `HrError("not_found")` 且无 `cause`，无误折风险。用例由 `codeOf(result) !== ""`（空断言）收紧为精确单码。G2-R6 复核通过。 |
| L-27 | **`elidedOf` 双根误折**：模式无左边界，`reduce` 顺序 `[cwd, real]`，当 `realpath(cwd)` 把 `cwd` 作为**后缀**包含时（macOS `/var/folders/x` → `/private/var/folders/x`），先折 `cwd` 命中 `real` 串中段：`/private/var/folders/x/doc.html` → `/privatedoc.html`（畸形串 + 残留 `/private` 半截绝对路径）。CI 绿是因为 `cwd === realpath(cwd)` 时不返回双根。 | P2（默认环境无影响；暴露时性质等同 L-23 泄露） | **已修（F9.2，2026-11-15）**：最长优先排序（`[...roots].sort((a,b) => b.length - a.length)`），比加左边界改动小。审计员补证：前缀关系（`cwd=/a/b`、`real=/a/b/c`）与后缀关系（macOS `/var` ⊂ `/private/var`）都被排序兜住。 |

| L-28 | `elidedOf` 的 `escapeRegExp` 每次调用都对根串跑一遍正则替换，且 `sort` 每次新建数组。`roots` 恒为 1–2 个、错误路径不是热路径，**实测无影响**。 | P3（性能无关紧要处） | 不修。若将来错误折叠进入批量路径（一次请求折上百条），再改为模块级缓存或一次性 `replaceAll`。 |
| L-29 | `ac2-surface` 的"description 长度 > 20 且不是 `x: type` 复述"是**启发式哨兵**，不是契约：`"filePath nodeId htmlContent"`（25 字符、无冒号）能漏过。它能杀死"空串 / 过短 / 参数复述 / `description===name`"这类明显退化，证不了"说明了何时用"。 | P3（非契约，别在卡片里写成"已保证描述质量"） | 不修。真要保证质量只能人审；保留它作为退化哨兵，判据写成"能杀死明显退化"而非"保证质量"。 |
