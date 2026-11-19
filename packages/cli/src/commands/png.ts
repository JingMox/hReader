// 这层管：`hr png`（打印稿 → 会话层出长图 → PNG 头校验 → 原子写）；不判 argv、不定退出码。
// 落盘三连（io → 越界 → 已存在）与 `hr pdf` 同序同语义（D5），渲染失败时盘上零残留。

import { dirname } from "node:path";

import { DEFAULT_STYLE_ID, HrError, nodePatchDeps } from "@hreader/core";

import type { LongImage } from "../chrome/cdp";
import { assertPixelRequestOf } from "../chrome/pixels";
import { assertPngOf, pngSizeOf } from "../chrome/png";
import { dataPng, humanPng, jsonOk, type PngReport } from "../output";
import {
  assertOutInsideOf,
  assertTargetFreeOf,
  assertWritableDirOf,
  printProductOf,
  writeOutOf,
} from "./exportPrint";

export type RenderPng = (input: {
  readonly html: string;
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
  readonly timeoutMs: number;
}) => Promise<LongImage>;

export interface PngCommandInput {
  /** 绝对路径：打印稿要先读源文档。 */
  readonly path: string;
  /** 原样字符串：越界是语义错误（`invalid_input` exit 1），不是用法错误。 */
  readonly width: string;
  readonly scale: string;
  readonly maxHeight: string;
  /** 用户是否显式传了 `--max-height`：没传就不拿默认值做面积预检（短文档会被误拒）。 */
  readonly maxHeightExplicit: boolean;
  /** 命中的大纲旗标（`--outline`/`--no-outline`）：PNG 没有大纲，给了就是 `invalid_input`。 */
  readonly outlineFlag: string | undefined;
  readonly timeoutMs: number;
  /** 绝对路径（`run.ts` 已真实化）。 */
  readonly out: string;
  readonly force: boolean;
  readonly workspace: string;
  readonly json: boolean;
  readonly warn: (message: string) => void;
  /** 回执里印的 `--out`（用户视角）：不给就印真实路径。 */
  readonly displayOut?: string | undefined;
  /** 会话层注入点：`run.ts` 接真 Chrome，进程内测试接假传输。 */
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

/** 报告宽高取自 IHDR，不取渲染层自报值：旧 bug 就是渲染层报了陈旧视口高。 */
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
  // 已知旗标放错子命令属于用户输入错（同 `--page-size` 越界）：一落盘都不落，先拦。
  if (input.outlineFlag !== undefined) {
    throw new HrError("invalid_input", `hr png 不支持 ${input.outlineFlag}（PNG 没有大纲）`);
  }
  const width = sizeOf(input.width, WIDTH);
  const scale = sizeOf(input.scale, SCALE);
  const maxHeight = sizeOf(input.maxHeight, MAX_HEIGHT);
  // 起 Chrome 前先拦显式 `--max-height` 下的最坏总像素（如 `--scale 3 --max-height 50000`）：
  // 单边与真实面积要等量到内容高，见 `cdp.ts`。
  assertPixelRequestOf({ width, scale, maxHeight, maxHeightExplicit: input.maxHeightExplicit });
  await assertPngOutOf(input);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
  const product = await printProductOf({
    path: input.path,
    visual: DEFAULT_STYLE_ID,
    // 长图按 A4 版心排，不跟 `--page-size`：PNG 没有纸，只有视口宽。
    paper: "a4",
    workspace: input.workspace,
    warn: input.warn,
  });
  const image = await input.render({
    html: product.html,
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
