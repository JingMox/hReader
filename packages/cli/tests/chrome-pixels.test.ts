// 这层管：像素闸的边界值（65535/65536、2.5e8 上下一格），不碰 Chrome。
import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import {
  assertPixelFrameOf,
  assertPixelRequestOf,
  PIXEL_AREA_LIMIT,
  PIXEL_EDGE_LIMIT,
} from "../src/chrome/pixels";

const codeOf = (run: () => void): string | undefined => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error.code;
    throw error;
  }
  return undefined;
};

const messageOf = (run: () => void): string => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error.message;
    throw error;
  }
  return "";
};

describe("assertPixelFrameOf · 单边", () => {
  it("65535 放行，65536 拒绝", () => {
    expect(PIXEL_EDGE_LIMIT).toBe(65_535);
    expect(
      codeOf(() => {
        assertPixelFrameOf({ deviceWidth: 65_535, deviceHeight: 1 });
      }),
    ).toBeUndefined();
    expect(
      codeOf(() => {
        assertPixelFrameOf({ deviceWidth: 65_536, deviceHeight: 1 });
      }),
    ).toBe("invalid_input");
  });
});

describe("assertPixelFrameOf · 旧 16384 上限已证伪", () => {
  it("16385 这种旧上限下的合法高度不再被单边闸拒（默认档 9 页长图 17634 就死在这）", () => {
    expect(
      codeOf(() => {
        assertPixelFrameOf({ deviceWidth: 2400, deviceHeight: 16_385 });
      }),
    ).toBeUndefined();
    expect(
      codeOf(() => {
        assertPixelFrameOf({ deviceWidth: 2400, deviceHeight: 17_634 });
      }),
    ).toBeUndefined();
  });
});

describe("assertPixelFrameOf · 高边", () => {
  it("高边卡在 65535", () => {
    expect(
      codeOf(() => {
        assertPixelFrameOf({ deviceWidth: 1, deviceHeight: 65_535 });
      }),
    ).toBeUndefined();
    const message = messageOf(() => {
      assertPixelFrameOf({ deviceWidth: 1, deviceHeight: 65_536 });
    });
    expect(message).toContain("超过单边 65535");
    expect(message).toContain("请降 `--scale` 或 `--max-height`");
  });
});

describe("assertPixelFrameOf · 总像素", () => {
  it("恰好 2.5e8 放行，多一格拒绝", () => {
    expect(PIXEL_AREA_LIMIT).toBe(250_000_000);
    expect(
      codeOf(() => {
        assertPixelFrameOf({ deviceWidth: 16_000, deviceHeight: 15_625 });
      }),
    ).toBeUndefined();
    const message = messageOf(() => {
      assertPixelFrameOf({ deviceWidth: 16_000, deviceHeight: 15_626 });
    });
    expect(message).toContain("超过总像素 250000000");
    expect(message).toContain("请降 `--scale` 或 `--max-height`");
  });
});

describe("assertPixelRequestOf · 起 Chrome 前的预检", () => {
  it("默认档（1200×20000@2）放行：单边闸不看请求高", () => {
    expect(
      codeOf(() => {
        assertPixelRequestOf({
          width: 1200,
          scale: 2,
          maxHeight: 20_000,
          maxHeightExplicit: false,
        });
      }),
    ).toBeUndefined();
  });

  it("未显式给 --max-height 时不算最坏面积：--width 4096 --scale 3 放行", () => {
    expect(
      codeOf(() => {
        assertPixelRequestOf({
          width: 4096,
          scale: 3,
          maxHeight: 20_000,
          maxHeightExplicit: false,
        });
      }),
    ).toBeUndefined();
  });
});

describe("assertPixelRequestOf · 显式 --max-height 的面积闸", () => {
  it("显式 --max-height 20000@2 的面积合法必须放行（2400×20000×2 = 96M < 2.5e8）", () => {
    expect(
      codeOf(() => {
        assertPixelRequestOf({
          width: 1200,
          scale: 2,
          maxHeight: 20_000,
          maxHeightExplicit: true,
        });
      }),
    ).toBeUndefined();
  });

  it("显式 --scale 3 --max-height 50000 的总像素超限被拒", () => {
    expect(
      codeOf(() => {
        assertPixelRequestOf({
          width: 1200,
          scale: 3,
          maxHeight: 50_000,
          maxHeightExplicit: true,
        });
      }),
    ).toBe("invalid_input");
  });
});

describe("assertPixelRequestOf · 宽边闸", () => {
  it("宽边闸永远查：65535 放行、65536 拒绝", () => {
    expect(
      codeOf(() => {
        assertPixelRequestOf({
          width: 65_535,
          scale: 1,
          maxHeight: 1000,
          maxHeightExplicit: false,
        });
      }),
    ).toBeUndefined();
    expect(
      codeOf(() => {
        assertPixelRequestOf({
          width: 65_536,
          scale: 1,
          maxHeight: 1000,
          maxHeightExplicit: false,
        });
      }),
    ).toBe("invalid_input");
  });
});
