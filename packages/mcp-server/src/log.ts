// 这层管：日志（只写 stderr）。stdout 是 JSON-RPC 通道，任何一行多余输出都会毒化协议（AC-4）。

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const logLine = (line: string): void => {
  process.stderr.write(`[hreader-mcp] ${line}\n`);
};

/** 堆栈只进 stderr：正文里出现堆栈等于把实现细节倒给模型（AC-3）。 */
export const logFailure = (where: string, error: unknown): void => {
  const stack =
    error instanceof Error && error.stack !== undefined ? error.stack : messageOf(error);
  logLine(`${where} 失败：${stack}`);
};
