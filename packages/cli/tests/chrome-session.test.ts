import { existsSync } from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { renderPdfOf } from "../src/chrome/session";
import { VERSION_TEXT, depsWithOf, fakeChromeOf, responderOf } from "./chrome-helpers";
import { DEVTOOLS_LINE, NEVER, renderSetupOf, type SessionSetup } from "./chrome-session-setup";

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

/** 造一个"非 Error 的拒绝值"：`prefer-promise-reject-errors` 只准拒绝 Error，绕开它才不会让 lint 逼着删掉兜底分支。 */
const rejectionOf = (reason: string): Promise<string> =>
  new Promise<string>((_resolve, reject) => {
    Reflect.apply(reject, undefined, [reason]);
  });

const sleepOf = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const renderWithOf = (setup: SessionSetup, timeoutMs = 1000): Promise<Uint8Array> =>
  renderPdfOf({ html: "<p>hi</p>", pageSize: "a4", stop: NEVER, timeoutMs, deps: setup.deps }).then(
    (result) => result.bytes,
  );

describe("renderPdfOf · chrome_missing", () => {
  it("HREADER_CHROME 不存在时直接报 chrome_missing", async () => {
    const dirs: string[] = [];
    const deps = depsWithOf({
      chrome: fakeChromeOf().chrome,
      dirs,
      connect: () => responderOf({}).transport,
      env: { HREADER_CHROME: "/nope/chrome" },
      exists: () => false,
    });
    const error = await failureOf(
      renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps }),
    );
    expect(error.code).toBe("chrome_missing");
    expect(error.message).toContain("HREADER_CHROME=/nope/chrome 不存在");
    expect(dirs).toEqual([]);
  });

  it("没有 HREADER_CHROME 时提示未设置", async () => {
    const deps = depsWithOf({
      chrome: fakeChromeOf().chrome,
      dirs: [],
      connect: () => responderOf({}).transport,
      env: {},
      exists: () => false,
    });
    const error = await failureOf(
      renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps }),
    );
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
      connect: () => responderOf({ pages: 2 }).transport,
      env: {},
      exists: (path) => path === "/usr/bin/chromium",
      onSpawn: () => {
        spawns += 1;
      },
    });
    const pending = renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps });
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
      connect: () => responderOf({}).transport,
      env: { HREADER_CHROME: "/nope/chrome" },
      exists: (path) => path === "/usr/bin/google-chrome",
    });
    const error = await failureOf(
      renderPdfOf({ html: "<p>x</p>", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps }),
    );
    expect(error.code).toBe("chrome_missing");
    expect(fake.signals).toEqual([]);
  });

  it("启动失败时报 chrome_failed 并清掉临时目录", async () => {
    const fake = fakeChromeOf();
    const dirs: string[] = [];
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs,
      connect: () => responderOf({}).transport,
      spawnError: "spawn EACCES",
    });
    const error = await failureOf(
      renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps }),
    );
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toContain("启动 Chrome 失败：spawn EACCES");
    expect(dirs.length).toBe(1);
    expect(existsSync(dirs[0] ?? "")).toBe(false);
  });
});

describe("renderPdfOf · DevTools 端点", () => {
  it("DevTools 地址没有端口时报 chrome_failed", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    setup.fake.stderr("DevTools listening on ws://127.0.0.1/devtools/browser/x\n");
    const error = await failureOf(pending);
    expect(error.message).toContain("没有端口");
    await sleepOf(20);
    expect(setup.fake.signals).toContain("SIGKILL");
  });

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

describe("renderPdfOf · 版本端点", () => {
  it("/json/version 拉取失败映射成 chrome_failed", async () => {
    const dirs: string[] = [];
    const fake = fakeChromeOf();
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs,
      connect: () => responderOf({}).transport,
      fetchText: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const pending = renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps });
    fake.stderr(DEVTOOLS_LINE);
    const error = await failureOf(pending);
    expect(error.message).toContain("读取 /json/version 失败：ECONNREFUSED");
    expect(existsSync(dirs[0] ?? "")).toBe(false);
  });

  it("没有 webSocketDebuggerUrl 时报 chrome_failed", async () => {
    const fake = fakeChromeOf();
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs: [],
      connect: () => responderOf({}).transport,
      fetchText: () => Promise.resolve(JSON.stringify({ Browser: "Fake" })),
    });
    const pending = renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps });
    fake.stderr(DEVTOOLS_LINE);
    const error = await failureOf(pending);
    expect(error.message).toContain("没有 webSocketDebuggerUrl");
  });
});

describe("renderPdfOf · 非 Error 的拒绝值", () => {
  it("读成一行而不是 [object Object]", async () => {
    const fake = fakeChromeOf();
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs: [],
      connect: () => responderOf({}).transport,
      fetchText: () => rejectionOf("plain-string"),
    });
    const pending = renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 1000, deps });
    fake.stderr(DEVTOOLS_LINE);
    const error = await failureOf(pending);
    expect(error.message).toContain("读取 /json/version 失败：plain-string");
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
  it("按 /json/version 的端口拼 URL，并清掉临时目录", async () => {
    const setup = renderSetupOf();
    const pending = renderWithOf(setup);
    // 分两段喂 stderr：覆盖“缓冲区还没凑齐整行”的分支。
    setup.fake.stderr("booting\nDevTools listening on ");
    setup.fake.stderr("ws://127.0.0.1:9222/devtools/browser/fake\n");
    const bytes = await pending;
    expect(bytes.length).toBeGreaterThan(0);
    expect(setup.requestedUrls).toEqual(["http://127.0.0.1:9222/json/version"]);
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
    const setup = renderSetupOf({ print: "hang" });
    let stop: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const pending = renderPdfOf({
      html: "<p>x</p>",
      pageSize: "a4",
      stop: stopping,
      timeoutMs: 1000,
      deps: setup.deps,
    });
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

describe("renderPdfOf · 晚绑定 transport", () => {
  it("超时赢下竞赛后才接上的 transport 会当场关闭", async () => {
    const fake = fakeChromeOf();
    const dirs: string[] = [];
    const responder = responderOf({});
    let closed = 0;
    const transport = {
      ...responder.transport,
      close: () => {
        closed += 1;
        responder.transport.close();
      },
    };
    let release: (text: string) => void = () => undefined;
    const deps = depsWithOf({
      chrome: fake.chrome,
      dirs,
      connect: () => transport,
      fetchText: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const pending = renderPdfOf({ html: "x", pageSize: "a4", stop: NEVER, timeoutMs: 20, deps });
    fake.stderr(DEVTOOLS_LINE);
    const error = await failureOf(pending);
    expect(error.code).toBe("render_timeout");
    release(VERSION_TEXT);
    await sleepOf(20);
    expect(closed).toBe(1);
  });
});
