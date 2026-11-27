// This layer: `hr png` (print sheet -> session-layer tall image -> PNG header validation -> atomic write); no argv checks, no exit codes.
// The three write checks (io -> out-of-bounds -> exists) share `hr pdf`'s order and meaning; a failed render leaves nothing on disk.

import { dirname } from "node:path";

import { HrError, nodePatchDeps } from "@hreader/core";

import type { LongImage, RenderSource } from "../chrome/types";
import { assertPixelRequestOf } from "../chrome/pixels";
import { assertPngOf, pngSizeOf } from "../chrome/png";
import { dataPng, humanPng, jsonOk, type PngReport } from "../output";
import { foreignPlanOf } from "./export-foreign";
import {
  assertOutInsideOf,
  assertTargetFreeOf,
  assertWritableDirOf,
  printProductOf,
  writeOutOf,
} from "./export-print";

export type RenderPng = (input: {
  /** `sheet` = the managed print sheet; `foreign` = the capability-gated raw page. */
  readonly source: RenderSource;
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
  readonly timeoutMs: number;
}) => Promise<LongImage>;

export interface PngCommandInput {
  /** Absolute path: the print sheet is built by first reading the source document. */
  readonly path: string;
  /** Verbatim string: out of range is a semantic error (`invalid_input` exit 1), not a usage error. */
  readonly width: string;
  readonly scale: string;
  readonly maxHeight: string;
  /** Whether the user explicitly passed `--max-height`: unset, the default must not feed the area preflight (short documents would be wrongly refused). */
  readonly maxHeightExplicit: boolean;
  /** The outline flag given (`--outline`/`--no-outline`): PNG has no outline, so passing one is `invalid_input`. */
  readonly outlineFlag: string | undefined;
  readonly timeoutMs: number;
  /** Print-sheet theme: `undefined` = the document's embedded `#hr-theme` (default only when absent); explicit values are validated by core. */
  readonly visual: string | undefined;
  /** Absolute path (already realpathed by `run.ts`). */
  readonly out: string;
  readonly force: boolean;
  readonly workspace: string;
  /** User config root for global permission modes (`run.ts` resolves it at the process boundary). */
  readonly home: string;
  readonly json: boolean;
  readonly warn: (message: string) => void;
  /** The `--out` printed in the receipt (user's view): falls back to the real path when not given. */
  readonly displayOut?: string | undefined;
  /** Session-layer injection point: `run.ts` wires real Chrome, in-process tests wire a fake transport. */
  readonly render: RenderPng;
}

interface Size {
  readonly flag: string;
  readonly min: number;
  readonly max: number;
}

const WIDTH: Size = { flag: "--width", min: 256, max: 4096 };

const SCALE: Size = { flag: "--scale", min: 1, max: 3 };

const MAX_HEIGHT: Size = { flag: "--max-height", min: 1000, max: 50_000 };

const sizeOf = (value: string, size: Size): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < size.min || parsed > size.max) {
    throw new HrError(
      "invalid_input",
      `${size.flag} 必须是 ${String(size.min)}..${String(size.max)} 的整数：${value}`,
    );
  }
  return parsed;
};

const assertPngOutOf = async (input: PngCommandInput): Promise<void> => {
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  assertOutInsideOf(input.out, input.workspace);
};

/** Reported width/height come from IHDR, not the render layer's self-report: an old bug was the render layer reporting a stale viewport height. */
const reportOf = (image: LongImage, out: string): PngReport => {
  const size = pngSizeOf(image.bytes);
  return {
    base64: Buffer.from(image.bytes).toString("base64"),
    bytes: image.bytes.length,
    width: size.width,
    height: size.height,
    clipped: image.clipped,
    out,
  };
};

export const pngCommand = async (input: PngCommandInput): Promise<string> => {
  // A known flag on the wrong subcommand is user input error (like an out-of-range `--page-size`): stop it before anything is written.
  if (input.outlineFlag !== undefined) {
    throw new HrError("invalid_input", `hr png 不支持 ${input.outlineFlag}（PNG 没有大纲）`);
  }
  const width = sizeOf(input.width, WIDTH);
  const scale = sizeOf(input.scale, SCALE);
  const maxHeight = sizeOf(input.maxHeight, MAX_HEIGHT);
  // Before Chrome starts, reject the worst-case total pixels under an explicit `--max-height` (e.g. `--scale 3 --max-height 50000`):
  // edge and real-area checks wait for the measured content height; see `cdp.ts`.
  assertPixelRequestOf({ width, scale, maxHeight, maxHeightExplicit: input.maxHeightExplicit });
  await assertPngOutOf(input);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
  // Same split `hr pdf` makes: foreign docs render raw behind the permission
  // gate; everything else keeps the managed print sheet.
  const foreign = await foreignPlanOf({
    path: input.path,
    workspace: input.workspace,
    home: input.home,
  });
  const image =
    foreign !== undefined
      ? await input.render({
          source: { kind: "foreign", page: foreign },
          width,
          scale,
          maxHeight,
          timeoutMs: input.timeoutMs,
        })
      : await input.render({
          source: {
            kind: "sheet",
            html: (
              await printProductOf({
                path: input.path,
                visual: input.visual,
                // Tall images lay out at A4 content width, ignoring `--page-size`: PNG has no paper, only a viewport width.
                paper: "a4",
                workspace: input.workspace,
                warn: input.warn,
              })
            ).html,
          },
          width,
          scale,
          maxHeight,
          timeoutMs: input.timeoutMs,
        });
  assertPngOf(image.bytes);
  await writeOutOf({
    path: input.out,
    workspace: input.workspace,
    data: image.bytes,
    what: "写入 PNG",
  });
  const report = reportOf(image, input.out);
  return input.json ? jsonOk(dataPng(report)) : humanPng(report, input.displayOut ?? report.out);
};
