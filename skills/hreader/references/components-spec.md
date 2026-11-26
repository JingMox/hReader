# 组件片断：复制即用

每个片段都是**单个根元素**、可直接作为 `--html-file` 的内容喂给 `hr patch`。主题靠 `data-hr-component` 选择器生效，不要再自己写内联 style。

## 1. KPI 卡阵 `kpi-bento`

3–6 个关键数字，每个格子一个结论 + 一句口径说明。少于 3 个用行内 `<strong>`，多于 6 个换成分组列表。

```html
<section data-hr-component="kpi-bento">
  <div>
    <p><strong>38%</strong></p>
    <p>首屏 TTI 降幅，口径为 P75 真机</p>
  </div>
  <div>
    <p><strong>12 ms</strong></p>
    <p>跨机房状态同步延迟，1 万 QPS 下实测</p>
  </div>
  <div>
    <p><strong>2 周</strong></p>
    <p>回滚窗口，超过即需数据迁移</p>
  </div>
</section>
```

## 2. 洞察 callout `callout-insight`

一段话，最多三句：先给判断，再给证据，最后给边界。不要塞列表。

```html
<aside data-hr-component="callout-insight">
  <p>
    结论先行：这套架构真正的瓶颈不是读写吞吐，而是跨机房状态同步——QPS 破万后它会吃满 30ms
    延迟预算。若业务能接受最终一致，这个瓶颈就不成立。
  </p>
</aside>
```

## 3. 风险 callout `callout-warning`

写代价、坑、失败前置条件。**不要**用它写普通提醒，否则读者会脱敏。

```html
<aside data-hr-component="callout-warning">
  <p>代价：迁移期间双写会让存储成本翻倍，且旧写入路径必须再撑两个版本才能下线。</p>
</aside>
```

## 4. 对比分栏 `split-compare`

恰好两栏；每栏一个 `.hr-card` 式容器，首行写方案名。多于两个方案改成分组表格。

```html
<section data-hr-component="split-compare">
  <div>
    <p><strong>方案 A：单库多租户</strong></p>
    <p>开发快、隔离弱；租户泄漏风险靠查询层兜。</p>
  </div>
  <div>
    <p><strong>方案 B：每租户一库</strong></p>
    <p>隔离强、运维重；迁移时需按月分批。</p>
  </div>
</section>
```

## 5. 深度折叠 `deep-dive`

`<details>` + `<summary>`：summary 是一句"值不值得展开"的钩子，正文放推演细节。默认收起。

```html
<details data-hr-component="deep-dive">
  <summary>展开：30ms 延迟是怎么算出来的</summary>
  <p>
    跨机房 RTT 12ms，状态同步两跳，P99 峰值再乘 1.6 的尾延迟系数，合计
    30ms——这个系数来自去年双十一的观测，不是理论值。
  </p>
</details>
```

## 6. 步骤时间线 `step-timeline`

`<ol>`，每项 `<li>` 以一个 `<strong>` 标题开头。用于流程、roadmap、复盘。

```html
<ol data-hr-component="step-timeline">
  <li>
    <p><strong>第 1 周 · 影子写</strong></p>
    <p>新路径只写不读，比对结果差异，差异率必须为零。</p>
  </li>
  <li>
    <p><strong>第 2 周 · 灰度读</strong></p>
    <p>按租户 5% → 50% → 100% 放量，每档观察一个完整业务日。</p>
  </li>
  <li>
    <p><strong>第 3 周 · 下线旧路径</strong></p>
    <p>删除双写，回滚窗口从此关闭。</p>
  </li>
</ol>
```

## 7. 图表舞台 `diagram-stage`

图片或 SVG 的容器，`<figcaption>` 必须有——没有图注的图在长文里等于噪声。

```html
<figure data-hr-component="diagram-stage">
  <img
    src="../assets/latency-budget.svg"
    alt="延迟预算拆解：RTT 12ms、同步两跳 18ms、尾延迟 30ms"
    width="960"
    height="540"
  />
  <figcaption>图 1 · 延迟预算拆解。数据来自 2026-10 双十一观测，非理论估算。</figcaption>
</figure>
```

## 8. 媒体卡片 `media-card`

录音或视频的统一外壳：播放器 + 图注（时长、发言人、来源）+ 可选的折叠逐字稿，三样永远在同一个位置。`<figure>` 里必须有 `<audio>` 或 `<video>`，也必须有 `<figcaption>`；逐字稿用一个普通的 `<details>` 放在最后。

```html
<figure data-hr-component="media-card">
  <audio controls preload="metadata" src="assets/weekly-01.m4a"></audio>
  <figcaption>录音 1 · 00:15 · 发言：产品负责人</figcaption>
  <details>
    <summary>展开逐字稿</summary>
    <p>先说结论：导出 PDF 这周必须修好，用户反馈里有三分之一都在说这件事。</p>
  </details>
</figure>
```

## 结构规约（`hr check` 与 `hr patch` 会查）

| 组件                                 | 根标签                      | 直接子元素                                   |
| ------------------------------------ | --------------------------- | -------------------------------------------- |
| `kpi-bento`                          | `section` / `div` / `ul`    | 3–6 个                                       |
| `callout-insight`、`callout-warning` | `aside` / `div` / `section` | 不限                                         |
| `split-compare`                      | `section` / `div`           | 恰好 2 个                                    |
| `deep-dive`                          | `details`                   | 必须有 `summary`                             |
| `step-timeline`                      | `ol`                        | 必须有 `li`                                  |
| `diagram-stage`                      | `figure`                    | 必须有 `figcaption`                          |
| `media-card`                         | `figure`                    | 必须有 `audio` 或 `video`，且有 `figcaption` |

不合规不会被拒写：片段照常落盘，问题随 `hr patch` 回执的 `warnings` 给出（`component_root` / `component_shape` / `inline_style`），整篇用 `hr check <file>` 复查。看到 warning 就再 patch 一次改掉，再说“完成”。

## 反面清单

- 不要给组件加内联 `style`、`class` 之外的自定义属性：主题只认 `data-hr-component`。
- 不要把 `kpi-bento` 写成 `<ul>`：它靠 `> *` 布局，`<li>` 也可，但别再套 `<div>`。
- 不要在 `<img>` 里写 `data:` URI 或外链脚本：`forbidden_content` 会拒绝，图请放相对路径。
- 不要把 `<details>` 当折叠目录用：它是内容折叠，目录请用大纲。
