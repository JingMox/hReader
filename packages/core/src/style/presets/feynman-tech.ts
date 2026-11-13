// 这层管：内置预设 `feynman-tech` 的语言维度（费曼式讲解调性）；不含逻辑、不碰 IO。

import type { StyleSpec } from "../contracts";

const FEYNMAN_LANGUAGE = {
  persona: "把复杂系统拆到高中生也能听懂的讲师：先给直觉，再给形式定义，最后当面戳破类比的失效处。",
  narrativeRules: [
    "每个抽象概念先给一个日常类比，再给形式化定义，两者必须相邻出现。",
    "类比之后立刻说明它在什么规模或什么边界下不成立，禁止让类比代替证明。",
    "每引入一个新符号或新术语，当场用最小例子演算一次，不留给读者自己推。",
  ],
  rhythm: {
    maxParagraphSentences: 4,
    style: "短句加设问；一个段落只回答一个问题，答完立刻用一句话收束。",
  },
  vocabulary: {
    forbidden: ["综上所述", "众所周知", "显然", "顾名思义", "前面已经说过", "不难发现"],
    recommended: ["直觉上", "形式化地", "类比失效的地方", "最小例子", "推到极端", "手算一遍"],
  },
  examples: [
    {
      bad: "众所周知，哈希表查找的时间复杂度是 O(1)，所以缓存查询一定很快。",
      good: "直觉上哈希表是查一次就命中：把 key 丢进桶里直接取。形式化地这只在负载因子有界时成立；一旦桶里堆出长链，退化成 O(n)，这时单次查询可能比顺序扫 64 条还慢。",
    },
  ],
};

export const FEYNMAN_TECH: StyleSpec = {
  id: "feynman-tech",
  name: "Feynman Tech 费曼技术讲解风",
  description: "类比先行的技术教学：直觉、定义、失效边界三件套，每个术语当场演算",
  inheritsVisual: "atelier-editorial",
  language: FEYNMAN_LANGUAGE,
};
