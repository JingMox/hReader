
## M1.5 · 协调者裁定 v3 #12–#17（第二轮返工期间）

| # | 裁定 | 理由 |
| --- | --- | --- |
| 12 | **幂等 = "剥 ID 后规范内容相同"**：相等 → 原字节返回、`changed:false`、不重注入 ID | 比对含 ID 就永不等（ID 每次新生成），`changed` 恒真 |
| 13 | `parseFragment("")` / 仅空白 / 仅注释 → `invalid_fragment` | 输错是契约违约（用户意图清楚），不是页面向量 |
| 14 | `undoPatch` 文件不可读 → `io_failure`（非 `not_a_file`） | "不可读" ≠ "不是普通文件"，混在一个码里没法区分 |
| 15 | 锁文件读取失败 → `io_failure`，不得当成"不存在"去抢锁 | 抢锁误判会写穿别人的临界区 |
| 16 | `<animate\|set attributeName="href\|src\|xlink:href">` 危险值 → `forbidden_content`；`<xmp>`、`style url(javascript:)` 不入名单 | 元素级 `href` 已拒，动画子元素改同一属性是同一绕过面；后两者不是可执行面 |
| 17 | **`values` 按 `;` 拆开逐项判**，`to/from/by` 保持单值；通用属性扫描同样先切再判 | 见下方事故记录 |

### 事故记录 · "先净化再判" 把列表拼回单个 token（v3#17）

`fragment.ts` 原写法：`value.split(";").join(" ")` 后整串送 `forbiddenUrlOf`，而
`normalizedUrl` 本身会 `replaceAll(/[\s\p{Cc}]/gu, "")` → `"safe javascript:alert(1)"`
归一成 `"safejavascript:alert(1)"`，前缀比对永不命中。于是
`<animate attributeName='href' values='safe;javascript:…'>` 通过 v3#16 的检查写入文档。

- **谁抓到的**：G2-R2 定向审计（编写员的 16/16 自测、测试员的 160 例全绿都没抓到）。
- **为什么没抓到**：测试员的用例只用了**单值** `values`；编写员的自测也是单值。
  两边的"覆盖"都落在首项上，第二项从未被构造。
- **沉淀为规则**（手册 §10.6）：**"列表/多值"必须与"单值"成对构造用例**；
  凡代码里出现 `join(" ")`、`split(...).join(...)`、把结构化值拍平成字符串再判的，
  审计员必须问一句"第二个元素呢"。

---

## 手册 §10.6 · 三条本轮新增的硬规则

1. **解析器属性名大小写**：HTML 词法层把属性名小写化，但 SVG 的 adjusted attribute
   （`attributeName`/`attributeType`/`viewBox`）是**驼峰**。凡按名字查属性，
   拒绝名单用大小写不敏感查找（`attributeValueLoose`），**ID 通道必须保持精确 `===`**。
   本轮 P1-7 的根因就是：拒绝名单用全小写名精确取值 → 恒 `undefined` → 断言函数从未被调用（死代码）。
2. **死代码即 P1**：`collectSvgScope` 恒假谓词、"注释声称与 X 同口径但实现不同"都算 P1。
3. **并发窗口**：编写员改 `src` 时审计员不得以 `pnpm test` 为判据；审计员必须记录
   `shasum` 前后一致，否则结论不对应同一份源码（本轮审计员自己发现并重取快照）。

## M1.5 · 收口（v3 #18–#19 + 三条新硬规则）

### 裁定
| # | 裁定 | 理由 |
| --- | --- | --- |
| 18 | `parse.ts` 的"缺位置"与"缺 startTag"合并成**一道**守卫；`spanOfLocation` 收两参 | 元素必有 startTag（parse5 `_attachElementToTree` 恒带），子守卫不可达即死代码；合并后唯一出口真实可达（合成元素 location=null） |
| 19 | **fuzz 语料必须覆盖 foreign content × 特殊元素**（`svg/math` × `template/table/select`） | 编写员的 4000 例语料不含 `<svg><template>`，于是"元素侧不可达"只是弱证据；审计员用 parse5 源码才证实，且顺手撞出裸崩 |

### 事故记录 · `<svg><template>` 裸崩（P1-R3-1 → 升级 P0）

