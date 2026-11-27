// This layer covers the `browser.ts` adapter — `pageLikeOf`/`browserLikeOf` map calls one-to-one onto
// puppeteer's method surface, errors uniformly fold into `chrome_failed` (ProtocolError takes `originalMessage`),
// and `browserOf` owns the handshake-failure copy. Fake objects injected throughout; no real Chrome.
import { ProtocolError, type ConnectOptions } from "puppeteer-core";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { browserLikeOf, browserOf, pageLikeOf, type PdfPrintOptions } from "../src/chrome/browser";

const printOf = (outline: boolean): PdfPrintOptions => ({
  printBackground: true,
  preferCSSPageSize: false,
  width: "595.28pt",
  height: "841.89pt",
  margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
  outline,
});

interface Calls {
  readonly goto: { url: string; options: unknown }[];
  readonly pdf: unknown[];
  readonly screenshot: unknown[];
  readonly setViewport: unknown[];
  readonly jsEnabled: boolean[];
  readonly interception: boolean[];
  /** The "request" handler registered via page.on — tests fire synthetic requests through it. */
  requestHandler: ((request: unknown) => void) | undefined;
  sessions: number;
}

type Failures = Partial<Record<"goto" | "pdf" | "screenshot" | "setViewport" | "metrics", Error>>;

const stubOf = <T, R>(calls: T[], failure: Error | undefined, ok: R): ((arg: T) => Promise<R>) => {
  return (arg) => {
    calls.push(arg);
    return failure === undefined ? Promise.resolve(ok) : Promise.reject(failure);
  };
};

const puppeteerPageOf = (calls: Calls, failures: Failures = {}) => ({
  goto: (url: string, options: { waitUntil: "load"; timeout: number }) => {
    calls.goto.push({ url, options });
    return failures.goto === undefined ? Promise.resolve(null) : Promise.reject(failures.goto);
  },
  pdf: stubOf(calls.pdf, failures.pdf, new Uint8Array([0x25])),
  screenshot: stubOf(calls.screenshot, failures.screenshot, new Uint8Array([0x89])),
  setViewport: stubOf(calls.setViewport, failures.setViewport, undefined),
  createCDPSession: () => {
    calls.sessions += 1;
    return Promise.resolve({
      send: (method: string) =>
        failures.metrics === undefined
          ? Promise.resolve({ method, ok: true })
          : Promise.reject(failures.metrics),
    });
  },
  setJavaScriptEnabled: (enabled: boolean) => {
    calls.jsEnabled.push(enabled);
    return Promise.resolve();
  },
  setRequestInterception: (value: boolean) => {
    calls.interception.push(value);
    return Promise.resolve();
  },
  on: (_event: "request", handler: (request: never) => void) => {
    calls.requestHandler = handler as (request: unknown) => void;
  },
});

const callsOf = (): Calls => ({
  goto: [],
  pdf: [],
  screenshot: [],
  setViewport: [],
  jsEnabled: [],
  interception: [],
  requestHandler: undefined,
  sessions: 0,
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

const protocolErrorOf = (original: string): ProtocolError => {
  const error = new ProtocolError();
  error.originalMessage = original;
  return error;
};

describe("pageLikeOf · method mapping", () => {
  it("should wait for load in goto and disable puppeteer's own timeout", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    await page.goto("file:///x.html");
    expect(calls.goto).toEqual([
      { url: "file:///x.html", options: { waitUntil: "load", timeout: 0 } },
    ]);
  });

  it("should pass pdf/screenshot/setViewport arguments through verbatim (screenshot is fixed type: png)", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    const pdfOptions = printOf(true);
    await page.pdf(pdfOptions);
    expect(calls.pdf).toEqual([pdfOptions]);
    const shot = {
      clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
      captureBeyondViewport: true,
    };
    await page.screenshot(shot);
    expect(calls.screenshot).toEqual([{ type: "png", ...shot }]);
    const viewport = { width: 800, height: 600, deviceScaleFactor: 2 };
    await page.setViewport(viewport);
    expect(calls.setViewport).toEqual([viewport]);
  });

  it("should run metrics through a one-shot CDP session and hand back the raw reply", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    const first = await page.metrics();
    const second = await page.metrics();
    expect(calls.sessions).toBe(1);
    expect(first).toEqual({ method: "Page.getLayoutMetrics", ok: true });
    expect(second).toEqual({ method: "Page.getLayoutMetrics", ok: true });
  });
});

