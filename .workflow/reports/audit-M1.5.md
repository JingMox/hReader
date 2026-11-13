G2: FAIL

# 审计报告 · M1.5（`hr_patch_node` / 原子写 / undo）

- 审计对象：工作区脏（未提交）。`git status --porcelain` = 6 个 `M` + 4 个 `??`；新增源码 **21 文件 / 1171 行**（`packages/core/src/io/**` 14 文件 734 行、`packages/core/src/ops/patchNode/**` 7 文件 437 行），另有未申报的 `packages/core/tests/io/**` + `packages/core/fixtures/**` **11 文件 / 1389 行**。
- 唯一依据：`.workflow/cards/M1.5.md`；自证 `.workflow/reports/impl-M1.5.md`。
- 环境：Node v24.15.0 / macOS（APFS 大小写不敏感）/ `parse5 8.1.1`。探针脚本 `/tmp/m15/p1..p15.mjs`，均通过 `packages/core/fixtures/load-src.mjs` 加载**真实源码**，不是替身实现。本报告全部"实测输出"为本人复跑所得，未采信自证。
- 结论：**2×P0 / 9×P1 / 12×P2**。分层与大部分原子写不变量是干净的（见 §3 PASS 清单），但**路径安全有一处可稳定利用的 workspace 逃逸**，且**交付态连 `pnpm verify` 的第一步都过不了**。

---

## 1. P0（阻断）

### P0-1 父目录符号链接替换 TOCTOU → 可在 workspace 外任意落盘

| 位置 | 代码 |
| --- | --- |
| `packages/core/src/io/paths.ts:68-70` | `workspaceReal = realpath(ws)`；`realPath = realpath(lexical)`；`isInside(workspaceReal, realPath)` 校验 |
| `packages/core/src/io/patchFile.ts:37` | `await writeAtomic(deps.fs, target.realPath, bytes)` |
| `packages/core/src/io/atomic.ts:13-14` | `join(dirname(path), \`.hr-tmp.${basename}.${nonce}\`)` |
| `packages/core/src/io/atomic.ts:36,43` | `open(tmpPath)` → `rename(tmpPath, path)` |

`paths.ts` 的校验**只对字符串做一次**，之后 `patchFile.ts:37` → `atomic.ts:36/43` 用同一路径串重新做系统调用。`realPath` 的**父目录**在两步之间被换成指向 workspace 外的符号链接时，tmp 与 rename 都落到外部，且 `resolveTarget` 已跑完、没有任何再校验（`lstat` 目标本体也不再看）。

复现：

```
node /tmp/m15/p11.mjs
```

实测输出（节选）：

```
[0] baseline: true
  [swap] ws/sub -> symlink /var/folders/.../T/m15out-F2PZCi (before tmp open)
[1] patch ok= true  path= /private<ws>/sub/doc.html
    outside file exists? true  content= "<html><head></head><body><article data-hr-id=\"a1\"><section data-hr-id=\"s1\">PWNED</section></article></body></html>"
```

即：调用方拿到 `changed=true` 和"工作区内路径"，实际内容被写进了 `/tmp/m15out-*`。攻击者只需在 workflow 目录内控制一个子目录（例如 `docs/` 下的临时目录、或用户可写的 `drafts/`），即可把整篇 HTML 写到任意可写位置（`~/.ssh/authorized_keys` 之外的任意 `.html`，以及覆盖任意已存在文件）。

修法方向（按优先级）：不要"校验字符串再按字符串写"；改为**open 父目录 fd（`O_DIRECTORY|O_NOFOLLOW`）后 `renameat`/`openat` 相对 fd 操作**（Node 无原生接口则至少：写 tmp 前对 `dirname(realPath)` 重新 `realpath` + `isInside` 复核，rename 前再复核一次，并在 tmp 侧用 `O_EXCL|O_NOFOLLOW`）。

### P0-2 交付态 `pnpm verify` 六步中五步红；自证"全绿"不可复现

卡片 `.workflow/cards/M1.5.md:107` 的门禁 1 明确要求：`pnpm verify` EXIT=0。实测（本工作区，未改任何文件）：

```
$ pnpm format:check      -> EXIT=1
[warn] packages/core/tests/io/harness.ts
[warn] packages/core/tests/io/patch-actions.test.ts
[warn] packages/core/tests/io/patch-file.test.ts

$ pnpm lint              -> EXIT=1
packages/core/tests/io/patch-file.test.ts
   7:36  error  'undoPatch' is defined but never used     @typescript-eslint/no-unused-vars
  10:10  error  'codeOfAsync' is defined but never used
  11:33  error  'found' is defined but never used
  30:31  error  Arrow function has too many lines (44). Maximum allowed is 40
✖ 4 problems (4 errors, 0 warnings)

$ pnpm typecheck         -> EXIT=2
packages/core/tests/io/harness.ts(37,57): error TS2322: Type 'Promise<string | undefined>' is not assignable to type 'Promise<void>'
packages/core/tests/io/patch-file.test.ts(7,36): error TS6133: 'undoPatch' is declared but its value is never read.
packages/core/tests/io/patch-file.test.ts(10,10): error TS6133: 'codeOfAsync' is declared but its value is never read.
packages/core/tests/io/patch-file.test.ts(11,33): error TS6133: 'found' is declared but its value is never read.

$ pnpm test:coverage     -> EXIT=1
 Test Files  3 failed | 32 passed (35)
      Tests  3 failed | 544 passed (547)

$ pnpm depcruise         -> EXIT=0   ✔ no dependency violations found (113 modules, 346 dependencies cruised)
$ pnpm knip              -> EXIT=1   (见 P2-8)
```

三个红用例（`pnpm -s test:coverage` 原文）：

```
FAIL packages/core/tests/entry-points.test.ts > package public surfaces > should not leak internal symbols onto the public surface
AssertionError: expected [ 'applyPatch', 'parseFragment', …(3) ] to deeply equal []
  ❯ packages/core/tests/entry-points.test.ts:43:24

FAIL packages/core/tests/outline-surface.test.ts > ops facade > should expose exactly buildOutline at runtime
AssertionError: expected [ 'applyPatch', 'buildOutline', …(2) ] to deeply equal [ 'buildOutline', 'readNode' ]
  ❯ packages/core/tests/outline-surface.test.ts:101:42

FAIL packages/core/tests/io/undo-bytes.test.ts > undo · 无快照与失败路径 > should keep the snapshot and the file when the atomic restore fails
AssertionError: expected 'not_a_file' to be 'io_failure'
  ❯ packages/core/tests/io/undo-bytes.test.ts:91:18
```

后两条与本卡实现直接相关（第一条是公共面泄漏，见 P2-9；第二条是**本卡自己新增的测试就是红的**）。第二条的成因：`packages/core/src/io/undo.ts:36` 先 `resolveTarget` 再看历史，测试用假 fs 让 `realpath` 失败时错误码变成 `not_a_file` 而非 `io_failure` —— 顺序与错误码契约不一致。

自证与实测的矛盾点，逐条对齐：

- `impl-M1.5.md:3`「`tsc` EXIT=0、`eslint packages/core/src` 0 warning」——**收窄了作用域**：仓库门禁是 `tsc --noEmit -p tsconfig.json`（含 `tests/**`）和 `eslint .`；`src` 之外全红。
- `impl-M1.5.md:4`「`pnpm verify` 按 G1 裁定**本轮不跑**（knip 在测试未落地时必红）」——我在 `.workflow/cards/M1.5.md`、`.workflow/state.md`、`.workflow/execution-manual.md`、`.workflow/reports/audit-M1.4.md` 中**未找到任何豁免裁定**；卡片 §6 只写了"`pnpm verify` EXIT=0"。这属于**自证虚构授权**，比红更严重：G3/G4 会按裁定口头放行而漏掉上面三条红。
- `impl-M1.5.md:42`「该文件是卡片允许的唯一测试改动」——卡片全文无此授权（见 P2-10）。
- `impl-M1.5.md:50`「新增 20 文件、+1172 行」——实测 **21 文件 / 1171 行**（`packages/core/src/io/index.ts` 14 文件 734 行 + `ops/patchNode` 7 文件 437 行）；另有 **11 文件 / 1389 行** 未申报的 `tests/io/**` + `fixtures/**`。

---

## 2. P1（规格违背 / 高危）

### P1-1 锁可被抢走：空锁体窗口 + 只看年龄不看存活

- `packages/core/src/io/lock.ts:42-49`：`decodePayload` 解析失败 → `undefined`；`:51-60` 读失败（ENOENT）→ `undefined`。
- `packages/core/src/io/lock.ts:74-75`：`isStale(undefined) === true`。
- `packages/core/src/io/lock.ts:125-131`：判定陈旧即 `unlinkQuiet` 并 `continue`，**不看 nonce、不问持有者**。
- `packages/core/src/io/lock.ts:82-89`：`open`（建文件）到 `write`（写 payload）之间就是一个 **payload 尚未落盘的窗口**，此时另一进程读到空文件即判"陈旧"并删除。

```
$ node /tmp/m15/p5.mjs
[A] live lock, lockTimeoutMs=1999 -> locked elapsed=2137ms (expected <= 1999ms)
[B] empty lock (live writer's window) -> ACQUIRED (stole a live lock); lock file present after = false
[C] lock owned by live pid but at=now-61s -> ACQUIRED (takeover of live holder)
[D] dead pid lock -> ACQUIRED+patched; lock left behind = false
[E] garbage lock body -> ACQUIRED
[F] pid=-1, at=future -> ACQUIRED elapsed=0ms
```

