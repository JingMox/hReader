// 假传输/假进程/假页面的共同夹具：让 `chrome_*` 的每层都能跳过真 Chrome 单独测。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChromeDeps, ChromeProcess } from "../src/chrome/session";
import { fieldOf, type CdpParams } from "../src/chrome/protocol";
import { fakeTransportOf, type ChromeTransport, type FakeTransport } from "../src/chrome/transport";

import { screenshotOf, type Viewport } from "./chrome-png";

export { pngBase64Of, pngOf } from "./chrome-png";

export const VERSION_TEXT = JSON.stringify({
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
});

/**
 * 造一份页数可数、**结构自洽**的 PDF：Catalog(1) → Pages(2) → Page(3..)，带 trailer，不带 `/Outlines`。
 * 页树与 trailer 必须真在：产物要过 `bookmarkCountOf` 的 trailer → `/Root` 走法。
 */
export const pdfOf = (pages: number): string => {
  const ids = Array.from({ length: pages }, (_unused: unknown, index: number) => String(3 + index));
  const pageObjects = ids
    .map(
      (id: string) =>
        `${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] >>\nendobj`,
    )
    .join("\n");
  const tree = ids.map((id: string) => `${id} 0 R`).join(" ");
  const pagesObject = `2 0 obj\n<< /Type /Pages /Count ${String(pages)} /Kids [${tree}] >>\nendobj\n`;
  const tail = `${pageObjects}\ntrailer\n<< /Size 99 /Root 1 0 R >>\nstartxref\n0000\n%%EOF\n`;
  return `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n${pagesObject}${tail}`;
};

export const pdfBase64Of = (pages: number): string => Buffer.from(pdfOf(pages)).toString("base64");

export interface FakeChrome {
  readonly chrome: ChromeProcess;
  readonly signals: string[];
  stderr(text: string): void;
  exit(code: number | null): void;
  fail(message: string): void;
}

