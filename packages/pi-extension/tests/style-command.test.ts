// 这层管：`/hr-style`（AC-5）——视觉 id 只来自 `GET /api/theme`（不扫目录）、非法 id 连 POST 都不发、
// 合法 id 发的 body 恰好是 `{ docId, visualId }` 且带 CSRF 头、未绑定文档时只提示、状态行里记住本会话风格。

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
/** 订阅端点：常驻空流，免得 `/hreader` 的重连循环打断命令。 */
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

describe("/hr-style 列表来源", () => {
  it("无参时逐字列出 `GET /api/theme` 的原值（不排序、不裁剪、不加后缀）", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", "");
    expect(harness.notifies).toHaveLength(1);
    expect(harness.notifies[0]?.type).toBe("info");
    expect(harness.notifies[0]?.message).toBe(
      "用法：/hr-style <视觉 id>——不给 id 就列出 daemon 报的可选值\n" +
        "可选风格：feynman-tech、atelier-editorial",
    );
  });

  it("`themes` 里的空串/非字符串被剔除，非数组当作没有可选值（不报出假 id）", async () => {
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

  it("`GET /api/theme` 本身失败：把 daemon 的错误码转成文本，不发 POST", async () => {
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

describe("/hr-style 非法 id", () => {
  it("非法 id：一次 notify 里同时给出用户输入与全部可选 id，且不发 POST", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES] });
    await harness.run("hr-style", "nope");
    expect(harness.notifies).toHaveLength(1);
    expect(harness.notifies[0]?.type).toBe("error");
    expect(harness.notifies[0]?.message).toContain("nope");
    expect(harness.notifies[0]?.message).toContain("feynman-tech");
    expect(harness.notifies[0]?.message).toContain("atelier-editorial");
    expect(postsOf(harness, "/api/style")).toHaveLength(0);
  });

  it("合法 id：POST 恰一次，body 恰好两个键，带 cookie 与 `x-hr-csrf: 1`", async () => {
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

describe("/hr-style 未绑定文档", () => {
  it("只提示先跑 `/hreader <路径>`，不发任何 POST", async () => {
    const harness = harnessOf({ "/api/theme": [THEMES], "/api/style": [STYLED] });
    await harness.run("hr-style", "feynman-tech");
    expect(harness.notifies).toHaveLength(1);
    expect(harness.notifies[0]?.type).toBe("error");
    expect(harness.notifies[0]?.message).toContain("先用 /hreader <文档路径> 绑定文档");
    expect(postsOf(harness, "/api/style")).toHaveLength(0);
  });
});

describe("/hr-style 落盘", () => {
  it("`changed:false`（视觉没变）：仍是 info，但不说“已换成”", async () => {
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

  it("POST 失败（daemon 报 `unknown_style`）：文本带错误码，不污染本会话风格", async () => {
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

  it("daemon 没在跑：只提示 `hr serve`，一次 fetch 都不发", async () => {
    const harness = harnessOf({}, { daemon: "{}" });
    await harness.run("hr-style", "feynman-tech");
    expect(harness.notifies[0]?.type).toBe("error");
    expect(harness.notifies[0]?.message).toContain("hr serve");
    expect(harness.calls).toHaveLength(0);
  });
});

describe("/hreader 状态行里的风格", () => {
  it("换过风格后，`/hreader` 无参的状态行追加 `，风格 <id>`", async () => {
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
