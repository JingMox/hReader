// 结构化排版组件目录与内置 SVG 图标。
const hrd = window.__hrd;

hrd.COMPONENTS = [
  { id: "h2", label: "二级标题 H2", tag: "标题", html: "<h2>新章节标题</h2>" },
  { id: "h3", label: "三级标题 H3", tag: "标题", html: "<h3>小节标题</h3>" },
  {
    id: "kpi-bento",
    label: "KPI 指标卡阵 (kpi-bento)",
    tag: "数据",
    html: '<div data-hr-component="kpi-bento"><div><p><strong>38%</strong></p><p>关键指标变化</p></div><div><p><strong>12 ms</strong></p><p>核心延迟实测</p></div><div><p><strong>100%</strong></p><p>自动化覆盖率</p></div></div>',
  },
  {
    id: "callout-insight",
    label: "洞察高亮块 (callout-insight)",
    tag: "判断",
    html: '<div data-hr-component="callout-insight"><p>结论先行：在此写下一条需要读者记住的关键判断与事实依据。</p></div>',
  },
  {
    id: "callout-warning",
    label: "风险提示块 (callout-warning)",
    tag: "代价",
    html: '<div data-hr-component="callout-warning"><p>风险提示：明确列出方案的代价、前置条件与回滚边界。</p></div>',
  },
  {
    id: "split-compare",
    label: "左右对比分栏 (split-compare)",
    tag: "对照",
    html: '<div data-hr-component="split-compare"><div><p><strong>方案 A</strong></p><p>上手更快，改造成本低。</p></div><div><p><strong>方案 B</strong></p><p>隔离更强，长期扩展性好。</p></div></div>',
  },
  {
    id: "deep-dive",
    label: "深度推演折叠 (deep-dive)",
    tag: "细节",
    html: '<details data-hr-component="deep-dive"><summary>展开：查看推演细节与口径说明</summary><p>这里放置可跳过的详细推演步骤或原始数据来源。</p></details>',
  },
  {
    id: "step-timeline",
    label: "步骤时间线 (step-timeline)",
    tag: "流程",
    html: '<ol data-hr-component="step-timeline"><li><p><strong>第 1 步 · 准备</strong></p><p>完成现状评估与备份。</p></li><li><p><strong>第 2 步 · 实施</strong></p><p>按计划灰度推进。</p></li><li><p><strong>第 3 步 · 验收</strong></p><p>核对指标后正式收尾。</p></li></ol>',
  },
  {
    id: "diagram-stage",
    label: "图表舞台 (diagram-stage)",
    tag: "图示",
    html: '<figure data-hr-component="diagram-stage"><svg viewBox="0 0 640 120" width="640" height="120" role="img" aria-label="流程示意图"><rect x="20" y="25" width="160" height="70" rx="8" fill="#efe7d6" stroke="#7a4b1f"/><text x="100" y="65" text-anchor="middle" font-size="14" fill="#1b1a17">1. 输入与解析</text><line x1="180" y1="60" x2="240" y2="60" stroke="#7a4b1f" stroke-width="2"/><rect x="240" y="25" width="160" height="70" rx="8" fill="#efe7d6" stroke="#7a4b1f"/><text x="320" y="65" text-anchor="middle" font-size="14" fill="#1b1a17">2. 结构化改写</text><line x1="400" y1="60" x2="460" y2="60" stroke="#7a4b1f" stroke-width="2"/><rect x="460" y="25" width="160" height="70" rx="8" fill="#efe7d6" stroke="#7a4b1f"/><text x="540" y="65" text-anchor="middle" font-size="14" fill="#1b1a17">3. 排版与发布</text></svg><figcaption>图 1 · 结构化写作流程示意（右键或点右侧菜单可编辑 SVG）</figcaption></figure>',
  },
];

hrd.ICONS = {
  treeChevRight:
    '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>',
  treeChevDown:
    '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 4.5 3.5 3.5 3.5-3.5"/></svg>',
  toToc:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3" cy="4" r="1" fill="currentColor" stroke="none"/><path d="M6 4h7.5"/><circle cx="5.2" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 8h5.5"/><circle cx="5.2" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M8 12h4.2"/></svg>',
  toFiles:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.8A1 1 0 0 1 3 2.8h2.6l1.1 1.2H13a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/><path d="M5 8.2h6" stroke-width="1.2" opacity="0.65"/></svg>',
  search:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><circle cx="7.2" cy="7.2" r="4.3"/><path d="m10.6 10.6 2.9 2.9"/></svg>',
  vault:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"><path d="M1.8 4.2a1.2 1.2 0 0 1 1.2-1.2h3l1.3 1.5h5.7a1.2 1.2 0 0 1 1.2 1.2v6.1a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2Z"/></svg>',
  sidebar:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2"/><path d="M5.6 2.5v11"/></svg>',
  source:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 4.5-3.3 3.5 3.3 3.5M10.5 4.5l3.3 3.5-3.3 3.5"/></svg>',
  focus:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/></svg>',
  notes:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"><path d="M3 3h10v7.5H7.2L4 13v-2.5H3Z"/></svg>',
  gear: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><circle cx="8" cy="8" r="2.2"/><path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1" stroke-linecap="round"/></svg>',
};