describe("pageLikeOf · request routing", () => {
  interface RequestCalls {
    readonly responded: unknown[];
    continued: number;
    aborted: number;
  }

  const puppeteerRequestOf = (url: string, calls: RequestCalls) => ({
    url: () => url,
    method: () => "GET",
    respond: (reply: unknown) => {
      calls.responded.push(reply);
      return Promise.resolve();
    },
    continue: () => {
      calls.continued += 1;
      return Promise.resolve();
    },
    abort: () => {
      calls.aborted += 1;
      return Promise.resolve();
    },
  });

  const flushOf = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  it("should arm interception and hand each request the three verdict verbs", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    await page.routeRequests(async (request) => {
      if (request.url.endsWith("/blocked")) await request.abort();
      else if (request.url.endsWith("/passed")) await request.continue();
      else await request.respond({ status: 200, headers: { "x-a": "b" }, body: "ok" });
    });
    expect(calls.interception).toEqual([true]);
    const fire = async (url: string): Promise<RequestCalls> => {
      const hits: RequestCalls = { responded: [], continued: 0, aborted: 0 };
      calls.requestHandler?.(puppeteerRequestOf(url, hits));
      await flushOf();
      return hits;
    };
    const served = await fire("http://hreader-export.invalid/f/cap/doc.html");
    expect(served.responded).toEqual([{ status: 200, headers: { "x-a": "b" }, body: "ok" }]);
    expect((await fire("https://cdn.example/passed")).continued).toBe(1);
    expect((await fire("https://cdn.example/blocked")).aborted).toBe(1);
  });

  it("should abort the request when the gate itself throws — fail closed, never leak", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    await page.routeRequests(() => Promise.reject(new Error("gate exploded")));
    const hits: RequestCalls = { responded: [], continued: 0, aborted: 0 };
    calls.requestHandler?.(puppeteerRequestOf("https://cdn.example/x", hits));
    await flushOf();
    expect(hits.aborted).toBe(1);
    expect(hits.responded).toEqual([]);
    expect(hits.continued).toBe(0);
  });
});

describe("pageLikeOf · error folding", () => {
  it("should fold a plain error's first line into chrome_failed", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls, { goto: new Error("navigate boom\nsecond") }));
    const error = await failureOf(page.goto("file:///x"));
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toBe("Page.navigate 失败：navigate boom");
  });

  it("should use originalMessage for a ProtocolError to drop the protocol prefix", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls, { pdf: protocolErrorOf("Print job failed") }));
    const error = await failureOf(page.pdf(printOf(false)));
    expect(error.message).toBe("Page.printToPDF 失败：Print job failed");
  });
});

describe("pageLikeOf · protocol names per method", () => {
  it("should carry the protocol name Emulation.setDeviceMetricsOverride when setViewport fails", async () => {
    const page = pageLikeOf(puppeteerPageOf(callsOf(), { setViewport: new Error("vp") }));
    const error = await failureOf(page.setViewport({ width: 1, height: 1, deviceScaleFactor: 1 }));
    expect(error.message).toBe("Emulation.setDeviceMetricsOverride 失败：vp");
  });

  it("should carry each protocol name when screenshot / metrics fail", async () => {
    const page = pageLikeOf(
      puppeteerPageOf(callsOf(), {
        screenshot: new Error("shot"),
        metrics: new Error("metrics"),
      }),
    );
    const shot = await failureOf(
      page.screenshot({
        clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
        captureBeyondViewport: true,
      }),
    );
    expect(shot.message).toBe("Page.captureScreenshot 失败：shot");
    expect((await failureOf(page.metrics())).message).toBe("Page.getLayoutMetrics 失败：metrics");
  });
});

describe("browserLikeOf", () => {
  it("should return a PageLike on newPage success and fold a failure into Target.createTarget's chrome_failed", async () => {
    const calls = callsOf();
    let disconnects = 0;
    const browser = browserLikeOf({
      newPage: () => Promise.resolve(puppeteerPageOf(calls)),
      disconnect: () => {
        disconnects += 1;
        return Promise.resolve();
      },
    });
    const page = await browser.newPage();
    await page.goto("file:///x");
    expect(calls.goto.length).toBe(1);
    browser.disconnect();
    expect(disconnects).toBe(1);

    const failing = browserLikeOf({
      newPage: () => Promise.reject(new Error("target gone\nstack")),
      disconnect: () => Promise.resolve(),
    });
    const error = await failureOf(failing.newPage());
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toBe("Target.createTarget 失败：target gone");
  });
});

describe("browserOf", () => {
  it("should fix the handshake parameters: ws endpoint + protocolTimeout 0", async () => {
    const calls = callsOf();
    let seen: ConnectOptions | undefined;
    const browser = await browserOf("ws://127.0.0.1:9/devtools/browser/x", (options) => {
      seen = options;
      return Promise.resolve({
        newPage: () => Promise.resolve(puppeteerPageOf(calls)),
        disconnect: () => Promise.resolve(),
      });
    });
    expect(seen).toEqual({
      browserWSEndpoint: "ws://127.0.0.1:9/devtools/browser/x",
      protocolTimeout: 0,
    });
    expect(typeof browser.newPage).toBe("function");
  });

  it("should fold a handshake failure into chrome_failed + first line", async () => {
    const error = await failureOf(
      browserOf("ws://127.0.0.1:9/x", () =>
        Promise.reject(new Error("connect ECONNREFUSED\nmore")),
      ),
    );
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toBe("连接 Chrome 失败：connect ECONNREFUSED");
  });
});