export const fakeChromeOf = (): FakeChrome => {
  const stderrHandlers: ((text: string) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  const errorHandlers: ((error: Error) => void)[] = [];
  const signals: string[] = [];
  const chrome: ChromeProcess = {
    pid: 7001,
    onStderr: (cb) => {
      stderrHandlers.push(cb);
      return () => {
        const index = stderrHandlers.indexOf(cb);
        if (index >= 0) stderrHandlers.splice(index, 1);
      };
    },
    onExit: (cb) => void exitHandlers.push(cb),
    onError: (cb) => void errorHandlers.push(cb),
    killGroup: (signal) => void signals.push(signal),
  };
  return {
    chrome,
    signals,
    stderr: (text) => {
      stderrHandlers.forEach((handler) => {
        handler(text);
      });
    },
    exit: (code) => {
      exitHandlers.forEach((handler) => {
        handler(code);
      });
    },
    fail: (message) => {
      errorHandlers.forEach((handler) => {
        handler(new Error(message));
      });
    },
  };
};

export interface ResponderOptions {
  readonly pages?: number;
  readonly targets?: "page" | "none" | "no-id" | "not-array";
  readonly attach?: "session" | "none";
  readonly navigate?: "ok" | "error";
  /** `manual`：navigate 回包但**不**发 `loadEventFired`，由用例自己 `inject`（M17 的时间线判别）。 */
  readonly loadEvent?: "immediate" | "manual";
  readonly print?: "ok" | "error" | "hang" | "no-data";
  /** `cssContentSize.height`；`"none"` = 不给这个字段。 */
  readonly contentHeight?: number | "none";
  readonly png?: "ok" | "error" | "hang" | "no-data" | "not-png" | "half-width" | "half-height";
}

export interface Responder {
  readonly transport: ChromeTransport;
  readonly sent: readonly string[];
  inject(text: string): void;
  drop(): void;
}

const jsonOf = (id: number, result: unknown): string => JSON.stringify({ id, result });

const errorOf = (id: number, message: string): string => JSON.stringify({ id, error: { message } });

const loadEventOf = (): string => JSON.stringify({ method: "Page.loadEventFired", params: {} });

const targetsOf = (mode: ResponderOptions["targets"]): unknown => {
  if (mode === "none") return [];
  if (mode === "not-array") return "nope";
  return [{ targetId: mode === "no-id" ? undefined : "t1", type: "page" }];
};

const navigateOf = (options: ResponderOptions, base: FakeTransport, id: number): void => {
  if (options.navigate === "error") {
    base.receive(errorOf(id, "navigate boom\nsecond line"));
    return;
  }
  base.receive(jsonOf(id, { frameId: "f1" }));
  if (options.loadEvent === "manual") return;
  // 第二次 loadEventFired 没有等待者：覆盖“无人等的事件被丢掉”的路径。
  base.receive(loadEventOf());
  base.receive(loadEventOf());
};

const printOf = (options: ResponderOptions, base: FakeTransport, id: number): void => {
  if (options.print === "hang") return;
  if (options.print === "error") {
    base.receive(errorOf(id, "printToPDF boom\nat stack"));
    return;
  }
  if (options.print === "no-data") {
    base.receive(jsonOf(id, {}));
    return;
  }
  base.receive(jsonOf(id, { data: pdfBase64Of(options.pages ?? 2) }));
};

type Handler = (id: number, params: CdpParams) => void;

const isRecord = (value: unknown): value is CdpParams =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metricsOf = (options: ResponderOptions, base: FakeTransport, id: number): void => {
  const height = options.contentHeight ?? 900;
  base.receive(jsonOf(id, height === "none" ? {} : { cssContentSize: { width: 800, height } }));
};

const replyOf =
  (base: FakeTransport, result: unknown): Handler =>
  (id) => {
    base.receive(jsonOf(id, result));
  };

/** 握手阶段的三条：target 列表 / attach / Page.enable。 */
const targetHandlersOf = (
  options: ResponderOptions,
  base: FakeTransport,
): (readonly [string, Handler])[] => [
  ["Target.getTargets", replyOf(base, { targetInfos: targetsOf(options.targets) })],
  ["Target.attachToTarget", replyOf(base, options.attach === "none" ? {} : { sessionId: "s1" })],
  ["Page.enable", replyOf(base, {})],
];

const metricsHandlerOf =
  (options: ResponderOptions, base: FakeTransport): Handler =>
  (id) => {
    metricsOf(options, base, id);
  };

/** 有 `clip` 就以 clip 为准；真 Chrome 把 clip.scale 与 deviceScaleFactor 相乘，假传输照此口径回字节。 */
const captureHandlerOf =
  (options: ResponderOptions, base: FakeTransport, viewport: Viewport): Handler =>
  (id, params) => {
    const clip = fieldOf(params, "clip");
    const capture =
      clip === undefined
        ? viewport
        : {
            width: Number(fieldOf(clip, "width")),
            height: Number(fieldOf(clip, "height")),
            scale: Number(fieldOf(clip, "scale")) * viewport.scale,
          };
    screenshotOf(options.png, base, capture, id);
  };

/** 渲染阶段：navigate / printToPDF / 长图三条（尺寸取自 override）。 */
const pageHandlersOf = (
  options: ResponderOptions,
  base: FakeTransport,
  viewport: Viewport,
): (readonly [string, Handler])[] => [
  [
    "Page.navigate",
    (id) => {
      navigateOf(options, base, id);
    },
  ],
  [
    "Page.printToPDF",
    (id) => {
      printOf(options, base, id);
    },
  ],
  ["Page.getLayoutMetrics", metricsHandlerOf(options, base)],
  [
    "Emulation.setDeviceMetricsOverride",
    (id, params) => {
      viewport.width = Number(fieldOf(params, "width"));
      viewport.height = Number(fieldOf(params, "height"));
      viewport.scale = Number(fieldOf(params, "deviceScaleFactor"));
      base.receive(jsonOf(id, {}));
    },
  ],
  ["Page.captureScreenshot", captureHandlerOf(options, base, viewport)],
];

const handlersOf = (
  options: ResponderOptions,
  base: FakeTransport,
  viewport: Viewport,
): Map<string, Handler> =>
  new Map([...targetHandlersOf(options, base), ...pageHandlersOf(options, base, viewport)]);

export const responderOf = (options: ResponderOptions = {}): Responder => {
  const base = fakeTransportOf();
  const viewport: Viewport = { width: 0, height: 0, scale: 1 };
  const dispatch = handlersOf(options, base, viewport);
  const respond = (text: string): void => {
    const parsed: unknown = JSON.parse(text);
    const id: unknown = fieldOf(parsed, "id");
    const method: unknown = fieldOf(parsed, "method");
    if (typeof id !== "number" || typeof method !== "string") return;
    const params: unknown = fieldOf(parsed, "params");
    dispatch.get(method)?.(id, isRecord(params) ? params : {});
  };
  const transport: ChromeTransport = {
    send: (text) => {
      base.send(text);
      queueMicrotask(() => {
        respond(text);
      });
    },
    onMessage: (cb) => {
      base.onMessage(cb);
    },
    onClose: (cb) => {
      base.onClose(cb);
    },
    close: () => {
      base.close();
    },
  };
  return {
    transport,
    sent: base.sent,
    inject: (text) => {
      base.receive(text);
    },
    drop: () => {
      base.drop();
    },
  };
};

export interface DepsInput {
  readonly chrome: ChromeProcess;
  readonly dirs: string[];
  readonly connect: (url: string) => ChromeTransport;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => boolean;
  readonly fetchText?: (url: string) => Promise<string>;
  readonly spawnError?: string;
  readonly onSpawn?: (args: readonly string[]) => void;
}

export const depsWithOf = (input: DepsInput): ChromeDeps => ({
  env: input.env ?? { HREADER_CHROME: "/fake/chrome" },
  exists: input.exists ?? ((path) => path === "/fake/chrome"),
  spawn: (_file, args) => {
    input.onSpawn?.(args);
    if (input.spawnError !== undefined) throw new Error(input.spawnError);
    return input.chrome;
  },
  fetchText: input.fetchText ?? (() => Promise.resolve(VERSION_TEXT)),
  connect: input.connect,
  tempDir: () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-chrome-"));
    input.dirs.push(dir);
    return dir;
  },
  remove: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  killGraceMs: 5,
});
