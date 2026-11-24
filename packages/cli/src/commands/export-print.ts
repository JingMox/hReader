// 这层管：`hr export`（读文档 → 大纲 → 主题 → 打印稿 → stdout 或原子写）；不判参数、不定退出码。
// `hr pdf` 复用同一份打印稿与同一套 `--out` 规矩，避免第二套路径判定。

import { basename, dirname, extname, resolve } from "node:path";

import {
  buildOutline,
  HrError,
  isInside,
  loadThemeCss,
  nodePatchDeps,
  nodeStyleDeps,
  parseHtml,
  serializeHtml,
  writeAtomic,
  type PatchDeps,
} from "@hreader/core";
import { printHtmlReportOf, type PaperSize, type PrintHtmlResult } from "@hreader/renderer-html";

import { readTextFile } from "../input";
import { dataExport, humanExport, humanExportWritten, jsonOk } from "../output";

const encoder = new TextEncoder();

export interface ExportPrintInput {
  readonly path: string;
  readonly visual: string;
  /** 绝对路径；`undefined` = 打 stdout。 */
  readonly out: string | undefined;
  readonly workspace: string;
  readonly json: boolean;
  /** `--out` 已存在时是否覆盖；缺省拒绝并提示补 `--force`（对外契约 `file_exists`）。 */
  readonly force: boolean;
  /** 非致命提示的出口（外部图片被删）；由 `run.ts` 接到 stderr，本层不碰进程。 */
  readonly warn: (message: string) => void;
  /** 回执里印的 `--out`（用户视角）：不给就印真实路径。 */
  readonly displayOut?: string | undefined;
}

/** fs 的 errno 不许当 `code` 泄给外面：折成 `io_failure`（exit 3），原始错误只留在 `cause`。 */
export const ioFailureOf = (error: unknown, what: string, path: string): HrError =>
  error instanceof HrError
    ? error
    : new HrError("io_failure", `${what}失败：${path}`, { cause: error });

/**
 * 父目录不存在/不是目录/不可读都算 io：`writeAtomic` 会把 `ENOENT` 当逃逸（fail-closed），这里先判清楚。
 * 用 `readdir` 而不是 `stat`：端口里没有 `isDirectory`，而"能列出来"正好等价于"是个可进的目录"。
 */
export const assertWritableDirOf = async (dir: string, deps: PatchDeps): Promise<void> => {
  try {
    await deps.fs.readdir(dir);
  } catch (error: unknown) {
    throw ioFailureOf(error, "写入前检查父目录", dir);
  }
};

/**
 * 越界必须**先于**"目标已存在"判：`file_exists`（exit 1）抢在前面会把"写到 workspace 外面"报成"已存在"，
 * 还顺带探一次外面那个路径（脏文件就是这么留下的）。这里只做词法那道（`run.ts` 已把两侧换成真实路径），
 * 符号链接逃逸交给 `writeAtomic` 落盘前的 realpath 复核，不在这里再写一份。
 */
export const assertOutInsideOf = (path: string, workspace: string): void => {
  if (!isInside(workspace, resolve(path))) {
    throw new HrError("path_outside_workspace", `--out 只能写到 workspace 内：${path}`);
  }
};

export const assertTargetFreeOf = async (
  path: string,
  force: boolean,
  deps: PatchDeps,
): Promise<void> => {
  if (force) return;
  try {
    await deps.fs.lstat(path);
  } catch {
    return;
  }
  throw new HrError("file_exists", `目标已存在：${path}（加 --force 覆盖）`);
};

export interface PrintSourceInput {
  readonly path: string;
  readonly visual: string;
  /** 纸张必填：`hr export`/`hr png` 固定 a4，`hr pdf` 传 `--page-size`。 */
  readonly paper: PaperSize;
  readonly workspace: string;
  readonly warn: (message: string) => void;
}

/** 打印稿的单一来源：`hr export` 落 HTML、`hr pdf` 把同一份 HTML 交给 Chrome。 */
export const printProductOf = async (input: PrintSourceInput): Promise<PrintHtmlResult> => {
  // 不注入 id（BUG-02）：源里没有 `data-hr-id`，产物就不带——否则用户从打印稿里拄下的 id
  // 在源文件里不存在，拿去 `patch` 只会得到 `node_not_found`。
  const parsed = parseHtml(await readTextFile(input.path));
  // 主题走 core：`loadThemeCss` 内部已过 `assertThemeSafe`，这一层不重复实现闸门。
  const report = printHtmlReportOf({
    docId: basename(input.path, extname(input.path)),
    visualId: input.visual,
    paper: input.paper,
    bodyClass: `hr-visual-${input.visual}`,
    documentHtml: serializeHtml(parsed),
    outline: buildOutline(parsed).nodes,
    themeCss: await loadThemeCss(input.visual, nodeStyleDeps(input.workspace)),
  });
  // 4 MiB 上限只在渲染层剥一次（`print-page.ts` 的 `MAX_PRODUCT_BYTES`，判据 `>`）：
  // 同一道闸在两层各写一遍会得到一条永远跑不到的支路，而 `HrError("invalid_input")`
  // 已经能穿到 `run.ts` 的退出码映射里。这里的 `bytes` 只用于人读行与 `--json`。
  if (report.droppedImages > 0) {
    input.warn(`已移除 ${String(report.droppedImages)} 个外部图片\n`);
  }
  return report;
};

export interface WriteOutInput {
  readonly path: string;
  readonly workspace: string;
  readonly data: Uint8Array;
  readonly what: string;
}

export const writeOutOf = async (input: WriteOutInput): Promise<void> => {
  try {
    await writeAtomic(
      { path: input.path, workspace: input.workspace, data: input.data },
      nodePatchDeps,
    );
  } catch (error: unknown) {
    throw ioFailureOf(error, input.what, input.path);
  }
};

export const exportPrintCommand = async (input: ExportPrintInput): Promise<string> => {
  // `hr export` 的纸固定 a4：它是 `hr export` 的产物契约，换纸只能走 `hr pdf --page-size`。
  const report = await printProductOf({ ...input, paper: "a4" });
  if (input.out === undefined) {
    return input.json ? jsonOk(dataExport(report, null)) : humanExport(report);
  }
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  // 顺序是契约的一部分：io（父目录不可写）→ 越界 → 已存在，退出码才能稳定是 3/3/1。
  assertOutInsideOf(input.out, input.workspace);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
  await writeOutOf({
    path: input.out,
    workspace: input.workspace,
    data: encoder.encode(report.html),
    what: "写入打印稿",
  });
  return input.json
    ? jsonOk(dataExport(report, input.out))
    : humanExportWritten(input.displayOut ?? input.out, report.bytes);
};
