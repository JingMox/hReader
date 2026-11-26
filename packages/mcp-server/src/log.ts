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

const truncatedOf = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}…[truncated ${String(text.length - max)} chars]`;

export const logLine = (line: string): void => {
  process.stderr.write(`[hreader-mcp] ${truncatedOf(line, LINE_MAX_CHARS)}\n`);
};

/** Every layer of the `cause` chain (`HrError(message, { cause: errnoError })`) keeps its stack: the root cause sits at the tail.
 * A bare non-`Error` (`throw "x"`) has no stack, so we use its own text: diagnostics always go to stderr; the body side has fallback wording. */
const stackChainOf = (error: unknown): readonly string[] => {
  const stacks: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && stacks.length < CAUSE_MAX_DEPTH) {
    stacks.push(truncatedOf(current.stack ?? current.message, SECTION_MAX_CHARS));
    current = current.cause;
  }
  if (current instanceof Error) stacks.push("…[truncated further causes]");
  return stacks.length > 0 ? stacks : [truncatedOf(messageOf(error), SECTION_MAX_CHARS)];
};

/** Stacks only go to stderr: a stack in the body dumps implementation details on the model. */
export const logFailure = (where: string, error: unknown): void => {
  const stacks = stackChainOf(error);
  logLine(`${where} 失败：${stacks.join("\n    caused by: ")}`);
};
