// This layer: the shared search tokenizer — `Intl.Segmenter("zh")` word segments, word-like
// parts only, lowercased — plus the CJK test that gates fuzzy matching. Pure: no IO, no state.

/** A term together with where it sits in the source string (UTF-16 offsets). */
interface SearchToken {
  /** Lowercased term text: index keys and query terms share this form. */
  readonly text: string;
  /** Inclusive UTF-16 start offset in the source string. */
  readonly start: number;
  /** Exclusive UTF-16 end offset in the source string. */
  readonly end: number;
}

/** One segmenter serves every call: `segment()` carries no state between runs. */
const SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * Word-like segments only: whitespace, punctuation, and emoji never become terms. The
 * index and the query go through the same tokenize pass, so a term seen one way can
 * never match a string tokenized the other way.
 */
export const searchTokensOf = (text: string): readonly SearchToken[] => {
  const tokens: SearchToken[] = [];
  for (const part of SEGMENTER.segment(text)) {
    if (part.isWordLike !== true) continue;
    tokens.push({
      text: part.segment.toLowerCase(),
      start: part.index,
      end: part.index + part.segment.length,
    });
  }
  return tokens;
};

/** The `tokenize` callback MiniSearch expects (positions are dropped here). */
export const tokenizeSearchText = (text: string): string[] =>
  searchTokensOf(text).map((token) => token.text);

/**
 * Terms containing any CJK-script character never take fuzzy matching: a one-edit move on a
 * two-character word is a different word, and fuzzy recall noise outweighs typo tolerance there.
 * Anything else (latin, digits, mixed) counts as "latin" for the fuzzy gate.
 */
const CJK_TERM = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export const isCjkTerm = (term: string): boolean => CJK_TERM.test(term);
