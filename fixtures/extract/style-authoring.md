# 访谈式自定义风格：从对话到 style.yaml

目标：用 6 个问题问出一份能直接跑的风格，而不是让用户"描述一下你想要什么风格"。

## 先问清 6 件事

按顺序问，每问一次只问一个问题；用户答不上来就给出默认值并说明理由。

1. **读者是谁、读完后要做什么？** → 决定 `persona`（回答者身份）与判断粒度。
2. **先给结论还是先给背景？** → 决定 `narrativeRules` 的第一条（默认：结论先行）。
3. **每段最长几句？** → 决定 `rhythm.maxParagraphSentences`（默认 3）。
4. **哪些词一看就想删？** → 进 `vocabulary.forbidden`（先给 5 个常见空话让用户挑）。
5. **哪些词是这个行业的口头禅、希望保留？** → 进 `vocabulary.recommended`。
6. **给我一个"写得差"和一个"写得好"的真实句子。** → 进 `examples`；这是唯一能校准口味的字段，尽量要到。

## 落成文件

放在项目的 `.hreader/style.yaml`（项目级），或用 `--tone <id>` 显式指定时放在 `.hreader/styles/<id>.yaml`。

```yaml
id: product-weekly
name: 产品周报口径
description: 判断先行、数字落地、拒绝空话的周报体
inheritsVisual: atelier-editorial

language:
  persona: 带过三年 B 端产品线、每周四晚上写周报的产品负责人：先说结论，再给数据，最后划清这周没做的事。
  narrativeRules:
    - 第一句必须是本周最重要的判断，禁止用"本周主要工作"开场。
    - 每个结论挂一个数字或一个日期，做不到就明说没有数据。
    - 每节末尾写"下周不做什么"，用排除法收敛读者预期。
  rhythm:
    maxParagraphSentences: 2
  vocabulary:
    forbidden: ["赋能", "抓手", "闭环", "稳步推进", "持续发力"]
    recommended: ["本可以", "代价", "卡点", "下周一之前"]
  examples:
    - bad: "本周我们稳步推进了多个需求，整体进展顺利。"
      good: "本周只交付了一件事：结算页重构上线。另外三件被我砍掉，因为它们的验收标准至今没人能写出来。"
```

## 校验与试跑

```bash
# 1. 先确认能被解析（错的 schema 会报 invalid_style 并指出键名）
node skills/hreader/scripts/hr.mjs style report.html --tone product-weekly --json

# 2. 看编译出来的 prompt 是否真的在约束你
node skills/hreader/scripts/hr.mjs style report.html --tone product-weekly

# 3. 用禁用词表检查现有草稿
node skills/hreader/scripts/hr.mjs style report.html --lint
```

## 常见坑

- `id` 必须全小写、只含 `a-z0-9-`；和文件名一致，否则 `unknown_style`。
- `inheritsVisual` 只能填内置视觉 id（当前 `atelier-editorial`）；填别的会 `unknown_style`。
- `narrativeRules` 至少 1 条、最多 8 条；写成"可证伪的约束"而不是"要专业"。
- `forbidden` 里的词会**区分大小写以外的写法**（大小写折叠、全角半角折叠），填词根即可，不要填整句。
- `examples` 里 `bad`/`good` 必须成对；只给 `good` 会被 `invalid_style` 拒绝。

## 别做的事

- 不要让用户"给个形容词"就当风格：形容词进不了 YAML，只会变成一份没约束力的提示词。
- 不要复制别人的 `forbidden` 列到自己的风格里：禁用词是团队伤疤，抄来的不疼。
- 不要把风格文件和主题 CSS 混为一谈：`style.yaml` 管文字，`theme.css` 管排版，两者通过 `inheritsVisual` 连接。
