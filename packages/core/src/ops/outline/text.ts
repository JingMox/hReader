// 这层管：字数与截断（词切分口径的唯一实现）；不做归一、不判断标签、不遍历 DOM。

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const COMBINING_MARK = /\p{M}/u;
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 字数规则：先 NFC 归一（组合附标不另计、NFC/NFD 同值）。
 * 一个 `[\p{L}\p{N}]` 连续串计 1 词，**只有** CJK（汉字/假名/谚文，含扩展 B）逐字符各计 1；
 * 全角拉丁/希伯来/阿拉伯等非 CJK 字母按连串计。连字符/撇号/逗号/句点/空白都是分隔符。
 */
export const countWords = (text: string): number => {
  let count = 0;
  let inRun = false;
  for (const character of text.normalize("NFC")) {
    if (COMBINING_MARK.test(character)) {
      continue;
    }
    if (WORD_CHARACTER.test(character)) {
      if (CJK_CHARACTER.test(character)) {
        count += 1;
        inRun = false;
        continue;
      }
      if (!inRun) {
        count += 1;
        inRun = true;
      }
      continue;
    }
    inRun = false;
  }
  return count;
};

/** 码点长度：astral 字符（CJK 扩展 B、emoji）按 1 计，与字数规则同口径。 */
const characterCount = (text: string): number => Array.from(text).length;

/** 超上限时保留前 `limit` 个码点并以 `…` 结尾；是否发生截断由调用方统计。 */
export const truncate = (text: string, limit: number): string =>
  characterCount(text) > limit ? `${Array.from(text).slice(0, limit).join("")}…` : text;