`isTemplate = (node) => node.nodeName === "template"` 只判名字不判命名空间；SVG 里的
`<template>` 没有 `.content` 片段 → `element.content.childNodes` 抛
`TypeError: Cannot read properties of undefined (reading 'childNodes')`。

- 可达性：`parseFragment` 与 `applyPatch` 双双可达，随机语料 **54/4023（1.3%）**；`{locations:true}` 与默认模式同样崩。
- 危害：`TypeError` **逃出 `HrError` 契约**（`error.code` 为空），所有按 code 分类的调用方逻辑被击穿；输入完全用户可控。
- 谁抓到的：**审计员在签另一个改动时顺手发现的**（"签字不等于只看 diff"），并追溯到 parse5 源码证明"有 location 必有 startTag"。
- 修法：命名空间判定（或 `"content" in element` 结构化探测），且必须保证 `<svg><template><circle/></template></svg>` **往返字节保真**——"不崩"≠"没丢内容"。

### 手册 §10.7 · 本轮新增规则（并入下文 §10 总表）

1. **签字轮也要报"顺手发现的既有问题"**：审计员只读核对一个 hunk 时撞到的既有缺陷，必须记成 `P*-Rn-k` 并标注"既有/非本次引入"，由协调者决定是否阻断当前卡。
2. **裸异常 = 契约违约 = P0**：任何非 `HrError` 的抛出（`TypeError`/`RangeError`/`AggregateError`）从公开 API 漏出，一律按 P0 处理，不论输入多怪。
3. **"不崩"与"不丢内容"是两条断言**：修复崩溃类缺陷时，必须同时断言往返/子树保真；只断言"不抛"会把"静默丢子树"写成绿灯。

## M1.6（合并 M1.7）· 风格引擎 + Atelier Editorial + `apply_style` — CLOSED

- **实现** 15 文件 1289 行（`packages/core/src/style/**`）+ 主题 244 行；`yaml@^2` 仅 `src/style/*.ts` 可用（depcruise 规则）
- **门禁** G1 → G2 **FAIL（1×P0 / 5×P1 / 9×P2）** → R1 返工 → G2-R **PASS（6/6 CLOSED）** → G3.1–G3.4 → G4 PASS
- **最终** `pnpm verify` EXIT=0，69 文件 / **924 例**，四维 100%，变异 7/7 被杀（含 2 个反向变异）

### 本卡真实缺陷（都被 CI 绿灯掩盖过）
| # | 缺陷 | 为什么严重 |
| --- | --- | --- |
| P0-1 | 无 `<head>` 时把 `<style>` 写到**字节 0**，`<!doctype>` 被挤后 → quirks mode | 输出的文档整体进入怪异模式，所有字节保真都白搭 |
| P1-1 | CSS 转义绕过：`\68 ttp://` → `http://`（浏览器里），静态防线形同虚设 | 安全防线被"换个写法"绕过，且注释还声称会拒 |
| P1-2 | 两个 `<style id="hr-theme">` 只换第一个，旧的那个赢 | 幂等性在"文档被重复应用过"时崩 |
| P1-3 | `loadStyle` 能加载、`applyStyle` 报 `unknown_style` | 同一份输入两套解析口径 |
| P1-4 | 裁定 #5 的缺省值不可达（省略整块 → 报错） | 合同写了、代码没做到，测试还把它固化了 |
| P1-5 | 未知键报文永远列顶层键集；每层 `assertKnownKeys` 是死代码 | 嵌套报错把用户带偏 |

### 流程教训（已写进手册 §11）
1. **"verify 全绿"必须附 `EXIT=0` 与命令原文**：测试员报"四维 100%"，我复跑两次都是 `spec.ts` 分支 98.7%。
2. **测试固化的旧裁定会伪装成"实现回归"**：R1 修完后 5 条红全是"测试在钉旧行为"，必须逐条按裁定翻转，不许改实现迁就测试。
3. **第三方边界的可选字段守卫怎么做 100%**：`yaml` 的 `pos?` 在类型上可选、真实输入永远有 → 内部 `@internal` 导出 + 直接单测，而不是 `/* v8 ignore */`。
4. **修法本身要复审**：转义反转义的 ReDoS、dedupe 的字节保真、`resolveStyle` 统一后的新死代码——这三条都是"修 bug 引入 bug"的高发位置。

