# test-M1.5 · hReader 增量 patch 测试报告（G3 / G3.2）

日期：2026-11-13 · 依据：`.workflow/cards/M1.5.md`（§6 六道门 + 尾部 v2 裁定 #1–#11、v3 #12–#15）、`.workflow/reports/impl-M1.5.md`
范围：`packages/core/tests/**`、`packages/core/fixtures/**`（`src/**` 未改）

## 0. 一句话实况

- 全仓 **675 passed / 2 todo / 0 failed**（49 文件）；M1.5 承担 `tests/io/**` 17 文件 **160 例**。
- `pnpm verify`：**红**——`format:check`（8 个 src 文件，编写员侧）、`test:coverage`（io 97.37% / patchNode 99.4%，硬门 100%）、`knip`（src 导出面 + fixture）。
  `lint` / `typecheck` / `depcruise` 全绿（tests 侧 `eslint` 0 error、`prettier --check packages/core/tests` OK）；`knip` 修好 src 导出面与 fixtures entry 后可回落。
- 变异体 **6 条全杀**（含 1 条反向变异）。

## 1. 用例清单（`packages/core/tests/io/`，160 例）

| 文件 | 例数 | 覆盖点 |
| --- | --- | --- |
| `patch-actions.test.ts` | 20 | 纯层 `applyPatch`：`insert_after` 落在兄弟位置（不是子节点）、`append` 到空元素、`delete` 根（清空 inner 且保留 `<article>`/属性）、`replace` 全等 → `changed:false`、span 越界/未知 action/非字符串 html → `invalid_input`、root 幂等判定 |
| `patch-file.test.ts` | 4 | 经 `io`：写盘 + 快照原字节、append 保留未触及子树、delete 不分配新 id、内容全等 → 不写盘不留历史（`changed:false`） |
| `corpus.test.ts` | 3 | 真实结构文章 round-trip：replace 后 `readNode` 能按新 id 读、append 进组件内部、delete 后 `node_not_found` |
| `v2-rulings.test.ts` | 8 | v2#1 AC4' CRLF+单引号+`&nbsp;`+BOM 只改目标区间（diff 区间断言）、delete 精确删区间、v3#12 实体写法差 → 返回原字节、v2#6 快照名 `sha256-16-<ts>-<seq>.html`、快照被篡改 → `io_failure` 且不消费、v2#7 活 pid 90s 不接管 / 死 pid 接管无残留 / tmp 只清死 pid |
| `undo-bytes.test.ts` | 2 | BOM / CRLF / 非 ASCII / 无末尾换行（+ 空文件、二进制）patch→undo 后 `sha256` 逐字节相等（`node:crypto` 自算） |
| `undo.test.ts` | 13 | undo 还原字节/删快照/回报 sha、二进制快照不解码、历史空 → `undo_unavailable`、写失败/删快照失败/历史不可读 → `io_failure` 且原文件不动、锁被占 → `locked`、快照名与内容不符 → 拒、listSnapshots 按 seq 排序、忽略无 hash 前缀名、prune 裁到 10、同毫秒 seq 递增 |
| `history.test.ts` | 3 | 连做 12 次 patch → 目录只剩 10 份且最旧 seq 1–2 被裁、undo×2 回到第 11 次之前的状态、无历史 → `undo_unavailable` |
| `lock.test.ts` | 13 | 假 clock 精确断言 2000ms 预算 / 25ms 重试间隔（不真等）、`locked` 边界、陈旧接管三型（mtime 老 / pid 不存在 / 内容损坏）、120s 活 pid 不接管、连发两次接管不能活锁、释锁读不到不抛 |
| `kill.test.ts` | 3 | **真实子进程** `fixtures/kill-writer.mjs`：写 tmp 后停 barrier → 父进程 `SIGKILL` → 原文件 sha 不变 + tmp 在盘；再 patch 一次 → 遗留 tmp 被清；barrier 未到就 kill 也不留半成品 |
| `concurrency.test.ts` | 3 | **真实双进程**同文件：一成功一 `locked`（或串行双成功）→ 最终可解析、sha 等于其中一次结果、绝不混合；活锁被占时不写 |
| `paths.test.ts` | 8 | 四种逃逸（`../x.html`、绝对路径、指向 workspace 外的符号链接、`mkdtemp` 外链目录）全 `path_outside_workspace` 且目标未创建；workspace 自身/`.hreader` 拒绝；内部链接按 realpath 记历史 |
| `fragment-gate-io.test.ts` | 2 | 经 io 的片段拒绝：`<ScRiPt>`/`<svg onload>`/`onfocus`/`&#106;avascript:`/`<meta http-equiv=refresh>`/多根/纯文本/`</style` 注入 → `forbidden_content`（或 `invalid_fragment`）且**文件字节不变** |
| `fragment-gate.test.ts` | 4 | 纯层 `guardFragment` 同上集合 + 空片段/纯空白/纯注释 → `invalid_fragment`（v3#13） |
| `facade.test.ts` | 5 | `io/index.ts` 门面只暴露 5 个入口、错误码透传、workspace 相对路径拒绝 |
| `node-fs.test.ts` | 5 | 真 fs 端口：打开/写/rename/unlink 的错误包装、`EPERM` 视为活进程 |
| `unit-helpers.test.ts` | 7 | 零散导出逐分支打满：`attrs` 三个取值函数（大小写敏感/宽松）、`bytes.decodeUtf8` 非法 UTF-8 → `io_failure` + BOM 保留、`isProcessAlive(0/-1/1.5)`、`readBytes` 读失败、不可 `lstat` 的 tmp 不删、不可读锁按无限龄接管 |
| `atomic.test.ts` | 9 | 原子写失败矩阵（rename/写入/建 tmp/读目录/父目录逃逸）→ 原文件不动 + tmp 不留；遗留 tmp 只清死 pid 或 >5min |

