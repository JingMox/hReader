import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import {
  PAGE_SIZES,
  isPdfPageSize,
  printParamsOf,
  renderPdfOverCdpOf,
  type PdfPageSize,
} from "../src/chrome/cdp";
import { fieldOf } from "../src/chrome/protocol";
import { pdfOf, responderOf, type ResponderOptions } from "./chrome-helpers";

const PAGE = /\/Type\s*\/Page\b(?!s)/gu;

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "hr-cdp-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const renderOf = (options: ResponderOptions, dir: string): Promise<Uint8Array> => {
  const responder = responderOf(options);
  return renderPdfOverCdpOf({
    transport: responder.transport,
    html: "<p>hi</p>",
    dir,
    pageSize: "a4",
  });
};

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

const waitForOf = async (check: () => boolean): Promise<void> => {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error("等待条件超时");
};

describe("printParamsOf", () => {
  it("纸张表按 pt 对齐 D3b 的四舍五入值", () => {
    expect(PAGE_SIZES.a4.widthPt).toBeCloseTo(595.28, 2);
    expect(PAGE_SIZES.a4.heightPt).toBeCloseTo(841.89, 2);
    expect(PAGE_SIZES.letter.widthPt).toBeCloseTo(612, 2);
    expect(PAGE_SIZES.letter.heightPt).toBeCloseTo(792, 2);
    expect(PAGE_SIZES.a5.widthPt).toBeCloseTo(419.53, 2);
    expect(PAGE_SIZES.a5.heightPt).toBeCloseTo(595.28, 2);
  });

  it.each<PdfPageSize>(["a4", "letter", "a5"])("%s 的纸张（英寸）与 CSS 余白一致", (pageSize) => {
    const params = printParamsOf(pageSize);
    expect(params["printBackground"]).toBe(true);
    // 钉死 false：print-css 的 `@page{size:A4}` 会让 --page-size 失效。
    expect(params["preferCSSPageSize"]).toBe(false);
    const widthIn = Number(params["paperWidth"]);
    const heightIn = Number(params["paperHeight"]);
    expect(Math.abs(widthIn * 72 - PAGE_SIZES[pageSize].widthPt)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(heightIn * 72 - PAGE_SIZES[pageSize].heightPt)).toBeLessThanOrEqual(1.5);
    expect(Number(params["marginTop"])).toBeCloseTo(20 / 25.4, 6);
    expect(Number(params["marginBottom"])).toBeCloseTo(20 / 25.4, 6);
    expect(Number(params["marginLeft"])).toBeCloseTo(18 / 25.4, 6);
    expect(Number(params["marginRight"])).toBeCloseTo(18 / 25.4, 6);
  });

  it("isPdfPageSize 只认三种纸张", () => {
    expect(["a4", "letter", "a5"].every((value) => isPdfPageSize(value))).toBe(true);
    expect(isPdfPageSize("A4")).toBe(false);
    expect(isPdfPageSize("b5")).toBe(false);
  });
});

describe("renderPdfOverCdpOf · 握手与产物", () => {
  it("握手后出 PDF，页数按 /Type /Page 计数", async () => {
    await withDir(async (dir) => {
      const bytes = await renderOf({ pages: 3 }, dir);
      const text = Buffer.from(bytes).toString("latin1");
      expect(text.startsWith("%PDF")).toBe(true);
      expect(text).toContain("/MediaBox");
      expect((text.match(PAGE) ?? []).length).toBe(3);
      expect((text.match(PAGE) ?? []).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("没有 page 目标时报 chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderOf({ targets: "none" }, dir));
      expect(error.code).toBe("chrome_failed");
      expect(error.message).toContain("page 目标");
    });
  });

  it("targetInfos 不是数组时同样按“没有目标”处理", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderOf({ targets: "not-array" }, dir));
      expect(error.message).toContain("page 目标");
    });
  });

  it("page 目标缺 targetId 时报 chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderOf({ targets: "no-id" }, dir));
      expect(error.message).toContain("page 目标");
    });
  });
});