`[B]` = 两个进程可同时持锁 → 丢更新（AC6 的反面）。`[C]` 说明 `isStale`（`:74-78`）在 `!isProcessAlive(pid)` 之外还允许"年龄 > 60s 即接管"，**持有者还活着也照删**；`READ` 到 rename 之间慢于 60s 的 patch（大文档 + 慢盘）就会被顶掉。`[F]` 说明 payload 无任何信任边界校验（`pid: -1` 会走到 `process.kill(-1, 0)`，即对**整个进程组**做权限探测）。

修法：payload 缺失/不可解析 ≠ 陈旧（应视作"刚被创建"，重试而非接管）；接管必须走"CAS"：把锁文件 `rename` 成自己的 `.takeover` 再读内容比对 nonce，失败则退让；`at` 需要持锁方周期性 touch 才能作为唯一判据。

### P1-2 遗留 tmp 清理会误删并发写者的 tmp（无归属校验）

`packages/core/src/io/atomic.ts:11`（固定前缀 `.hr-tmp.`）+ `:17-22`（**只要名前缀匹配就 unlink**）+ `:35`（每次写前都跑）。锁是**按文件**的（`paths.ts:82-83` 用 `sha1(relative)`），同目录下另一个文件的并发写者持有的是另一把锁，其 tmp 会在本进程的 `removeStaleTmp` 里被删掉。

```
$ node /tmp/m15/p3.mjs   # 段 [7]
[7] stale-tmp] patch victim.html ok=true; foreign tmp .hr-tmp.other.html.a1b2c3d4e5f6 still exists = false
```

后果：并发者 `rename(tmp → target)` 时 tmp 已被 unlink → 其 patch 以 `io_failure` 失败（写者视角的"随机失败"），极端情况下 tmp 已被删除而进程仍在写 fd，最终 rename 报 ENOENT，**待写入内容丢失**。修法：tmp 名带 pid+nonce 后按"mtime 超过 N 分钟"才回收，或回收前 `lstat` 校验 owner（同一 pid 命名空间）。

### P1-3 root 保护可绕过：用真实 `data-hr-id` 删掉整个 `<article>`

`packages/core/src/ops/patchNode/apply.ts:69-73`：只有 `targetId === "root"`（`constants.ts:20`）才走 root 分支；`:122-125` 的 `delete` 拦截也只对 `isRoot` 生效。用 `<article>` 自己的 `data-hr-id` 打就是普通节点操作。

```
$ node /tmp/m15/p13.mjs
[7] delete article via real data-hr-id
   changed=true newIds=[]
   html=<html><head></head><body></body></html>
```

`[2d]` 同理会把兄弟节点插到 `<article>` **外面**（`<body><article …/></article><section>X</section></body>`）。产出文档不再满足"正文是单个 `<article>`"这一 M1 全链路不变量，`buildOutline`/`readNode` 在下一个环节炸。卡片 `M1.5.md:112` 把"root 保护失效（删掉 `<article>` 属性）"列为必须被杀死的变异体，这条正好是漏网的那只。

### P1-4 片段自带的 `data-hr-id` 直接采用，不查重 → 文档出现重复 ID

`packages/core/src/ops/patchNode/apply.ts:141-145`：`injectNodeIds` 只给**缺** id 的元素补，已有的原样保留；`PatchOutcome.newIds` 只报新分配的 → 调用方无从得知撞了。

```
$ node /tmp/m15/p13.mjs   # 段 [4]
[4] root=root append identical (pretty)
   changed=true newIds=[]
   html=<html><head></head><body><article data-hr-id="a1" class="post" lang="zh">
  <section data-hr-id="s1">A</section>
<section data-hr-id="s1">A</section></article></body></html>
```

两个 `data-hr-id="s1"`。`locateTarget`（`locate.ts`，首个命中）后续一律打到第一个 → 第二个永远不可达，undo/patch 语义漂移。修法：片段解析后对 id 做 collect，与文档现存 id 求交，冲突即 `invalid_input`（或重分配并进 `newIds`）。

### P1-5 BOM 每次 patch 累积一份（+3 字节）

`packages/core/src/io/bytes.ts:10`（`ignoreBOM: true`，刻意不丢 BOM）+ `:37-42`（`withBom` 无条件把 BOM 拼回**序列化结果**前面）。但 parse 出来的 BOM 文本节点留在 `<body>` 起始处，序列化时又被写出来，于是"原 BOM + 文本节点 BOM"叠起来。

```
$ node /tmp/m15/p3.mjs   # 段 [1]
[1 BOM] orig BOM count=1 bytes=145
  after patch#1: ok=true BOM count=2 bytes=179 head=efbbbf3c68746d6c3e3c6865 bodyHead=3c626f64793eefbbbf0a3c74
  after patch#2: ok=true BOM count=3 bytes=228 bodyHead=3c626f64793eefbbbfefbbbf
  after patch#3: ok=true BOM count=4 bytes=277 bodyHead=3c626f64793eefbbbfefbbbf
```

每 patch 一次 +3 字节，`<body>` 后堆 ZWNBSP。AC4 要求"仅目标节点变化"，这里每次都变。修法：`decodeUtf8` 收到 BOM 后先剥掉再 parse 文本（`text.slice(1)` / 用 `ignoreBOM:false`），`withBom` 只负责序列化一层。

### P1-6 整篇 CRLF / 引号 / 实体被重写（AC4 "只改目标节点" 不成立）

`packages/core/src/io/patchFile.ts:23`（全量 `applyPatch(decode(original))`）+ `:36`（全量 `encode(outcome.html)`）：任何一次 patch 都是"整篇 parse → 整篇 serialize"。

```
$ node /tmp/m15/p3.mjs   # 段 [2]
[2 CRLF churn] ok=true originalCRLF=12 afterCRLF=0 afterLF=10
  untouched <p> line before="    <p data-hr-id=\"p1\">keep &amp; me</p>"
  untouched <p> line after ="    <p data-hr-id=\"p1\">keep &amp; me</p>"
  meta quote before="  <meta name=\"x\" content='single' />" after="  <meta name=\"x\" content=\"single\">"
  nbsp before=true after=false afterRawNbsp=true
```

横行 12 处 CRLF 全变 LF，单引号属性被改双引号、自闭合 `/>` 被改 `>`，`&nbsp;` 变成原始 U+00A0 字节。对"AI 一次 patch、用户 git diff"的场景这是**整文件 diff**，把"增量 patch"的意义抹掉了（卡片 §5 明确"不做 diff"——但这里的副作用等价于制造了伪 diff）。修法：至少在"目标节点之外"保留原始源片段（parse5 带 `sourceCodeLocationInfo` 做局部替换），或明确把"整篇重排"写进 AC 并承认代价。

### P1-7 片段校验漏网：`<base href>` / `<meta charset>` / `<svg><set attributeName=onload>`

- `packages/core/src/ops/patchNode/constants.ts:31-38`：`FORBIDDEN_TAGS` = script/style/iframe/object/embed/link，**不含 `base`**。
- `packages/core/src/ops/patchNode/fragment.ts:34-36`：只拦 `<meta http-equiv>`，`<meta charset>` 放过；`<svg><set>` 不在 `on*` 属性黑名单的触发面上（属性名是 `attributeName`）。

```
$ node /tmp/m15/p2.mjs
BLOCKED  svg onload                         -> forbidden_content: 片段含事件属性 onload（<svg>），已拒绝
ACCEPTED svg <set attributeName=onload>     changed=true out=<article data-hr-id="a1"><svg><set attributeName="onload" to="alert(1)"></set></svg></article>   <<< DANGER
BLOCKED  meta refresh                       -> forbidden_content: 片段含 <meta http-equiv>（可改写文档行为），已拒绝
ACCEPTED meta charset                       changed=true out=<article data-hr-id="a1"><meta charset="utf-16"></article>   <<< DANGER
ACCEPTED base href                          changed=true out=<article data-hr-id="a1"><base href="https://evil.example/"></article>   <<< DANGER
ACCEPTED style attr w/ javascript:url       changed=true out=<article data-hr-id="a1"><section style="background:url(javascript:alert(1))" data-hr-id="hr-5943792b">x</section></article>   <<< DANGER
ACCEPTED xmp raw text                       changed=true out=<article data-hr-id="a1"><xmp><img src=x onerror=alert(1)></xmp></article>   <<< DANGER
ACCEPTED noembed raw text                   changed=true out=<article data-hr-id="a1"><noembed><img src=x onerror=alert(1)></noembed></article>   <<< DANGER
```

严重度判断（自己构造，逐条记结论）：