纯层隔离：`patch-actions.test.ts` / `fragment-gate.test.ts` 直接 `import ../src/ops/patchNode/**`，不经 `io`。

## 2. 变异体表（`packages/core/fixtures/mutants.mjs`，真跑，结果落 `mutants-result.json`）

| ID | 变异 | 结果 | 杀死它的用例 |
| --- | --- | --- | --- |
| M1 | 锁重试不按 `timeoutMs`（deadline+60s） | KILLED ×3 | `lock.test.ts` → "should retry every 25ms for the default 2000ms budget and then report locked"；"should keep a 120000ms old lock from a live pid and time out"；"should refuse a second takeover so two writers cannot livelock" |
| M2 | history 存"重新序列化"而非原字节（CRLF→LF） | KILLED ×1 | `undo-bytes.test.ts` → "should restore 'CRLF' byte for byte" |
| M3 | rename 前不删 tmp | KILLED ×2 | `atomic.test.ts` → "should replace the file, drop the tmp and sweep dead-pid tmp first"；"should fail before touching the target when the directory cannot be read" |
| M4 | `changed:false` 仍写盘+留历史 | KILLED ×1 | `patch-file.test.ts` → "should leave bytes and history untouched for identical content" |
| M5 | root replace 用整个元素区间（丢 `<article>` 属性） | KILLED ×2 | `patch-actions.test.ts` → "should replace all children but keep `<article>` and its attributes"；"should treat surrounding whitespace as different content" |
| M6（反向） | `isInsideWorkspace` 恒真（逃逸不再被拒） | KILLED ×4 | `paths.test.ts` → `../` / workspace 自身 / 外链文件 / 外链目录 四条 |

补充反向变异（手工，跑完已恢复 src）：把 `apply.ts` 的 span 拼接改回"整篇 `serialize`" → `tests/io` 38 例中 **28 红**（首红 `v2-rulings.test.ts` "should keep CRLF, single quotes, entities and the BOM byte-identical outside the target"）。
**回答"实现偷偷改回全篇重写哪条会红"：** `v2-rulings.test.ts:50`（区间 diff）、`undo-bytes.test.ts:54` 的 `each` CRLF 用例（`should restore CRLF byte for byte`）、`patch-actions.test.ts` 的 span 用例，三条独立命中。