describe("renderPdfOverCdpOf · attach 失败", () => {
  it("attach 没有 sessionId 时报 chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderOf({ attach: "none" }, dir));
      expect(error.message).toContain("sessionId");
    });
  });
});

describe("renderPdfOverCdpOf · 调用失败", () => {
  it("navigate 失败只带首行错误", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderOf({ navigate: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
      expect(error.message).toContain("Page.navigate 失败：navigate boom");
      expect(error.message).not.toContain("second line");
    });
  });

  it("printToPDF 失败映射成 chrome_failed 且只留首行", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderOf({ print: "error" }, dir));
      expect(error.code).toBe("chrome_failed");
      expect(error.message).toContain("Page.printToPDF 失败：printToPDF boom");
      expect(error.message).not.toContain("at stack");
    });
  });

  it("printToPDF 没有 data 时报 chrome_failed", async () => {
    await withDir(async (dir) => {
      const error = await failureOf(renderOf({ print: "no-data" }, dir));
      expect(error.message).toContain("没有返回 data");
    });
  });
});

// M17 判别点（§15.2）：`Page.navigate` 回包不等于页面加载完了。不 `await loaded` 时 printToPDF
// 会赶在 `loadEventFired` 之前发出，打到半渲染的页。
describe("renderPdfOverCdpOf · 等 load 事件（M17）", () => {
  it("navigate 回包后仍等 loadEventFired 才 printToPDF", async () => {
    await withDir(async (dir) => {
      const responder = responderOf({ pages: 1, loadEvent: "manual" });
      const pending = renderPdfOverCdpOf({
        transport: responder.transport,
        html: "<p>hi</p>",
        dir,
        pageSize: "a4",
      });
      await waitForOf(() => responder.sent.some((text) => text.includes("Page.navigate")));
      expect(responder.sent.some((text) => text.includes("Page.printToPDF"))).toBe(false);
      responder.inject(JSON.stringify({ method: "Page.loadEventFired", params: {} }));
      const bytes = await pending;
      expect(Buffer.from(bytes).toString("latin1")).toContain("/Type /Page");
    });
  });
});

describe("renderPdfOverCdpOf · 断开与扁平报文", () => {
  it("连接断开时在途调用以 chrome_failed 结束，坏报文被忽略", async () => {
    await withDir(async (dir) => {
      const responder = responderOf({ print: "hang" });
      const pending = renderPdfOverCdpOf({
        transport: responder.transport,
        html: pdfOf(1),
        dir,
        pageSize: "a4",
      });
      await waitForOf(() => responder.sent.some((text) => text.includes("Page.printToPDF")));
      responder.inject("not json");
      responder.inject(JSON.stringify({ id: 999, result: {} }));
      responder.drop();
      const error = await failureOf(pending);
      expect(error.code).toBe("chrome_failed");
      expect(error.message).toContain("连接已断开");
    });
  });
});

describe("renderPdfOverCdpOf · 扁平报文", () => {
  it("扁平会话的 Page.* 报文都带顶层 sessionId", async () => {
    await withDir(async (dir) => {
      const responder = responderOf({ pages: 1 });
      await renderPdfOverCdpOf({
        transport: responder.transport,
        html: pdfOf(1),
        dir,
        pageSize: "a4",
      });
      const pageMessages = responder.sent
        .map((text: string): unknown => JSON.parse(text))
        .filter((message) => String(fieldOf(message, "method")).startsWith("Page."));
      expect(pageMessages.length).toBe(3);
      expect(pageMessages.every((message) => fieldOf(message, "sessionId") === "s1")).toBe(true);
    });
  });

  it("没有在途调用时断开连接不产生副作用", async () => {
    await withDir(async (dir) => {
      const responder = responderOf({});
      const bytes = await renderPdfOverCdpOf({
        transport: responder.transport,
        html: pdfOf(1),
        dir,
        pageSize: "a5",
      });
      responder.drop();
      expect(bytes.length).toBeGreaterThan(0);
    });
  });
});