| 输入 | 结果 | 判定 |
| --- | --- | --- |
| `<base href="https://evil.example/">` | **ACCEPTED** | **P1**：改写整篇文档基准 URL，所有相对资源/链接被劫持（比 `onerror` 更隐蔽） |
| `<meta charset="utf-16">` | **ACCEPTED** | **P1**：charset 切换 → 后续字节按 UTF-16 重解，典型 charset-switch XSS；同类的 `http-equiv` 已被拦，`charset` 漏了 |
| `<svg><set attributeName="onload" to="alert(1)">` | **ACCEPTED** | **P1**：用 SVG 动画属性凭空造出 `onload`，绕过 `on*` 属性黑名单 |
| `<ScRiPt>` / `<scr<script>ipt>` / `<math><mtext><script>` / `onFOCUS` / `javascript:`+空白+大小写 / `&#106;avascript:` / `&colon;` / `java&Tab;script:` / `form action=javascript:` / `template` 包 `onerror` | BLOCKED | PASS（这部分做得对） |
| `style="background:url(javascript:alert(1))"` | ACCEPTED | P2（现代浏览器不执行 CSS `url(javascript:)`；仅二次处理时成为放大器） |
| `<xmp>`/`<noembed>` 包 `<img onerror>` | ACCEPTED | P2（浏览器按 raw text 解析 → 冻结文件里是惰性的；换任何二次处理器即成 mXSS） |

修法：`base` 入 `FORBIDDEN_TAGS`；`meta` 除 `http-equiv` 外禁 `charset`；`<svg>` 子树里禁 `set`/`animate`/`animateTransform` 且禁 `attributeName` 取 `on*`；`style` 属性做 CSS 值扫描（至少禁 `url(` 里的非 http(s) 协议与 `expression(`）。

### P1-8 AC7 幂等在"美化过"的文档上失效：无变更也写盘 + 留历史

`packages/core/src/ops/patchNode/apply.ts:99-101`：root replace 的快路径要求 `article.children.length === 1`；**格式化过的文档里 `<article>` 的 children 是 [文本, 元素, 文本]**，快路径永不命中。

```
$ node /tmp/m15/p13.mjs
[1] root=root replace identical content (pretty, 3 children)
   changed=true newIds=[]
   html=<html><head></head><body><article data-hr-id="a1" class="post" lang="zh"><section data-hr-id="s1">A</section></article></body></html>
[8] root replace identical (compact, 1 child)
   changed=false newIds=[]
```

`[1]` 不仅 `changed=true`，还把原有的换行缩进**吃掉了**（同一内容、两次不同字节）。卡片 `M1.5.md:35` 要求"编排层不得写盘、不得留历史"，这里会多写一次盘 + 多留一份快照（并挤掉一份真历史，`history.ts:9` 只留 10）。修法：比较前过滤纯空白文本节点（或对 `article` 的 children 做"忽略空白"集合比较）。

### P1-9 损坏快照被静默写回（undo 无完整性校验，`sha256` 自指）

`packages/core/src/io/undo.ts:23-27`：读快照 → 直接 `writeAtomic` 回目标 → 删快照 → 返回 `sha256Hex(bytes)`。没有"快照是否是完整 HTML"或"当前文件是否仍是我们要撤销的那一版"的任何检查。

```
$ node /tmp/m15/p6.mjs   # 段 [truncated snapshot]
[truncated snapshot] undo -> ok sha=9c7fefaa8902 bytes=12; file now = "<article dat"
```

快照被截断到 12 字节后，undo 把 `<article dat` 写进用户文档并报告"成功"（`sha256` 是对**被写坏的那 12 字节**求的，不能当校验）。同时 `undoPatch` 也不校验"当前内容"基线 → 外部编辑器在 patch 之后改过的内容会被无条件覆盖（`node /tmp/m15/p14.mjs` 段 `[D]`：`external edit then undo -> file = "…v0…"`，`EXTERNAL-EDIT` 消失）。

---

## 3. P2（质量 / 一致性 / 可测性）

| # | 位置 | 问题 | 证据 |
| --- | --- | --- | --- |
| P2-1 | `packages/core/src/io/lock.ts:115-117,133` | 超时不收敛：`ceil(timeout/25)` 次 × `sleep(25)`，无 deadline | 实测 1999→2137ms、2001→2172ms（超 138/171ms）；`p5.mjs [A]` |
| P2-2 | `packages/core/src/io/atomic.ts:39-43` | 只 `file.sync()`，rename 后未 fsync 父目录；`:26` 注释"掉电也不会出现半截文件"说过头 | 代码阅读 + `ports.ts` 无目录 sync 能力 |
| P2-3 | `packages/core/src/io/history.ts:39-45,58` | `sortKey` 是 `${at}-${padStart(seq,4)}` 字符串序；seq ≥ 10000 退化为字典序；同毫秒依赖注入 clock 单调 | 代码阅读 |
| P2-4 | `packages/core/src/io/undo.ts:36-37` | `undoPatch` 先 `resolveTarget` 再查历史 → 目标不存在时报 `not_a_file` 而非 `undo_unavailable`；本卡自己的测试就因此红 | `tests/io/undo-bytes.test.ts:91` 红 |
| P2-5 | `packages/core/src/ops/patchNode/fragment.ts:44-46` | `forbidden` 值判定是"整串前缀"比对，不做 CSS/URL 解析 → `style` 里的 `javascript:`、`xmp/noembed` raw text 都放过（见 P1-7 表末两行） | `p2.mjs` |
| P2-6 | `packages/core/src/ops/patchNode/fragment.ts`（纯文本片段分支） | 错误文案自相矛盾：`invalid_fragment: 片段必须恰好有一个根元素，收到 1 个根级内容节点`（"恰好一个"却因"1 个"报错），文案不可稳定断言 | `node /tmp/m15/p12.mjs` 段 `[6]` |
| P2-7 | `packages/core/src/io/atomic.ts:16,24-27`、`packages/core/src/io/contracts.ts`（34 行纯类型） | 注释复述实现/复述类型（"这层管…"三段 + 逐字段 JSDoc），与"注释只解释签名表达不了的"冲突 | 代码阅读 |
| P2-8 | `atomic.ts:11,17`、`history.ts:9,14`、`lock.ts:14,15,17,21,111`、`index.ts:12`、`ops/patchNode/tree.ts:6`；`tests/io/harness.ts`、`tests/io/tree-probe.ts` | `knip --strict` EXIT=1：7 个未用导出 + 4 个未用类型 + 2 个未用测试文件 | `pnpm knip` 原文 |
| P2-9 | `packages/core/src/index.ts`（+14 行）、`packages/core/src/ops/index.ts`（+2 行） | 把 `applyPatch/parseFragment/nodePatchDeps/patchFile/undoPatch` 放上公共面，打红两个既有契约测试；应走子路径导出或显式加入白名单 | `entry-points.test.ts:43`、`outline-surface.test.ts:101` |
| P2-10 | `packages/core/tests/hr-error.test.ts`（+6 行 `CODE_MATRIX`） | 改动本身良性且必要（新增 6 个错误码），但自证声称"卡片允许的唯一测试改动"，卡片全文无此授权 → 越界改动 | `git diff` + `grep -n "tests/" .workflow/cards/M1.5.md` 无命中 |
| P2-11 | `packages/core/src/ops/patchNode/apply.ts:102` | root replace 只用单个 fragment，而片段校验要求"恰好一个根元素" → 卡片 `M1.5.md:38` 的"替换 `<article>` 全部子节点"在 API 上不可表达（多子节点恒 `invalid_fragment`） | `p13.mjs [3]` |
| P2-12 | `packages/core/src/io/patchFile.ts:35-38` | 先写快照再写正文；正文写失败时历史里留一份"从未生效"的快照 → 留下一次 undo 会"还原到当前状态"的空操作，且挤占 10 份额度 | 代码阅读（`atomic.ts:44-46` 会回滚正文） |

---

## 4. PASS 清单（逐条自跑，避免只报坏消息）

| 审计项 | 结论 | 证据 |
| --- | --- | --- |
| 分层：`ops/patchNode/**` 不得 import `node:fs`/`node:path` | **PASS** | `grep -rn 'from "node:' packages/core/src/ops/patchNode/` → ZERO；`grep -rnE '\bprocess\.|new Date|Date\.now|randomUUID|node:crypto'` → ZERO；其 import 全指向 `../../html/*`、`../../hr-error`、`./*` |
| 分层：`io/**` 只经端口访问 fs | **PASS** | `grep -rn "node:fs" packages/core/src` 仅 `io/node-fs.ts:1`；`node:path` 只出现在 `io/{atomic,history,lock,paths,undo}.ts`（层内合法） |
| `depcruise` | **PASS** | EXIT=0，`113 modules, 346 dependencies cruised` |
| `wx` 真独占 | **PASS** | `io/node-fs.ts:22` `open(path, "wx")` |
| fsync 真调 | **PASS** | `io/node-fs.ts:27-29` → `handle.sync()`；`atomic.ts:39` |
| tmp 与目标同目录 | **PASS** | `io/atomic.ts:13-14` `join(dirname(path), …)` |
| rename/写前失败删 tmp | **PASS** | `atomic.ts:44-46`；实测 data-sync 抛 ENOSPC、rename 抛 EXDEV：`leftover tmp = []`、原文件字节不变（`node /tmp/m15/p15.mjs`、`p14.mjs [B]`） |
| history 原字节（非重新序列化） | **PASS** | `orig sha=fbdf02ce4b32 snapshot sha=fbdf02ce4b32 equal=true`（`p3.mjs [3]`） |
| 保留 10 份 + 裁剪顺序 | **PASS** | 13 次 patch 后 `dirs=1 maxSnapshots=10 limit=10`（`p6.mjs`） |
| undo 链式可用 | **PASS** | `undo1 ==B? true`、`undo2 ==A? true`、`remaining=[]`、空历史 `undo_unavailable`（`p6.mjs`） |
| `.hreader` 不可被 patch | **PASS** | `.hreader/…`、`.HREADER/…` 均 `path_outside_workspace`（realpath 归一挡住了大小写变体） |
| `..` / 绝对路径 / 父目录外链 | **PASS** | `../escape.html`→`path_outside_workspace`、`/etc/hosts`→同、`etclink/hosts`→同（`p4.mjs [5]`） |
| 非法 UTF-8 | **PASS** | `io_failure`，且原文件字节不变（`p4.mjs [8]`） |
| `changed:false` 不写盘 | **PASS** | `[F] no-op patch on disk -> {"changed":false,"bytes":112}`（`p7.mjs`） |
| `insert_after` 兄弟语义 | **PASS** | `[3]` 新 `<p>` 紧跟 `p1`、仍在 `<section>` 内（`p12.mjs`） |
| `root` 的 replace 保留 `<article>` 属性 | **PASS** | `targetId:"root"` 时保留 `data-hr-id="a1" class="post" lang="zh"`（`p13.mjs [2]`）——但绕道真实 id 就失效，见 P1-3 |
| `root` 的 `delete`/`insert_*` | **PASS** | `invalid_input`（`p13.mjs [5][6]`） |
| 异常路径 `finally` 释锁 | **PASS** | `io/lock.ts:143-159` try/finally；校验失败后锁文件不残留 |
| 非 ASCII / 大小写路径 | **PASS** | `文档 全角.html` ok；`Case.HTML` 经 realpath 归一到 `case.html` |
| `.gitignore` 改动 | **PASS** | 仅 +1 行 `.hreader/locks/`，与申报一致 |
| 未偷偷改 `knip.json` / `eslint.config.*` / `vitest.config.ts` | **PASS** | `git status` 无这些文件 |