## 3. `pnpm verify` 真实输出（2026-11-13）

```
$ pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm depcruise && pnpm knip
$ prettier --check .
[warn] packages/core/src/html/parse.ts
[warn] packages/core/src/io/atomic.ts
[warn] packages/core/src/io/lock.ts
[warn] packages/core/src/io/node-fs.ts
[warn] packages/core/src/io/patchFile.ts
[warn] packages/core/src/ops/patchNode/apply.ts
[warn] packages/core/src/ops/patchNode/fragment.ts
[warn] packages/core/src/ops/patchNode/ids.ts
[warn] Code style issues found in 8 files.   → EXIT=1
```

分阶段实跑（tests 侧已全绿）：

```
pnpm lint       EXIT=0   $ eslint . --max-warnings=0 --report-unused-disable-directives
pnpm typecheck  EXIT=0   $ tsc --noEmit -p tsconfig.json --pretty false
pnpm depcruise  EXIT=0   ✔ no dependency violations found (133 modules, 449 dependencies cruised)
pnpm knip       EXIT=1   Unused files (9) / Unused exports (8) / Unused exported types (5)
pnpm test:coverage EXIT=1
 Test Files  48 passed (48)
      Tests  675 passed | 2 todo (677)
 All files | 99.5 stmts | 98.58 br | 100 fn | 99.5 lines
 src/io | 97.37 | 95.08 | 100 | 97.37
 src/ops/patchNode | 99.4 | 97.71 | 100 | 99.4
```

### 3.1 归因

- **format:check（8 文件）＝ src 待修**：全部实现侧文件，`prettier --write` 即可，不涉及语义。
- **knip＝src 待修 + 我方待裁定**：`src/io/{atomic,history,lock,paths}.ts` 与 `ops/patchNode/attrs.ts` 有 8 个导出仅测试用（`TMP_PREFIX`/`removeStaleTmp`/`HISTORY_LIMIT`/`LOCK_RETRY_MS`/`DEFAULT_LOCK_TIMEOUT_MS`/`acquireLock`/`isInside`/`hasAttribute`）+ 5 个类型；另 `fixtures/*.mjs` 与 `tests/io/*.ts` 被 knip 当"未引用文件"（脚本与测试辅助，需 `knip.json` 的 entry 白名单，我不改配置 → **待裁定**）。
- **coverage＝我未补完 + 1 条 src 不可达**（详见 §4）。
- **两条 `it.todo`**：`tests/entry-points.test.ts:43`、`tests/outline-surface.test.ts:101` —— 公共面泄漏，等 G1-R1 导出面收口后转回真断言。

## 4. 覆盖缺口（io / patchNode 未达 100%，逐行）

| 文件 | 未覆盖行 | 补测方式（尚未写） |
| --- | --- | --- |
| `src/io/atomic.ts` | 60-61/63-64（父目录 `isMissing` → `path_outside_workspace`）、71-72（rename 目标变成符号链接） | 假 fs `state.dirs.delete("/ws")`；rename 前把目标换成 symlink（**本轮未写**） |
| ~~`src/io/bytes.ts`~~ | ✅ 已补（`unit-helpers.test.ts`） | 100% |
| `src/io/lock.ts` | 只剩 113-119（放回 steal 后的补偿 rename 失败分支；69-70 已补） | 篡改 nonce 后让 `rename(steal→path)` 抛（**本轮未写**） |
| `src/io/paths.ts` | 50-51（`statOf` 的 lstat 失败） | 目标存在性检查前注入 `lstat=ENOENT` |
| ~~`src/io/process.ts`~~ | ✅ 已补 | 100% |
| `src/ops/patchNode/apply.ts` | 53-54（`spanOf` 的 `{...ZERO_SPAN, ...}` 合并分支） | 直接传 `locations` 模式节点 |
| ~~`src/ops/patchNode/attrs.ts`~~ | ✅ 已补 | 100% |
| `src/ops/patchNode/fragment.ts` | 只剩分支 27、47（行覆盖 100%） | 反向：树外 `<set>` 不误杀已补 |
| `src/html/parse.ts` | 50 行的分支（`innerStart` 取 `startTag.endOffset` 的缺省臂） | 自闭合/隐式闭合标签 |

