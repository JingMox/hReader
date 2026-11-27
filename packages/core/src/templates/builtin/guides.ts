// This layer: guide.md texts for the builtin templates (English, written for the content-generating AI); pure strings, no logic.

const SHARED = `Do not hand-write \`data-hr-id\` attributes — the pipeline assigns them. Do not add inline styles; visual choices live in the theme, keyed by \`data-hr-component\` selectors. Fill every parenthesized placeholder with real content, then delete the parentheses.`;

const COMPONENTS = `Components (write the structure, the theme styles it): \`kpi-bento\` — a div grid of 3-6 key numbers, each cell a <p><strong>number</strong></p> plus a one-line caption; \`callout-insight\` — an <aside> with one judgment, evidence, and boundary in a single <p>; \`callout-warning\` — same shape, for costs and failure preconditions only; \`split-compare\` — a div grid of exactly two columns, each leading with <p><strong>option name</strong></p>; \`step-timeline\` — an <ol> of steps, each <li> a strong action line plus owner and deadline; \`deep-dive\` — a <details> whose <summary> hooks the reader and whose body carries the full derivation.`;

export const BLANK_HTML_GUIDE = `# Free-form HTML document

A clean semantic HTML5 skeleton: title, one top-level heading, a lead paragraph, and one content section. There is no managed article structure — any element, class, or component may be used.

- Keep semantic tags (\`<header>\`, \`<main>\`, \`<section>\`, \`<footer>\`) where they fit.
- Link page assets with relative paths under \`assets/\` — they are copied next to the document on creation.
- The template's neutral stylesheet is inlined into \`<style id="hr-theme">\`; restyle by editing that block or the document itself.
`;

export const GUIDES: Readonly<Record<"note" | "report" | "minutes" | "brief" | "slides", string>> =
  {
    note: `# Note

A single-section note: lead with the conclusion in one sentence, then expand. The skeleton is one <article data-hr-kind="note"> containing an <h1> and a "要点" section with a single placeholder paragraph — keep it short; a note is not a report.

${SHARED}`,

    report: `# Report

A full report: conclusion first, evidence in the middle, actions at the end. The skeleton is an <article data-hr-kind="report"> with sections in a fixed order — 结论 (callout-insight), 关键数据 (kpi-bento), 分析 (free prose), 方案对比 (split-compare), 风险 (callout-warning), 下一步 (step-timeline).

${COMPONENTS}

${SHARED}`,

    minutes: `# Meeting minutes

Meeting minutes: decisions, discussion, actions, transcript. The skeleton is an <article data-hr-kind="minutes"> with sections — 结论与决定 (callout-insight), 讨论要点 (per-topic prose), 待办 (step-timeline for action items), 录音与逐字稿 (a <details> deep-dive; switch to a media-card when audio exists).

${COMPONENTS}

${SHARED}`,

    brief: `# Decision brief

A one-page decision brief: what to do, why, what it costs, what happens next. The skeleton is an <article data-hr-kind="brief"> with sections — 建议 (callout-insight, a single sentence), 依据 (kpi-bento), 代价与风险 (callout-warning), 下一步 (step-timeline).

${COMPONENTS}

${SHARED}`,

    slides: `# Slide deck

A slide deck: every <section> inside the <article data-hr-kind="slides"> is one 16:9 page, and the <h1> is the title page. One page carries one message — its <h2> is the conclusion of that page, not a topic label.

${COMPONENTS}

${SHARED}`,
  };
