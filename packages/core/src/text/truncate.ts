// This layer: pure string helpers shared by every host's output truncation; no I/O, no state.

/**
 * The longest prefix of `text` whose length is at most `maxUnits` UTF-16 code units and that does
 * not end inside a surrogate pair: when the cut at `maxUnits` would land between a high surrogate
 * (index `maxUnits - 1`) and its low half (index `maxUnits`), the high half is dropped too — the
 * result is one unit shorter than the limit, never longer, and never carries a newly-created lone
 * surrogate into JSON (where it would serialize as an invalid `\ud8xx` scalar).
 * `maxUnits` is floored and clamped at 0: negative, fractional and `NaN` limits all degrade to a
 * clean cut instead of an unbounded one (`Infinity` still means "no cut").
 * Lone surrogates already in the input are echoed as-is: the cut must not *create* one, but
 * truncating is not the place to repair malformed text.
 */
export const cutAtCodePoint = (text: string, maxUnits: number): string => {
  const max = Number.isNaN(maxUnits) ? 0 : Math.max(0, Math.floor(maxUnits));
  if (text.length <= max) return text;
  const lead = text.charCodeAt(max - 1);
  const tail = text.charCodeAt(max);
  const splitsPair = lead >= 0xd800 && lead <= 0xdbff && tail >= 0xdc00 && tail <= 0xdfff;
  return text.slice(0, splitsPair ? max - 1 : max);
};