**未评估（不声称）**：AC3 kill 测试、AC6 双进程并发（`p5.mjs` 用同进程模拟接管判定，真实双进程未跑）；覆盖率四维 100% 因 3 个用例先红**无法评估**（阈值检查在用例失败后被跳过）。

---

## 5. 复现索引

```
/Users/liu/Documents/Project/hReader/packages/core/fixtures/load-src.mjs   # 探针统一入口（加载真实源码）
node /tmp/m15/p2.mjs    # 片段对抗矩阵（P1-7）
node /tmp/m15/p3.mjs    # BOM 累积、CRLF 漂移、history 原字节（P1-5/P1-6）
node /tmp/m15/p4.mjs    # 路径逃逸、.hreader、非法 UTF-8、幂等
node /tmp/m15/p5.mjs    # 锁：超时/接管/空锁体（P1-1、P2-1）
node /tmp/m15/p6.mjs    # undo 链、prune、损坏快照（P1-9）
node /tmp/m15/p7.mjs    # changed:false 口径
node /tmp/m15/p11.mjs   # 父目录符号链接 TOCTOU 逃逸（P0-1）
node /tmp/m15/p12.mjs   # applyPatch 语义（append/insert_after/重复 id）
node /tmp/m15/p13.mjs   # root 语义 + 幂等快路径（P1-3、P1-8、P2-11）
node /tmp/m15/p14.mjs   # tmp 清理 / 外部编辑被 undo 覆盖
node /tmp/m15/p15.mjs   # sync 失败后 tmp 清理
```

---

## 6. 放行条件（建议）

1. P0-1 用 `openat`/`renameat` 或"写前+rename 前双重 realpath 复核 + `O_NOFOLLOW`"修掉，并补 AC6 竞态用例（子进程 + 符号链接替换）。
2. P0-2 全部修绿：`pnpm verify` 六步 EXIT=0（含 `tests/io/**` 纳入 `tsc`/`eslint`），并撤回"G1 裁定本轮不跑"的说法——要么拿出裁定原文，要么按卡片 §6 跑。
3. P1-1（锁 CAS 接管）、P1-2（tmp 归属校验）、P1-3（root 真实 id 保护）、P1-4（重复 id 拒绝）、P1-5（BOM 去重）、P1-8（幂等快路径忽略空白）为**合入前必修**；P1-6/P1-7/P1-9 至少要给出书面取舍（写进卡片 AC 或实现注释 + 测试固化）。
4. 自证的量化部分（命令、文件数、行数、"唯一测试改动"）必须可复跑，否则 G3/G4 的门禁会建立在不存在的裁定上。

ACP: 审 21 文件 1171 行（+未申报 11 文件 1389 行测试/夹具），自跑 15 个探针 + 6 步门禁；2×P0（父目录符号链接 TOCTOU 实测写出 workspace 外文件；`pnpm verify` 六步五红且"G1 裁定不跑"无原文）、9×P1（空锁体抢锁、误删并发 tmp、root 保护可用真实 id 绕过、重复 id、BOM 累积、整篇 CRLF/引号重写、`<base href>`/`<meta charset>`/`<svg><set>` 漏网、美化文档幂等失效、损坏快照静默回写）、12×P2；PASS：分层零泄漏、`wx`/fsync/rename 前清 tmp、history 原字节、prune 10、undo 链、`.hreader` 保护、非法 UTF-8、`..`/绝对路径/父目录外链拦截。

---

## G2-R 定向复验（返工后，v2 裁定 #1–#11）

G2-R: FAIL

范围：只验 G2 的 11 条（P0-1、P1-1…P1-9）与返工新增的攻击面。**未跑** `pnpm verify`/`pnpm test`（`packages/core/tests/io/**` 正由测试员重写，653 例仍在变，不作判据）。全部用 `/tmp/m15c/*.mjs` 直接 `loadSrc` 加载 `src` 复现，`node v24.15.0`。只读：未改 `src/**`、未碰 `tests/**`、未 commit。

| 项 | 判定 | 一句话证据 |
|---|---|---|
| P0-1 | CLOSED（有残余窗口） | 父目录换外链 → `path_outside_workspace`，外部零文件、零残留 tmp；最后瞬间换链仍可逃（P2-R1） |
| P1-1 | CLOSED | 空锁体（新 mtime）不再被抢；`1999ms/2001ms` 均 `locked`；4 并发 append 全部落盘 |
| P1-2 | CLOSED | 死 pid 的 tmp 删、活 pid 的留、不可解析的留 |
| P1-3 | CLOSED | 用真实 `data-hr-id="a1"` 做 `delete`/`insert_*` → `invalid_input`；`replace` 保留 `<article ...>` 逐字节 |
| P1-4 | CLOSED | 片段自带 `data-hr-id="dup"` 被剥并重注入，全局 ID 唯一 |
| P1-5 | CLOSED | 连打 3 次 patch，BOM 恒为 1 份（`efbbbf3c2164…`） |
| P1-6 | CLOSED | 6/6 用例 diff 区间 ⊆ 目标元素 span，区间外逐字节不变（真用 `span`） |
| P1-7 | **OPEN** | `<svg><set attributeName="onload">` 仍**放行**：`collectSvgScope` 谓词恒假，`assertAnimationAllowed` 是死代码 |
| P1-8 | CLOSED | 同内容重打：`changed=false`、`historyPath=null`、mtime 不变、字节相等 |
| P1-9 | CLOSED | 截断快照 → `io_failure` 且快照未被消费（125/130 字节仍在）、原文件未动；修复后 undo 回 A |

### P1-7（OPEN）`<svg><set attributeName="on*">` 仍漏网 —— 裁定 #9 未落地

- 位置：`packages/core/src/ops/patchNode/fragment.ts:53-59`

```ts
const collectSvgScope = (root: HtmlNode): ReadonlySet<HtmlNode> => {
  const scope = new Set<HtmlNode>();
  walkElements(root, (node) => {
    if (node.tag === SVG_CONTAINER || scope.has(node)) scope.add(node);   // ← 恒假分支
  });
  return scope;
};
```

`walkElements` 是 pre-order 且每个节点只访问一次，`scope.has(node)` 在该行永远为 `false`（节点此刻还没入集合，父先于子入集合，而子节点本身不会第二次被访问）。结果 `scope` 里只有 `<svg>` 元素自己，`fragment.ts:66` 的 `if (svgScope.has(node)) assertAnimationAllowed(node)` 对 `<set>/<animate>` 永不成立 → `assertAnimationAllowed`（`fragment.ts:45-51`）是死代码。

复现：`node /tmp/m15c/o-svg-set.mjs`
```
LEAK  <svg><set attributeName='onload' to='alert(1)'></set></svg> -> changed=true "<article data-hr-id=\"a1\"><svg><set attributeName=\"onload\" to=\"alert(1)\"></set></svg></article>"
LEAK  <svg><animate attributeName='onfocus' values='x'></animate></svg> -> changed=true "<article data-hr-id=\"a1\"><svg><animate attributeName=\"onfocus\" values=\"x\"></animate></svg></article>"
```
（`assertAttributesAllowed` 拦不住：属性名是 `attributename`，取值 `onload` 不以 `javascript:` 开头。）

