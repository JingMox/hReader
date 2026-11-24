// 这层管 `/hr-style` 的三条边角语义：风格归属、并发取代、回显净化与截断、
// 以及 2xx 非 JSON 的文案。断言都落在"用户终端上看得见什么"上。

import { describe, expect, it } from "vitest";

import { hreaderExtensionOf, type HreaderRequest } from "../pi-hreader.ts";
import { daemonJsonOf, fakeContextOf, fakeDepsOf, fakePiOf, runCommandOf } from "./fakes.ts";
import { routedFetchOf, type ScriptedReply } from "./sse-fakes.ts";

const DAEMON = daemonJsonOf({ port: 7331, token: "tok-1", workspace: "/work" });
const THEMES: ScriptedReply = {
  text: JSON.stringify({ themes: ["feynman-tech", "atelier-editorial"] }),
};
const STYLED: ScriptedReply = {
  text: JSON.stringify({ changed: true, revision: 3, changedNodes: [] }),
};
/** 终端逃逸序列（实测能清屏并改色，用来验证回显净化）。 */
const ESC = "\u001b[2J\u001b[31mPWNED\u001b[0m";
/** `GET /api/theme` 的恶意版本：ESC 序列 + 换行 id（workspace 目录名是不可信输入）。 */
const EVIL_THEMES: ScriptedReply = {
  text: JSON.stringify({ themes: ["feynman-tech", "\u001b[2J\u001b[31mPWNED\u001b[0m", "a\nb"] }),
};
/** 订阅端点：常驻空流，免得 `/hreader` 的重连循环打断命令。 */
const EVENTS: ScriptedReply = { chunks: [], keepOpen: true };

interface Harness {
  readonly run: (name: string, args: string) => Promise<void>;
  readonly notifies: readonly { readonly message: string; readonly type: string | undefined }[];
  readonly calls: readonly { url: string; request: HreaderRequest }[];
}

const harnessOf = (
  routes: Readonly<Record<string, readonly ScriptedReply[]>>,
  options: { readonly daemon?: string } = {},
): Harness => {
  const routed = routedFetchOf(routes);
  const { deps } = fakeDepsOf({
    home: "/home/u",
    fetch: routed.fetch,
    daemon: options.daemon ?? DAEMON,
  });
  const fake = fakePiOf();
  hreaderExtensionOf(deps)(fake.pi);
  const context = fakeContextOf();
  return {
    run: (name, args) => runCommandOf(fake, name, args, context.ctx),
    notifies: context.notifies,
    calls: routed.calls,
  };
};

const postsOf = (harness: Harness, urlPart: string): readonly HreaderRequest[] =>
  harness.calls.filter((call) => call.url.includes(urlPart)).map((call) => call.request);

const sleepOf = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

describe("/hr-style 的归属（风格是文档属性）", () => {
  it("换到另一个文档后，状态行不再报上一个文档的风格", async () => {
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/a.html");
    await harness.run("hr-style", "feynman-tech");
    await harness.run("hreader", "docs/b.html");
    await harness.run("hreader", "");
    const status = harness.notifies.at(-1)?.message ?? "";
    expect(status).toContain("workspace /work");
    expect(status).not.toContain("风格");
  });

  it("换回原来的文档时仍记得它的风格（不清空，也不跨文档串味）", async () => {
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/a.html");
    await harness.run("hr-style", "feynman-tech");
    await harness.run("hreader", "docs/b.html");
    await harness.run("hreader", "docs/a.html");
    await harness.run("hreader", "");
    expect(harness.notifies.at(-1)?.message).toContain("，风格 feynman-tech");
  });
});

