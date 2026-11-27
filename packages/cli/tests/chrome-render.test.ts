// This layer covers page-level behavior of `renderPdfOnBrowserOf`/`renderPngOnBrowserOf` (navigation, print
// parameters, height measurement and cropping, pixel assertions); fake `BrowserLike`/`PageLike`, no Chrome.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import {
  cssPageParamsOf,
  printParamsOf,
  renderPdfOnBrowserOf,
  renderPngOnBrowserOf,
} from "../src/chrome/render";
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
    source: { kind: "sheet", html: "<p>hi</p>" },
    dir,
    pageSize: "a4",
    outline,
    preferCSSPageSize: false,
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

describe("printParamsOf", () => {
  it("should align the paper table to Chrome's rounded pt values", () => {
    expect(PAGE_SIZES.a4.widthPt).toBeCloseTo(595.28, 2);
    expect(PAGE_SIZES.a4.heightPt).toBeCloseTo(841.89, 2);
    expect(PAGE_SIZES.letter.widthPt).toBeCloseTo(612, 2);
    expect(PAGE_SIZES.letter.heightPt).toBeCloseTo(792, 2);
    expect(PAGE_SIZES.a5.widthPt).toBeCloseTo(419.53, 2);
    expect(PAGE_SIZES.a5.heightPt).toBeCloseTo(595.28, 2);
  });

  it.each<PdfPageSize>(["a4", "letter", "a5"])(
    "should keep %s paper (pt string) consistent with the CSS margins",
    (size) => {
      const params = printParamsOf(size, true);
      expect(params.printBackground).toBe(true);
      // Pinned false: print-css `@page{size:A4}` would nullify --page-size.
      expect(params.preferCSSPageSize).toBe(false);
      // The unit must ride inside the string: a bare number is read as px by puppeteer.
      expect(params.width).toBe(`${String(PAGE_SIZES[size].widthPt)}pt`);
      expect(params.height).toBe(`${String(PAGE_SIZES[size].heightPt)}pt`);
      expect(params.margin).toEqual({ top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" });
      expect(params.outline).toBe(true);
    },
  );

  it("should pass outline explicitly from the caller: false stays false instead of a missing key", () => {
    expect(printParamsOf("a5", false).outline).toBe(false);
    expect(Object.hasOwn(printParamsOf("a5", false), "outline")).toBe(true);
    // Runtime cannot see "required", but signature length can: `printParamsOf.length === 2`.
    expect(printParamsOf.length).toBe(2);
  });

  it("should only accept the three paper kinds in isPdfPageSize", () => {
    expect(["a4", "letter", "a5"].every((value) => isPdfPageSize(value))).toBe(true);
    expect(isPdfPageSize("A4")).toBe(false);
    expect(isPdfPageSize("b5")).toBe(false);
  });
});

describe("renderPdfOnBrowserOf · opening and artifact", () => {
  it("should navigate via file:// after writing the HTML into a temp dir", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ pages: 1 });
      const bytes = await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: { kind: "sheet", html: "<p>hi</p>" },
        dir,
        pageSize: "a4",
        outline: true,
        preferCSSPageSize: false,
      });
      const htmlPath = join(dir, "input.html");
      expect(readFileSync(htmlPath, "utf8")).toBe("<p>hi</p>");
      expect(page.goneTo).toEqual([pathToFileURL(htmlPath).href]);
      expect(bytes.length).toBeGreaterThan(0);
    });
  });

  it("should pass false to page.pdf when outline is false", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ pages: 1 });
      await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: { kind: "sheet", html: "<p>hi</p>" },
        dir,
        pageSize: "a4",
        outline: false,
        preferCSSPageSize: false,
      });
      expect(page.pdfCalls[0]?.outline).toBe(false);
    });
  });
});

describe("cssPageParamsOf · slides page frame belongs to CSS", () => {
  it("should set preferCSSPageSize true, fall back to 16:9 for w/h, and zero the margins", () => {
    const params = cssPageParamsOf(true);
    expect(params.preferCSSPageSize).toBe(true);
    // The fallback applies only when the artifact lacks @page; 960×540pt is the same page frame as the skeleton's 13.333in×7.5in.
    expect(params.width).toBe("960pt");
    expect(params.height).toBe("540pt");
    expect(params.margin).toEqual({ top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" });
    expect(params.outline).toBe(true);
  });

  it("should ignore pageSize in the render layer when preferCSSPageSize is true: CSS paper params reach page.pdf directly", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ pages: 1 });
      await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: { kind: "sheet", html: "<p>hi</p>" },
        dir,
        // a5 is the legal value farthest from 16:9: if it still lands in the artifact the branch did not take effect.
        pageSize: "a5",
        outline: true,
        preferCSSPageSize: true,
      });
      expect(page.pdfCalls[0]?.preferCSSPageSize).toBe(true);
      expect(page.pdfCalls[0]?.width).toBe("960pt");
    });
  });
});