同轮批量跑 `/tmp/m15c/h-final.mjs` 的 29 条片段用例，**7 条 MISS**：
```
MISS svg set onload          -> WROTE    （裁定 #9 点名项）
MISS svg set ONLOAD          -> WROTE
MISS svg animate onfocus     -> WROTE
MISS nested svg set          -> WROTE    <div><svg><set attributeName='onclick'>
MISS svg set href (allowed)  -> WROTE    （href 放行是正确的，属"期望 WROTE"误计入）
MISS style javascript: url   -> WROTE    <section style='background:url(javascript:alert(1))'>（G2 已记 P2）
MISS xmp raw                 -> WROTE    <xmp><img src=x onerror=alert(1)></xmp>（G2 已记 P2）
```
净漏 = 4 条 `<svg><set|animate attributeName="on*">`（含大小写与嵌套两种写法），即裁定 #9 的那一条**完全未生效**。其余裁定 #9 项（`<base>`、`<meta charset>`、`<meta http-equiv>`、`<link>`、`<svg onload>`）均 `REJECT forbidden_content`。

修复方向（给实现方）：`walkElements` 不携带祖先信息，改为自带栈的遍历（进入元素压栈、离开出栈）或一次 `Map<node, boolean>` 的带上下文遍历；`assertAnimationAllowed` 只在"最近的 svg 祖先存在"时调用。当前签名表达不了这条规则，注释却断言它成立——`fragment.ts:44` 的注释因此是**假注释**，比没注释更坏。

### 逐条实测（CLOSED 项）

**P0-1**（`node /tmp/m15c/a-p01.mjs`、`a4-p01.mjs`）：
```
[hook] swapped ws/sub -> symlink(.../m15c-out) just before tmp open
[A1] parent-dir swap at tmp-open -> REJECT path_outside_workspace: 父目录真实路径已跑出 workspace…
     outside file created? false
     leftover tmp in OUT: []
     original file restored, sha==before? true
[A3] pre-placed symlink at realPath -> REJECT path_outside_workspace: 真实路径落在 workspace 外：a.html
     victim bytes unchanged? true content="VICTIM-ORIGINAL"
     ws3/a.html still symlink? true
     leftover tmp in ws3: []
```
两道 `assertParentInside`（`atomic.ts:91`、`atomic.ts:94` 调用点（定义在 `atomic.ts:51`））实测存在，realpath 轨迹：
`writeAtomic` 对 history 与正文各做 2 次 `realpath(dir)`；hook 在 tmp `open` 时换链 → 第 2 次复核立刻中断。

**P1-1**（`node /tmp/m15c/e-lock2.mjs`）：
```
[B1] empty lock body, fresh -> locked in 220ms; lock present=true        ← G2 的抢锁已关闭
[B2] empty lock body, age 6s -> ACQUIRED (takeover, expected)
[B3] live lock timeoutMs=1999 -> locked elapsed=2006ms
[B3] live lock timeoutMs=2001 -> locked elapsed=2024ms
[B4] live pid, age 130s -> ACQUIRED (takeover, expected)
[B5] dead pid, fresh -> ACQUIRED (expected)
[B6] payload missing nonce, fresh -> locked          [B6b] age 6s -> ACQUIRED
[B7] 4 concurrent appends -> ok,ok,ok,ok  final="…<p data-hr-id=\"t\">A<em>1</em><em>3</em><em>4</em><em>2</em></p>"
[B8] leftover .steal-* files: []
```
单次 `open(wx)`+一次写（`lock.ts:70-84`）、CAS 接管（`lock.ts:87-110`）都在实测里生效。

**P1-2**（同文件）：
```
[P1-2] patch ok=true changed=true; tmp left: [".hr-tmp.1.abcd.other.html",".hr-tmp.notapid.abcd.x.html"]
```
喂 6 个构造 tmp：死 pid（新/旧）、活 pid、pid 0、不可解析 pid；只留活 pid 与不可解析的两个，其余删除。

**P1-3/P1-4**（`node /tmp/m15c/h-final.mjs`）：
```
delete via "a1" -> REJECT invalid_input
insert_before via "a1" -> REJECT invalid_input
insert_after via "a1" -> REJECT invalid_input
replace via "a1" -> WROTE "<article data-hr-id=\"a1\"><p data-hr-id=\"hr-1e11b6df\">Z</p></article>"
injected fragment claimed data-hr-id="dup" -> ids=["a1","dup","hr-3f5a59bd"] unique? true newIds=[hr-3f5a59bd]
```

**P1-5/P1-8**（`node /tmp/m15c/f-file.mjs`、`j-bom.mjs`）：
```
orig BOM count=1 bytes=145
patch#1 BOM count=1 bytes=191 head=efbbbf3c2164
patch#2 BOM count=1 bytes=237 head=efbbbf3c2164
patch#3 BOM count=1 bytes=283 head=efbbbf3c2164
starts with exactly one BOM? true
r1 changed=true hist=285991ed01a5902b-…-1.html
r2 changed=false hist=null bytesEqual=true undoable=true
BOM doc: r2.changed=false mtime unchanged=true r2.historyPath=null
```

**P1-6**（`node /tmp/m15c/c-span2.mjs`；样本 = CRLF + 单引号 + `&nbsp;` + 缩进）：
```
replace p1: target span=[166,213) inner=[185,209) | diff=[181,209) | diff ⊆ span? true
delete  p2: target span=[219,248) inner=[238,244) | diff=[219,248) | diff ⊆ span? true
append  p1: target span=[166,213) inner=[185,209) | diff=[210,210) | diff ⊆ span? true
dup replace pB:      target span=[58,85)  | diff=[73,81)  | diff ⊆ span? true
dup insert_after pB: target span=[58,85)  | diff=[85,85)  | diff ⊆ span? true
dup insert_before pC:target span=[88,115) | diff=[103,103)| diff ⊆ span? true
```
`apply.ts:96-101` 的 `rangeFor` 真按 `span.start/end/innerStart/innerEnd` 取区间，`apply.ts:144` 只做一次三段拼接；不是"整篇重排后碰巧相等"。

**P1-9 + undo 链**（`node /tmp/m15c/h-final.mjs`、`i-chain.mjs`）：
```
snapshot=285991ed01a5902b-…-1.html shaPrefixMatches=true bytes=130
truncated snapshot -> REJECT io_failure: 快照内容与文件名哈希不符，拒绝写回…
snapshot survived? true bytes=125    file untouched? true
repaired -> undo sha=285991ed01a5 back-to-A? true snaps=[]
undo1 -> ==B? true  snaps=["285991ed…html"]   undo2 -> ==A? true  snaps=[]   undo3 -> REJECT undo_unavailable
```

### 返工新增攻击面

| 攻击面 | 结论 | 证据 |
|---|---|---|
| 重复内容下 span 定位 | 正确 | 三个同文本 `<p>`，patch 中间 `pB` 只动 `[73,81)`，`pA/pC` 字节不变 |
| `<template>` 内元素 span | 可靠 | `<template><p data-hr-id="pI">in</p></template>` 的 `pI` replace 落在 `[69,75)` |
| 自闭合/空元素 span | 可靠 | `<p>text<br/></p>` append、`<p>a<br>b<img src="x.png">c</p>` replace 均落在 `</p>` 前/整元素区间 |
| `stripHrIds` 误删正文 ID | 设计如此（裁定 #4） | 片段**整棵子树**的 `data-hr-id` 全剥（`ids.ts:58-83`），文档侧 `keepMe` 保留；片段根与非根一视同仁 |
| BOM 使 `changed=false` 失效 | 未发生 | BOM 文档重打同内容 → `changed=false`、mtime 不变（BOM 在文本里，比较仍是逐字节） |
| `<svg><set>` svg 作用域 | **漏网** | 见上文 P1-7 |

### 注释口径

`apply.ts` / `atomic.ts` / `lock.ts` 的注释以"为什么"为主，无"复述类型"的 JSDoc：
- `atomic.ts:50`（P0-1 为何两次复核）、`atomic.ts:13`（tmp 名带 pid 的理由）、`bytes.ts:9`（`ignoreBOM: true` 是为了 AC4 逐字节）；
- `lock.ts:69`（为何单次 `open(wx)` 一次写）、`lock.ts:86`（CAS 接管 + nonce 比对）、`lock.ts:33`（`pid<=0` 为何非法）；
- `apply.ts:95`（区间取自源码 offset 的理由）、`apply.ts:107`（`withoutSelfId` 与 P1-8 幂等的关系）。

唯一反对意见就是 P1-7：`fragment.ts:44` 的注释断言"必须按 svg 上下文单独判"，而实现没有判——注释与代码相反，必须随修复一起改。

### 追加 P2（不计入本轮，仅登记）

- **P2-R1 残余 TOCTOU 窗口**（`atomic.ts:94-96`）：第 2 次 `realpath` 与 `assertTargetNotLink` 之后、`rename` 之前的窗口内，攻击者把 tmp 镜像到外部目录并把父目录换成同名外链，仍能把内容写到 workspace 外（`node /tmp/m15c/a4-p01.mjs` → `WROTE changed=true`，外部 `doc.html` 出现）。关闭需要 `openat`/`dirfd`（Node 无 API），裁定 #10 只要求两道复核，故按 CLOSED 记；窗口已从"整段 patch 期间"缩到"两条语句之间"。
- **P2-R2 `root` replace 多子节点不可达**：片段规则要求"恰好一个根元素"（`fragment.ts:103-110`），而卡 §1 写"`replace` 替换 `<article>` 的全部子节点"——三段内容会被 `invalid_fragment` 拒（`h1`+`p`+`p` 实测 `REJECT invalid_fragment`）。规格自相矛盾，建议在卡里改成"`root` 的 `replace` 语义 = 用单根片段替换全部子节点"。

