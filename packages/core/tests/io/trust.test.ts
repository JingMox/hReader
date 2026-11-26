// 这层管：信任档存取——读、写、内容一变即失效、文件损坏回落 off；不测 HTTP 路由。

import { describe, expect, it } from "vitest";

import type { TrustLevel } from "@hreader/core";

import { resolveTarget } from "../../src/io/paths";
import { readTrust, writeTrust } from "../../src/io";
import {
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  sha256Of,
  systemError,
  type FakeFs,
} from "./harness";

const WORKSPACE = "/ws";
const DOC = "doc.html";
const TRUST_PATH = `${WORKSPACE}/.hreader/trust.json`;

const DOC_BYTES = new TextEncoder().encode("<div>foreign one</div>");
const OTHER_BYTES = new TextEncoder().encode("<div>foreign two</div>");

interface World {
  readonly fs: FakeFs;
  readonly read: (bytes: Uint8Array) => Promise<TrustLevel>;
  readonly write: (bytes: Uint8Array, level: TrustLevel) => Promise<void>;
}

/** 假 fs 里的最小世界：workspace + 一篇外来文档，读/写都走 `readTrust`/`writeTrust`。 */
const worldOf = async (seed: Readonly<Record<string, string>>): Promise<World> => {
  const fs = fakeFs({ [`${WORKSPACE}/${DOC}`]: "seed", ...seed });
  const deps = depsOf(fs.port, fixedClock(0).clock, recordingSleep().sleep);
  const target = await resolveTarget({ workspace: WORKSPACE, file: DOC }, fs.port);
  return {
    fs,
    read: (bytes) => readTrust({ target, bytes }, deps),
    write: (bytes, level) => writeTrust({ target, bytes, level }, deps),
  };
};

describe("trust · 读取回落", () => {
  it("should report off when trust.json does not exist", async () => {
    const world = await worldOf({});

    expect(await world.read(DOC_BYTES)).toBe("off");
  });

  it("should report off when trust.json is not valid JSON", async () => {
    const world = await worldOf({ [TRUST_PATH]: "{oops" });

    expect(await world.read(DOC_BYTES)).toBe("off");
  });

  it("should report off when trust.json is not valid UTF-8", async () => {
    const world = await worldOf({});
    world.fs.state.files.set(TRUST_PATH, new Uint8Array([0xff, 0xfe, 0x00]));

    expect(await world.read(DOC_BYTES)).toBe("off");
  });

  it("should report off when trust.json holds a non-object value", async () => {
    const world = await worldOf({ [TRUST_PATH]: "42" });

    expect(await world.read(DOC_BYTES)).toBe("off");
  });

  it("should report off when trust.json holds null", async () => {
    const world = await worldOf({ [TRUST_PATH]: "null" });

    expect(await world.read(DOC_BYTES)).toBe("off");
  });

  it("should report off when the stored level is not a known TrustLevel", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({ [sha256Of(DOC_BYTES)]: "admin" }),
    });

    expect(await world.read(DOC_BYTES)).toBe("off");
  });

  it("should report off when reading trust.json fails with a system error", async () => {
    const world = await worldOf({ [TRUST_PATH]: "{}" });
    world.fs.fail("readFile", systemError("EACCES"), (path) => path === TRUST_PATH);

    expect(await world.read(DOC_BYTES)).toBe("off");
  });
});

describe("trust · 写入", () => {
  it("should persist the grant keyed by content sha256", async () => {
    const world = await worldOf({});

    await world.write(DOC_BYTES, "local");

    expect(await world.read(DOC_BYTES)).toBe("local");
    const table = JSON.parse(world.fs.textAt(TRUST_PATH)) as Record<string, string>;
    expect(Object.values(table)).toEqual(["local"]);
    expect(Object.keys(table)[0]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("should keep grants for other contents when writing a new one", async () => {
    const world = await worldOf({});

    await world.write(DOC_BYTES, "local");
    await world.write(OTHER_BYTES, "local");

    expect(await world.read(DOC_BYTES)).toBe("local");
    expect(await world.read(OTHER_BYTES)).toBe("local");
  });

  it("should overwrite a previous grant for the same content", async () => {
    const world = await worldOf({});

    await world.write(DOC_BYTES, "local");
    await world.write(DOC_BYTES, "off");

    expect(await world.read(DOC_BYTES)).toBe("off");
  });

  it("should never write into the document file itself", async () => {
    const world = await worldOf({ [`${WORKSPACE}/${DOC}`]: "<div>foreign one</div>" });

    await world.write(DOC_BYTES, "local");

    expect(world.fs.textAt(`${WORKSPACE}/${DOC}`)).toBe("<div>foreign one</div>");
  });
});

describe("trust · 内容变化即失效", () => {
  it("should fall back to off when the document bytes change after the grant", async () => {
    const world = await worldOf({});
    await world.write(DOC_BYTES, "local");

    const edited = new TextEncoder().encode("<div>foreign one!</div>");

    expect(await world.read(edited)).toBe("off");
  });
});
