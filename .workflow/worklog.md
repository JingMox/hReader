
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
