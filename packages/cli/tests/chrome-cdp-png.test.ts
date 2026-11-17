// 这层管：`renderPngOverCdpOf` 的长图报文序列与裁剪语义（假传输，不碰真 Chrome）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderPngOverCdpOf, type PngViewport } from "../src/chrome/cdp";
import { fieldOf } from "../src/chrome/protocol";
import { pngOf, responderOf, type ResponderOptions } from "./chrome-helpers";

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "hr-cdp-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const pngOfDir = (options: ResponderOptions, dir: string, viewport: PngViewport) => {
  const responder = responderOf(options);
  const pending = renderPngOverCdpOf({
    transport: responder.transport,
    html: "<p>hi</p>",
    dir,
    ...viewport,
  });
  return { responder, pending };
};

const viewportOf = (overrides: Partial<PngViewport> = {}): PngViewport => ({
  width: 1200,
  scale: 2,
  maxHeight: 20_000,
  ...overrides,
});

const ihdrOf = (bytes: Uint8Array): { width: number; height: number; depth: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), depth: view.getUint8(24) };
};

const allParamsOf = (sent: readonly string[], method: string): readonly unknown[] =>
  sent.filter((text) => text.includes(method)).map((text) => fieldOf(JSON.parse(text), "params"));

const overridesOf = (sent: readonly string[]): readonly unknown[][] =>
  allParamsOf(sent, "Emulation.setDeviceMetricsOverride").map((params) =>
    ["width", "height", "deviceScaleFactor", "mobile"].map((key) => fieldOf(params, key)),
  );

const shotsOf = (sent: readonly string[]): readonly unknown[] =>
  allParamsOf(sent, "Page.captureScreenshot");

describe("renderPngOverCdpOf · 量高复量边界", () => {
  it("内容恰好 1000px 时仍要用 100 高复量（`>` 写成 `>=` 会少一次视口覆写）", async () => {
    await withDir(async (dir) => {
      const { responder, pending } = pngOfDir({ contentHeight: 1000 }, dir, viewportOf());
      const image = await pending;
      expect(ihdrOf(image.bytes).height).toBe(2000);
      expect(overridesOf(responder.sent)).toEqual([
        [1200, 1000, 2, false],
        [1200, 100, 2, false],
        [1200, 1000, 2, false],
      ]);
    });
  });
});

describe("renderPngOverCdpOf · 量高顺序", () => {
  it("先按 1000 高落定宽度，再按真实高重设视口，按 IHDR 报设备像素", async () => {
    await withDir(async (dir) => {
      const { responder, pending } = pngOfDir({ contentHeight: 900.4 }, dir, viewportOf());
      await expect(pending).resolves.toMatchObject({ width: 2400, height: 1802, clipped: false });
      expect(overridesOf(responder.sent)).toEqual([
        [1200, 1000, 2, false],
        [1200, 100, 2, false],
        [1200, 901, 2, false],
      ]);
    });
  });

  it("短文档（内容 300px）改用 100 高复量，IHDR 高不得是 1000", async () => {
    await withDir(async (dir) => {
      const { responder, pending } = pngOfDir({ contentHeight: 300 }, dir, viewportOf());
      const image = await pending;
      expect(ihdrOf(image.bytes).height).toBe(600);
      expect(image.height).not.toBe(2000);
      expect(overridesOf(responder.sent)).toEqual([
        [1200, 1000, 2, false],
        [1200, 100, 2, false],
        [1200, 300, 2, false],
      ]);
    });
  });

  it("宽很窄（--width 256）时报告高仍等于 IHDR 高", async () => {
    await withDir(async (dir) => {
      const image = await pngOfDir(
        { contentHeight: 7229 },
        dir,
        viewportOf({ width: 256, scale: 1, maxHeight: 20_000 }),
      ).pending;
      expect(ihdrOf(image.bytes).height).toBe(7229);
      expect(image.height).toBe(ihdrOf(image.bytes).height);
    });
  });
});

