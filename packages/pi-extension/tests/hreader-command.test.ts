// 这层管：`/hreader` 命令——daemon 没起时只提示 `hr serve`（绝不 spawn），有 daemon 时给出阅读器 URL；
// 以及默认导出确实把自己注册成一个 Pi 扩展（`pi.registerCommand`）。

import { describe, expect, it } from "vitest";

import hreaderExtension, { hreaderExtensionOf, type DaemonInfo } from "../pi-hreader.ts";
import { fakeContextOf, fakeDepsOf, fakePiOf } from "./fakes.ts";

const INFO: DaemonInfo = { port: 7331, token: "tok-1", pid: 4242, workspace: "/work" };

const openWith = (options: { readonly daemon?: string; readonly hasUI?: boolean }) => {
  const { deps } = fakeDepsOf({
    home: "/home/u",
    ...(options.daemon === undefined ? {} : { daemon: options.daemon }),
  });
  const { pi, commands } = fakePiOf();
  hreaderExtensionOf(deps)(pi);
  const command = commands.get("hreader");
  if (command === undefined) throw new Error("`/hreader` 没注册上");
  return { run: command.handler, fake: fakeContextOf({ ...options }) };
};

describe("/hreader", () => {
  it("daemon 没在跑：只提示 hr serve，且是 error 级", async () => {
    const { run, fake } = openWith({});
    await run("docs/x.html", fake.ctx);
    const [first] = fake.notifies;
    expect(fake.notifies).toHaveLength(1);
    expect(first?.type).toBe("error");
    expect(first?.message).toContain("hr serve");
  });

  it("daemon 在跑：给出 `http://127.0.0.1:<port>/s/<docId>?t=<token>` 形状的 URL", async () => {
    const { run, fake } = openWith({ daemon: JSON.stringify(INFO) });
    await run("docs/x.html", fake.ctx);
    const [first] = fake.notifies;
    expect(first?.type).toBe("info");
    expect(first?.message).toContain("http://127.0.0.1:7331/s/docs%2Fx.html?t=tok-1");
  });

  it("参数为空：一次 notify，既给用法也给 daemon 状态（AC-2 / D11）", async () => {
    const { run, fake } = openWith({ daemon: JSON.stringify(INFO) });
    await run("   ", fake.ctx);
    expect(fake.notifies.map((entry) => entry.type)).toEqual(["info"]);
    const message = fake.notifies[0]?.message ?? "";
    expect(message).toContain("/hreader <path>");
    // 审计员 P1：无参时若只打用法，用户看不到 daemon 到底在不在、在哪个端口。
    expect(message).toContain("127.0.0.1:7331");
    expect(message).toContain("/work");
    // 根路径是 cookie 认证、`/s/:docId` 是 token 认证：无参时没有可点的合法链接。
    expect(message).not.toContain("http://");
  });

  it("越界路径：报错并说出 workspace，不拼 URL", async () => {
    const { run, fake } = openWith({ daemon: JSON.stringify(INFO) });
    await run("/etc/passwd", fake.ctx);
    const [first] = fake.notifies;
    expect(first?.type).toBe("error");
    expect(first?.message).toContain("/work");
    expect(first?.message).not.toContain("http://");
  });
});

describe("默认导出", () => {
  it("把 2 命令 + 3 工具注册进 Pi，描述非空（扩展能被裸加载的最小证据）", () => {
    const { pi, commands, tools, shutdown } = fakePiOf();
    hreaderExtension(pi);
    expect([...commands.keys()]).toEqual(["hreader", "hr-style"]);
    expect([...tools.keys()]).toEqual([
      "hreader_outline",
      "hreader_read_node",
      "hreader_patch_node",
    ]);
    expect(commands.get("hreader")?.description).not.toBe("");
    expect(commands.get("hr-style")?.description).not.toBe("");
    expect(shutdown).toHaveLength(1);
  });
});
