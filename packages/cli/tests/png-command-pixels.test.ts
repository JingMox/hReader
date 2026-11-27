// This layer covers `pngCommand`'s pixel gate and "w/h taken from IHDR" (rendering is a fake injected render, no Chrome); the rest lives in `png-command.test.ts`.
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
  visual: "atelier-editorial",
  out: join(dir, "out.png"),
  force: false,
  workspace: dir,
  home: dir,
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
  throw new Error("expected an HrError to be thrown");
};

const dataFieldOf = (text: string): ((key: string) => unknown) => {
  const data = fieldOf(JSON.parse(text), "data");
  return (key) => fieldOf(data, key);
};

describe("pngCommand · pixel gate (exit 1, before Chrome)", () => {
  it.each([
    ["1200", "3", "50000"],
    ["1200", "3", "24000"],
    ["4096", "3", "7000"],
  ])(
    "should report invalid_input for --width %s --scale %s --max-height %s without rendering",
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

describe("pngCommand · implicit --max-height does not count worst-case area from the default", () => {
  it("should produce an image for --width 4096 --scale 3 (legal width edge, short document) without a wrong refusal", async () => {
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

describe("pngCommand · w/h taken from IHDR", () => {
  it("should report the json height from the IHDR for --width 256, not the render layer's stale viewport height", async () => {
    await withDocOf(async (dir) => {
      // Old bug: the render layer reported 4661 (stale viewport) while the on-disk IHDR was really 7229.
      const render = (): Promise<LongImage> =>
        Promise.resolve({ bytes: pngOf(256, 7229), width: 256, height: 4661, clipped: false });
      const field = dataFieldOf(
        await pngCommand(inputOf(dir, { width: "256", scale: "1", json: true, render })),
      );
      expect([field("width"), field("height")]).toEqual([256, 7229]);
    });
  });
});