describe("renderPngOverCdpOf · clip 裁剪", () => {
  it("截图带 clip：max-height 真裁到设备尺寸，而不是整页", async () => {
    await withDir(async (dir) => {
      const { responder, pending } = pngOfDir(
        { contentHeight: 4661 },
        dir,
        viewportOf({ maxHeight: 2000 }),
      );
      await expect(pending).resolves.toMatchObject({ width: 2400, height: 4000, clipped: true });
      const [shot = {}] = shotsOf(responder.sent);
      expect(fieldOf(shot, "clip")).toEqual({ x: 0, y: 0, width: 1200, height: 2000, scale: 1 });
    });
  });

  it("裁剪档与不裁剪档的字节不同（旧实现两档一模一样）", async () => {
    await withDir(async (dir) => {
      const clipped = await pngOfDir({ contentHeight: 4661 }, dir, viewportOf({ maxHeight: 2000 }))
        .pending;
      const full = await pngOfDir({ contentHeight: 4661 }, dir, viewportOf({ maxHeight: 20_000 }))
        .pending;
      expect([ihdrOf(clipped.bytes).height, ihdrOf(full.bytes).height]).toEqual([4000, 9322]);
      expect(Buffer.from(clipped.bytes).equals(Buffer.from(full.bytes))).toBe(false);
    });
  });
});

describe("renderPngOverCdpOf · 裁剪边界", () => {
  it("超过 maxHeight 时先裁不缩，并置 clipped", async () => {
    await withDir(async (dir) => {
      const { responder, pending } = pngOfDir(
        { contentHeight: 30_000 },
        dir,
        viewportOf({ maxHeight: 16_000, scale: 1 }),
      );
      const image = await pending;
      expect([image.height, image.clipped]).toEqual([16_000, true]);
      expect(overridesOf(responder.sent).map((params) => params[1])).toEqual([1000, 16_000]);
    });
  });

  it("恰好等于 maxHeight 时不算裁剪", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir(
        { contentHeight: 5000 },
        dir,
        viewportOf({ maxHeight: 5000, scale: 1 }),
      );
      await expect(pending).resolves.toMatchObject({ height: 5000, clipped: false });
    });
  });
});

describe("renderPngOverCdpOf · 产物", () => {
  it("PNG 头里就是设备像素宽高与位深 8", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir(
        { contentHeight: 700 },
        dir,
        viewportOf({ width: 640, scale: 3 }),
      );
      const image = await pending;
      expect(ihdrOf(image.bytes)).toEqual({ width: 1920, height: 2100, depth: 8 });
      expect([...image.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });
  });
});

describe("renderPngOverCdpOf · 分辨率交叉断言", () => {
  it("IHDR 宽只有一半时抛 chrome_failed，并把实际值与期望值都写进文案", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir({ contentHeight: 700, png: "half-width" }, dir, viewportOf());
      await expect(pending).rejects.toMatchObject({ code: "chrome_failed" });
      await expect(pending).rejects.toThrow(/实际宽 1200px，期望 1200×2=2400px/u);
    });
  });

  it("IHDR 高只有一半时抛 chrome_failed，并把实际值与期望值都写进文案", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir({ contentHeight: 700, png: "half-height" }, dir, viewportOf());
      await expect(pending).rejects.toMatchObject({ code: "chrome_failed" });
      await expect(pending).rejects.toThrow(/实际高 700px，期望 700×2=1400px/u);
    });
  });

  it("宽与 --width×--scale 相等时照旧出图", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir({ contentHeight: 700 }, dir, viewportOf());
      await expect(pending).resolves.toMatchObject({ width: 2400 });
    });
  });
});

describe("renderPngOverCdpOf · 像素闸", () => {
  it("真实面积超限（4096×64000）在截图前被拒成 invalid_input", async () => {
    await withDir(async (dir) => {
      const { responder, pending } = pngOfDir(
        { contentHeight: 64_000 },
        dir,
        viewportOf({ width: 4096, maxHeight: 70_000, scale: 1 }),
      );
      await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
      expect(shotsOf(responder.sent)).toEqual([]);
    });
  });
});

describe("renderPngOverCdpOf · 失败", () => {
  it("没有 cssContentSize 时报 render_empty", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir({ contentHeight: "none" }, dir, viewportOf());
      await expect(pending).rejects.toMatchObject({ code: "render_empty" });
    });
  });

  it("截图报错映射成 chrome_failed", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir({ png: "error" }, dir, viewportOf());
      await expect(pending).rejects.toMatchObject({ code: "chrome_failed" });
      await expect(pending).rejects.toThrow(
        /Page\.captureScreenshot 失败：captureScreenshot boom/u,
      );
    });
  });

  it("截图没有 data 时报 chrome_failed", async () => {
    await withDir(async (dir) => {
      const { pending } = pngOfDir({ png: "no-data" }, dir, viewportOf());
      await expect(pending).rejects.toThrow(/Page\.captureScreenshot 没有返回 data/u);
    });
  });
});

it("pngOf 夹具给的是带 IHDR 的最小 PNG", () => {
  expect(ihdrOf(pngOf(10, 20))).toEqual({ width: 10, height: 20, depth: 8 });
});
