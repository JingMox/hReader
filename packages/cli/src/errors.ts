// 这层管：错误文本的收敛（取首行、unknown 归一到 string）与「先出报告再失败」的错误形态；零 I/O。

import { HrError } from "@hreader/core";

/**
 * `--strict` 失败：报告已在 `report` 里排好（stdout 照常先出），错误本体按
 * `invalid_document` 落到退出码 1。`--json` 时报告 JSON 必须是 stdout 上唯一一行，
 * 所以错误消息统一走 stderr，不走 `reportFailure` 的「json 错误进 stdout」通道。
 */
export class StrictFailure extends HrError {
  readonly report: string;

  constructor(message: string, report: string) {
    super("invalid_document", message);
    this.name = "StrictFailure";
    this.report = report;
  }
}

/**
 * 给已存在的错误「追加一行 stderr 指引」的包装：code / message / data 原样保留
 * （冻结契约不动），hint 由 `reportFailure` 在错误行之后补印。
 */
export class HintedError extends HrError {
  readonly hint: string;

  constructor(error: HrError, hint: string) {
    super(error.code, error.message, {
      cause: error,
      ...(error.data === undefined ? {} : { data: error.data }),
    });
    this.name = "HintedError";
    this.hint = hint;
  }
}

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
