// `renderPdfOf` / `renderPngOf` 共用的进程内装配：假进程 + 假传输 + 假版本端点，目录/进程组可观察。
import type { renderPdfOf } from "../src/chrome/session";
import {
  depsWithOf,
  fakeChromeOf,
  responderOf,
  VERSION_TEXT,
  type FakeChrome,
  type ResponderOptions,
} from "./chrome-helpers";

/** 进程内测试的停止口：永不 resolve，等价于"没人按 Ctrl-C"。 */
export const NEVER: Promise<void> = new Promise<void>(() => undefined);

export const DEVTOOLS_LINE = "DevTools listening on ws://127.0.0.1:9222/devtools/browser/fake\n";

export interface SessionSetup {
  readonly fake: FakeChrome;
  readonly dirs: string[];
  readonly spawnedArgs: string[][];
  readonly requestedUrls: string[];
  readonly responder: ReturnType<typeof responderOf>;
  readonly deps: ReturnType<typeof depsWithOf>;
}

export const renderSetupOf = (options: ResponderOptions = { pages: 2 }): SessionSetup => {
  const fake = fakeChromeOf();
  const responder = responderOf(options);
  const dirs: string[] = [];
  const spawnedArgs: string[][] = [];
  const requestedUrls: string[] = [];
  const deps = depsWithOf({
    chrome: fake.chrome,
    dirs,
    connect: () => responder.transport,
    fetchText: (url) => {
      requestedUrls.push(url);
      return Promise.resolve(VERSION_TEXT);
    },
    env: { HREADER_CHROME: "/fake/chrome" },
    onSpawn: (args) => {
      spawnedArgs.push([...args]);
    },
  });
  return { fake, dirs, spawnedArgs, requestedUrls, responder, deps };
};

type PdfInput = Parameters<typeof renderPdfOf>[0];

/** `renderPdfOf` 的默认入参：只关心个别字段的用例靠 `overrides` 改（`outline` 缺省开）。 */
export const inputOf = (deps: PdfInput["deps"], overrides: Partial<PdfInput> = {}): PdfInput => ({
  html: "x",
  pageSize: "a4",
  outline: true,
  stop: NEVER,
  timeoutMs: 1000,
  deps,
  ...overrides,
});