## 5. 待裁定（src 侧不可达或需配置）

1. **`src/io/atomic.ts:60-64` 疑似不可达**：`resolveParent` 前已 `realpath(workspace)` 成功，父目录消失只可能发生在 racy 删除，假 fs 能触发但真机难复现 → 若要 100% 覆盖需用假 fs 打（可做，非删代码）；若编写员认为该分支不可能出现，建议删掉并让 `realpath` 失败直接冒泡为 `io_failure`。
2. **`src/io/lock.ts:113-119` 补偿 rename 失败**：需要"第三个进程在 steal 窗口占位"，只有假 fs 能稳定构造；建议合并进 `lock.test.ts` 的假 fs 组而不是 mock 子进程。
3. **`knip.json` 需要给 `packages/core/{fixtures,tests/io}` 加 entry**，否则 9 个"未引用文件"永不消失（我不改配置）。
4. **v2#2 与 v3#12 措辞冲突**：v2#2 说"`changed` 看写盘字节"，v3#12 说"内容等价即原字节返回"。我按 v3#12 落地（`v2-rulings.test.ts` 内已注明），请把卡片 AC 文本同步，避免下一张卡又按 #2 写反。
5. **`ios` 门面错误码**：`fragment-gate-io.test.ts` 里多根片段实现给 `invalid_fragment`、含禁用标签给 `forbidden_content`；空片段按 v3#13 已是 `invalid_fragment`，若卡片 §4 表格不区分，请以 v3 为准补表。

ACP: test-M1.5 交付 · tests/io 17 文件 160 例全绿（全仓 675 passed / 2 todo，2 条 todo 等 G1-R1 导出面）· verify 仍红三处：format:check 8 个 src 文件（实现侧 `prettier --write`）、coverage io 97.37%/patchNode 99.4%（全仓 99.5%；剩余缺口 atomic 60-64/71-72、lock 113-119、paths 50-51、apply 53-54、fragment 分支 27/47，均已列 §4）、knip 需 src 导出面 + fixtures entry 配置；变异体 6 条全杀（M1 锁预算 ×3、M2 原字节快照 ×1、M3 遗留 tmp ×2、M4 changed:false ×1、M5 root span ×2、M6 反向逃逸 ×4），另手工反向变异"span→全篇 serialize" 令 38 例中 28 红，字节保真被回退必红。

## G3.3 · 覆盖率收尾 + v3#17 回归（2026-11-13）

### G3.3-a v3#17 回归（审计员抓到的真实漏洞，优先级高于覆盖率）

新增 `packages/core/tests/io/v3-animations.test.ts`（13 例，纯层 `parseFragment`，不经 io）：

| 组 | 输入 | 期望 |
| --- | --- | --- |
| `values` 逐项判（回归） | `values="safe;javascript:alert(1)"` / `"0 ; 1 ; JavaScript:alert(1)"` / `xlink:href` + `"a;b;data:text/html;base64,xx"` / `src` + `"ok;java&#9;script:alert(1)"` | `forbidden_content` |
| 单值不误杀 | `to="safe;../x.html"`、`values="0;1;0"`、`values="red;blue"` | `no_throw` |
| 动画 URL 目标（v3#16） | `attributeName="href"` + `to="javascript:…"` / `from="  JaVaScRiPt:…"` / `by="data:text/html,…"`；`<a href="safe;javascript:…">`；`<a xlink:href="0;data:text/html">` | `forbidden_content` |
| 非 URL 目标不误杀 | `attributeName="fill" to="red"`、`attributeName="opacity" values="0;1;0"`、树外 `<div><animate attributeName="href">` | `no_throw` |

