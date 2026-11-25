// `renderPdfOf` / `renderPngOf` 共用的进程内装配：假进程 + 假浏览器，目录/进程组可观察。
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

/** 进程内测试的停止口：永不 resolve，等价于"没人按 Ctrl-C"。 */
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

/** `renderPdfOf` 的默认入参：只关心个别字段的用例靠 `overrides` 改（`outline` 缺省开）。 */
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
