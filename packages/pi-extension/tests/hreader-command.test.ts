// The `/hreader` command: when the daemon is down it only hints `hr serve` (never spawns), and with a
// daemon up it yields the reader URL; also that the default export registers itself as a Pi extension (`pi.registerCommand`).

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
  it("should only hint hr serve at error level when the daemon is down", async () => {
    const { run, fake } = openWith({});
    await run("docs/x.html", fake.ctx);
    const [first] = fake.notifies;
    expect(fake.notifies).toHaveLength(1);
    expect(first?.type).toBe("error");
    expect(first?.message).toContain("hr serve");
  });

  it("should yield a `http://127.0.0.1:<port>/s/<docId>?t=<token>`-shaped URL when the daemon is up", async () => {
    const { run, fake } = openWith({ daemon: JSON.stringify(INFO) });
    await run("docs/x.html", fake.ctx);
    const [first] = fake.notifies;
    expect(first?.type).toBe("info");
    expect(first?.message).toContain("http://127.0.0.1:7331/s/docs%2Fx.html?t=tok-1");
  });

  it("should send one notify with both usage and daemon status when args are empty", async () => {
    const { run, fake } = openWith({ daemon: JSON.stringify(INFO) });
    await run("   ", fake.ctx);
    expect(fake.notifies.map((entry) => entry.type)).toEqual(["info"]);
    const message = fake.notifies[0]?.message ?? "";
    expect(message).toContain("/hreader <path>");
    // Printing usage alone on no-args would hide whether the daemon is up at all and on which port.
    expect(message).toContain("127.0.0.1:7331");
    expect(message).toContain("/work");
    // The root path is cookie-auth and `/s/:docId` token-auth: with no args there is no clickable valid link.
    expect(message).not.toContain("http://");
  });

  it("should report the workspace and build no URL for an out-of-bounds path", async () => {
    const { run, fake } = openWith({ daemon: JSON.stringify(INFO) });
    await run("/etc/passwd", fake.ctx);
    const [first] = fake.notifies;
    expect(first?.type).toBe("error");
    expect(first?.message).toContain("/work");
    expect(first?.message).not.toContain("http://");
  });
});

describe("default export", () => {
  it("should register 2 commands and 3 tools into Pi with non-empty descriptions (minimal proof the extension loads bare)", () => {
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
