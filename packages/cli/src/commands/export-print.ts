// This layer: `hr export` (read document -> outline -> theme -> print sheet -> stdout or atomic write); no argument checks, no exit codes.
// `hr pdf` reuses the same print sheet and the same `--out` rules, avoiding a second copy of the path logic.

import { basename, dirname, extname, resolve } from "node:path";

import {
  assertThemeSafe,
  buildOutline,
  DEFAULT_STYLE_ID,
  embeddedThemeCssOf,
  HrError,
  isInside,
  loadThemeCss,
  nodePatchDeps,
  nodeStyleDeps,
  parseHtml,
  serializeHtml,
  writeAtomic,
  type PatchDeps,
  type StyleDeps,
} from "@hreader/core";
import { printHtmlReportOf, type PaperSize, type PrintHtmlResult } from "@hreader/renderer-html";

import { readTextFile } from "../input";
import { dataExport, humanExport, humanExportWritten, jsonOk } from "../output";

const encoder = new TextEncoder();

export interface ExportPrintInput {
  readonly path: string;
  readonly visual: string;
  /** Absolute path; `undefined` = print to stdout. */
  readonly out: string | undefined;
  readonly workspace: string;
  readonly json: boolean;
  /** Whether to overwrite an existing `--out`; default refuses and suggests `--force` (public contract `file_exists`). */
  readonly force: boolean;
  /** Outlet for non-fatal notes (external images dropped); `run.ts` routes it to stderr — this layer never touches the process. */
  readonly warn: (message: string) => void;
  /** The `--out` printed in the receipt (user's view): falls back to the real path when not given. */
  readonly displayOut?: string | undefined;
}

/** fs errnos must never leak outward as `code`: fold into `io_failure` (exit 3) and keep the original only in `cause`. */
export const ioFailureOf = (error: unknown, what: string, path: string): HrError =>
  error instanceof HrError
    ? error
    : new HrError("io_failure", `${what}失败：${path}`, { cause: error });

/**
 * A missing/non-directory/unreadable parent all count as io: `writeAtomic` treats `ENOENT` as an escape (fail-closed), so judge it here first.
 * `readdir` rather than `stat`: the port has no `isDirectory`, and "can be listed" is exactly equivalent to "is an enterable directory".
 */
export const assertWritableDirOf = async (dir: string, deps: PatchDeps): Promise<void> => {
  try {
    await deps.fs.readdir(dir);
  } catch (error: unknown) {
    throw ioFailureOf(error, "写入前检查父目录", dir);
  }
};

/**
 * Out-of-bounds must be judged **before** "target exists": letting `file_exists` (exit 1) win would misreport
 * "writing outside the workspace" as "already exists" and probe the outside path in passing (that is how stray
 * files get left). This layer only does the lexical check (`run.ts` already realpathed both sides); symlink
 * escapes are re-checked by `writeAtomic`'s realpath right before writing — not duplicated here.
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
  /** `undefined` = use the document's embedded `#hr-theme`; fall back to the default theme when the document has none. */
  readonly visual: string | undefined;
  /** Page size is required: `hr export`/`hr png` fix it at a4, `hr pdf` passes `--page-size`. */
  readonly paper: PaperSize;
  readonly workspace: string;
  readonly warn: (message: string) => void;
}

interface ResolvedTheme {
  readonly visualId: string;
  readonly bodyClass: string;
  readonly themeCss: string;
}

/**
 * Theme fallback chain: an explicit `--visual` loads by id; otherwise the document's own `#hr-theme`
 * wins (it is what `applyStyle` wrote, and re-printing must use the same bytes), and only a missing or
 * blank one falls through to the default theme.
 * All three paths pass `assertThemeSafe` before output: the document may be foreign and its `#hr-theme` bytes are untrusted.
 */
const resolveTheme = async (html: string, input: PrintSourceInput): Promise<ResolvedTheme> => {
  const deps: StyleDeps = nodeStyleDeps(input.workspace);
  const fromId = async (id: string): Promise<ResolvedTheme> => ({
    visualId: id,
    bodyClass: `hr-visual-${id}`,
    themeCss: await loadThemeCss(id, deps),
  });
  if (input.visual !== undefined) return fromId(input.visual);
  const embedded = embeddedThemeCssOf(html);
  if (embedded === undefined || embedded.trim() === "") return fromId(DEFAULT_STYLE_ID);
  assertThemeSafe(embedded);
  return { visualId: "document", bodyClass: "hr-visual-document", themeCss: embedded };
};

/** Single source of the print sheet: `hr export` writes the HTML, `hr pdf` hands the same HTML to Chrome. */
export const printProductOf = async (input: PrintSourceInput): Promise<PrintHtmlResult> => {
  // No id injection (BUG-02): if the source has no `data-hr-id`, the product carries none — otherwise an id the user copied from the print sheet
  // would not exist in the source and `patch` could only answer `node_not_found`.
  const html = await readTextFile(input.path);
  const parsed = parseHtml(html);
  const theme = await resolveTheme(html, input);
  const report = printHtmlReportOf({
    docId: basename(input.path, extname(input.path)),
    visualId: theme.visualId,
    paper: input.paper,
    bodyClass: theme.bodyClass,
    documentHtml: serializeHtml(parsed),
    outline: buildOutline(parsed).nodes,
    themeCss: theme.themeCss,
  });
  // The 4 MiB cap is enforced once, in the render layer (`MAX_PRODUCT_BYTES` in print-page.ts, judged with `>`):
  // duplicating the same gate in both layers yields a branch that can never run, and `HrError("invalid_input")`
  // already reaches `run.ts`'s exit-code mapping. `bytes` here only feeds the human line and `--json`.
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
  // `hr export` fixes the paper at a4: that is the `hr export` product contract — other sizes only come via `hr pdf --page-size`.
  const report = await printProductOf({ ...input, paper: "a4" });
  if (input.out === undefined) {
    return input.json ? jsonOk(dataExport(report, null)) : humanExport(report);
  }
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  // The order is part of the contract: io (unwritable parent) -> out-of-bounds -> exists, so exit codes stay a stable 3/3/1.
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
