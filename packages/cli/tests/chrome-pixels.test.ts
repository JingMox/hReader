// This layer covers the pixel gate boundary values (65535/65536, one cell either side of 2.5e8); no Chrome.
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

describe("assertPixelFrameOf · single edge", () => {
  it("should pass 65535 and reject 65536", () => {
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

describe("assertPixelFrameOf · old 16384 limit disproved", () => {
  it("should no longer reject legal heights under the old limit (the default-profile 9-page long image 17634 died on this)", () => {
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

describe("assertPixelFrameOf · height edge", () => {
  it("should cap the height edge at 65535", () => {
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

describe("assertPixelFrameOf · total pixels", () => {
  it("should pass exactly 2.5e8 and reject one cell more", () => {
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

describe("assertPixelRequestOf · pre-Chrome checks", () => {
  it("should pass the default profile (1200×20000@2): the single-edge gate ignores requested height", () => {
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

  it("should not count worst-case area when --max-height is not explicit: --width 4096 --scale 3 passes", () => {
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

describe("assertPixelRequestOf · explicit --max-height area gate", () => {
  it("should pass a legal area at explicit --max-height 20000@2 (2400×20000×2 = 96M < 2.5e8)", () => {
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

  it("should reject an over-limit total at explicit --scale 3 --max-height 50000", () => {
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

describe("assertPixelRequestOf · width-edge gate", () => {
  it("should always check the width edge: 65535 passes, 65536 rejects", () => {
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
