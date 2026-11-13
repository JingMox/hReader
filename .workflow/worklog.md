
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
