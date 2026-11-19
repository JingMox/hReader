// 这层管：`pdf` / `png` 两条产物命令的装配（路径换算 + 会话层注入点）；`run.ts` 只做分发。
// 拆成独立文件是为了守住 `max-lines: 300`（本仓硬门禁），语义没有变化。

import { join } from "node:path";

import type { Intent } from "./args";
import { realpathThroughAncestors } from "./canonical";
import { chromeDepsOf, renderPdfOf, renderPngOf } from "./chrome/session";
import { pdfCommand } from "./commands/pdf";
import { pngCommand } from "./commands/png";
import { displayedPathOf } from "./output";

/** 分发层归一好的三样：展示口径（`cwd`）、停止口、env 快照；`warn` 是 stderr 的非致命通道。 */
export interface ProductIo {
  readonly cwd: string;
  readonly stop: Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly warn: (message: string) => void;
}

/** 纸/超时/大纲这类字段意图层与命令层同名：整体透传，只换算路径相关的三项。 */
export const pdfOf = (
  intent: Extract<Intent, { kind: "pdf" }>,
  paths: { readonly workspace: string; readonly file: string },
  io: ProductIo,
): Promise<string> =>
  pdfCommand({
    ...intent,
    path: join(paths.workspace, paths.file),
    out: realpathThroughAncestors(intent.out),
    workspace: paths.workspace,
    warn: io.warn,
    displayOut: displayedPathOf(intent.out, io.cwd),
    render: (renderInput) =>
      renderPdfOf({ ...renderInput, stop: io.stop, deps: chromeDepsOf(io.env) }),
  });

/** 长图尺寸在会话层定；这里只把视口参数与停止口接上（D1 命令层不碰进程）。 */
export const pngOf = (
  intent: Extract<Intent, { kind: "png" }>,
  paths: { readonly workspace: string; readonly file: string },
  io: ProductIo,
): Promise<string> =>
  pngCommand({
    ...intent,
    path: join(paths.workspace, paths.file),
    out: realpathThroughAncestors(intent.out),
    workspace: paths.workspace,
    warn: io.warn,
    displayOut: displayedPathOf(intent.out, io.cwd),
    render: (renderInput) =>
      renderPngOf({ ...renderInput, stop: io.stop, deps: chromeDepsOf(io.env) }),
  });
