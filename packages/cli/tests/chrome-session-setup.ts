// In-process assembly shared by `renderPdfOf` / `renderPngOf`: fake process + fake browser, observable dirs/process groups.
import type { renderPdfOf } from "../src/chrome/session";

import {
  depsWithOf,
  fakeBrowserOf,
  fakeChromeOf,
  fakePageOf,
  type FakeBrowser,
  type FakeChrome,
  type FakePage,
  type FakePageOptions,
} from "./chrome-helpers";

/** The stop signal for in-process tests: never resolves, equivalent to "nobody pressed Ctrl-C". */
export const NEVER: Promise<void> = new Promise<void>(() => undefined);

export const DEVTOOLS_LINE = "DevTools listening on ws://127.0.0.1:9222/devtools/browser/fake\n";

export interface SessionSetup {
  readonly fake: FakeChrome;
  readonly browser: FakeBrowser;
  readonly page: FakePage;
  readonly dirs: string[];
  readonly spawnedArgs: string[][];
  readonly deps: ReturnType<typeof depsWithOf>;
}

export const renderSetupOf = (options: FakePageOptions = { pages: 2 }): SessionSetup => {
  const fake = fakeChromeOf();
  const page = fakePageOf(options);
  const browser = fakeBrowserOf(page);
  const dirs: string[] = [];
  const spawnedArgs: string[][] = [];
  const deps = depsWithOf({
    chrome: fake.chrome,
    dirs,
    connect: () => Promise.resolve(browser),
    env: { HREADER_CHROME: "/fake/chrome" },
    onSpawn: (args) => {
      spawnedArgs.push([...args]);
    },
  });
  return { fake, browser, page, dirs, spawnedArgs, deps };
};

type PdfInput = Parameters<typeof renderPdfOf>[0];

/** Default inputs for `renderPdfOf`: cases that care about a few fields change them via `overrides` (`outline` defaults on). */
export const inputOf = (deps: PdfInput["deps"], overrides: Partial<PdfInput> = {}): PdfInput => ({
  html: "x",
  pageSize: "a4",
  outline: true,
  preferCSSPageSize: false,
  stop: NEVER,
  timeoutMs: 1000,
  deps,
  ...overrides,
});