对照组覆盖：`values='0;1;0'`（数字列表）、`values='red;blue'`（颜色列表）、`href='safe;javascript:x'`（通用属性扫描）。三条对照全绿 → 修的是"列表只判首项"，不是把列表整体误杀。

**为什么原套件没抓到（如实自查）**：不是我断言太弱，是**输入类缺失**——`tests/io/fragment-gate*.test.ts` 里 `values` 出现 **0 次**（`grep -c values` = 0），整个"动画改 URL 属性"向量从未进入测试语料；原用例只覆盖了 `href="javascript:…"` 直写、`on*` 事件、`<script>`/`<svg onload>`/实体混淆、多根。审计漏洞（`values` 列表只判首项）落在这条**从未被表示的输入轴**上，所以既没有红也没有误杀，属于"测了个看起来全的集合，却漏了一整类属性"。以后新增任何属性名分支，先在语料表里补齐 `{元素 × 属性 × 单值/列表}` 的三维交叉，而不是按"攻击样例"手工挑。

### G3.3-b 6 处覆盖率缺口的落点（现全部 100%，除 parse.ts 一处不可达）

| 位置 | 触发故障 | 用例 | 不变量 |
| --- | --- | --- | --- |
| `io/atomic.ts` 69-70 | `realpath(dir)` 跑出 workspace | `atomic.test.ts` "should refuse to write through a parent that left the workspace"（删 `/ws` 目录、只留 `/elsewhere`） | `path_outside_workspace`，原文件字节不变 |
| `io/atomic.ts` 77-78 | rename 目标是符号链接 | `atomic.test.ts` "should refuse when the parent realpath leaves the workspace" | `path_outside_workspace`，tmp 已清 |
| `io/lock.ts` 113-115 | 接管时 CAS 不符（移走的 nonce ≠ 手里的） | `lock.test.ts` "should drop the stolen copy and retry when the nonce changed mid-takeover" | 不写回、steal 副本被删、最终 `locked` |
| `io/lock.ts` 54（`isMissing` 真臂） | `open` 成功但 `readFile` 抛 ENOENT | 新增 `lock-errors.test.ts` "should treat an ENOENT on read as 'lock gone' and retry until the budget ends" | `locked`，锁体 `nonce:"alive"` 原样保留 |
| `ops/patchNode/fragment.ts` 79-80,90-94 | `values` 列表含危险项 | `v3-animations.test.ts` 第一组 4 例 | `forbidden_content`，不产树 |
| `html/parse.ts` 50 | 元素有 `sourceCodeLocation` 但无 `startTag` | **不可达**（见下） | — |

`parse.ts:50` 的 `location.startTag === undefined` 分支不可达（实证）：`sourceSpanOf` 只在 `parse.ts:164` 对元素调用；唯一"有 location 无 startTag"的节点是 `#text`；元素侧我跑了 12 个规范构造（`</br>`、游离 `</p>`、`<template>`、adoption agency、`<frameset>`、SVG/MathML 混合）+ 4000 例随机标签串 fuzz + 仓库全部 fixture，**没有一例**元素带 location 而无 startTag —— `</br>`/`</p>` 造出的隐式元素 `sourceCodeLocation === null`，走的是 `ZERO_SPAN` 假臂（已覆盖）。**待裁定**：建议改法不是 `/* v8 ignore */`，而是把守卫升到类型层（`const startTag = location.startTag as NonNullable<…>` + 注释说明 parse5 对元素必给 startTag），运行时不再有分支，也不失守卫价值（VS Code 里类型仍可选）；若坚持保留运行时守卫，则只能给该文件单独放宽 branch 阈值，二者选一。

### G3.3-c 覆盖率前后

| 指标 | R4 交付 | G3.3 后 |
| --- | --- | --- |
| 行 | 99.57% | **100%** |
| 分支 | 98.83% | **99.91%**（唯一缺口 = `html/parse.ts:50` 不可达分支） |
| 函数 / 语句 | 100% | 100% |
| 用例 | 675 passed / 2 todo | **700 passed / 2 todo**（51 文件） |
| `io` / `patchNode` | 97.37 / 99.40 | **100 / 100**（含分支） |

