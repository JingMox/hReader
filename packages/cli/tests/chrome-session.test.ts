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
  throw new Error("预期抛出 HrError");
};

const sleepOf = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const renderWithOf = (setup: SessionSetup, timeoutMs = 1000): Promise<Uint8Array> =>
  renderPdfOf(inputOf(setup.deps, { html: "<p>hi</p>", timeoutMs })).then((result) => result.bytes);

const connectToPageOf =
  (options = {}) =>
  () =>
    Promise.resolve(fakeBrowserOf(fakePageOf(options)));

describe("renderPdfOf · chrome_missing", () => {
  it("HREADER_CHROME 不存在时直接报 chrome_missing", async () => {
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

  it("没有 HREADER_CHROME 时提示未设置", async () => {
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

describe("renderPdfOf · 系统 Chrome 候选", () => {
  it("没给 HREADER_CHROME 时按候选路径找系统 Chrome", async () => {
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

describe("renderPdfOf · 启动失败", () => {
  it("HREADER_CHROME 写错时不回落到系统装的 Chrome", async () => {
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

  it("启动失败时报 chrome_failed 并清掉临时目录", async () => {
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

describe("renderPdfOf · DevTools 端点", () => {
  it("Chrome 提前退出时带 stderr 首行", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    setup.fake.stderr("fatal: no display\nsecond\n");
    setup.fake.exit(1);
    const error = await failureOf(pending);
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toContain("Chrome 提前退出（code 1）：fatal: no display");
    expect(error.message).not.toContain("second");
  });

  it("Chrome 启动 error 事件映射成 chrome_failed", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    setup.fake.fail("ENOENT");
    const error = await failureOf(pending);
    expect(error.message).toContain("Chrome 启动失败：ENOENT");
  });
});

describe("renderPdfOf · connect 失败", () => {
  it("connect 拒绝时错误原样透出、临时目录照收", async () => {
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

describe("renderPdfOf · 超时", () => {
  it("超时后报 render_timeout 并升级到 SIGKILL", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup, 30);
    const error = await failureOf(pending);
    expect(error.code).toBe("render_timeout");
    expect(error.message).toContain("渲染超时（0s）");
    await sleepOf(40);
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(setup.dirs.every((dir) => existsSync(dir))).toBe(false);
  });
});

describe("renderPdfOf · 成功路径", () => {
  it("按 DevTools 行里的 ws 端点直连，并清掉临时目录", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    // 分两段喂 stderr：覆盖“缓冲区还没凑齐整行”的分支。
    setup.fake.stderr("booting\nDevTools listening on ");
    setup.fake.stderr("ws://127.0.0.1:9222/devtools/browser/fake\n");
    const bytes = await pending;
    expect(bytes.length).toBeGreaterThan(0);
    expect(setup.spawnedArgs[0] ?? []).toContain("--headless=new");
    expect(setup.spawnedArgs[0]?.some((arg) => arg.startsWith("--user-data-dir="))).toBe(true);
    const dir = setup.dirs[0] ?? "";
    expect(setup.spawnedArgs[0] ?? []).toContain(`--user-data-dir=${join(dir, "profile")}`);
    expect(existsSync(dir)).toBe(false);
    await sleepOf(20);
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("renderPdfOf · 中断", () => {
  it("stop 一到就报 chrome_failed，且照样收掉进程组与临时目录", async () => {
    const setup = renderSetupOf({ pdf: "hang" });
    let stop: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const pending = renderPdfOf(inputOf(setup.deps, { html: "<p>x</p>", stop: stopping }));
    setup.fake.stderr(DEVTOOLS_LINE);
    await sleepOf(10);
    stop();
    const error = await failureOf(pending);
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toContain("渲染被中断");
    await sleepOf(20);
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(setup.dirs[0] ?? "")).toBe(false);
  });
});

describe("renderPngOf · 长图路径", () => {
  it("成功路径：长图回传 IHDR 尺寸，进程组与临时目录照收", async () => {
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
    await sleepOf(20);
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("渲染失败时错误透出、临时目录照收", async () => {
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

describe("renderPdfOf · 晚绑定 browser", () => {
  it("超时赢下竞赛后才接上的 browser 会当场 disconnect", async () => {
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
    await sleepOf(20);
    expect(browser.disconnected.count).toBe(1);
  });
});
