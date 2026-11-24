// 这层管：`renderPdfOnBrowserOf`/`renderPngOnBrowserOf` 的页面级行为（导航、打印参数、
// 量高与裁剪、像素断言）；假 `BrowserLike`/`PageLike`，不起 Chrome。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printParamsOf, renderPdfOnBrowserOf, renderPngOnBrowserOf } from "../src/chrome/render";
import { PAGE_SIZES, isPdfPageSize, type PdfPageSize } from "../src/chrome/types";
import { fakeBrowserOf, fakePageOf, type FakePageOptions } from "./chrome-helpers";

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "hr-render-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const renderPdfOf = (options: FakePageOptions, dir: string, outline = true) =>
  renderPdfOnBrowserOf({
    browser: fakeBrowserOf(fakePageOf(options)),
    html: "<p>hi</p>",
    dir,
    pageSize: "a4",
    outline,
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

describe("printParamsOf", () => {
  it("纸张表按 pt 对齐 Chrome 的四舍五入值", () => {
    expect(PAGE_SIZES.a4.widthPt).toBeCloseTo(595.28, 2);
    expect(PAGE_SIZES.a4.heightPt).toBeCloseTo(841.89, 2);
    expect(PAGE_SIZES.letter.widthPt).toBeCloseTo(612, 2);
    expect(PAGE_SIZES.letter.heightPt).toBeCloseTo(792, 2);
    expect(PAGE_SIZES.a5.widthPt).toBeCloseTo(419.53, 2);
    expect(PAGE_SIZES.a5.heightPt).toBeCloseTo(595.28, 2);
  });

  it.each<PdfPageSize>(["a4", "letter", "a5"])("%s 的纸张（pt 字符串）与 CSS 余白一致", (size) => {
    const params = printParamsOf(size, true);
    expect(params.printBackground).toBe(true);
    // 钉死 false：print-css 的 `@page{size:A4}` 会让 --page-size 失效。
    expect(params.preferCSSPageSize).toBe(false);
    // 单位必须带在字符串里：裸数字会被 puppeteer 当 px。
    expect(params.width).toBe(`${String(PAGE_SIZES[size].widthPt)}pt`);
    expect(params.height).toBe(`${String(PAGE_SIZES[size].heightPt)}pt`);
    expect(params.margin).toEqual({ top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" });
    expect(params.outline).toBe(true);
  });

  it("outline 键由调用方显式给：false 时也是 false 而不是缺键", () => {
    expect(printParamsOf("a5", false).outline).toBe(false);
    expect(Object.hasOwn(printParamsOf("a5", false), "outline")).toBe(true);
    // 运行时看不出"必填"，但签名长度能：`printParamsOf.length === 2`。
    expect(printParamsOf.length).toBe(2);
  });

  it("isPdfPageSize 只认三种纸张", () => {
    expect(["a4", "letter", "a5"].every((value) => isPdfPageSize(value))).toBe(true);
    expect(isPdfPageSize("A4")).toBe(false);
    expect(isPdfPageSize("b5")).toBe(false);
  });
});

describe("renderPdfOnBrowserOf · 开场与产物", () => {
  it("HTML 写进临时目录后以 file:// 导航", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ pages: 1 });
      const bytes = await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        html: "<p>hi</p>",
        dir,
        pageSize: "a4",
        outline: true,
      });
      const htmlPath = join(dir, "input.html");
      expect(readFileSync(htmlPath, "utf8")).toBe("<p>hi</p>");
      expect(page.goneTo).toEqual([pathToFileURL(htmlPath).href]);
      expect(bytes.length).toBeGreaterThan(0);
    });
  });

  it("outline: false 传给 page.pdf 的是 false", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ pages: 1 });
      await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        html: "<p>hi</p>",
        dir,
        pageSize: "a4",
        outline: false,
      });
      expect(page.pdfCalls[0]?.outline).toBe(false);
    });
  });
});

describe("renderPdfOnBrowserOf · 失败映射", () => {
  it("navigate 失败映射成 chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPdfOf({ goto: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
    });
  });

  it("printToPDF 失败映射成 chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPdfOf({ pdf: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
    });
  });
});

const renderPngOf = (options: FakePageOptions, dir: string, maxHeight = 20_000) =>
  renderPngOnBrowserOf({
    browser: fakeBrowserOf(fakePageOf(options)),
    html: "<p>x</p>",
    dir,
    width: 800,
    scale: 2,
    maxHeight,
  });

describe("renderPngOnBrowserOf · 量高与裁剪", () => {
  it("整页高交给 setViewport，并按 scale 折算设备像素", async () => {
    await withDir(async (dir) => {
      const image = await renderPngOf({ contentHeight: 900.4 }, dir);
      expect([image.width, image.height, image.clipped]).toEqual([1600, 1802, false]);
    });
  });

  it("短文档换小视口复量（首量 1000 封顶时再用 100 量一次）", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ contentHeight: 640 });
      await renderPngOnBrowserOf({
        browser: fakeBrowserOf(page),
        html: "<p>x</p>",
        dir,
        width: 800,
        scale: 1,
        maxHeight: 20_000,
      });
      // 两次量高（1000 与 100）+ 一次截图视口（640）。
      expect(page.viewports.map((v) => v.height)).toEqual([1000, 100, 640]);
      expect(page.shotCalls[0]?.clip).toEqual({ x: 0, y: 0, width: 800, height: 640, scale: 1 });
    });
  });
});

describe("renderPngOnBrowserOf · 长图与裁剪", () => {
  it("长文档量一次就够（高于 1000 不进入短文档复量）", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ contentHeight: 5000 });
      await renderPngOnBrowserOf({
        browser: fakeBrowserOf(page),
        html: "<p>x</p>",
        dir,
        width: 800,
        scale: 1,
        maxHeight: 20_000,
      });
      expect(page.viewports.map((v) => v.height)).toEqual([1000, 5000]);
    });
  });

  it("超出 --max-height 裁短并标 clipped", async () => {
    await withDir(async (dir) => {
      const image = await renderPngOf({ contentHeight: 5000 }, dir, 2000);
      expect([image.width, image.height, image.clipped]).toEqual([1600, 4000, true]);
      expect(existsSync(join(dir, "input.html"))).toBe(true);
    });
  });
});

describe("renderPngOnBrowserOf · 失败归口", () => {
  it("cssContentSize 缺失时报 render_empty", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ contentHeight: "none" }, dir));
      expect(error.code).toBe("render_empty");
      expect(error.message).toContain("没有可用的页面高度");
    });
  });

  it("截图失败映射成 chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ png: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
    });
  });

  it("产物不是 PNG 时报 render_empty", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ png: "not-png" }, dir));
      expect(error.code).toBe("render_empty");
    });
  });

  it("倍率没乘上的半分辨率产物被当场拦下（宽与高各一道闸）", async () => {
    await withDir(async (dir) => {
      const wide = await failureOf(renderPngOf({ png: "half-width" }, dir));
      expect(wide.code).toBe("chrome_failed");
      expect(wide.message).toContain("实际宽");
      const tall = await failureOf(renderPngOf({ png: "half-height" }, dir));
      expect(tall.code).toBe("chrome_failed");
      expect(tall.message).toContain("实际高");
    });
  });
});

describe("renderPngOnBrowserOf · 像素硬闸", () => {
  it("单边像素越界在截图前就是 invalid_input", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ contentHeight: 40_000 }, dir, 40_000));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("超过单边");
    });
  });
});
