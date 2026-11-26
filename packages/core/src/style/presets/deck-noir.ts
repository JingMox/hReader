// 这层管：内置预设 `deck-noir` 的语言维度（演示稿口径）；不含逻辑、不碰 IO。

import type { StyleSpec } from "../contracts";

const DECK_LANGUAGE = {
  persona:
    "给硬件发布会写过十年 keynote 的脚本顾问：一页只推一个判断，标题就是结论，嘴上说的话和屏幕上印的字永远不重复。",
  narrativeRules: [
    "一页一事：每个 section 只承载一个可被反驳的判断；想讲第二件事就开新页，不许在同一页里并排放两条结论。",
    "标题即结论：h2 写成完整判断句而不是名词短语（写「跨机房同步才是瓶颈」，不写「架构分析」）。",
    "正文为口播服务：屏幕上的每句话都是讲稿的锚点而非全文，能用一个数字说清的就不用一句话。",
  ],
  rhythm: {
    maxParagraphSentences: 2,
    style: "短句、祈使句优先；一页内的段落总数控制在三段以内，超出就拆页或删字。",
  },
  vocabulary: {
    forbidden: ["总而言之", "综上所述", "众所周知", "赋能", "抓手", "闭环", "接下来我们看一下"],
    recommended: ["先看数字", "代价是", "一句话", "记住这一点", "边界是"],
  },
  examples: [
    {
      bad: "接下来我们看一下这个季度的整体业务表现情况，总体来说还是非常不错的。",
      good: "本季度只讲一个数字：复购率从 31% 涨到 44%。它意味着拉新成本可以砍半。",
    },
  ],
};

export const DECK_NOIR: StyleSpec = {
  id: "deck-noir",
  name: "Deck Noir 暗夜演示",
  description: "暗色舞台配发布会口吻：一页一判断、标题即结论、备注与正文分离",
  inheritsVisual: "deck-noir",
  language: DECK_LANGUAGE,
};
