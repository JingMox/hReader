import { existsSync } from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { renderPdfOf, renderPngOf } from "../src/chrome/session";
import { depsWithOf, fakeBrowserOf, fakeChromeOf, fakePageOf } from "./chrome-helpers";
import {
  DEVTOOLS_LINE,
  inputOf,
  NEVER,
  renderSetupOf,
  type SessionSetup,
} from "./chrome-session-setup";

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("expected an HrError to be thrown");
};

const sleepOf = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Bounded condition wait: rendering/signal escalation all lands on observable fakes — wait on state, not milliseconds. */
const until = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!ready() && Date.now() < deadline) {
    await sleepOf(1);
  }
  if (!ready()) throw new Error(`timed out waiting for "${what}"`);
};

const renderWithOf = (setup: SessionSetup, timeoutMs = 1000): Promise<Uint8Array> =>
  renderPdfOf(inputOf(setup.deps, { html: "<p>hi</p>", timeoutMs })).then((result) => result.bytes);

const connectToPageOf =
  (options = {}) =>
  () =>
    Promise.resolve(fakeBrowserOf(fakePageOf(options)));

describe("renderPdfOf · chrome_missing", () => {
  it("should report chrome_missing directly when HREADER_CHROME does not exist", async () => {
    const dirs: string[] = [];
    const deps = depsWithOf({
      chrome: fakeChromeOf().chrome,
      dirs,
      connect: connectToPageOf(),
      env: { HREADER_CHROME: "/nope/chrome" },
      exists: () => false,
    });
    const error = await failureOf(renderPdfOf(inputOf(deps)));
    expect(error.code).toBe("chrome_missing");
    expect(error.message).toContain("HREADER_CHROME=/nope/chrome 不存在");
    expect(dirs).toEqual([]);
  });

  it("should say it is unset when there is no HREADER_CHROME", async () => {
    const deps = depsWithOf({
      chrome: fakeChromeOf().chrome,
      dirs: [],
      connect: connectToPageOf(),
      env: {},
      exists: () => false,
    });
    const error = await failureOf(renderPdfOf(inputOf(deps)));
    expect(error.code).toBe("chrome_missing");
    expect(error.message).toContain("未设置 HREADER_CHROME");
  });
});

describe("renderPdfOf · system Chrome candidates", () => {
  it("should look for system Chrome at candidate paths when HREADER_CHROME is not given", async () => {
    const fake = fakeChromeOf();
    let spawns = 0;
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs: [],
      connect: connectToPageOf({ pages: 2 }),
      env: {},
      exists: (path) => path === "/usr/bin/chromium",
      onSpawn: () => {
        spawns += 1;
      },
    });
    const pending = renderPdfOf(inputOf(deps));
    fake.stderr(DEVTOOLS_LINE);
    await pending;
    expect(spawns).toBe(1);
  });
});

describe("renderPdfOf · startup failure", () => {
  it("should not fall back to an installed Chrome when HREADER_CHROME is wrong", async () => {
    const fake = fakeChromeOf();
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs: [],
      connect: connectToPageOf(),
      env: { HREADER_CHROME: "/nope/chrome" },
      exists: (path) => path === "/usr/bin/google-chrome",
    });
    const error = await failureOf(renderPdfOf(inputOf(deps, { html: "<p>x</p>" })));
    expect(error.code).toBe("chrome_missing");
    expect(fake.signals).toEqual([]);
  });

  it("should report chrome_failed and clean the temp dir on startup failure", async () => {
    const fake = fakeChromeOf();
    const dirs: string[] = [];
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs,
      connect: connectToPageOf(),
      spawnError: "spawn EACCES",
    });
    const error = await failureOf(renderPdfOf(inputOf(deps)));
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toContain("启动 Chrome 失败：spawn EACCES");
    expect(dirs.length).toBe(1);
    expect(existsSync(dirs[0] ?? "")).toBe(false);
  });
});

describe("renderPdfOf · DevTools endpoint", () => {
  it("should carry the first stderr line when Chrome exits early", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    setup.fake.stderr("fatal: no display\nsecond\n");
    setup.fake.exit(1);
    const error = await failureOf(pending);
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toContain("Chrome 提前退出（code 1）：fatal: no display");
    expect(error.message).not.toContain("second");
  });

  it("should map a Chrome startup error event to chrome_failed", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    setup.fake.fail("ENOENT");
    const error = await failureOf(pending);
    expect(error.message).toContain("Chrome 启动失败：ENOENT");
  });
});