### G3.3-d `pnpm verify` 真实输出（EXIT=1，仅 coverage 一步）

```
$ pnpm verify
$ prettier --check .              → All matched files use Prettier code style!   EXIT=0
$ eslint . --max-warnings=0 …     → EXIT=0
$ tsc --noEmit -p tsconfig.json   → EXIT=0
$ vitest run --coverage
 Test Files  51 passed (51)
      Tests  700 passed | 2 todo (702)
 All files          |     100 |    99.91 |     100 |     100 |
-------------------|---------|----------|---------|---------|
ERROR: Coverage for branches (98.5%) does not meet global threshold (100%) for packages/core/src/html/parse.ts
ELIFECYCLE  Command failed with exit code 1.
$ depcruise / knip               → 未在 verify 内执行（第 4 步已失败）；单独跑均 EXIT=0（0 违规 / --strict 无输出）
```

红点只有一处、且是"不可达分支"，属 src 侧待裁定项（§G3.3-b 末段），测试侧已无可补。

ACP: G3.3 收尾 · 全仓 700 passed / 2 todo / 0 failed（51 文件），行/函数/语句 100%，分支 99.91%（唯一缺口 html/parse.ts:50 不可达分支，已实证：sourceSpanOf 仅对元素调用、元素必有 startTag，12 构造 + 4000 fuzz + 全 fixture 零反例，建议改类型层守卫而非 ignore）；v3#17 回归 13 例落 `tests/io/v3-animations.test.ts`（values 逐项判 ×4 拒绝、单值不误杀 ×3、动画 URL 目标 ×5 拒绝、非 URL 目标 ×3 放行）；原套件没抓到的原因是输入类缺失——fragment-gate 里 `values` 出现 0 次，整条"动画改 URL 属性"输入轴从未进语料，教训：新增属性分支时按 {元素×属性×单值/列表} 三维交叉补语料；io/patchNode 双维 100%，verify 仍红仅 coverage 一项（parse.ts 不可达分支），待裁定两条：parse.ts 守卫改类型层、或该文件分支阈值单独放宽。

## G3.4 · foreign `template` 裸崩回归 + 输入轴矩阵（2026-11-13）

### G3.4-a 新增 `packages/core/tests/html/foreign-template.test.ts`（13 例）

根因：`parse.ts` 的 `isTemplate` 曾只看 `nodeName`，而 parse5 只给 **HTML 命名空间**的 `template` 挂 `content`；foreign content（svg/math）里的同名元素是普通元素，读 `content.childNodes` 直接 `TypeError: Cannot read properties of undefined (reading 'childNodes')`。修复后改为 `hasTemplateContent = (node) => "content" in node`。

| 组 | 用例 | 断言 |
| --- | --- | --- |
| 不崩 + 子树不丢（`it.each` 6 例 × 2 模式） | `<svg><template>x</template></svg>`、`<svg><template>`、`<svg><TEMPLATE>y</TEMPLATE></svg>`、`<math><template>z</template></math>`、带 `<text>` 子元素、`<foreignObject>` 内嵌 | 不抛；`template` 元素恰好 1 个；`textOf(tree)` 等于原文文本；`children` 长度正确（未闭合 = 0）；序列化后子树仍在原处 |
| 往返字节保真 | `DOC('<svg><template><circle cx="1"></circle></template></svg>')` | `serialize(parse(x)) === x`，且跑第二遍往返仍 `=== x`（钉子：不崩 ≠ 没丢内容） |
| 规范化边界 | `cx='1'` + `/>` 变体 | 树里 `attrs === [["cx","1"]]`（内容没丢）；序列化按仓库既有约定统一双引号并展开自闭合 → 断规范化结果，不把规范化误判成丢内容 |
| span | `locations: true` | `svg` = `{0,33,5,27}`、`template` = `{5,27,15,16}`：位置来自源码，不是 ZERO_SPAN |
| `parseFragment`（applyPatch 入口） | 3 条（svg 文本 / math / 大写） | 返回树且含 `template` 元素，**不是 TypeError** |
| 未闭合 | `parseFragment("<svg><template>")` | 抛 `invalid_fragment`（结构校验），**不是 TypeError** |
| 真模板对照组（2 例 × 2 模式） | `<template>x</template>` 在 `<head>` | 子节点照常在 `children`、无 `<content>` 包裹、`serialize` 与原文一致、span = `{12,34,22,23}` |

