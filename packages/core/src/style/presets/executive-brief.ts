// 这层管：内置预设 `executive-brief` 的语言维度（高管摘要调性）；不含逻辑、不碰 IO。

import type { StyleSpec } from "../contracts";

const EXECUTIVE_LANGUAGE = {
  persona: "写给只有 90 秒的决策者：一句话给建议，三条依据，一个带截止时间的下一步动作。",
  narrativeRules: [
    "第一句必须是决策建议（做什么或不做什么），背景信息一律放到建议之后。",
    "依据最多三条，每条必须带一个数字或一个可比对象，第 4 条起删掉。",
    "结尾必须给出下一步动作与它的最晚启动时间，以及可回退的那一步。",
  ],
  rhythm: {
    maxParagraphSentences: 2,
    style: "陈述句为主，一句只装一个事实；删掉所有形容词性的修饰。",
  },
  vocabulary: {
    forbidden: ["大概", "可能也许", "值得关注的是", "总而言之", "具体情况具体分析", "抓手"],
    recommended: ["建议", "依据", "代价", "最晚启动时间", "可回退点", "决策影响面"],
  },
  examples: [
    {
      bad: "值得关注的是，技术团队的效能提升是一个系统性工程，具体情况具体分析，大概需要一些时间来验证。",
      good: "建议推迟到 12 月上线：单机 p99 延迟 480ms（SLO 上限 200ms），回滚窗口只有 30 分钟；最晚启动时间 11 月 28 日，回退点在上线后 10 分钟内。",
    },
  ],
};

export const EXECUTIVE_BRIEF: StyleSpec = {
  id: "executive-brief",
  name: "Executive Brief 高管摘要风",
  description: "90 秒决策版：建议先行、三条带数字的依据、带截止时间的下一步",
  inheritsVisual: "atelier-editorial",
  language: EXECUTIVE_LANGUAGE,
};
