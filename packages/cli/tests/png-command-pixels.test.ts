// 这层管：`pngCommand` 的像素闸与"宽高取自 IHDR"（渲染由假 render 注入，不起 Chrome）；其余行为在 `png-command.test.ts`。
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import type { LongImage } from "../src/chrome/types";
import { pngCommand, type PngCommandInput } from "../src/commands/png";
import { pngOf } from "./chrome-helpers";
import { fieldOf, withTempDir } from "./harness";

const DOC = "<html><body><article><h1>标题</h1><p>正文</p></article></body></html>";

const withDocOf = (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    writeFileSync(join(dir, "doc.html"), DOC);
    await run(dir);
  });

const imageOf = (): LongImage => ({
  bytes: pngOf(2400, 1800),
  width: 2400,
  height: 1800,
  clipped: false,
});

const inputOf = (dir: string, overrides: Partial<PngCommandInput> = {}): PngCommandInput => ({
  path: join(dir, "doc.html"),
  width: "1200",
  scale: "2",
  maxHeight: "20000",
  maxHeightExplicit: false,
  outlineFlag: undefined,
  timeoutMs: 60_000,
  out: join(dir, "out.png"),
  force: false,
  workspace: dir,
  json: false,
  warn: () => undefined,
  render: () => Promise.resolve(imageOf()),
  ...overrides,
});

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

const dataFieldOf = (text: string): ((key: string) => unknown) => {
  const data = fieldOf(JSON.parse(text), "data");
  return (key) => fieldOf(data, key);
};

describe("pngCommand · 像素闸（exit 1，起 Chrome 前）", () => {
  it.each([
    ["1200", "3", "50000"],
    ["1200", "3", "24000"],
    ["4096", "3", "7000"],
  ])(
    "--width %s --scale %s --max-height %s → invalid_input，且不渲染",
    async (width, scale, maxHeight) => {
      await withDocOf(async (dir) => {
        let rendered = false;
        const render = (): Promise<LongImage> => {
          rendered = true;
          return Promise.resolve(imageOf());
        };
        const error = await failureOf(
          pngCommand(inputOf(dir, { width, scale, maxHeight, maxHeightExplicit: true, render })),
        );
        expect(error.code).toBe("invalid_input");
        expect(error.message).toContain("请降 `--scale` 或 `--max-height`");
        expect(rendered).toBe(false);
      });
    },
  );
});

describe("pngCommand · 未显式给 --max-height 时不拿默认值算最坏面积", () => {
  it("--width 4096 --scale 3（宽边合法、短文档）能出图，不误拒", async () => {
    await withDocOf(async (dir) => {
      let rendered = false;
      const render = (input: { width: number; scale: number; maxHeight: number }) => {
        rendered = true;
        expect([input.width, input.scale, input.maxHeight]).toEqual([4096, 3, 20_000]);
        return Promise.resolve(imageOf());
      };
      const field = dataFieldOf(
        await pngCommand(inputOf(dir, { width: "4096", scale: "3", json: true, render })),
      );
      expect(rendered).toBe(true);
      expect(field("width")).toBe(2400);
    });
  });
});

describe("pngCommand · 宽高取自 IHDR", () => {
  it("--width 256 时 json 高等于 IHDR 高，不是渲染层自报的旧视口高", async () => {
    await withDocOf(async (dir) => {
      // 旧 bug：渲染层报 4661（陈旧视口），盘上 IHDR 其实是 7229。
      const render = (): Promise<LongImage> =>
        Promise.resolve({ bytes: pngOf(256, 7229), width: 256, height: 4661, clipped: false });
      const field = dataFieldOf(
        await pngCommand(inputOf(dir, { width: "256", scale: "1", json: true, render })),
      );
      expect([field("width"), field("height")]).toEqual([256, 7229]);
    });
  });
});