describe("openPageOf · foreign source gating", () => {
  it("should disable JS, route every request through the gate, and abort a deny verdict", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({});
      const records: { url: string; action: string; status?: number }[] = [];
      await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: {
          kind: "foreign",
          page: {
            url: "http://hreader-export.invalid/f/cap/index.html",
            gate: () => Promise.resolve({ kind: "deny" }),
          },
        },
        dir,
        pageSize: "a4",
        outline: false,
        preferCSSPageSize: false,
        audit: (record) => {
          records.push(record);
        },
      });
      expect(page.jsEnabled).toEqual([false]);
      expect(page.goneTo).toEqual(["http://hreader-export.invalid/f/cap/index.html"]);
      if (page.routed === undefined) throw new Error("interception was never armed");
      const settled: string[] = [];
      await page.routed({
        url: "https://cdn.example/x.png",
        method: "GET",
        navigation: false,
        mainFrame: false,
        respond: () => {
          settled.push("respond");
          return Promise.resolve();
        },
        continue: () => {
          settled.push("continue");
          return Promise.resolve();
        },
        abort: () => {
          settled.push("abort");
          return Promise.resolve();
        },
      });
      expect(settled).toEqual(["abort"]);
      expect(records).toEqual([{ url: "https://cdn.example/x.png", action: "deny" }]);
    });
  });

  it("should serve a serve verdict's reply and pass an allow verdict to continue", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({});
      const plan = {
        url: "http://hreader-export.invalid/f/cap/index.html",
        gate: (url: string) =>
          Promise.resolve(
            url.endsWith("/local.png")
              ? {
                  kind: "serve" as const,
                  reply: {
                    status: 200,
                    headers: { "content-type": "image/png" },
                    body: "bytes",
                  },
                }
              : { kind: "allow" as const },
          ),
      };
      await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: { kind: "foreign", page: plan },
        dir,
        pageSize: "a4",
        outline: false,
        preferCSSPageSize: false,
      });
      if (page.routed === undefined) throw new Error("interception was never armed");
      const settled: string[] = [];
      const replies: unknown[] = [];
      const fire = (url: string) =>
        page.routed?.({
          url,
          method: "GET",
          navigation: false,
          mainFrame: false,
          respond: (reply) => {
            settled.push("respond");
            replies.push(reply);
            return Promise.resolve();
          },
          continue: () => {
            settled.push("continue");
            return Promise.resolve();
          },
          abort: () => {
            settled.push("abort");
            return Promise.resolve();
          },
        });
      await fire("http://hreader-export.invalid/f/cap/local.png");
      await fire("https://cdn.example/x.png");
      expect(settled).toEqual(["respond", "continue"]);
      expect(replies).toEqual([
        { status: 200, headers: { "content-type": "image/png" }, body: "bytes" },
      ]);
    });
  });

  it("should no-content every main-frame navigation after the initial one — meta refresh, anchor, or form submit", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({});
      const records: { url: string; action: string }[] = [];
      const plan = {
        url: "http://hreader-export.invalid/f/cap/index.html",
        // The gate would happily serve the refresh target — the veto must not
        // come from the gate but from the interception layer in front of it.
        gate: () =>
          Promise.resolve({
            kind: "serve" as const,
            reply: { status: 200, headers: { "content-type": "text/css" }, body: "css" },
          }),
      };
      await renderPdfOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: { kind: "foreign", page: plan },
        dir,
        pageSize: "a4",
        outline: false,
        preferCSSPageSize: false,
        audit: (record) => {
          records.push(record);
        },
      });
      if (page.routed === undefined) throw new Error("interception was never armed");
      const settled: string[] = [];
      const fire = (url: string, navigation: boolean, mainFrame: boolean) =>
        page.routed?.({
          url,
          method: "GET",
          navigation,
          mainFrame,
          respond: (reply) => {
            settled.push(`respond${String(reply.status)}`);
            return Promise.resolve();
          },
          continue: () => {
            settled.push("continue");
            return Promise.resolve();
          },
          abort: () => {
            settled.push("abort");
            return Promise.resolve();
          },
        });

      // The initial goto's own navigation runs the gate — it's the only one.
      await fire("http://hreader-export.invalid/f/cap/index.html", true, true);
      // A meta refresh or <a target=_self>/form navigation to a same-origin
      // /f/ path is vetoed before the gate can serve it — answered 204 so the
      // navigation cancels without committing Chrome's error page over the
      // document (abort() would replace it, still hijacking the snapshot).
      await fire("http://hreader-export.invalid/f/cap/style.css", true, true);
      // ...and so is an external navigation, even with a gate that would allow it.
      await fire("https://evil.example/stolen", true, true);
      // A subframe navigation is not a main-frame navigation: the gate still
      // answers it (the CSP's frame-src 'none' is what keeps real iframes out).
      await fire("http://hreader-export.invalid/f/cap/inner.html", true, false);
      // A plain subresource fetch is untouched either way.
      await fire("http://hreader-export.invalid/f/cap/img.png", false, true);

      expect(settled).toEqual([
        "respond200",
        "respond204",
        "respond204",
        "respond200",
        "respond200",
      ]);
      expect(records.map((r) => r.action)).toEqual([
        "serve",
        "deny",
        "deny",
        "serve",
        "serve",
      ]);
    });
  });
});