ACP: 复验 11 条（P0-1 CLOSED + P1-1…P1-9 中 8 CLOSED / 1 OPEN），自跑 9 个探针（`/tmp/m15c/{a-p01,a4-p01,b-span,c-span2,d-idem2,e-lock2,f-file,h-final,i-chain,j-bom,o-svg-set}.mjs`）+ 29 条片段对抗用例；唯一 OPEN = P1-7（裁定 #9 的 `<svg><set attributeName="on*">` 因 `collectSvgScope` 谓词恒假而未生效，`assertAnimationAllowed` 是死代码）→ G2-R FAIL，需实现方修 `fragment.ts:53-59` 后重跑 `o-svg-set.mjs` 与 `h-final.mjs`。

---

## G2-R2（终检：4 条定向复验）

G2-R2: FAIL — 3 CLOSED / 1 OPEN（新 P1：v3#16 的 `values` 多值列表只有首项被拦）

被测快照（`shasum` 前 8 位，跑前跑后各取一次、一致 → 本节结论对应同一份源码）：
`ops/patchNode/fragment.ts cf5d4734` · `attrs.ts fd8287d2` · `apply.ts 40cd0e10` · `constants.ts c52a7ea7` · `ids.ts 9b6acb25` · `html/parse.ts ac806613`（03:35:38 → 03:35:39）。

⚠ 审计窗内 `src` 在动：`fragment.ts` 03:33:28 才落地 v3#16 的 `ANIMATION_URL_TARGETS` / `ANIMATION_VALUE_ATTRIBUTES` 块（首遍读数时该块还不存在）。首遍读数只能作为"机制"参考，**下文所有 CLOSED/OPEN 全部用上面这份快照重跑过**，命令见各节。
判据全部来自 `/tmp/m15c/*.mjs` 直载 `src`；按要求**未**拿 `pnpm test` 当依据（测试员在改 `tests/io/**`）。

### 结论表

| # | 项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | P1-7 根因（`attributeValueLoose`） | **CLOSED** | 宽松查找只服务拒绝名单；`data-hr-id` 仍走精确匹配；`o-svg-set.mjs` 由 LEAK → REJECT |
| 2 | v3#16（`<set attributeName="href\|src\|xlink:href">` 危险值） | **OPEN（部分落地）** | 单值全拦；`values="safe;javascript:…"` 放行 → 新 P1-R2-1 |
| 3 | #12 幂等 | **CLOSED** | 空白差 → `changed:true`（3/3）；ID 差 → `changed:false` 且 `historyPath=null`、快照数 1→1 |
| 4 | `attributeValueLoose` 新攻击面 | **CLOSED** | 10/10 变体全部 `forbidden_content`，含大写 `HREF`/`HTTP-EQUIV`/`ONKEYUP`/`BASE`/`charset` |

### 1. P1-7 根因：CLOSED

根因假设（解析器把 SVG adjusted attribute 还原成驼峰，旧代码用全小写名精确取值 → 恒 `undefined`）成立，实测：

```
[tokenizer] <svg><set attributeName='x' attributeType='y'/> -> ... set,[["attributeName","x"],["attributeType","y"]]
```

- `packages/core/src/ops/patchNode/attrs.ts:19-28` 新增 `attributeValueLoose`（逐属性 `toLowerCase()` 比较），`:32-33` 新增 `hasAttributeLoose`。
- 引用面收得很干净：全仓只有 `packages/core/src/ops/patchNode/fragment.ts:7` 引入这两个函数，用在 `fragment.ts:34`（`meta http-equiv|charset`）与 `fragment.ts:65`、`fragment.ts:72`（SVG 动画）——**只服务拒绝名单**。
- ID 通道没被放松：`packages/core/src/ops/patchNode/apply.ts:73` 仍是 `attributeValue(node.attrs, HR_ID_ATTRIBUTE) === targetId`（精确 `===`），`apply.ts:132-135` 的 `withoutSelfId` 同样用 `attributeValue`；`packages/core/src/html/inject.ts:53,121` 未动。
- `DATA-HR-ID` 之所以看起来"能被当 ID"（`[locate] targetId p9 vs data-HR-id -> changed=true`），原因是 HTML 词法层就把属性名小写化了，与本次宽松化无关：
  ```
  [tokenizer] <p DATA-HR-ID='x'> -> p,[["data-hr-id","x"]]
  [tokenizer] <svg><circle DATA-HR-ID='r'/> -> circle,[["data-hr-id","r"]]
  ```
  即"宽松化没把 `DATA-HR-ID` 变成 ID"在 `attrs` 层成立，词法层的小写折叠是规范行为，R2 前后一致（不新增风险，卡片"已有 ID 一律不动"的口径不变）。
- 复跑原探针（上一轮唯一 OPEN）：
  ```
  node /tmp/m15c/o-svg-set.mjs
  REJECT <svg><set attributeName='onload' to='alert(1)'> -> forbidden_content   （上一轮：LEAK）
  REJECT <svg><animate attributeName='onfocus' values='x'> -> forbidden_content
  ```
- 补测上下文与大小写变体（`/tmp/m15c/r2e-final.mjs`）：
  ```
  bare <set onload> outside svg            ACCEPT   ← 设计如此（树外无改写能力），与 fragment.ts:83-85 注释一致
  <svg><set attributeName='ONLOAD'>        REJECT forbidden_content
  <svg><g><set attributeName='onclick'>    REJECT forbidden_content
  <svg><set attributeName='onBegin'>       REJECT forbidden_content
  ```

⇒ **CLOSED**。附注（P2-R2-a）：`packages/core/src/ops/patchNode/constants.ts:44` 注释写"`attributeName` 被 parse5 小写化"，与 `attrs.ts:19`（"解析器保留属性名源码大小写"）互相矛盾，实测是**保留驼峰**；`constants.ts:44` 那句注释是错的，修 P1-7 时应顺手改成"被 parse5 还原成驼峰"。

### 2. v3#16：OPEN（部分落地）→ 新 P1-R2-1

已落地的部分（`packages/core/src/ops/patchNode/fragment.ts:56-77`）：`ANIMATION_URL_TARGETS = {href, src, xlink:href}`（`:57`）、`ANIMATION_VALUE_ATTRIBUTES = ["to","from","by","values"]`（`:60`），命中后逐属性取 `forbiddenUrlOf`（`:41-42`）。

单值全拦：

```
node /tmp/m15c/r2g-values.mjs
values first-position js         REJECT forbidden_content
set to js (first)                REJECT forbidden_content
animate values via #x6a first    REJECT forbidden_content
animate to js 2nd-ish            REJECT forbidden_content
```

漏网（**新 P1**）：

```
values 2nd-position js           ACCEPT(changed=true)     <animate attributeName='href' values='safe;javascript:alert(1)'>
values 2nd-position JS upper     ACCEPT(changed=true)     values='safe;JavaScript:alert(1)'
values 2nd, space+semicolon      ACCEPT(changed=true)     values='safe; javascript:alert(1)'
values 2nd data:text/html        ACCEPT(changed=true)     values='safe;data:text/html,<b>x</b>'
animate values 2nd via entity    ACCEPT(changed=true)     values='safe;&#x6a;avascript:x'
```

**P1-R2-1 `values` 多值列表只有首项被判**
`packages/core/src/ops/patchNode/fragment.ts:72`：
```ts
(attributeValueLoose(node.attrs, name) ?? "").split(";").join(" "),
```
把分号换成空格后**整串**送进 `forbiddenUrlOf`（`fragment.ts:41-42` → `normalizedUrl` 是 `fragment.ts:26`，`replaceAll(/[\s\p{Cc}]/gu, "")` 会把空格也删掉），于是 `"safe javascript:alert(1)"` 归一成 `"safejavascript:alert(1)"`，前缀比对自然不命中。`values` 按 SMIL 规范是**分号分隔的多值列表**，危险值落在第 2 项及以后即可越过 v3#16，也同时越过 `fragment.ts:49` 的通用属性值扫描（同一条 `forbiddenUrlOf`）。

