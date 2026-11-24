// 这层管：错误文本的收敛（取首行、unknown 归一到 string）；零 I/O。

/**
 * 只留首个非空行并截到 200 字：Chrome / puppeteer / pdf-lib 的报错常带整段栈与绝对路径，
 * 整段塞进 envelope 既泄路径又撑爆 `--json`。
 */
export const firstErrorLineOf = (text: string): string => {
  const line = text.split(/\r?\n/u).find((item) => item.trim() !== "") ?? "";
  return line.length > 200 ? line.slice(0, 200) : line;
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
