// This layer: logging (stderr only). stdout is the JSON-RPC channel — any extra line there poisons the protocol.

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Character cap for one log entry (one write): error messages echo unbounded input verbatim,
 * and a megabyte-long single line can stall the log pipeline and the CI runner; the truncation point marks how many chars were cut. */
const LINE_MAX_CHARS = 8 * 1024;
/** Cap per error-chain segment (one stack/message layer): each layer truncates independently so the tail cause is not eaten by a huge earlier layer. */
const SECTION_MAX_CHARS = 4 * 1024;
/** Depth cap for the `cause` chain: an overly deep or self-cyclic chain must not loop forever or turn the log into a bottomless pit. */
const CAUSE_MAX_DEPTH = 8;
/** Headroom kept inside each section's share of the line budget for its own `…[truncated N chars]`
 * marker — N has at most 10 digits for any real string. */
const SECTION_MARK_RESERVE = 32;
/** Floor for a section's share of the line budget: keeps the share (and the `…[truncated further
 * causes]` marker inside it) printable even when the prefix leaves almost no room. */
const SECTION_MIN_CHARS = 256;
/** Separator between cause-chain layers. */
const CAUSED_BY = "\n    caused by: ";
/** Marker appended when the cause chain is deeper than CAUSE_MAX_DEPTH. */
const CAUSES_MARK = "…[truncated further causes]";

/** Back off one code unit when the cut at `max` splits a surrogate pair: `Array.from` counts code
 * points, so one point across the two boundary units means a kept lone half-surrogate — a worse defect
 * than one fewer char (an already-lone surrogate in the input stays untouched). */
const codePointCutOf = (text: string, max: number): number =>
  Array.from(text.slice(max - 1, max + 1)).length === 1 ? max - 1 : max;

const truncatedOf = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const kept = codePointCutOf(text, max);
  return `${text.slice(0, kept)}…[truncated ${String(text.length - kept)} chars]`;
};

export const logLine = (line: string): void => {
  process.stderr.write(`[hreader-mcp] ${truncatedOf(line, LINE_MAX_CHARS)}\n`);
};

/** Every layer of the `cause` chain (`HrError(message, { cause: errnoError })`) keeps its stack: the root cause sits at the tail.
 * Layers are raw here — the per-section share of the line budget is only known once the chain length is, so
 * truncation happens in `logFailure`. A bare non-`Error` (`throw "x"`) has no stack: diagnostics always go to
 * stderr; the body side has fallback wording. */
const stackChainOf = (error: unknown): readonly string[] => {
  const stacks: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && stacks.length < CAUSE_MAX_DEPTH) {
    stacks.push(current.stack ?? current.message);
    current = current.cause;
  }
  if (current instanceof Error) stacks.push(CAUSES_MARK);
  return stacks.length > 0 ? stacks : [messageOf(error)];
};

/** Stacks only go to stderr: a stack in the body dumps implementation details on the model. */
export const logFailure = (where: string, error: unknown): void => {
  const stacks = stackChainOf(error);
  const prefix = `${where} 失败：`;
  // The whole line is capped at LINE_MAX_CHARS: split it into equal per-section shares — each minus its own
  // possible truncation marker — so giant earlier stacks cannot push the last cause, or the
  // `…[truncated further causes]` marker, past the cut.
  const share = Math.floor(
    (LINE_MAX_CHARS - prefix.length - CAUSED_BY.length * (stacks.length - 1)) / stacks.length,
  );
  const sectionMax = Math.max(
    SECTION_MIN_CHARS,
    Math.min(SECTION_MAX_CHARS, share - SECTION_MARK_RESERVE),
  );
  const bounded = stacks.map((section) => truncatedOf(section, sectionMax));
  logLine(`${prefix}${bounded.join(CAUSED_BY)}`);
};
