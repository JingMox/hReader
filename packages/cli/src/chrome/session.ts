// This layer: one render lifecycle (spawn -> render vs timeout vs interrupt -> reap the process group and temp dir) and
// assembling the production `ChromeDeps`; page-level sequences live in `render.ts`, process supervision in `process.ts`.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HrError } from "@hreader/core";

import { browserOf, type BrowserLike } from "./browser";
import { deadlineOf } from "./deadline";
import {
  chromeProcessOf,
  devtoolsUrlOf,
  startChromeOf,
  stopChromeOf,
  type ChromeDeps,
  type ChromeRun,
} from "./process";
import { renderPdfOnBrowserOf, renderPngOnBrowserOf } from "./render";
import type { LongImage, PdfPageSize } from "./types";

const KILL_GRACE_MS = 2000;

export const chromeDepsOf = (env: Readonly<Record<string, string | undefined>>): ChromeDeps => ({
  env,
  exists: existsSync,
  spawn: (file, args, options) => chromeProcessOf(spawn(file, [...args], options)),
  connect: browserOf,
  tempDir: () => mkdtempSync(join(tmpdir(), "hr-chrome-")),
  remove: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  killGraceMs: KILL_GRACE_MS,
});

/** Shared stop handle for render commands: `run.ts` passes `io.stop`; in-process tests pass a never-settling promise. */
interface ChromeRenderInput {
  readonly html: string;
  readonly timeoutMs: number;
  /** Required: `main.ts` already suppresses the default signal behavior, so without this nothing can interrupt (Ctrl-C would wait out `--timeout`). */
  readonly stop: Promise<void>;
  readonly deps: ChromeDeps;
}

interface RenderPdfInput extends ChromeRenderInput {
  readonly pageSize: PdfPageSize;
  readonly outline: boolean;
  readonly preferCSSPageSize: boolean;
}

interface RenderPngInput extends ChromeRenderInput {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
}

const connectBrowserOf = async (deps: ChromeDeps, run: ChromeRun): Promise<BrowserLike> => {
  const browser = await deps.connect(await devtoolsUrlOf(run));
  run.browser = browser;
  // Timeout/interrupt won while connect was still pending: nobody will close that connection later, so disconnect it on the spot.
  if (run.stopped) browser.disconnect();
  return browser;
};

const sessionPdfOf = async (input: RenderPdfInput, run: ChromeRun): Promise<Uint8Array> =>
  renderPdfOnBrowserOf({
    browser: await connectBrowserOf(input.deps, run),
    html: input.html,
    dir: run.dir,
    pageSize: input.pageSize,
    outline: input.outline,
    preferCSSPageSize: input.preferCSSPageSize,
  });

const sessionPngOf = async (input: RenderPngInput, run: ChromeRun): Promise<LongImage> =>
  renderPngOnBrowserOf({
    browser: await connectBrowserOf(input.deps, run),
    html: input.html,
    dir: run.dir,
    width: input.width,
    scale: input.scale,
    maxHeight: input.maxHeight,
  });

/** `stop` only resolves: turning it into a "stop here" rejection lets `Promise.race` abandon a still-running render. */
const interruptOf = (stop: Promise<void>): Promise<never> =>
  stop.then((): never => {
    throw new HrError("chrome_failed", "渲染被中断（收到 SIGINT/SIGTERM）");
  });

const overChromeOf = async <T>(
  input: ChromeRenderInput,
  render: (run: ChromeRun) => Promise<T>,
): Promise<T> => {
  const run = startChromeOf(input.deps);
  const deadline = deadlineOf(input.timeoutMs);
  try {
    const rendering = render(run);
    // After the race is lost nobody awaits this chain: attach a no-op handler so its failure cannot become an unhandled rejection.
    void rendering.catch(() => undefined);
    return await Promise.race([rendering, deadline.expired, interruptOf(input.stop)]);
  } finally {
    deadline.cancel();
    await stopChromeOf(run, input.deps);
  }
};

export const renderPdfOf = async (input: RenderPdfInput): Promise<{ bytes: Uint8Array }> => ({
  bytes: await overChromeOf(input, (run) => sessionPdfOf(input, run)),
});

export const renderPngOf = (input: RenderPngInput): Promise<LongImage> =>
  overChromeOf(input, (run) => sessionPngOf(input, run));
