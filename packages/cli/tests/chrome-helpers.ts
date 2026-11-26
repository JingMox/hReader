// Shared fixtures for fake process/browser/page: every `chrome_*` layer can be tested without real Chrome.
import { mkdtempSync, rmSync } from "node:fs";

import { HrError } from "@hreader/core";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BrowserLike,
  PageLike,
  PdfPrintOptions,
  PngShotOptions,
  ViewportSpec,
} from "../src/chrome/browser";
import type { ChromeDeps, ChromeProcess } from "../src/chrome/process";

import { pngOf } from "./chrome-png";

export { pngBase64Of, pngOf } from "./chrome-png";

/** A promise that never resolves: the "hang" mode of goto/metrics/pdf parks rendering on it (so the outer timeout/abort wins). */
const HANG: Promise<never> = new Promise<never>(() => undefined);

/**
 * Build a PDF with a countable, **structurally consistent** page count: Catalog(1) → Pages(2) → Page(3..),
 * with trailer, without `/Outlines`. The page tree and trailer must really be there: the artifact must
 * survive `inspectPdfOf`'s catalog → `/Outlines` walk.
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

export interface FakePageOptions {
  readonly pages?: number;
  readonly goto?: "ok" | "error" | "hang";
  readonly pdf?: "ok" | "error" | "hang";
  /** `cssContentSize.height`; `"none"` = do not provide the field. */
  readonly contentHeight?: number | "none" | "hang";
  readonly png?: "ok" | "error" | "hang" | "not-png" | "half-width" | "half-height";
}

export interface FakePage extends PageLike {
  readonly goneTo: string[];
  readonly pdfCalls: PdfPrintOptions[];
  readonly shotCalls: PngShotOptions[];
  readonly viewports: ViewportSpec[];
}

/** Half-resolution fixture: only half of width or height is given, to verify the post-screenshot scale cross-check. */
const halfShotOf = (
  mode: FakePageOptions["png"],
  width: number,
  height: number,
): { readonly width: number; readonly height: number } =>
  mode === "half-width"
    ? { width: Math.round(width / 2), height }
    : { width, height: Math.round(height / 2) };

const shotBytesOf = (
  options: PngShotOptions,
  viewport: ViewportSpec,
  mode: FakePageOptions["png"],
): Uint8Array => {
  if (mode === "not-png") return Buffer.from("GIF89a");
  const deviceWidth = options.clip.width * options.clip.scale * viewport.deviceScaleFactor;
  const deviceHeight = options.clip.height * options.clip.scale * viewport.deviceScaleFactor;
  if (mode === "half-width" || mode === "half-height") {
    const half = halfShotOf(mode, deviceWidth, deviceHeight);
    return pngOf(half.width, half.height);
  }
  return pngOf(deviceWidth, deviceHeight);
};

const gotoOf = (goneTo: string[], mode: FakePageOptions["goto"]): PageLike["goto"] => {
  return (url) => {
    goneTo.push(url);
    if (mode === "hang") return HANG;
    if (mode === "error")
      return Promise.reject(new HrError("chrome_failed", "Page.navigate 失败：navigate boom"));
    return Promise.resolve();
  };
};

const pdfCallOf = (pdfCalls: PdfPrintOptions[], options: FakePageOptions): PageLike["pdf"] => {
  return (params) => {
    pdfCalls.push(params);
    if (options.pdf === "hang") return HANG;
    if (options.pdf === "error") {
      return Promise.reject(new HrError("chrome_failed", "Page.printToPDF 失败：printToPDF boom"));
    }
    return Promise.resolve(Buffer.from(pdfOf(options.pages ?? 2)));
  };
};

const shotCallOf = (
  shotCalls: PngShotOptions[],
  viewports: ViewportSpec[],
  options: FakePageOptions,
): PageLike["screenshot"] => {
  return (params) => {
    shotCalls.push(params);
    const mode = options.png ?? "ok";
    if (mode === "hang") return HANG;
    if (mode === "error") {
      return Promise.reject(
        new HrError("chrome_failed", "Page.captureScreenshot 失败：captureScreenshot boom"),
      );
    }
    const viewport = viewports.at(-1) ?? { width: 0, height: 0, deviceScaleFactor: 1 };
    return Promise.resolve(shotBytesOf(params, viewport, mode));
  };
};

const metricsOf = (mode: FakePageOptions["contentHeight"]): PageLike["metrics"] => {
  return () => {
    if (mode === "hang") return HANG;
    if (mode === "none") return Promise.resolve({});
    return Promise.resolve({ cssContentSize: { width: 800, height: mode ?? 900 } });
  };
};

/** Fake `PageLike`: records every call; replies follow the `options` failure modes. */
export const fakePageOf = (options: FakePageOptions = {}): FakePage => {
  const goneTo: string[] = [];
  const pdfCalls: PdfPrintOptions[] = [];
  const shotCalls: PngShotOptions[] = [];
  const viewports: ViewportSpec[] = [];
  return {
    goneTo,
    pdfCalls,
    shotCalls,
    viewports,
    goto: gotoOf(goneTo, options.goto),
    pdf: pdfCallOf(pdfCalls, options),
    screenshot: shotCallOf(shotCalls, viewports, options),
    setViewport: (viewport) => {
      viewports.push(viewport);
      return Promise.resolve();
    },
    metrics: metricsOf(options.contentHeight),
  };
};

export interface FakeBrowser extends BrowserLike {
  readonly disconnected: { count: number };
}

export const fakeBrowserOf = (page: PageLike): FakeBrowser => {
  const disconnected = { count: 0 };
  return {
    disconnected,
    newPage: () => Promise.resolve(page),
    disconnect: () => {
      disconnected.count += 1;
    },
  };
};

export interface DepsInput {
  readonly chrome: ChromeProcess;
  readonly dirs: string[];
  readonly connect: (url: string) => Promise<BrowserLike>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => boolean;
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
