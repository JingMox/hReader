// 这层管："文本 → 折叠串"这一件事（NFKC + 小写 + 去零宽，附码元偏移映射）；不解析 HTML、不匹配。
// 解析层（spec.ts 的禁词去重）与匹配层（lint.ts）必须同口径，所以折叠原语只许有一份：
// 两份各写一遍，`école` 的两种写法就会一边算一个词、一边算两个。

/** 零宽字符（Cf，含 U+200B）不参与匹配：粘贴污染不该让禁用词漏网。 */
const ZERO_WIDTH = /\p{Cf}/u;

export interface Folded {
  /** 归一化后的文本（NFKC + 小写 + 去零宽）：只在内部用于查找。 */
  readonly text: string;
  /** 归一化后第 i 个码元对应的原文码元偏移：命中点由此映射回原文。 */
  readonly source: readonly number[];
}

/**
 * 逐**码元**折叠（NFKC 可能变长：`ﬁ` → `fi`）：`indexOf` 返回码元下标，source 也必须逐码元记，
 * 否则 emoji 这类代理对之前的命中会整体偏 +1。
 */
export const foldOf = (text: string): Folded => {
  const chars: string[] = [];
  const source: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined || ZERO_WIDTH.test(char)) continue;
    for (const folded of char.normalize("NFKC").toLowerCase()) {
      chars.push(folded);
      source.push(index);
    }
  }
  return { text: chars.join(""), source };
};

/** 词表去重（spec.ts）必须与匹配同口径，否则「école」的两种写法会算两个词、同一条命中报两次。 */
export const foldWord = (word: string): string => foldOf(word).text;