- 复现：`node /tmp/m15c/r2g-values.mjs`（源码行 `/tmp/m15c/r2g-values.mjs:9`）
- 影响面：`<animate|set attributeName="href|src|xlink:href" values="safe;javascript:…">` 会作为合法片段写入文档；这与"`href="javascript:`" 同一类可执行面，正是 v3#16 要堵的口子。
- 修法（一行）：`values` 单独处理，按 `;` 拆开逐项判：`const urls = name === "values" ? value.split(";") : [value]; urls.some(v => forbiddenUrlOf(v) !== undefined)`；`to/from/by` 保持单值（`to="safe;javascript:…"` 在 SVG 里是相对 URL，不构成同一面，可继续只判首项）。
- 若裁定"`values` 不在 #16 范围"，需在 `fragment.ts:56-77` 注释与卡片里写明"仅判列表首项"——现状是代码注释 `fragment.ts:56` 声称"与直接写 `href` 同口径"，与实现不符。

⇒ 该项 **OPEN**，其余 3 项不受此条影响。

### 3. #12 幂等：CLOSED

三步链（`/tmp/m15c/r2c-step.mjs`）：

```
r1 changed=true  ids=[hr-4c1b5157]
r2 changed=false ids=[]  byteEqual2=true        ← 同内容 + 换 ID
r3 changed=false         byteEqual3=true
file: write changed=true snaps=1; id-only repatch changed=false historyPath=null snaps=1 bytesUnchanged=true
file: history tree = ["history","locks","history/d2a835c324904d890ba8f5cca43a4df0ecde04d1","…/fa8a836a215d8e65-2026-11-13T03:35:39.009Z-1.html"]
```

- ② "内容相同但 ID 不同 → `changed:false` 且不产生历史文件"：`packages/core/src/io/patchFile.ts:25` 的 `if (!outcome.changed)` 早退，`writeSnapshot`（`patchFile.ts:36`）根本到不了；实测 `historyPath=null`、快照 1→1、文件字节不变。
- ① "内容相同但空白不同 → 必须 `changed:true`"（`/tmp/m15c/r2b-idem.mjs`）：
  ```
  [2a] one extra space    changed=true
  [2b] leading newline    changed=true
  [2c] trailing space     changed=true
  [3]  fragment adds class changed=true
  ```
  原因：`contentKey`（`apply.ts:105-111`）走 `serializeHtml`，文本节点逐字保留，空白差进得了 key。
- 附带确认（R2 未碰但同属 P1-8 家族）：`root` replace 仍保留 `<article>` 自身属性，`newIds` 文档序（`/tmp/m15c/r2e-final.mjs`）：
  ```
  root replace keeps article attrs  "<article data-hr-id=\"a1\" class=\"post\" lang=\"zh\"><section data-hr-id=\"hr-b2943a94\">…"
  root replace newIds order         [hr-b2943a94,hr-0770d2f5,hr-bbaf4965]
  ```
- 口径提示（不是缺陷，建议写进卡片 AC 一句话）：`sameContent`（`apply.ts:113-115`）比的是"剥 ID 后序列化"而非字节，所以**只改引号/实体写法**的 patch 会 `changed:false` 不落盘：
  ```
  quote-style only fragment   noop     doc: class='x'  fragment: class="x"
  entity form only fragment   noop     doc: A&nbsp;B   fragment: A\u00a0B
  ```
  这与 #12"内容等价就不写"的意图一致，代价是调用方无法用 patch 做源码规范化。

⇒ **CLOSED**。

### 4. `attributeValueLoose` 新攻击面：CLOSED

`/tmp/m15c/r2f-adv.mjs` + `r2a-safety.mjs`，10 条按裁定构造的变异全部拒绝：

```
meta order reversed          REJECT forbidden_content    <meta content='0;url=javascript:alert(1)' http-equiv='Refresh'>
meta charset                 REJECT forbidden_content
BASE uppercase               REJECT forbidden_content    <BASE HREF='//evil'>
svg a xlink:href js          REJECT forbidden_content
set attributeName ONKEYUP    REJECT forbidden_content
set attributename lenient    REJECT forbidden_content    <set attributename='onerror'>（大小写宽松查找命中）
set to space+js entity       REJECT forbidden_content    to=' &#x6a;avascript:alert(1)'
animate values js            REJECT forbidden_content    values='javascript:x;y'（危险值在首项）
a HREF leading space         REJECT forbidden_content    <a HREF=' javascript:alert(1)'>
meta HTTP-EQUIV up           REJECT forbidden_content
p text 'javascript:'         ACCEPT changed=true        ← 正确：文本不是属性值
```

⇒ **CLOSED**。宽松化没有制造新的"误放行"面；代价只有反向的**过拒**（`constants.ts:42` 前缀比对是整串前缀，`<code data-x="javascript:…">` 这类正文示例也会被拒——上一轮 P2-5 已记，不新增）。

### 5. 返工引入的新面（自测，未见其它 P0/P1）

`/tmp/m15c/r2d-span.mjs`：

- **重复内容下的 span 定位正确**：两个同文本 `<p>`，只改目标那个
  `S1 dup: patch p2 -> …<p data-hr-id="p1">same</p>\n  <p data-hr-id="hr-7206759b">TWO</p>…`；`delete p1` 只删第一个。定位走 id（`apply.ts:73`），span 逐元素取自 `parse.ts:47-52` 的 `sourceCodeLocation`，不按文本匹配。
- **隐含闭合 `</p>`**：`innerEnd` 由 `parse.ts:51`（`endTag === undefined ? endOffset : …`）兜住，`append` 落在元素内容末尾而非 `startTag` 之后：
  `S2 implied end tag append -> <p data-hr-id="p2">B<em>x</em></article>`
- **`<template>`**：`append` 到 template 本身 → `invalid_input`（模板不在块级名单，符合 §1）；template 内部的 `<p>` 可正常 replace。
- **自闭合/void**：`<br/>`/`<img/>` 同在目标内时 `append` 落点正确（`…b<img src="x"/><em>z</em></p>`）。
- **`stripHrIds` 过宽（P2-R2-b）**：`ids.ts:47` 对**整棵子树**剥 ID，而 `fragment.ts:137` 注释写"片段**根上**自带的 `data-hr-id` 一律剥掉"。实测非块级子的 ID 直接消失（不再重注入）、块级子换新 hash：
  ```
  S5 nested user id on <span> -> <section data-hr-id="hr-8621ebae"><span>t</span></section>
  S5 nested user id on <p>    -> <section data-hr-id="hr-8621ebae"><p data-hr-id="hr-d496b58b">t</p></section>
  ```
  行为本身可辩护（ID 归注入器所有），但注释说的是"根上"，二者必须对齐，否则下一个改动会按注释把 `ids.ts:47` 改成只剥根、从而放过复制粘贴回来的整棵 ID 树。
- **BOM 不影响 `#12` 判定**：写后 BOM 保留（`head="efbbbf3c6172"`），内容相同 → `changed=false` 且文件逐字节等于输入；只有"BOM 落在 `<article>` 内部 + `root` replace"会被区间一并换掉（`S6c`，可接受，`bytes.ts:9` 的 `ignoreBOM: true` 语义正确）。

### 6. 其它（一行级，不阻塞）

- `packages/core/src/ops/patchNode/apply.ts:104` 是**孤立 JSDoc**（"区间取自源码 offset：区间之外一个字节都不动…"），描述的是 `apply.ts:117` 的 `rangeFor`，却悬在 `apply.ts:106` 的 `contentKey` 上；两个 `/** */` 连排会让人误以为它讲的是 `contentKey`。挪到 `rangeFor` 前面即可。
- `constants.ts:44` 注释与 `attrs.ts:19` 矛盾（见 §1 附注）。

### 未覆盖 / 说明

- 未跑 `pnpm verify` / `pnpm test`（测试员在改 `tests/io/**`，653→160 例仍在变），本轮判据 100% 来自直载 `src` 的探针。
- `/tmp/m15c` 探针清单：`r2a-safety` `r2b-idem` `r2c-step` `r2d-span` `r2e-final` `r2f-adv` `r2g-values` `o-svg-set`。
- 未 commit、未改 `src/**`、未碰 `tests/**`（`git status` 里 `tests/io/**` 与 `tests/*.test.ts` 的改动均为实现方/测试员所留）。

ACP: P1-7 根因 CLOSED（`attributeValueLoose` 仅进拒绝名单，`o-svg-set.mjs` LEAK→REJECT）；v3#16 **OPEN（部分）**——`fragment.ts:72` 把 `values` 按 `;` 换成空格后整串比前缀，`values="safe;javascript:alert(1)"` 实测 ACCEPT（新 P1-R2-1，一行可修）；#12 CLOSED（空白差 changed:true 3/3、ID 差 changed:false + historyPath=null + 快照 1→1）；`attributeValueLoose` 新面 10/10 全拦。计数 3 CLOSED / 1 OPEN → G2-R2 FAIL。被测快照 fragment.ts cf5d4734 / attrs.ts fd8287d2 / apply.ts 40cd0e10；审计窗内 src 在动（v3#16 于 03:33:28 落地），所有结论已在 03:35:38 同一快照上重跑。

## G2-R3（签字：`parse.ts` 守卫合并，只判 3 件）

G2-R3: PASS — 3/3 认可；改动在 parse5 8.1.1 下不可观察，不存在放宽路径。附 1 条**既有** P1（不在本次 hunk 内，另记）。

### 判 1 · 语义是否变了 → **不可达已证实**（CLOSED）

不是"可达但无影响"，是**结构上构造不出来**。parse5 8.1.1 里元素位置只有一个构造点：

```js
// node_modules/.pnpm/parse5@8.1.1/node_modules/parse5/dist/parser/index.js:296-305
_attachElementToTree(element, location, insertionLocation) {
    if (this.options.sourceCodeLocationInfo) {
        const loc = location && { ...location, startTag: location };   // ← 有 location 必带 startTag
        this.treeAdapter.setNodeSourceCodeLocation(element, loc);
    }
    ...
```

```js
// 同文件 :354 `_insertFakeElement` / :372 `_insertFakeRootElement` —— 合成元素给的是 null，不是"半截 location"
this._attachElementToTree(element, null, insertionLocation);        // :354
this.treeAdapter.setNodeSourceCodeLocation(element, null);          // :372
```

```js
// 同文件 :428-447 —— 补 end 位置有前置守卫，不会把 null 提升成"只有 end 的对象"
_setEndLocation(element, closingToken) {
    if (this.treeAdapter.getNodeSourceCodeLocation(element) && closingToken.location) {
        ...
        this.treeAdapter.updateNodeSourceCodeLocation(element, endLoc);
    }
}
// tree-adapters/default.js:212 —— 且是 spread 合并，startTag 必被保留
updateNodeSourceCodeLocation(node, endLocation) {
    node.sourceCodeLocation = { ...node.sourceCodeLocation, ...endLocation };
}
```

