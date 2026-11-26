// 这层管：日志（只写 stderr）。stdout 是 JSON-RPC 通道，任何一行多余输出都会毒化协议。

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 单条日志（一次 write）的字符上限：错误信息会原样回显不受限的入参，
 * MB 级单行能把日志管线与 CI runner 卡死；截断处标出被截掉的字符数。 */
const LINE_MAX_CHARS = 8 * 1024;
/** 错误链单段（一层 stack/message）的上限：每层各自截断，链尾的错因不被前面的大层吃掉。 */
const SECTION_MAX_CHARS = 4 * 1024;
/** `cause` 链的层数上限：过深或自环的链不能变死循环、也不能把日志写成无底洞。 */
const CAUSE_MAX_DEPTH = 8;

const truncatedOf = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}…[truncated ${String(text.length - max)} chars]`;

export const logLine = (line: string): void => {
  process.stderr.write(`[hreader-mcp] ${truncatedOf(line, LINE_MAX_CHARS)}\n`);
};

/** `cause` 链（`HrError(message, { cause: errnoError })`）的每一层堆栈都要留下：错因在链尾。
 * 裸非 `Error`（`throw "x"`）没有堆栈，就用它本身的文字：诊断一律进 stderr，正文那边有兜底文案。 */
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

/** 堆栈只进 stderr：正文里出现堆栈等于把实现细节倒给模型。 */
export const logFailure = (where: string, error: unknown): void => {
  const stacks = stackChainOf(error);
  logLine(`${where} 失败：${stacks.join("\n    caused by: ")}`);
};