describe("被取代的命令不得动 daemon（POST 侧）", () => {
  it("GET /api/theme 慢时，被取代的那条命令连 POST 都不发（不只丢结果）", async () => {
    // Arrange：第一次 GET 慢 150ms，第二次 10ms（daemon 卡一下就是这个形状）。
    const harness = harnessOf({
      "/api/theme": [{ ...THEMES, waitMs: 150 }, THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    // Act：先发 feynman-tech（卡在 GET），5ms 后发 atelier-editorial。
    await Promise.all([
      harness.run("hr-style", "feynman-tech"),
      sleepOf(5).then(() => harness.run("hr-style", "atelier-editorial")),
    ]);
    // Assert：只有后发那条落在 daemon 上；被打断的那条不得发 POST（否则盘上风格与状态行分叉）。
    expect(postsOf(harness, "/api/style").map((request) => request.body)).toEqual([
      JSON.stringify({ docId: "docs/x.html", visualId: "atelier-editorial" }),
    ]);
    await harness.run("hreader", "");
    expect(harness.notifies.at(-1)?.message).toContain("，风格 atelier-editorial");
  });
});

describe("/hr-style 的并发（后发起的命令赢）", () => {
  it("后一次的结果不被前一次的慢响覆盖，被丢弃的那次也不改状态", async () => {
    // Arrange：第一条 POST 的 body 晚 150ms 才到，第二条 10ms。
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [
        { ...STYLED, waitMs: 150 },
        { ...STYLED, waitMs: 10 },
      ],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    await Promise.all([
      harness.run("hr-style", "feynman-tech"),
      // 第二条在第一条还没 settle 时发出。
      sleepOf(5).then(() => harness.run("hr-style", "atelier-editorial")),
    ]);
    await harness.run("hreader", "");
    // Assert：两次都真发了 POST（不是"第二次吞掉第一次"）。
    expect(postsOf(harness, "/api/style").map((request) => request.body)).toEqual([
      JSON.stringify({ docId: "docs/x.html", visualId: "feynman-tech" }),
      JSON.stringify({ docId: "docs/x.html", visualId: "atelier-editorial" }),
    ]);
    // 最终状态是后发那条；先发的慢响既没 notify 也没写状态。
    expect(harness.notifies.at(-1)?.message).toContain("，风格 atelier-editorial");
    expect(harness.notifies.map((entry) => entry.message).join("\n")).not.toContain(
      "换成 feynman-tech",
    );
  });
});

describe("回显净化与截断（workspace 不可信）", () => {
  it("视觉 id 里的控制字符不原样进入列表、回显与状态行", async () => {
    const harness = harnessOf({
      // id 来自 workspace 目录名 → 不可信输入：ESC 序列、换行、都实测能进终端。
      "/api/theme": [EVIL_THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hr-style", "");
    const listed = harness.notifies[0]?.message ?? "";
    expect(listed).not.toContain("\u001b");
    expect(listed).toContain("?[2J?[31mPWNED?[0m");
    expect(listed).toContain("a?b");
  });

  it("换完风格的回显与状态行同样净化", async () => {
    const harness = harnessOf({
      "/api/theme": [EVIL_THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    await harness.run("hr-style", ESC);
    expect(harness.notifies.at(-1)?.message).not.toContain("\u001b");
    await harness.run("hreader", "");
    const status = harness.notifies.at(-1)?.message ?? "";
    expect(status).not.toContain("\u001b");
    expect(status).toContain("?[2J?[31mPWNED?[0m");
  });
});

describe("回显长度上界（4KB 长 id）", () => {
  it("非法 id 的回显同样净化（用户粘进来的 ESC 不得原样进终端）", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", `${ESC}-nope`);
    const message = harness.notifies[0]?.message ?? "";
    expect(message).not.toContain("\u001b");
    expect(message).toContain("?[2J?[31mPWNED?[0m-nope");
    // 可选列表仍完整在（净化+限长的只是回显的那一段）。
    expect(message).toContain("可选风格：feynman-tech、atelier-editorial");
  });

  it("非法 id 很长时回显被单独限到 120 以内（列表不被 NOTIFY_MAX 挤掉）", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", `${"y".repeat(400)}-nope`);
    const message = harness.notifies[0]?.message ?? "";
    // ① 回显段被 ECHO_MAX 截住：整条 notify 远小于 NOTIFY_MAX（400），不写死具体长度。
    expect(message.length).toBeLessThan(200);
    expect(message).toContain("… 的风格");
    // ② 可选列表完整在——若把 ECHO_MAX 放到 400，列表会被 NOTIFY_MAX 整条截掉。
    expect(message).toContain("可选风格：feynman-tech、atelier-editorial");
  });

  it("4KB 长 id 的 notify 不超过 400 字符（不撑成几千字符满屏）", async () => {
    const longId = "x".repeat(4096);
    const harness = harnessOf({
      "/api/theme": [{ text: JSON.stringify({ themes: [longId] }) }],
      "/api/style": [STYLED],
    });
    await harness.run("hr-style", "");
    const listed = harness.notifies[0]?.message ?? "";
    expect(listed.length).toBeLessThanOrEqual(400);
    expect(listed.endsWith("…")).toBe(true);
  });
});

describe("2xx 但响应不是 JSON 的文案", () => {
  it("`GET /api/theme` 返回 200 但不是 JSON：不说“返回 200：未知错误”", async () => {
    const harness = harnessOf({ "/api/theme": [{ text: "<html>oops</html>" }] });
    await harness.run("hr-style", "feynman-tech");
    const message = harness.notifies[0]?.message ?? "";
    expect(harness.notifies[0]?.type).toBe("error");
    expect(message).toContain("响应不是 JSON");
    expect(message).not.toContain("未知错误");
    expect(postsOf(harness, "/api/style")).toHaveLength(0);
  });
});