## M1.8 (merged M1.8+M1.9: CLI `hr` + Universal Skill shell) — 2026-11-13

Card v1 §8 already carries 7 rulings + AC5a/AC5b split (written before dispatch).

### G1 deliverable (run `del_mwelwecz_zerh`)
- `packages/cli/**` 14 files 1011 lines; `skills/hreader/**` (SKILL.md 178 lines, hr.mjs 193, components-spec 112, style-authoring 118).
- Modified: `pnpm-workspace.yaml`, `vitest.config.ts`, `knip.json`, `.dependency-cruiser.cjs`, root `package.json`, `src/index.ts` (+invalid_utf8, `readBytes`).
- `pnpm verify` **RED**: format 3 files; `tsc` TS2322 on `tests/hr-error.test.ts` `CODE_MATRIX` (expected, tester's); coverage `packages/cli` **79.05%** (no tests yet, expected); `depcruise` flagged `main.ts → cli-context.ts` thin wrapper (writer resolved by merging the file, kept `process.exitCode`).
- Writer self-reported **14 ambiguities** and **13 dead branches** in its own code (§5.2 of `impl-M1.8.md`) — the dead-branch list is now the tester's点名清单.

### Coordinator mistake (logged deliberately)
- Dispatched G3 by resuming the WRITER's session id (`del_mwelwecz_zerh` instead of tester `del_mwels1wd_zrrb`). Cancelled within seconds (`del_mwemm4ge_8zcx`); `git status` + `ls packages/cli/tests` confirmed **zero writes**. Rule added: before `resumeFrom`, re-read the state table row for the role — never resume from memory.

### G3 run killed by watchdog (del_mwemmn7e_pqwe → resumed as del_mwen6jsy_wdie)
- Symptom: 5 min of no output mid-run; exit 143. Root cause: a spawned CLI child reading stdin that was never closed → parent waits on child, child waits on stdin.
- Coordinator verified it was NOT the deep-nesting command: `outline` on 4000-deep AND 40000-deep `<div>` returns EXIT=0 in well under a second.
- New standing rule (`.workflow/WORKFLOW.md` §11.x): every test spawn needs `stdio: ["ignore","pipe","pipe"]` + a hard timeout; a hang counts as a failure. Test suites must not be able to hang.
- Correction: the rule above was first announced to the tester as "手册 §11" while `§11` in `execution-workbook.md` is the progress table; the real home is **§5 测试纪律**, where it now lives. Lesson: cite section numbers by reading the file, not from memory (same failure class as the wrong `resumeFrom` id earlier today).

## M1.8 · 合并卡（CLI `hr` + Universal Skill 壳）→ `G4: PASS`

- **G1**（编写员）：`packages/cli/**` 12→13 文件（含抽取的 `resolve-hook.ts`）、`skills/hreader/**` 4 文件；门禁配置纳入新扫描面（cli 测试、`skills/**`、`allowImportingTsExtensions` 附注释）。
- **G2**（审计员）：FAIL 0×P0 / 2×P1 / 12×P2 →
  - P1-1 `hr read` 拒收裸 node id（`outline`/`patch` 打印的 id 喂不回去，两条被文档化的回路全断）；
  - P1-2 `--workspace` 不做 realpath（macOS `/private` 前缀 → 符号链接 workspace 全误判越界）；
  - P2 里最值得记的是**`--workspace` 不存在时报 `path_outside_workspace`**（误导性错误码）。
- **G3**（测试员）：`packages/cli/tests` **177 例**，全仓 1102→**1109**；变异 6/6 全杀；自己又抓出 `--workspace` 误导报文。
  - 这轮它给 `cli/src` 的 6 处覆盖率缺口做了正确分类（**分支不可达，不是测试漏**），逐条给了原因——这是本仓库第一次由测试员自己完成"死代码 vs 测试漏"的判别。
  - G3 首跑被看门狗杀掉：spawn 了读 stdin 的子进程却没关 stdin。已写进工作簿 §5「子进程卫生」。
- **R1–R5**（编写员）：裸 id 按 `①选择器→②裸 id→③两者都报` 顺序解析；realpath 两边取真（目标不存在时对父目录 realpath）；6 处死臂我逐条裁定（抽函数 / 删字段 / 删兜底 / 纯函数判码）；`knip` 5 条配置 hint 清零。
- **两个流程教训**（记在这里，因为都是"协调者失误"）：
  1. 我两次把任务发起给了**错误角色的会话**（`resumeFrom` 填错 id）；两次都在零写入时取消。规则：`resumeFrom` 必须对照 `state.md` 角色行核对，不许凭记忆。
  2. 我在派单里写了不存在的路径（`src/style/css.ts:36`）；编写员自己查出来后按意图正确修改，并在报告里写"我改的比你指的位置更对，因为有两份检查同时在跑"。**角色不该盲从协调者的行号**，我据此把"照抄协调者的行号当圣旨"写成了反面规则。
- **收口**：`pnpm verify` EXIT=0 / 84 文件 **1109 例** / 四维 100% / `knip` 零 hint。

## M2.1 — 本地 Daemon + SSE 同步桥（G4 PASS，提交 `M2.1`）

- 三方门禁：G1（编写员）→ G2 FAIL（2×P0/5×P1/9×P2）→ R1 修 3×P0 → G2-R PASS → G3（1439 例）→ R5 修丢写 P1 → R7/R8 覆盖与公共面收口 → G2-R2 PASS。
- 抓到的真问题（按价值排序）：
  1. **丢写**：`ageOf` 在 `lstat` 失败时返回 `MAX_SAFE_INTEGER`，刚建的锁被判"最陈旧"从而被抢；20 路并发时后写者覆盖前写者，全部返回 200。改为失败返回 `0` + `trySteal` 的 nonce 二次校验。
  2. **响应体泄露内部状态**：坏 JSON 打开失败时把绝对路径与配置原文写进了浏览器可见响应体。改为固定文案 + 细节只走 `--debug`。
  3. **SSE 帧注入**：`nodeId` 含 `\n` 可伪造 `event: doc.changed`。统一走 `frame(event, id, payload)` 做 JSON 序列化与 CR/LF 拒绝。
  4. **请求走私面**：`Transfer-Encoding: chunked` + `Content-Length` 并存时按 CL 处理。改为 400 直接拒。
- **测量口径教训（协调者判断失误，已记入手册 12.5）**：G2-R2 的"20 并发 8 s"来自 20 个独立 `hr patch` CLI 进程（冷启动），不是 daemon 请求；同条件另测为 449 ms/worst 445 ms。据此派的 R9 一度要撤销，但 `withDocQueue` 已实现并实测把 531 ms 降到 449 ms，且 `queue.ts` 100% 覆盖、清理逻辑有测试，故**保留**（理由从"修 8 s"改为"减少锁文件 churn + 进程内同文档顺序确定"）。
- 协调者自身错误留档：一次 `resumeFrom` 填错角色会话（已秒级取消、零写入）；一次派单给了错误路径；R9 的派单基于未对齐的性能数字。

## M2.2 立项（协调者裁定：零依赖手写 UI）

`docs/02` §5 原写"Vite + Preact/React"，与用户 2026-11-13 的"不新增任何依赖（含 dev）"冲突。裁定：**手写 DOM，无框架无 bundler**，`tsc` 直出 ESM，daemon 静态托管；`docs/02` 三处表述已同步。

核心设计（写进 `M2.2.md` §0/§2）：
- `Host` 接口是**唯一**碰真实 DOM 的适配器；`widgets/**` 只依赖接口与类型，测试用假 Host 即可驱动渲染逻辑，不依赖 jsdom。
- `keys.ts`（键盘→Intent）、`state.ts`（reducer）、`style-switch.ts` 是纯函数——把可测性放进结构里，而不是靠测试技巧。
- 不做虚拟 DOM、不做 diff：widget 自己维护 `update`。数据形状固定，通用 diff 是负资产。
- 分层由 depcruise 表达：`widgets` 不许 import `dom.ts` 实现；纯函数模块不许碰 `document`/`window`/`fetch`/`EventSource`。

**待用户确认（不阻塞）**：零依赖 ⇒ 无 jsdom，DOM 层只能靠 `Host` 假实现 + 手动浏览器验收。若要更高保真度，唯一办法是破例加一个 dev 依赖（如 `happy-dom`）。建议先零依赖做到 M2.4 再评估。

## M2.2 · 阅读器三栏骨架（零依赖手写 DOM）

- **范围**：`packages/app/**`（14 文件 → 1290 行）+ core 静态托管两条路由（`/`、`/assets/:path`）+ `GET /api/theme` + CLI `--app-dir`。路由 9 → 12。
- **门禁**：1643 例 / 133 文件 / 四维 perFile 100% / depcruise 308 模块零违规 / knip 干净 / `verify` EXIT=0（协调者复跑）。
- **6 轮返工关掉的真缺陷**：
  1. **SSE 帧 100% 被丢弃**（服务端 `event: doc.changed` vs 客户端只听 `message`）——增量链路运行时是死的，而 1568 例全绿、变异 6/6 全杀。→ 手册 §10.5「假件只能控时序，不能定义格式」。
  2. **`--app-dir` 词法器不认** → 静态托管整条链路不可达。
  3. **主题下拉完全无效**（`dispatchIntent` 只写 store，`themeSelected` 到不了 `selectTheme`），且被 `it.fails` 钉成"已知失败"。→ KD 登记制 + CAP。
  4. **点 TOC 不滚正文**（`scrollTo` 分支放在 `keyHandlerOf` 里，按键永远产不出该 intent）——覆盖率缺口把它暴露出来。→ 手册 §10.7「每层路由都要有从最外层入口出发的用例」。
- **流程收获**：
  - `it.fails` 一律禁止用于功能卡；已知缺陷只能走 `KD-nn` 标记 + `.workflow/known-defects.md` + CAP=10 的机械闸门（`known-defects-registry.test.ts`）。
  - 测试员两次自报"EXIT=0"不可复现 → 交付必须贴原始输出块，协调者在 commit 前自己复跑。
  - 覆盖率缺口先分类：**死代码 → 删**；**走错层的活代码 → 位移**（M2.2 R5 即此）；**真缺用例 → 补**。
  - `verify` 链加入 `pnpm build`（否则 `dist` 陈旧，验收时浏览器拿到旧 JS，绿是假的）。

## M2.3 · 划词批注持久化 + Visual Diff + 撤销

- **范围**：20 条 AC / 16 条路由。新增 `packages/core/src/server/annotation.ts`、`annotation-basis.ts`（重识别三档）、`diff.ts`（字符级 + 格子数闸）、`annotationOps.ts`、`annotation-replies.ts`；app 侧 `notes-*.ts` 四类批注面 + `diffview.ts`。
- **门禁（协调者亲跑，非自证）**：1951 例 / 167 文件 / 四维 perFile 100% / depcruise 372 模块零违规 / knip 干净 / `verify` EXIT=0，53.7s。
- **G2 首轮 FAIL(2×P0) 与收口轮关掉的真缺陷**：
  1. **`diffFlow` 扔掉服务端权威 `nodeId`**（`notes-wire.ts`），改用本地 `activeId` —— 而我们刚把 `nodeId` 提升为必填并让守卫强制校验。后果：文档编辑后批注重识别到新 id，diff 面板标到**已不在 DOM 的旧 id**。字段验了不用 = 没验。
  2. **`blockBasisOf` 的早退把"块丢了"报成"无变化"**（`annotation-basis.ts:101`）：工作区零快照 + 当前文档也没这块时，不给 `reason`、不置 `degraded`，用户看到「字符级对比、无变化」。测试员写用例把它钉红，并**拒绝**把断言改成 `toBeUndefined()` 蒙过去。
  3. `noteSettled` 的 `card` 字段零生产者（死字段）。
  4. `reduceNote` 用 `undefined` 当"该 intent 未处理"信号 + 尾部 `: state` 兜底 —— 死臂、且将来新增 kind 会被**静默吞掉**。改为类型穷尽（`Extract<…, noteSubmitted|noteSettled>`），并用"加一个假 kind 看它编译错"证明。
  5. 同一个零宽区间常量被抄三份（`html/span.ts`、`html/parse.ts`、`style/apply.ts`）→ 归一到一份真值源。
- **9 条全量红的归因**：3 条是协调者自己的登记失误（把三条"设计边界"编成 `KD-13/14/15` 塞进登记表，把 `CAP=10` 挤到 13）→ 改判 `L-01/02/03` 单列一节；6 条是测试过期，0 条 src 回归。
- **流程收获**：
  - **门禁分两层**：轻量四联（`format:check`+`lint`+`typecheck`，6s，每角色每次交付必跑、全仓）+ 重量四联（`build`+`coverage`+`depcruise`+`knip`，3–4min，收口时协调者跑）。教训：角色各自只跑"定向测试 + 自己文件的 eslint"会让全仓 lint 的 2 条旧契约残影躲到最后。
  - **变异表按"判定"列举，不按"函数"列举**：`sameSlotAs` 去掉 `&& slot.depth === previous.depth` 后**全套件全绿**——这条"同 tag 不同层不得继承身份"零覆盖，而行覆盖率看着很健康。首轮 SURVIVED 是收获，不是失误。
  - **钉具名集合，不钉计数**：`REQUIRED_ANCHORS.length toBe(17)` 涨到 33 时只报"expected 33 to be 17"，说不出变的是谁；改成 33 个 id 具名后，删任一条会**指名道姓**。数字断言在"删一个加一个"时全哑。
  - **测试辅助件也要有契约**：测试内 helper 标 `Promise<unknown>` 等于把契约扔了，正解是给具名返回类型，不是在调用处加收窄。
  - 静态规则会误报：`isDeferred` 对 `type="hidden"` 的 `input` 误报 → 移出交互元素集合（而不是靠豁免），并用"加真实探针元素必须红/必须绿"双向证明。

## M2.3 · 划词批注持久化 + 字符级 Visual Diff + 撤销

- **范围**：`packages/core/src/notes/**`、`packages/core/src/server/**`（16 条路由）、`packages/core/src/html/span.ts`、`packages/app/src/**`（notes-surface / diffview / rail / guard）。20 条 AC 全绿，126 文件 / +9807 / -3293。
- **门禁**：1951 例 / 167 文件 / 四维 perFile 100% / depcruise 372 模块零违规 / knip 干净 / `pnpm verify` EXIT=0（协调者复跑，53.7s）。**本卡是首次全链绿**。
- **关掉的真缺陷（按发现顺序）**：
  1. **`div` 假合法**（KD-01 假件造成）：块级容器被当"可承载 span 的元素"，整片正文可被框进一条批注又永远渲染不出来。→ 手册 §10.6「假件比没件更坏」。
  2. **数量相等 ≠ 身份不变**（KD-02 重识别用例）：`data-hr-id` 在字节级 patch 下被保留，块删了又插回来的新块顶替旧 id。→ 判据换成 `originNodeId` + `degraded:true`。
  3. **`diffFlow` 不校验权威 `nodeId`**（KD-08 假件写错字段）：给错块发 diff 也照单全收。→ 假件字段全部以源码为真值核对。
  4. **`blockBasisOf` 丢块报"无变化"**：工作区零快照 + 当前文档也没该块时，`degraded:false` 让用户看到"字符级对比、两版一致"。→ 补 `reason:"block_missing"` + `degradedReason`。
  5. **`ZERO_SPAN` 抄了三份**（`html/span.ts` / `html/parse.ts` / `style/apply.ts`）：三份字面量相同、注释各写各的。→ 归一到 `html/span.ts` 一处真值源。
  6. **reducer 穷尽性靠 `?? get()` 兜底**：新增 kind 时静默走默认分支。→ 返回类型改为 `Extract<NoteIntent, noteSubmitted | noteSettled> | undefined`，删除 `??`（写者的 `Exclude<…>` 方案被我否掉：它仍留 7 个死臂）。
- **流程收获**：
  - **三个角色的"自报绿"都必须由协调者复跑**：本卡测试员两次报 EXIT=0 而我复跑露 9 红——其中 3 条是我自己把"设计边界"错登记成 `KD-13/14/15`（`known-defects-registry.test.ts` 的 CAP/白名单闸门直接判红），已改判为 `L-01/02/03`（设计边界，非缺陷）。
  - **审计员的"类型能证明穷尽"比我的字面改法更可靠**：我给的方向是"删 `??`"，写者验证后指出我的 `Exclude<>` 仍留死臂——派单只说方向、允许被证伪。
  - **消红灯时不许靠放宽门禁**：`spanOf`/`ZERO_SPAN`/`HtmlSpan`/`BlockBasis` 四条 knip 红灯，全部靠"合并真值源 + 收窄门面导出"消掉，没有一条靠 `knipignore` 或 `as any`。
- **新增遗留（`.workflow/known-defects.md`）**：
  - `L-04`：`Host.focus`（`packages/app/src/dom.ts:53,141,159-161`）零调用点，死 seam（下一卡二选一：收回或启用）。
  - `L-05`：diff 响应体 `reason`（`contracts.ts:58`）与 `originNodeId`（`contracts.ts:53`）在 app 侧**零读取**——`isDiffResponse` 连字段都没列，用户看到的那句话来自 `degradedReason`。下一卡三选一：真读 / 标注"仅审计用" / 删掉。

## C1 · 清 `L-04` / `L-05`（死 seam + wire 零消费字段）

- **门禁**：1951 例 / 167 文件 / 四维 perFile 100% / depcruise 零违规 / knip 干净 / `pnpm verify` EXIT=0（协调者复跑，54.2s）。用例数与 M2.3 相同——纯删除，没有靠删断言换绿。
- **清掉的**：`Host.focus`（`dom.ts:53/141/159-161`）+ `ElementLike.focus?`（`:16`，写者主动发现的"第二条残腿"）；wire 的 `AnnotationDiffBody.reason` 与 `.originNodeId`（`contracts.ts`），内部 `BlockBasis` 语义一字未动（`degraded` 仍由 `basis.reason !== undefined` 驱动）。
- **9 条 wire 断言"转换而非删除"**：改成字段存在的反向锁，断言条数不减（basis 34→38、per-block 35→36、route 26→27）。测试员做**变异自检**：把两字段塞回 `annotation-replies.ts` → 9 条全红（其中 2 条 `expected 'hr-c' to be undefined` 证明 `originNodeId` 的锁真开火），还原后 sha256 逐字节一致。
- **卡自身的事实错误**：我写"`annotations-diff-basis.test.ts` 对 `originNodeId` 的断言测的是内部结构"——错，它们读 `fieldOf(body, …)`。写者撞红 9 条后才报上来。→ 新规矩：卡里凡"某测试测的是内部结构"，写卡时**必须打开文件看它读对象还是读 `body`**。
- **零消费字段的两种命运**（本卡最重要的判据）：`reason` **该删**（`degradedReason` 已把"降没降级、为什么"说完）；`revision` **该用/该留**（过期响应唯一判据）；`before`/`after` **该留**（core 侧 `rebuild(chunks) === after` 的交叉验证输入，删了 `chunks` 就成孤证）。留下来的必须在契约里写明"线上为什么有它"，且不许美化——`revision` 如实写"当前 app 尚未使用"。
- **注释也是代码的一部分**：`annotation-basis.ts:60-66` 原写"前端按 `originNodeId` 标这条批注原本属于哪块"，而 wire 已无该字段、app 从不读它。**代码删干净了、注释还在替它作证**——测试员报出、本卡修掉。
- **恒真断言比没断言更坏**：`boot.test.ts:97,116` 的 `not.toContain("focus")` 在 `focus` op 移除后结构上不可能失败。测试员删它之前先证明"原意图已由其它断言承接"（临时删 `boot.ts:273` 的副作用 → 用例变红 → 还原 sha256 一致），而不是删完就算。

## 2026-11-17 M4.3 开卡（协调者自行裁定，用户授权 m04153「你自己定，自己安排」）

- 选 M4.3 而非 M4.2/M4.x 的理由：纯前端、本卡自查不需要新依赖、产物是字符串可端到端断言；M4.2 要 Rust 工具链与签名，M4.x 要先裁定构建链。
- 拆卡：M4.3 只做**单文件自包含可打印 HTML**；真 PDF/长图拆到 M4.4（待立卡、需渲染器调研）。docs/02 M4.3 行已按此改写。
- 首次实践"卡片预审"：写者开工前先派审计员审卡片本身，抓到 7 条 P1（含 AC-4 计数与 `buildOutline` 语义不符、`empty_document` 是新码、`writeAtomic` 未导出、D7 绕过 `assertThemeSafe`、F3 缺解析层、D11/SKIP 自相矛盾、F4 脚本必须 `.ts`），卡升 v2。结论：**预审比事后审便宜一个数量级**。