**可证伪性**：旧实现（`nodeName === "template"`）在这 6 条 foreign 输入上会在 `descendantsOf` 里读 `undefined.childNodes` 抛 `TypeError`；第一个 `it.each` 里我把 `parse` 的异常包成 `Error("…解析 … 抛了 …")` 显式失败，其余用例直接抛在 `parseHtml` 调用处——任一条都会红，不存在"修复前后都绿"的空转断言。

### G3.4-b 输入轴矩阵（把 v3#17 的教训固化）

片段校验（`parseFragment` / `guardFragment`）的语料必须按三维交叉，而不是按攻击样例手工挑：

| 轴 | 取值 | 语料状态 |
| --- | --- | --- |
| 元素 | `svg`(animate/set) / `math` / `foreignObject` / 普通 HTML / 树外 | 已覆盖（G3.4-a + v3-animations） |
| 属性名（URL 类） | `href` / `xlink:href` / `src` / 动画的 `attributeName` 值 | **G3.4 补齐 `src`、`xlink:href`、通用扫描 `xlink:href`** |
| 属性名（非 URL） | `fill` / `opacity` / `stroke-width` / `class` | 已覆盖（不误杀） |
| 取值形态 | 单值 / `;` 列表（`values`）/ `to`·`from`·`by` / 实体与制表符混淆 / 大小写混写 | **G3.4 补齐 `from`/`by` 与 src 列表** |

**G3.4 新增 7 例（`tests/io/v3-animations.test.ts`）**：
- 拒绝（5）：`attributeName="src" from="javascript:…"`、`src by="data:text/html…"`、`src values="ok;javascript:…"`、`set xlink:href values="a;b;data:text/html"`、通用扫描 `xlink:href="safe;javascript:…"` → 全部 `forbidden_content`。
- 放行（3，防过度收紧）：`src values="a.png;b.png"`、`xlink:href to="https://ok.example/a;b"`、`stroke-width values="1;2;1"`。
语料规则写进本节：**任何新增"属性名有语义"的分支，必须同时在上述三维里补格，否则不允许合并。**

### G3.4-c `pnpm verify` 真实输出（EXIT=0）

```
$ pnpm verify
$ prettier --check .            → All matched files use Prettier code style!
$ eslint . --max-warnings=0 …   → （无输出）
$ tsc --noEmit -p tsconfig.json → （无输出）
$ vitest run --coverage
 Test Files  52 passed (52)
      Tests  721 passed | 2 todo (723)
 All files          |     100 |      100 |     100 |     100 |
$ depcruise …                   → ✔ no dependency violations found
$ knip --strict                 → （无输出）
EXIT=0
```

（首次跑 verify 红在 `format:check`：新文件未过 prettier；`--write` 后重跑即 EXIT=0。用例从 G3.3 的 700 增至 **721**，四维 100%。）

ACP: G3.4 收尾 · 新增 20 例（`tests/html/foreign-template.test.ts` 13 例 + `tests/io/v3-animations.test.ts` 输入轴 7 例），往返断言**通过**（`serialize(parse(x)) === x` 且二次往返稳定，`<circle cx="1">` 子树保留），`pnpm verify` **EXIT=0**（52 文件 / 721 passed / 2 todo / 四维 100%）；foreign `template` 回归覆盖 svg/math/大写/未闭合/foreignObject 六类 × locations 开关，对照组证明真模板 `<content>` 语义未变；输入轴矩阵已写进 §G3.4-b 并补上 `src from/by`、`src values`、`xlink:href` 列表共 5 条拒绝 + 3 条放行。
