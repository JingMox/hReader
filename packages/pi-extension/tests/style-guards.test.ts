// Three edge semantics of `/hr-style`: style ownership, concurrent supersede, echo sanitization and
// truncation, and the non-JSON 2xx message. All assertions land on "what the user sees in the terminal".

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
/** Terminal escape sequences (verified to clear the screen and change color; used to prove echo sanitization). */
const ESC = "\u001b[2J\u001b[31mPWNED\u001b[0m";
/** A malicious `GET /api/theme`: ESC sequences plus a newline id (the workspace directory name is untrusted input). */
const EVIL_THEMES: ScriptedReply = {
  text: JSON.stringify({ themes: ["feynman-tech", "\u001b[2J\u001b[31mPWNED\u001b[0m", "a\nb"] }),
};
/** Subscription endpoint: a resident empty stream, so `/hreader`'s reconnect loop cannot interrupt the command. */
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

/** Waits until `min` requests have gone out to `urlPart` (calls are recorded the moment fetch is issued,
 *  before the response) — this turns "the second command fires while the first is still in flight" into an
 *  observable condition instead of guessing the schedule with sleeps. */
const untilCalls = async (harness: Harness, urlPart: string, min: number): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (harness.calls.filter((call) => call.url.includes(urlPart)).length < min) {
    if (Date.now() > deadline) throw new Error(`等 ${urlPart} 第 ${String(min)} 次请求超时`);
    await sleepOf(1);
  }
};

describe("/hr-style ownership (style is a document property)", () => {
  it("should stop reporting the previous document's style in the status line after switching documents", async () => {
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

  it("should still remember a document's style after switching back (not cleared, not leaked across documents)", async () => {
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

describe("a superseded command must not touch the daemon (POST side)", () => {
  it("should not even let the superseded command POST when GET /api/theme is slow (it loses more than the result)", async () => {
    // Arrange: the first GET takes 150ms, the second 10ms (the shape of a stalling daemon).
    const harness = harnessOf({
      "/api/theme": [{ ...THEMES, waitMs: 150 }, THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    // Act: fire feynman-tech first (stuck on the scripted 150ms delay of GET /api/theme), then wait until
    // that GET has really gone out before firing atelier-editorial — "the first is in flight" is observable.
    const themeCalls = harness.calls.filter((call) => call.url.includes("/api/theme")).length;
    await Promise.all([
      harness.run("hr-style", "feynman-tech"),
      untilCalls(harness, "/api/theme", themeCalls + 1).then(() =>
        harness.run("hr-style", "atelier-editorial"),
      ),
    ]);
    // Assert: only the later command lands on the daemon; the interrupted one must not POST (or disk style and status line fork).
    expect(postsOf(harness, "/api/style").map((request) => request.body)).toEqual([
      JSON.stringify({ docId: "docs/x.html", visualId: "atelier-editorial" }),
    ]);
    await harness.run("hreader", "");
    expect(harness.notifies.at(-1)?.message).toContain("，风格 atelier-editorial");
  });
});

describe("/hr-style concurrency (the latest command wins)", () => {
  it("should not let an earlier slow reply overwrite the later result, and the dropped one must not change state", async () => {
    // Arrange: the first POST's body arrives 150ms late, the second takes 10ms.
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [
        { ...STYLED, waitMs: 150 },
        { ...STYLED, waitMs: 10 },
      ],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    // The second fires while the first's POST /api/style is still unsettled:
    // a POST in calls proves the first already reached the write stage (its reply still held 150ms).
    const styleCalls = harness.calls.filter((call) => call.url.includes("/api/style")).length;
    await Promise.all([
      harness.run("hr-style", "feynman-tech"),
      untilCalls(harness, "/api/style", styleCalls + 1).then(() =>
        harness.run("hr-style", "atelier-editorial"),
      ),
    ]);
    await harness.run("hreader", "");
    // Assert: both really POSTed (the second did not swallow the first).
    expect(postsOf(harness, "/api/style").map((request) => request.body)).toEqual([
      JSON.stringify({ docId: "docs/x.html", visualId: "feynman-tech" }),
      JSON.stringify({ docId: "docs/x.html", visualId: "atelier-editorial" }),
    ]);
    // The final state is the later command's; the earlier slow reply neither notified nor wrote state.
    expect(harness.notifies.at(-1)?.message).toContain("，风格 atelier-editorial");
    expect(harness.notifies.map((entry) => entry.message).join("\n")).not.toContain(
      "换成 feynman-tech",
    );
  });
});

describe("echo sanitization and truncation (workspace is untrusted)", () => {
  it("should not let control characters in a visual id reach the list, the echo, or the status line verbatim", async () => {
    const harness = harnessOf({
      // Ids come from workspace directory names — untrusted input: ESC sequences and newlines verifiably reach the terminal.
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

  it("should also sanitize the post-switch echo and the status line", async () => {
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

describe("echo length bound (4KB long id)", () => {
  it("should also sanitize an illegal id's echo (pasted ESC must not reach the terminal verbatim)", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", `${ESC}-nope`);
    const message = harness.notifies[0]?.message ?? "";
    expect(message).not.toContain("\u001b");
    expect(message).toContain("?[2J?[31mPWNED?[0m-nope");
    // The candidate list stays complete (only the echoed segment is sanitized and capped).
    expect(message).toContain("可选风格：feynman-tech、atelier-editorial");
  });

  it("should cap a long illegal id's echo alone at 120 (the list is not squeezed out by NOTIFY_MAX)", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", `${"y".repeat(400)}-nope`);
    const message = harness.notifies[0]?.message ?? "";
    // ① The echo segment is capped by ECHO_MAX: the whole notify is far under NOTIFY_MAX (400); exact length unpinned.
    expect(message.length).toBeLessThan(200);
    expect(message).toContain("… 的风格");
    // ② The candidate list is complete — had ECHO_MAX been 400, the list would be clipped away by NOTIFY_MAX.
    expect(message).toContain("可选风格：feynman-tech、atelier-editorial");
  });

  it("should keep a 4KB-long-id notify within 400 chars (not inflated into a screen-filling blob)", async () => {
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

describe("message for a non-JSON 2xx", () => {
  it('should not say "200: unknown error" when `GET /api/theme` returns non-JSON 200', async () => {
    const harness = harnessOf({ "/api/theme": [{ text: "<html>oops</html>" }] });
    await harness.run("hr-style", "feynman-tech");
    const message = harness.notifies[0]?.message ?? "";
    expect(harness.notifies[0]?.type).toBe("error");
    expect(message).toContain("响应不是 JSON");
    expect(message).not.toContain("未知错误");
    expect(postsOf(harness, "/api/style")).toHaveLength(0);
  });
});
