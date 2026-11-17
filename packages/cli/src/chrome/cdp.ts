// 这层管：CDP 会话（连接、握手、出 PDF / 长图的报文序列）与纸张/余白/像素口径；进程与端口在 `session.ts`。

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HrError } from "@hreader/core";

import { contentHeightAtOf, overrideViewportOf, type PageSession } from "./page";
import { assertPixelFrameOf, assertShotHeightOf, assertShotWidthOf } from "./pixels";
import { pngSizeOf } from "./png";
import { cdpCallOf, fieldOf, firstErrorLineOf, listOf, replyOf, type CdpParams } from "./protocol";
import type { ChromeTransport } from "./transport";

export type PdfPageSize = "a4" | "letter" | "a5";

interface PaperSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** D3b 的纸张表（pt）；Chrome 打印出来会舍入到 ±1.5pt，测试按这张表容差比。 */
export const PAGE_SIZES: Readonly<Record<PdfPageSize, PaperSize>> = {
  a4: { widthPt: 595.28, heightPt: 841.89 },
  letter: { widthPt: 612.0, heightPt: 792.0 },
  a5: { widthPt: 419.53, heightPt: 595.28 },
};

export const isPdfPageSize = (value: string): value is PdfPageSize =>
  value === "a4" || value === "letter" || value === "a5";

const MM_PER_INCH = 25.4;

/** 纸张与余白都换算成英寸：`printToPDF` 的 `paperWidth`/`marginTop` 只认英寸。
 * `generateDocumentOutline` 由调用方显式给（无默认值）：忘了传就编译不过，不靠“缺省 true”。 */
export const printParamsOf = (pageSize: PdfPageSize, outline: boolean): CdpParams => ({
  printBackground: true,
  // print-css.ts 的 `@page{size:A4}` 是硬编码的：`true` 会让 CSS 永远赢，`--page-size` 直接失效。
  preferCSSPageSize: false,
  paperWidth: PAGE_SIZES[pageSize].widthPt / 72,
  paperHeight: PAGE_SIZES[pageSize].heightPt / 72,
  // 关掉 CSS 纸张后 CDP 的 0.4in 默认余白会压过 `@page{margin:20mm 18mm}`，必须显式给。
  marginTop: 20 / MM_PER_INCH,
  marginBottom: 20 / MM_PER_INCH,
  marginLeft: 18 / MM_PER_INCH,
  marginRight: 18 / MM_PER_INCH,
  // 有 heading 才产出：`true` 且文档没有 h1–h6 时，Chrome 不写 `/Outlines` 也不报错。
  generateDocumentOutline: outline,
});

interface CdpConnection {
  call(method: string, params: CdpParams, sessionId?: string): Promise<CdpParams>;
  nextEventOf(method: string): Promise<CdpParams>;
}

interface CdpOutcome {
  readonly ok: boolean;
  readonly result: CdpParams;
  readonly message: string;
}

interface EventWaiter {
  readonly method: string;
  readonly settle: (params: CdpParams) => void;
}

interface CdpState {
  readonly pending: Map<number, (outcome: CdpOutcome) => void>;
  readonly waiters: EventWaiter[];
  seq: number;
}

const deliverOf = (state: CdpState, method: string, params: CdpParams): void => {
  const index = state.waiters.findIndex((waiter) => waiter.method === method);
  if (index < 0) return;
  state.waiters.splice(index, 1).forEach((waiter) => {
    waiter.settle(params);
  });
};

const onReplyOf = (state: CdpState, text: string): void => {
  const reply = replyOf(text);
  if (reply.kind === "event") {
    deliverOf(state, reply.method, reply.params);
    return;
  }
  if (reply.kind === "invalid") return;
  const settle = state.pending.get(reply.id);
  if (settle === undefined) return;
  state.pending.delete(reply.id);
  settle(
    reply.kind === "error"
      ? { ok: false, result: {}, message: reply.message }
      : { ok: true, result: reply.result, message: "" },
  );
};

interface CdpRequest {
  readonly method: string;
  readonly params: CdpParams;
  readonly sessionId: string | undefined;
}

const callOf = (
  state: CdpState,
  transport: ChromeTransport,
  request: CdpRequest,
): Promise<CdpParams> =>
  new Promise((resolve, reject) => {
    state.seq += 1;
    const id = state.seq;
    state.pending.set(id, (outcome) => {
      if (outcome.ok) resolve(outcome.result);
      else {
        const detail = firstErrorLineOf(outcome.message);
        reject(new HrError("chrome_failed", `${request.method} 失败：${detail}`));
      }
    });
    transport.send(cdpCallOf(id, request.method, request.params, request.sessionId));
  });

const connectionOf = (transport: ChromeTransport): CdpConnection => {
  const state: CdpState = { pending: new Map(), waiters: [], seq: 0 };
  transport.onMessage((text) => {
    onReplyOf(state, text);
  });
  transport.onClose(() => {
    for (const settle of state.pending.values()) {
      settle({ ok: false, result: {}, message: "连接已断开" });
    }
    state.pending.clear();
  });
  return {
    call: (method, params, sessionId) => callOf(state, transport, { method, params, sessionId }),
    nextEventOf: (method) =>
      new Promise((resolve) => {
        state.waiters.push({ method, settle: resolve });
      }),
  };
};

