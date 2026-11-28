// This layer: `hr thumb` — one 600×400 first-screen PNG per document through the
// shared cache/queue/Chrome pipeline (`render` is the wired `ThumbRender`; see
// thumbs/service.ts). Pure boundary: the `--out` / stdout choice, the TTY rule,
// and the receipt. stdout keeps the `png`/`pdf` trade-off: binary goes to stdout
// only when it is a pipe — never onto a terminal.

import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { HrError, nodePatchDeps, type ThumbRender } from "@hreader/core";

import { assertPngOf, pngSizeOf } from "../chrome/png";
import { readFileBytes } from "../input";
import { dataThumb, humanThumb, jsonOk, type ThumbReport } from "../output";
import {
  assertOutInsideOf,
  assertTargetFreeOf,
  assertWritableDirOf,
  writeOutOf,
} from "./export-print";

export interface ThumbInput {
  /** Absolute path (already realpathed by `run.ts`). */
  readonly path: string;
  /**
   * `--out` target (absolute, already realpathed); `undefined` = write the PNG
   * to stdout, which is only legal when stdout is a pipe (`isStdoutTty` false)
   * or the answer is a `--json` line — a bare terminal gets `invalid_input`
   * with the --out hint instead of binary noise.
   */
  readonly out: string | undefined;
  /** Whether to overwrite an existing `--out` (default refuses with `file_exists`). */
  readonly force: boolean;
  readonly workspace: string;
  readonly json: boolean;
  /** The `--out` printed in the receipt (user's view): falls back to the real path when not given. */
  readonly displayOut?: string | undefined;
  /** `process.stdout.isTTY` captured by the process shell — the command layer never reads the tty itself. */
  readonly isStdoutTty: boolean;
  /** Binary stdout channel (`process.stdout.write` at the boundary): the PNG bytes go through it untouched. */
  readonly stdoutBytes: (bytes: Uint8Array) => void;
  /**
   * Session-level injection point: `run.ts` wires `createThumbRender` (queue +
   * cache + Chrome), tests wire a fake returning PNG bytes.
   */
  readonly render: ThumbRender;
}

/** Reported width/height come from IHDR, not the render layer's self-report — same rule as `hr png`. */
const reportOf = (bytes: Uint8Array, out: string | null): ThumbReport => {
  const size = pngSizeOf(bytes);
  return {
    base64: Buffer.from(bytes).toString("base64"),
    bytes: bytes.length,
    width: size.width,
    height: size.height,
    out,
  };
};

const assertOutOf = async (out: string, workspace: string): Promise<void> => {
  await assertWritableDirOf(dirname(out), nodePatchDeps);
  assertOutInsideOf(out, workspace);
};

export const thumbCommand = async (input: ThumbInput): Promise<string> => {
  // Refuse before anything renders: spending a Chrome run on output a terminal cannot take is the wrong failure order.
  if (input.out === undefined && input.isStdoutTty && !input.json) {
    throw new HrError(
      "invalid_input",
      "stdout 是终端，不能直接写 PNG 二进制：请给 --out <path>（或加 --json 输出 JSON 行）",
    );
  }
  if (input.out !== undefined) {
    await assertOutOf(input.out, input.workspace);
    await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
  }
  const hash = createHash("sha256")
    .update(await readFileBytes(input.path))
    .digest("hex");
  const png = await input.render({ path: input.path, hash });
  assertPngOf(png);
  if (input.out !== undefined) {
    await writeOutOf({
      path: input.out,
      workspace: input.workspace,
      data: png,
      what: "写入缩略图",
    });
    const report = reportOf(png, input.out);
    return input.json
      ? jsonOk(dataThumb(report))
      : humanThumb(report, input.displayOut ?? input.out);
  }
  if (input.json) return jsonOk(dataThumb(reportOf(png, null)));
  input.stdoutBytes(png);
  return "";
};