describe("renderPdfOnBrowserOf · failure mapping", () => {
  it("should map a navigate failure to chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPdfOf({ goto: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
    });
  });

  it("should map a printToPDF failure to chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPdfOf({ pdf: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
    });
  });
});

const renderPngOf = (options: FakePageOptions, dir: string, maxHeight = 20_000) =>
  renderPngOnBrowserOf({
    browser: fakeBrowserOf(fakePageOf(options)),
    source: { kind: "sheet", html: "<p>x</p>" },
    dir,
    width: 800,
    scale: 2,
    maxHeight,
  });

describe("renderPngOnBrowserOf · height measurement and cropping", () => {
  it("should hand the full page height to setViewport, scaled to device pixels", async () => {
    await withDir(async (dir) => {
      const image = await renderPngOf({ contentHeight: 900.4 }, dir);
      expect([image.width, image.height, image.clipped]).toEqual([1600, 1802, false]);
    });
  });

  it("should re-measure a short document with a small viewport (measure again at 100 once the first 1000 caps)", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ contentHeight: 640 });
      await renderPngOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: { kind: "sheet", html: "<p>x</p>" },
        dir,
        width: 800,
        scale: 1,
        maxHeight: 20_000,
      });
      // Two height measurements (1000 and 100) + one screenshot viewport (640).
      expect(page.viewports.map((v) => v.height)).toEqual([1000, 100, 640]);
      expect(page.shotCalls[0]?.clip).toEqual({ x: 0, y: 0, width: 800, height: 640, scale: 1 });
    });
  });
});

describe("renderPngOnBrowserOf · long image and clipping", () => {
  it("should measure a long document once (above 1000 skips the short-document re-measure)", async () => {
    await withDir(async (dir) => {
      const page = fakePageOf({ contentHeight: 5000 });
      await renderPngOnBrowserOf({
        browser: fakeBrowserOf(page),
        source: { kind: "sheet", html: "<p>x</p>" },
        dir,
        width: 800,
        scale: 1,
        maxHeight: 20_000,
      });
      expect(page.viewports.map((v) => v.height)).toEqual([1000, 5000]);
    });
  });

  it("should clip beyond --max-height and mark clipped", async () => {
    await withDir(async (dir) => {
      const image = await renderPngOf({ contentHeight: 5000 }, dir, 2000);
      expect([image.width, image.height, image.clipped]).toEqual([1600, 4000, true]);
      expect(existsSync(join(dir, "input.html"))).toBe(true);
    });
  });
});

describe("renderPngOnBrowserOf · failure routing", () => {
  it("should report render_empty when cssContentSize is missing", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ contentHeight: "none" }, dir));
      expect(error.code).toBe("render_empty");
      expect(error.message).toContain("没有可用的页面高度");
    });
  });

  it("should map a screenshot failure to chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ png: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
    });
  });

  it("should report render_empty when the artifact is not a PNG", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ png: "not-png" }, dir));
      expect(error.code).toBe("render_empty");
    });
  });

  it("should catch a half-resolution artifact where the scale was not applied (one gate each for width and height)", async () => {
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

describe("renderPngOnBrowserOf · hard pixel gate", () => {
  it("should be invalid_input for a single-edge overflow before any screenshot", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderPngOf({ contentHeight: 40_000 }, dir, 40_000));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("超过单边");
    });
  });
});
