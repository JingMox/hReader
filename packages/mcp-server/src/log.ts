// 这层管：日志（只写 stderr）。stdout 是 JSON-RPC 通道，任何一行多余输出都会毒化协议（AC-4）。

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const logLine = (line: string): void => {
  process.stderr.write(`[hreader-mcp] ${line}\n`);
};

/** `cause` 链（`HrError(message, { cause: errnoError })`）的每一层堆栈都要留下：错因在链尾。
 * 裸非 `Error`（`throw "x"`）没有堆栈，就用它本身的文字：诊断一律进 stderr，正文那边有兜底文案。 */
const stackChainOf = (error: unknown): readonly string[] => {
  const stacks: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    stacks.push(current.stack ?? current.message);
    current = current.cause;
  }
  return stacks.length > 0 ? stacks : [messageOf(error)];
};

/** 堆栈只进 stderr：正文里出现堆栈等于把实现细节倒给模型（AC-3）。 */
export const logFailure = (where: string, error: unknown): void => {
  const stacks = stackChainOf(error);
  logLine(`${where} 失败：${stacks.join("\n    caused by: ")}`);
};