类型上 `startTag?: Location`（`dist/common/token.d.ts:31-40`）只是可选标记，落地实现里"有 location ⇒ 有 startTag"恒成立；`sourceCodeLocation` 的取值域只有 `null` 与"带 startTag 的完整对象"。

自己跑的 fuzz（`/tmp/m15c/r3-span.mjs`、`/tmp/m15c/r3-frag.mjs`，语料 = 仓库 fixtures + 4000 随机标记串 + 23 条定向构造）：

```
$ node /tmp/m15c/r3-span.mjs
[parse5] corpus=4023 elements: withLoc=10427 noLoc=11888 locWithoutStartTag=0
[parse5] noLoc 标签分布: head×3905 html×3881 body×3523 p×391 tbody×63 colgroup×50 a×30 tr×26 b×19

$ node /tmp/m15c/r3-frag.mjs     # 7 个 fragment context（body/table/select/template/svg/div/p），patch 走的就是这条
[parseFragment] 元素=14712 withLoc=13417 noLoc=1295 locWithoutStartTag=0
```

**结论**：旧代码那条"有 location、无 startTag"的退化分支（`innerStart = startOffset`）是死代码；新旧实现对任何可达输入逐位相同。而且旧分支给出的区间本身是**错的**——`innerStart = startOffset` 会把起始标签 `<p>` 算进内容区，删掉它不会让任何路径变差。

### 判 2 · 是否偷偷放宽 → **没有路径依赖退化 span**（CLOSED）

`innerStart/innerEnd` 的消费者全仓只有一处：

- `packages/core/src/ops/patchNode/apply.ts:116-117`（`rangeFor`：`append` 用 `span.innerEnd`，其余用 `start/end/innerStart/innerEnd`）
- 其数据来源 `apply.ts:143` `const span = spanOf(located.target);`，`spanOf` = `{ ...ZERO_SPAN, ...target.span }`（`apply.ts:46,49`）

ZERO span 只可能来自 null-location 元素，而这类元素**过不了目标守卫**：

- `apply.ts:75-81`：`if (!isBlockLevel(found)) throw new HrError("invalid_input", ...patch 目标必须是块级元素)` —— 在 `spliceFor` 之前执行（`locateTarget` @ `apply.ts:85-98` → `applyPatch` @ `:169`），span 根本还没被读。
- null-location 的集合 = 隐式元素（`html/head/body/tbody/tr/colgroup`）+ AAA 克隆的格式化元素（实测 `a`/`b`）。隐式元素由 `_insertFakeElement` 创建，attrs 恒为 `[]`（`dist/parser/index.js:349-351`），**不可能带 `data-hr-id`**；AAA 克隆清单全是行内元素（a/b/big/code/em/font/i/nobr/s/small/strike/strong/tt/u），`isBlockLevel` 一律拒。
- 顺带核了重复 ID：克隆体与原体同带 `data-hr-id` 时 `locateById` 取文档序首个，但两只都是行内 → 同样被守卫拦下。

**观察（既有缺陷，非 R3 引入，未被消费）**：`spanOfLocation` 会原样透传 parse5 对**未闭合 raw-text 元素**给出的畸形区间（`innerEnd < innerStart`）：

```
$ node /tmp/m15c/r3-span2.mjs
"<script>alert(1)"       len=16  script[0,8,0,0] INVERTED
"<style>a"               len=8   style[0,7,0,0] INVERTED
"<title>a"               len=8   title[0,7,0,0] INVERTED
"<textarea>a"            len=11  textarea[0,10,0,0] INVERTED
"<xmp>a" / "<iframe>a"   → 同类 INVERTED
--- 可被 patch 的目标（带 data-hr-id）被截断的 script:
replace: HrError invalid_input data-hr-id="s1" 落在 <script> 上，patch 目标必须是块级元素
delete : HrError invalid_input data-hr-id="s1" 落在 <script> 上，patch 目标必须是块级元素
```

raw-text 元素永远不是块级目标 → 畸形 span 无消费者。记在这里是为了说明：`spanOfLocation` 目前对 `innerEnd < innerStart` 没有任何自检，将来若放宽目标白名单就会踩。

### 判 3 · 无 `as`/`!`/`v8 ignore`/阈值改动 → PASS

```
$ git diff -- packages/core/src/html/parse.ts | grep -nE '^\+.*(\bas [A-Z]|!\.|@ts-|v8 ignore|istanbul ignore|c8 ignore)'
(无输出)
$ grep -nE '\bas [A-Z]|!\.|@ts-|v8 ignore|istanbul ignore' packages/core/src/html/parse.ts
150:  element.attrs.map((attribute) => [attribute.name, attribute.value] as const);   # 只有 as const
$ git status --porcelain | grep -E '(vitest|tsconfig|eslint|depcruise)'
(无输出)   # 唯一被动的配置文件是 knip.json
```

新增的类型收窄全部走类型层（`type P5Location = NonNullable<...>`、`type P5StartTag = NonNullable<...>`），调用点靠 `if (!location?.startTag) return ZERO_SPAN;` 的窄化拿到两参签名——比旧的两道守卫更强，不是更松。

一条观察（同一返工窗口、但不在 `parse.ts` 改动内）：`knip.json` 新增 `ignoreIssues` 压制了 4 个文件的 unused exports（`io/atomic.ts`、`io/history.ts`、`io/lock.ts`、`ops/patchNode/attrs.ts`）。这意味着"knip strict 干净"里有一半是靠 suppression 达成的，而不是真的无未用导出。不影响本次签字（非阈值、非 parse 相关），供收口时决定是导出还是删。

### 附带发现 · P1-R3-1（既有，非本次改动引入）：`<svg><template>` 抛裸 TypeError

`parse.ts:92` 的模板判定只看名字，不看命名空间：

```ts
const isTemplate = (node: P5Element): node is P5Template => node.nodeName === "template";   // parse.ts:92
const descendantsOf = (element: P5Element): readonly P5Node[] =>
  isTemplate(element) ? element.content.childNodes : element.childNodes;                    // parse.ts:115-117
```

foreign content 里的 `<template>` 是 SVG 命名空间元素，**没有 `.content` 片段** → `:117` 直接读 `undefined.childNodes`。

```
$ node /tmp/m15c/r3-crash.mjs
"<svg><template>x</template></svg>"   loc=false  TypeError Cannot read properties of undefined (reading 'childNodes')
"<svg><template>x</template></svg>"   loc=true   TypeError ...
"<svg><template>"                     loc=false  TypeError ...
"<math><template>x</template></math>" loc=false  TypeError ...     # <mi>/<mtext> 是集成点，不崩
"<svg><TEMPLATE>x</TEMPLATE></svg>"   loc=false  TypeError ...     # 大小写无关
"<template>x</template>"              loc=false  OK nodes=["element:html"]

$ node /tmp/m15c/r3-reach.mjs      # 经公开 API 可达：不是内部路径
TypeError code=- msg=Cannot read properties of undefined (reading 'childNodes')  frag=<svg><template>x</template></svg>
```

随机语料命中率：**54 / 4023（1.3%）**（`/tmp/m15c/r3-span.mjs` 里 catch 计数，样本 `<table><head><mtext><div><svg><template>`、`&amp;<body><svg></script><li><html>x<tr>`）。

- 影响：`TypeError` 逃出 HrError 契约（`error.code` 为空），调用方按 `code` 断言/分类会炸；输入是用户可控的 fragment。
- 归属：`parse.ts:92` 与 `:115-117` **不在本次 diff 的 hunk 内**（diff hunk 在 13/33/156/240/252），且 `{ locations: true }` 与不带参两种模式**同样崩** → M1.1 起既有，非 R3 引入。修法在 `parse.ts:92` 加命名空间判定（`element.namespaceURI === NS.HTML`）或探测 `"content" in element`。
- 顺带：编写员"4000 fuzz 证明元素侧不可达"的语料显然不含 `<svg>`+`<template>` 组合，否则会先崩在这里——其 fuzz 覆盖度不足以支撑"不可达"，本次结论由我的 parse5 源码核 + 两轮独立 fuzz 支撑。

### G2-R3 一句话

签：守卫合并**可以签**（不可达、无放宽、无作弊），但同一文件里躺着一个既有裸崩（`<svg><template>`，随机输入 1.3% 命中、经 `applyPatch` 可达、错误契约被击穿），建议在 M1.5 收口前一并修掉——它比这次签字改动危险得多。

ACP: 判 1 CLOSED（parse5 8.1.1 `_attachElementToTree` 恒带 startTag、合成元素恒 null、`_setEndLocation` 有守卫；全文 10427 + fragment 13417 个 located 元素零反例）；判 2 CLOSED（唯一消费者 `apply.ts:116-117`，ZERO-span 生产者全被 `apply.ts:75-81` 块级守卫拦下）；判 3 PASS（无 as/!/ignore/阈值，仅 knip `ignoreIssues` 压制 4 文件 exports 观察）。附带 P1-R3-1：`parse.ts:92/117` 对 `<svg><template>` 抛裸 TypeError（两模式同崩、`applyPatch` 可达、随机语料 54/4023），既有非本次引入。探针：`/tmp/m15c/{r3-span,r3-frag,r3-crash,r3-span2,r3-reach}.mjs`；只读，未 commit，未碰 `tests/**`。
