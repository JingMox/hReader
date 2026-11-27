# Component fragments: copy-paste ready

Every fragment is a **single root element** and can be fed to `hr patch` as `--html-file` content verbatim. Themes key off the `data-hr-component` selector — do not add inline styles of your own.

## 1. KPI card grid `kpi-bento`

3–6 key numbers; each cell holds one conclusion plus a one-line note on how it was measured. Fewer than 3: use inline `<strong>` instead; more than 6: switch to a grouped list.

```html
<section data-hr-component="kpi-bento">
  <div>
    <p><strong>38%</strong></p>
    <p>first-screen TTI reduction, measured at P75 on real devices</p>
  </div>
  <div>
    <p><strong>12 ms</strong></p>
    <p>cross-region state-sync latency, measured at 10k QPS</p>
  </div>
  <div>
    <p><strong>2 weeks</strong></p>
    <p>rollback window; beyond it a data migration is required</p>
  </div>
</section>
```

## 2. Insight callout `callout-insight`

One paragraph, three sentences max: judgment first, then evidence, then the boundary. Do not stuff lists in.

```html
<aside data-hr-component="callout-insight">
  <p>
    Conclusion first: this architecture's real bottleneck is not read/write throughput but
    cross-region state sync — past 10k QPS it eats the whole 30 ms latency budget. If the business
    can live with eventual consistency, the bottleneck disappears.
  </p>
</aside>
```

## 3. Risk callout `callout-warning`

For costs, pitfalls, and failure preconditions. **Do not** use it for ordinary reminders — readers will grow numb to it.

```html
<aside data-hr-component="callout-warning">
  <p>
    Cost: dual writes during the migration double storage spend, and the old write path must survive
    two more releases before it can be retired.
  </p>
</aside>
```

## 4. Comparison columns `split-compare`

Exactly two columns; each column is a `.hr-card`-style container whose first line names the option. More than two options: switch to a grouped table.

```html
<section data-hr-component="split-compare">
  <div>
    <p><strong>Option A: one database, many tenants</strong></p>
    <p>Fast to build, weak isolation; tenant leakage risk is absorbed by the query layer.</p>
  </div>
  <div>
    <p><strong>Option B: one database per tenant</strong></p>
    <p>Strong isolation, heavy operations; migration ships in monthly batches.</p>
  </div>
</section>
```

## 5. Collapsible depth `deep-dive`

`<details>` + `<summary>`: the summary is a one-line "is it worth expanding" hook; the body holds the reasoning details. Collapsed by default.

```html
<details data-hr-component="deep-dive">
  <summary>Expand: how the 30 ms latency was derived</summary>
  <p>
    Cross-region RTT is 12 ms, state sync takes two hops, and the P99 peak multiplies in a 1.6
    tail-latency factor — 30 ms in total. That factor comes from last year's Double-11 observations,
    not from theory.
  </p>
</details>
```

## 6. Step timeline `step-timeline`

An `<ol>`; every `<li>` opens with a `<strong>` title. For processes, roadmaps, retrospectives.

```html
<ol data-hr-component="step-timeline">
  <li>
    <p><strong>Week 1 · Shadow writes</strong></p>
    <p>
      The new path writes without serving reads; diff the results — the divergence rate must be
      zero.
    </p>
  </li>
  <li>
    <p><strong>Week 2 · Gradual reads</strong></p>
    <p>Ramp per tenant 5% → 50% → 100%, observing one full business day per step.</p>
  </li>
  <li>
    <p><strong>Week 3 · Retire the old path</strong></p>
    <p>Drop the dual writes; the rollback window closes from here on.</p>
  </li>
</ol>
```

## 7. Diagram stage `diagram-stage`

A container for an image or SVG; `<figcaption>` is mandatory — an image without a caption is noise inside a long document.

```html
<figure data-hr-component="diagram-stage">
  <img
    src="../assets/latency-budget.svg"
    alt="Latency budget breakdown: 12 ms RTT, 18 ms for two sync hops, 30 ms tail latency"
    width="960"
    height="540"
  />
  <figcaption>
    Figure 1 · Latency budget breakdown. Data from the 2026-10 Double-11 observations, not a
    theoretical estimate.
  </figcaption>
</figure>
```

## 8. Media card `media-card`

The uniform shell for audio or video: player + caption (duration, speaker, source) + optional collapsible transcript — the three always sit in the same position. The `<figure>` must contain an `<audio>` or `<video>`, and must contain a `<figcaption>`; the transcript is a plain `<details>` placed last.

```html
<figure data-hr-component="media-card">
  <audio controls preload="metadata" src="assets/weekly-01.m4a"></audio>
  <figcaption>Recording 1 · 00:15 · Speaker: product lead</figcaption>
  <details>
    <summary>Expand transcript</summary>
    <p>
      Conclusion first: PDF export must be fixed this week — a third of user feedback is about it.
    </p>
  </details>
</figure>
```

## Structural spec (checked by `hr check` and `hr patch`)

| Component                            | Root tag                    | Direct children                                 |
| ------------------------------------ | --------------------------- | ----------------------------------------------- |
| `kpi-bento`                          | `section` / `div` / `ul`    | 3–6                                             |
| `callout-insight`, `callout-warning` | `aside` / `div` / `section` | unrestricted                                    |
| `split-compare`                      | `section` / `div`           | exactly 2                                       |
| `deep-dive`                          | `details`                   | must have `summary`                             |
| `step-timeline`                      | `ol`                        | must have `li`                                  |
| `diagram-stage`                      | `figure`                    | must have `figcaption`                          |
| `media-card`                         | `figure`                    | must have `audio` or `video`, plus `figcaption` |

Non-compliant fragments are not refused: they land as usual and the problems ride along in the `hr patch` receipt's `warnings` (`component_root` / `component_shape` / `inline_style`); re-check the whole document with `hr check <file>`. When you see a warning, patch once more to fix it before calling it "done".

## Anti-patterns

- Do not give components inline `style` or custom attributes beyond `class`: themes only recognize `data-hr-component`.
- Do not write `kpi-bento` as a `<ul>` with nested wrappers: it lays out by `> *` — `<li>` children are fine, but don't wrap them in extra `<div>`s.
- Do not use `data:` URIs or external scripts in `<img>`: `forbidden_content` rejects them — put images at relative paths.
- Do not use `<details>` as a collapsible table of contents: it collapses content; for a table of contents use the outline.
