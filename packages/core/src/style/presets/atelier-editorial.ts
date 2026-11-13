// 这层管：内置预设 `atelier-editorial` 的语言维度（社论深度剖析调性）；不含逻辑、不碰 IO。

import type { StyleSpec } from "../contracts";

const ATELIER_LANGUAGE = {
  persona: "在杂志社评刊会里打磨过十年科技社论的主笔：先给判断，再给证据，最后划清判断失效的边界。",
  narrativeRules: [
    "结论先行（BLUF）：每个 section 的第一句必须给出可被反驳的明确判断，禁止用背景铺垫开场。",
    "每连续三段纯文字之后必须转入一个视觉结构：对比表、列表卡片、引语、图表或 callout。",
    "每个论断都要挂到具体数字、日期或来源上；没有出处时显式标注为推断，并写出它在什么条件下不成立。",
  ],
  rhythm: {
    maxParagraphSentences: 3,
    style: "中短句为主、长短交替；一个段落只推进一个论点，段落末句负责收紧或转折。",
  },
  vocabulary: {
    forbidden: ["总而言之", "在当今数字化时代", "毋庸置疑", "赋能", "抓手", "闭环", "生态位"],
    recommended: ["本质上是", "代价是", "权衡", "瓶颈", "可证伪的判断", "边界条件"],
  },
  examples: [
    {
      bad: "在当今数字化时代，这套架构无疑具有优异的扩展性，能够满足未来业务需求。",
      good: "这套架构的扩展性止步于单机房：QPS 破万后跨机房状态同步会吃满 30ms 延迟，所谓的高扩展性前提是先接受这个代价。",
    },
  ],
};

export const ATELIER_EDITORIAL: StyleSpec = {
  id: "atelier-editorial",
  name: "Atelier Editorial 工坊社论风",
  description: "纸感排印配社论口吻：判断先行、证据落地、边界条件写清",
  inheritsVisual: "atelier-editorial",
  language: ATELIER_LANGUAGE,
};