describe("renderPdfOf · connect failure", () => {
  it("should pass the error through verbatim and still collect the temp dir when connect refuses", async () => {
    const dirs: string[] = [];
    const fake = fakeChromeOf();
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs,
      connect: () => Promise.reject(new HrError("chrome_failed", "连接 Chrome 失败：refused")),
    });
    const pending = renderPdfOf(inputOf(deps));
    fake.stderr(DEVTOOLS_LINE);
    const error = await failureOf(pending);
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toContain("连接 Chrome 失败");
    expect(existsSync(dirs[0] ?? "")).toBe(false);
  });
});

describe("renderPdfOf · timeout", () => {
  it("should report render_timeout and escalate to SIGKILL after the timeout", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup, 30);
    const error = await failureOf(pending);
    expect(error.code).toBe("render_timeout");
    expect(error.message).toContain("渲染超时（0s）");
    await until(() => setup.fake.signals.length === 2, "SIGKILL 升级");
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(setup.dirs.every((dir) => existsSync(dir))).toBe(false);
  });
});

describe("renderPdfOf · success path", () => {
  it("should connect directly to the ws endpoint in the DevTools line and clean the temp dir", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    // Feed stderr in two segments: covers the "buffer has not gathered a whole line yet" branch.
    setup.fake.stderr("booting\nDevTools listening on ");
    setup.fake.stderr("ws://127.0.0.1:9222/devtools/browser/fake\n");
    const bytes = await pending;
    expect(bytes.length).toBeGreaterThan(0);
    expect(setup.spawnedArgs[0] ?? []).toContain("--headless=new");
    expect(setup.spawnedArgs[0]?.some((arg) => arg.startsWith("--user-data-dir="))).toBe(true);
    const dir = setup.dirs[0] ?? "";
    expect(setup.spawnedArgs[0] ?? []).toContain(`--user-data-dir=${join(dir, "profile")}`);
    expect(existsSync(dir)).toBe(false);
    await until(() => setup.fake.signals.length === 2, "SIGKILL 升级");
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("renderPdfOf · interruption", () => {
  it("should report chrome_failed the moment stop fires and still collect the process group and temp dir", async () => {
    const setup = renderSetupOf({ pdf: "hang" });
    let stop: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const pending = renderPdfOf(inputOf(setup.deps, { html: "<p>x</p>", stop: stopping }));
    setup.fake.stderr(DEVTOOLS_LINE);
    // Wait until rendering really reaches page.pdf (the hang mode records the call then never returns) before stop —
    // otherwise stop may land before spawn/connect, and what gets aborted is not the "mid-render" path at all.
    await until(() => setup.page.pdfCalls.length > 0, "渲染开始");
    stop();
    const error = await failureOf(pending);
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toContain("渲染被中断");
    await until(() => setup.fake.signals.length === 2, "SIGKILL 升级");
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(setup.dirs[0] ?? "")).toBe(false);
  });
});

describe("renderPngOf · long image path", () => {
  it("should return IHDR dimensions for the long image on success and collect the process group and temp dir", async () => {
    const setup = renderSetupOf({ contentHeight: 900 });
    const pending = renderPngOf({
      html: "<p>x</p>",
      width: 800,
      scale: 2,
      maxHeight: 20_000,
      timeoutMs: 1000,
      stop: NEVER,
      deps: setup.deps,
    });
    setup.fake.stderr(DEVTOOLS_LINE);
    const image = await pending;
    expect([image.width, image.height, image.clipped]).toEqual([1600, 1800, false]);
    expect(existsSync(setup.dirs[0] ?? "")).toBe(false);
    await until(() => setup.fake.signals.length === 2, "SIGKILL 升级");
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("should pass the error through and collect the temp dir when rendering fails", async () => {
    const setup = renderSetupOf({ png: "not-png" });
    const pending = renderPngOf({
      html: "<p>x</p>",
      width: 800,
      scale: 1,
      maxHeight: 20_000,
      timeoutMs: 1000,
      stop: NEVER,
      deps: setup.deps,
    });
    setup.fake.stderr(DEVTOOLS_LINE);
    const error = await failureOf(pending);
    expect(error.code).toBe("render_empty");
    expect(existsSync(setup.dirs[0] ?? "")).toBe(false);
  });
});

describe("renderPdfOf · late-bound browser", () => {
  it("should disconnect a browser that only connects after the timeout won the race", async () => {
    const fake = fakeChromeOf();
    const dirs: string[] = [];
    const browser = fakeBrowserOf(fakePageOf({}));
    let release: () => void = () => undefined;
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs,
      connect: () =>
        new Promise((resolve) => {
          release = () => {
            resolve(browser);
          };
        }),
    });
    const pending = renderPdfOf(inputOf(deps, { timeoutMs: 20 }));
    fake.stderr(DEVTOOLS_LINE);
    const error = await failureOf(pending);
    expect(error.code).toBe("render_timeout");
    release();
    await until(() => browser.disconnected.count === 1, "迟到的 browser 被 disconnect");
    expect(browser.disconnected.count).toBe(1);
  });
});
