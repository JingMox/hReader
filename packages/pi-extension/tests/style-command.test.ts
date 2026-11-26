// `/hr-style`: visual ids come only from `GET /api/theme` (no directory scan), an illegal id never even
// POSTs, a legal one sends a body of exactly `{ docId, visualId }` with the CSRF header, an unbound
// session only gets a hint, and the status line remembers this session's style.

import { describe, expect, it } from "vitest";

import { hreaderExtensionOf, type HreaderRequest } from "../pi-hreader.ts";
import type { ConfirmAnswer } from "./fakes.ts";
import { daemonJsonOf, fakeContextOf, fakeDepsOf, fakePiOf, runCommandOf } from "./fakes.ts";
import { routedFetchOf, type ScriptedReply } from "./sse-fakes.ts";

const DAEMON = daemonJsonOf({ port: 7331, token: "tok-1", workspace: "/work" });
const THEMES: ScriptedReply = {
  text: JSON.stringify({
    themes: ["feynman-tech", "atelier-editorial"],
    default: "atelier-editorial",
  }),
};
const STYLED: ScriptedReply = {
  text: JSON.stringify({ changed: true, revision: 3, changedNodes: [] }),
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
  options: { readonly daemon?: string; readonly confirms?: readonly ConfirmAnswer[] } = {},
): Harness => {
  const routed = routedFetchOf(routes);
  const { deps } = fakeDepsOf({
    home: "/home/u",
    fetch: routed.fetch,
    daemon: options.daemon ?? DAEMON,
  });
  const fake = fakePiOf();
  hreaderExtensionOf(deps)(fake.pi);
  const context = fakeContextOf({ confirms: options.confirms ?? [] });
  return {
    run: (name, args) => runCommandOf(fake, name, args, context.ctx),
    notifies: context.notifies,
    calls: routed.calls,
  };
};

const postsOf = (harness: Harness, urlPart: string): readonly HreaderRequest[] =>
  harness.calls.filter((call) => call.url.includes(urlPart)).map((call) => call.request);

describe("/hr-style list source", () => {
  it("should list `GET /api/theme` values verbatim on no args (no sorting, no trimming, no suffix)", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", "");
    expect(harness.notifies).toHaveLength(1);
    expect(harness.notifies[0]?.type).toBe("info");
    expect(harness.notifies[0]?.message).toBe(
      "用法：/hr-style <视觉 id>——不给 id 就列出 daemon 报的可选值\n" +
        "可选风格：feynman-tech、atelier-editorial",
    );
  });

  it("should drop empty/non-string entries of `themes` and treat a non-array as no options (never report a fake id)", async () => {
    const dirty = harnessOf({
      "/api/theme": [{ text: JSON.stringify({ themes: ["", 42, "feynman-tech"] }) }],
    });
    await dirty.run("hr-style", "");
    expect(dirty.notifies[0]?.message).toContain("可选风格：feynman-tech");
    expect(dirty.notifies[0]?.message).not.toContain("、");

    const malformed = harnessOf({ "/api/theme": [{ text: JSON.stringify({ themes: "x" }) }] });
    await malformed.run("hr-style", "");
    expect(malformed.notifies[0]?.type).toBe("error");
    expect(malformed.notifies[0]?.message).toContain("themes 为空");
  });

  it("should turn the daemon's error code into text and send no POST when `GET /api/theme` itself fails", async () => {
    const harness = harnessOf({
      "/api/theme": [
        { status: 500, text: JSON.stringify({ code: "io_failure", message: "读目录失败" }) },
      ],
    });
    await harness.run("hr-style", "feynman-tech");
    expect(harness.notifies[0]?.type).toBe("error");
    expect(harness.notifies[0]?.message).toContain("io_failure");
    expect(postsOf(harness, "/api/style")).toHaveLength(0);
  });
});

describe("/hr-style illegal id", () => {
  it("should notify once with both the user input and all available ids, and send no POST, for an illegal id", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", "nope");
    expect(harness.notifies).toHaveLength(1);
    expect(harness.notifies[0]?.type).toBe("error");
    expect(harness.notifies[0]?.message).toContain("nope");
    expect(harness.notifies[0]?.message).toContain("feynman-tech");
    expect(harness.notifies[0]?.message).toContain("atelier-editorial");
    expect(postsOf(harness, "/api/style")).toHaveLength(0);
  });

  it("should POST exactly once with a two-key body carrying cookie and `x-hr-csrf: 1` for a legal id", async () => {
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    await harness.run("hr-style", "feynman-tech");
    const posts = postsOf(harness, "/api/style");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe("POST");
    expect(JSON.parse(posts[0]?.body ?? "")).toEqual({
      docId: "docs/x.html",
      visualId: "feynman-tech",
    });
    expect(posts[0]?.headers["x-hr-csrf"]).toBe("1");
    expect(posts[0]?.headers["cookie"]).toBe("hr=tok-1");
    expect(harness.notifies.at(-1)?.message).toContain("feynman-tech");
  });
});

describe("/hr-style with no bound document", () => {
  it("should only hint to run `/hreader <path>` first and send no POST", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES], "/api/style": [STYLED] });
    await harness.run("hr-style", "feynman-tech");
    expect(harness.notifies).toHaveLength(1);
    expect(harness.notifies[0]?.type).toBe("error");
    expect(harness.notifies[0]?.message).toContain("先用 /hreader <文档路径> 绑定文档");
    expect(postsOf(harness, "/api/style")).toHaveLength(0);
  });
});

describe("/hr-style persistence", () => {
  it('should stay info but not claim "switched" for `changed:false` (the visual did not change)', async () => {
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [{ text: JSON.stringify({ changed: false, revision: 3, changedNodes: [] }) }],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    await harness.run("hr-style", "feynman-tech");
    expect(harness.notifies.at(-1)?.type).toBe("info");
    expect(harness.notifies.at(-1)?.message).toContain("与当前视觉相同");
  });

  it("should surface the error code as text without polluting this session's style when POST fails (daemon reports `unknown_style`)", async () => {
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [
        { status: 404, text: JSON.stringify({ code: "unknown_style", message: "没有这个视觉" }) },
      ],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    await harness.run("hr-style", "feynman-tech");
    expect(harness.notifies.at(-1)?.type).toBe("error");
    expect(harness.notifies.at(-1)?.message).toContain("unknown_style");
    await harness.run("hreader", "");
    expect(harness.notifies.at(-1)?.message).not.toContain("风格");
  });

  it("should only hint `hr serve` and send no fetch at all when the daemon is down", async () => {
    const harness = harnessOf({}, { daemon: "{}" });
    await harness.run("hr-style", "feynman-tech");
    expect(harness.notifies[0]?.type).toBe("error");
    expect(harness.notifies[0]?.message).toContain("hr serve");
    expect(harness.calls).toHaveLength(0);
  });
});

describe("style in the `/hreader` status line", () => {
  it("should append the style suffix to the no-args `/hreader` status line after a style switch", async () => {
    const harness = harnessOf({
      "/api/theme": [THEMES],
      "/api/style": [STYLED],
      "/api/events": [EVENTS],
    });
    await harness.run("hreader", "docs/x.html");
    await harness.run("hr-style", "feynman-tech");
    await harness.run("hreader", "");
    const status = harness.notifies.at(-1)?.message ?? "";
    expect(status).toContain("127.0.0.1:7331");
    expect(status).toContain("workspace /work");
    expect(status).toContain("，风格 feynman-tech");
  });
});