const targetIdOf = (targets: unknown): string => {
  const page = listOf(targets).find((item) => fieldOf(item, "type") === "page");
  const targetId = page === undefined ? undefined : fieldOf(page, "targetId");
  if (typeof targetId !== "string")
    throw new HrError("chrome_failed", "Chrome 没有可用的 page 目标");
  return targetId;
};

const sessionIdOf = async (connection: CdpConnection): Promise<string> => {
  const targets = await connection.call("Target.getTargets", {});
  const targetId = targetIdOf(fieldOf(targets, "targetInfos"));
  const attached = await connection.call("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = fieldOf(attached, "sessionId");
  if (typeof sessionId !== "string") {
    throw new HrError("chrome_failed", "Target.attachToTarget 没有返回 sessionId");
  }
  return sessionId;
};

/** 两个渲染命令共用的开场：attach → 写临时 HTML → enable → navigate → 等 load。 */
const openPageOf = async (
  transport: ChromeTransport,
  html: string,
  dir: string,
): Promise<PageSession> => {
  const connection = connectionOf(transport);
  const sessionId = await sessionIdOf(connection);
  const htmlPath = join(dir, "input.html");
  writeFileSync(htmlPath, html);
  await connection.call("Page.enable", {}, sessionId);
  // 先挂事件再接 navigate：`loadEventFired` 可能比 navigate 的回包更早到，等回包后再挂会丢事件。
  const loaded = connection.nextEventOf("Page.loadEventFired");
  // `pathToFileURL` 而不是手拼 `file://`：路径里有空格/中文/`#` 时手拼会被当成 host 或 fragment。
  await connection.call("Page.navigate", { url: pathToFileURL(htmlPath).href }, sessionId);
  await loaded;
  return { connection, sessionId };
};

const bytesOf = (result: CdpParams, what: string): Uint8Array => {
  const data = fieldOf(result, "data");
  if (typeof data !== "string") throw new HrError("chrome_failed", `${what} 没有返回 data`);
  return Uint8Array.from(Buffer.from(data, "base64"));
};

const printPdfOf = async (
  page: PageSession,
  pageSize: PdfPageSize,
  outline: boolean,
): Promise<Uint8Array> => {
  const result = await page.connection.call(
    "Page.printToPDF",
    printParamsOf(pageSize, outline),
    page.sessionId,
  );
  return bytesOf(result, "Page.printToPDF");
};

interface CdpPrintInput {
  readonly transport: ChromeTransport;
  readonly html: string;
  readonly dir: string;
  readonly pageSize: PdfPageSize;
  readonly outline: boolean;
}

export const renderPdfOverCdpOf = async (input: CdpPrintInput): Promise<Uint8Array> => {
  const page = await openPageOf(input.transport, input.html, input.dir);
  return printPdfOf(page, input.pageSize, input.outline);
};

/** 长图请求：`width`/`maxHeight` 是 CSS 像素，`scale` 是设备像素倍率（超出 `maxHeight` 先裁不缩）。 */
export interface PngViewport {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
}

export interface LongImage {
  readonly bytes: Uint8Array;
  /** 以下宽高都反读自 IHDR（设备像素）。 */
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
}

/** `clip.scale` 固定 1，倍率只由 `deviceScaleFactor` 给（两个都给会被 Chrome 乘两次：1200×2000@2 出 4800×8000）；
 * 没有 clip 的 `captureBeyondViewport` 会出整页，`--max-height` 一个像素也裁不掉；clip 的 height 是 CSS 像素。 */
const shotParamsOf = (viewport: PngViewport, clipHeight: number): CdpParams => ({
  format: "png",
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: viewport.width, height: clipHeight, scale: 1 },
});

const capturePngOf = async (page: PageSession, viewport: PngViewport): Promise<LongImage> => {
  // 先把宽度落定再量高：否则 `getLayoutMetrics` 读到的是上一轮视口的布局，`--width` 很窄时
  // 报出来的高度会比真实内容矮一截（旧实现就是这么丢高度的）。
  const cssHeight = await contentHeightAtOf(page, viewport);
  const clipHeight = Math.min(cssHeight, viewport.maxHeight);
  // 真实内容高此时才知道：单边/总像素闸放在截图前，越界是 `invalid_input` 而不是 Chrome 崩。
  assertPixelFrameOf({
    deviceWidth: viewport.width * viewport.scale,
    deviceHeight: clipHeight * viewport.scale,
  });
  await overrideViewportOf(page, viewport, clipHeight);
  const shot = await page.connection.call(
    "Page.captureScreenshot",
    shotParamsOf(viewport, clipHeight),
    page.sessionId,
  );
  const bytes = bytesOf(shot, "Page.captureScreenshot");
  // 宽高一律反读 IHDR：Chrome 的返回值与自算的 `width × scale` 都可能偏差一像素，报告值必须与盘上字节一致。
  const size = pngSizeOf(bytes);
  assertShotWidthOf({ viewport, deviceWidth: size.width });
  assertShotHeightOf({ viewport, clipHeight, deviceHeight: size.height });
  return {
    bytes,
    width: size.width,
    height: size.height,
    clipped: cssHeight > viewport.maxHeight,
  };
};

interface CdpPngInput extends PngViewport {
  readonly transport: ChromeTransport;
  readonly html: string;
  readonly dir: string;
}

export const renderPngOverCdpOf = async (input: CdpPngInput): Promise<LongImage> => {
  const page = await openPageOf(input.transport, input.html, input.dir);
  return capturePngOf(page, input);
};
