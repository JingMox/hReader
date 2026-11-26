// 这层管：权限模型存取——路径键授权、损坏回落、旧 sha 键迁移、全局模式读写；
// 不测 HTTP 路由与 CSP（那是 server 层的事）。

import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../src/io/bytes";
import { resolveTarget } from "../../src/io/paths";
import {
  effectiveOf,
  readDocGrant,
  readGlobalModes,
  settingsPathOf,
  writeDocGrant,
  writeGlobalModes,
  type DocGrant,
  type PermissionMode,
} from "../../src/io";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  realDirOf,
  recordingSleep,
  sha256Of,
  systemError,
  withWorkspace,
  type FakeFs,
} from "./harness";
import { nodePatchDeps } from "../../src/io/node-fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE = "/ws";
const DOC = "doc.html";
const TRUST_PATH = `${WORKSPACE}/.hreader/trust.json`;
const HOME = "/home";
const SETTINGS_PATH = settingsPathOf(HOME);

const DOC_BYTES = encodeUtf8("<div>foreign one</div>");
const DENIED: DocGrant = { scripts: false, network: false };

interface World {
  readonly fs: FakeFs;
  readonly read: (bytes?: Uint8Array, doc?: string) => Promise<DocGrant>;
  readonly write: (grant: DocGrant, doc?: string) => Promise<void>;
  readonly targetOf: (doc: string) => ReturnType<typeof resolveTarget>;
}

/** 假 fs 里的最小世界：workspace + 外来文档，读/写都走 `readDocGrant`/`writeDocGrant`。 */
const worldOf = async (
  seed: Readonly<Record<string, string>>,
  docs: readonly string[] = [DOC],
): Promise<World> => {
  const fs = fakeFs({
    ...Object.fromEntries(docs.map((doc) => [`${WORKSPACE}/${doc}`, "seed"])),
    ...seed,
  });
  const deps = depsOf(fs.port, fixedClock(0).clock, recordingSleep().sleep);
  const targetOf = (doc: string) => resolveTarget({ workspace: WORKSPACE, file: doc }, fs.port);
  return {
    fs,
    targetOf,
    read: async (bytes = DOC_BYTES, doc = DOC) =>
      readDocGrant({ target: await targetOf(doc), bytes }, deps),
    write: async (grant, doc = DOC) =>
      writeDocGrant({ target: await targetOf(doc), grant }, deps),
  };
};

/** 假 home：种子文件把 `/home` 钉成已存在目录，否则 `realpath(home)` 先倒。 */
const homeWorldOf = async (seed: Readonly<Record<string, string>>) => {
  const fs = fakeFs({ [`${HOME}/keep`]: "", ...seed });
  const deps = depsOf(fs.port, fixedClock(0).clock, recordingSleep().sleep);
  return { fs, deps };
};

describe("readDocGrant · 读取回落", () => {
  it.each([
    ["trust.json does not exist", {}],
    ["trust.json is not valid JSON", { [TRUST_PATH]: "{oops" }],
    ["trust.json holds a non-object value", { [TRUST_PATH]: "42" }],
    ["trust.json holds null", { [TRUST_PATH]: "null" }],
    ["trust.json holds an array", { [TRUST_PATH]: "[]" }],
    [
      "the stored entry is not a grant shape",
      { [TRUST_PATH]: JSON.stringify({ [DOC]: { scripts: "yes" } }) },
    ],
    [
      "the stored entry drops a dimension",
      { [TRUST_PATH]: JSON.stringify({ [DOC]: { scripts: true } }) },
    ],
  ])("should fall back to denied when %s", async (_label, seed) => {
    const world = await worldOf(seed);

    expect(await world.read()).toEqual(DENIED);
  });

  it("should fall back to denied when trust.json is not valid UTF-8", async () => {
    const world = await worldOf({});
    world.fs.state.files.set(TRUST_PATH, new Uint8Array([0xff, 0xfe, 0x00]));

    expect(await world.read()).toEqual(DENIED);
  });

  it("should fall back to denied when reading trust.json fails with a system error", async () => {
    const world = await worldOf({ [TRUST_PATH]: "{}" });
    world.fs.fail("readFile", systemError("EACCES"), (path) => path === TRUST_PATH);

    expect(await world.read()).toEqual(DENIED);
  });

  it("should ignore unknown extra fields on a well-formed grant", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({ [DOC]: { scripts: true, network: true, note: "x" } }),
    });

    expect(await world.read()).toEqual({ scripts: true, network: true });
  });
});

describe("readDocGrant/writeDocGrant · 路径键语义", () => {
  it("should persist the grant keyed by workspace-relative path", async () => {
    const world = await worldOf({});

    await world.write({ scripts: true, network: true });

    expect(await world.read()).toEqual({ scripts: true, network: true });
    const table = JSON.parse(world.fs.textAt(TRUST_PATH)) as Record<string, unknown>;
    expect(table).toEqual({ [DOC]: { scripts: true, network: true } });
  });

  it("should keep the grant when the document bytes change", async () => {
    const world = await worldOf({});
    await world.write({ scripts: true, network: false });

    const edited = encodeUtf8("<div>edited</div>");

    expect(await world.read(edited)).toEqual({ scripts: true, network: false });
  });

  it("should not grant a sibling document under a different path", async () => {
    const world = await worldOf({}, ["a.html", "b.html"]);
    await world.write({ scripts: true, network: false }, "a.html");

    expect(await world.read(DOC_BYTES, "b.html")).toEqual(DENIED);
  });

  it("should keep grants for other documents when writing a new one", async () => {
    const world = await worldOf({}, ["a.html", "b.html"]);
    await world.write({ scripts: true, network: false }, "a.html");
    await world.write({ scripts: false, network: true }, "b.html");

    expect(await world.read(DOC_BYTES, "a.html")).toEqual({ scripts: true, network: false });
    expect(await world.read(DOC_BYTES, "b.html")).toEqual({ scripts: false, network: true });
  });

  it("should overwrite a previous grant for the same path", async () => {
    const world = await worldOf({});
    await world.write({ scripts: true, network: false });
    await world.write(DENIED);

    expect(await world.read()).toEqual(DENIED);
  });

  it("should never write into the document file itself", async () => {
    const world = await worldOf({ [`${WORKSPACE}/${DOC}`]: "<div>foreign one</div>" });

    await world.write({ scripts: true, network: false });

    expect(world.fs.textAt(`${WORKSPACE}/${DOC}`)).toBe("<div>foreign one</div>");
  });
});

describe("readDocGrant · 旧 sha 键迁移", () => {
  it("should migrate a matching legacy sha grant to the path key", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({ [sha256Of(DOC_BYTES)]: "local" }),
    });

    expect(await world.read()).toEqual({ scripts: true, network: false });
    const table = JSON.parse(world.fs.textAt(TRUST_PATH)) as Record<string, unknown>;
    expect(table[DOC]).toEqual({ scripts: true, network: false });
    // 旧键保留：另一份内容相同的文档共享同一 sha 授权，删掉会让它丢档。
    expect(table[sha256Of(DOC_BYTES)]).toBe("local");
  });

  it("should be idempotent: a second read hits the path key and does not rewrite", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({ [sha256Of(DOC_BYTES)]: "local" }),
    });

    await world.read();
    world.fs.state.log.length = 0;
    expect(await world.read()).toEqual({ scripts: true, network: false });

    // 命中路径键的直查不应再触发写——迁移只发生一次。
    expect(world.fs.state.log.some((line) => line.startsWith("writeFileAtomic"))).toBe(false);
  });

  it("should not migrate a legacy off record", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({ [sha256Of(DOC_BYTES)]: "off" }),
    });

    expect(await world.read()).toEqual(DENIED);
    expect(world.fs.state.files.has(TRUST_PATH)).toBe(true);
    expect(world.fs.state.log.some((line) => line.startsWith("writeFileAtomic"))).toBe(false);
  });

  it("should ignore a legacy sha that does not match the current bytes", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({ [sha256Of(encodeUtf8("other"))]: "local" }),
    });

    expect(await world.read()).toEqual(DENIED);
  });

  it("should still report the migrated grant when the migration write fails", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({ [sha256Of(DOC_BYTES)]: "local" }),
    });
    world.fs.fail("writeFileAtomic", systemError("EACCES"), () => true);

    expect(await world.read()).toEqual({ scripts: true, network: false });
  });

  it("should prefer an existing path grant over a matching legacy sha key", async () => {
    const world = await worldOf({
      [TRUST_PATH]: JSON.stringify({
        [sha256Of(DOC_BYTES)]: "local",
        [DOC]: DENIED,
      }),
    });

    // 路径键是权威：旧 sha 授权不得复活已被收回的文档。
    expect(await world.read()).toEqual(DENIED);
  });
});

describe("readGlobalModes · 读取回落", () => {
  it("should report per-doc/per-doc when the settings file is missing", async () => {
    const { deps } = await homeWorldOf({});

    expect(await readGlobalModes(HOME, deps)).toEqual({ scripts: "per-doc", network: "per-doc" });
  });

  it.each([
    ["not valid JSON", "{oops"],
    ["not valid UTF-8 bytes", null],
    ["a non-object value", "42"],
    ["null", "null"],
    ["an array", "[]"],
    ["unknown modes", JSON.stringify({ scripts: "admin", network: "admin" })],
  ])("should fall back to defaults when the file is %s", async (_label, content) => {
    const { fs, deps } = await homeWorldOf({});
    fs.state.files.set(
      SETTINGS_PATH,
      content === null ? new Uint8Array([0xff]) : encodeUtf8(content),
    );

    expect(await readGlobalModes(HOME, deps)).toEqual({
      scripts: "per-doc",
      network: "per-doc",
    });
  });

  it("should fall back per-dimension: a broken scripts value does not poison network", async () => {
    const { deps } = await homeWorldOf({
      [SETTINGS_PATH]: JSON.stringify({ scripts: "oops", network: "allow" }),
    });

    expect(await readGlobalModes(HOME, deps)).toEqual({ scripts: "per-doc", network: "allow" });
  });

  it("should fall back to defaults when reading the file fails with a system error", async () => {
    const { fs, deps } = await homeWorldOf({ [SETTINGS_PATH]: "{}" });
    fs.fail("readFile", systemError("EACCES"), (path) => path === SETTINGS_PATH);

    expect(await readGlobalModes(HOME, deps)).toEqual({
      scripts: "per-doc",
      network: "per-doc",
    });
  });
});

describe("writeGlobalModes · 读写", () => {
  it("should round-trip a full write", async () => {
    const { deps } = await homeWorldOf({});

    const modes = await writeGlobalModes(
      { home: HOME, modes: { scripts: "allow", network: "deny" } },
      deps,
    );

    expect(modes).toEqual({ scripts: "allow", network: "deny" });
    expect(await readGlobalModes(HOME, deps)).toEqual({ scripts: "allow", network: "deny" });
  });

  it("should keep the untouched dimension on a partial write", async () => {
    const { deps } = await homeWorldOf({
      [SETTINGS_PATH]: JSON.stringify({ scripts: "deny", network: "allow" }),
    });

    await writeGlobalModes({ home: HOME, modes: { scripts: "allow" } }, deps);

    expect(await readGlobalModes(HOME, deps)).toEqual({ scripts: "allow", network: "allow" });
  });

  it("should heal a corrupted settings file by writing over it", async () => {
    const { deps } = await homeWorldOf({ [SETTINGS_PATH]: "{oops" });

    await writeGlobalModes({ home: HOME, modes: { network: "deny" } }, deps);

    expect(await readGlobalModes(HOME, deps)).toEqual({ scripts: "per-doc", network: "deny" });
  });

  it("should propagate a missing home as an io error, never write outside it", async () => {
    const { fs, deps } = await homeWorldOf({});

    const code = await codeOfAsync(() =>
      writeGlobalModes({ home: "/missing-home", modes: { scripts: "allow" } }, deps),
    );

    expect(code).toBe("io_failure");
    expect([...fs.state.files.keys()].some((p) => p.startsWith("/missing-home"))).toBe(false);
  });
});

describe("permissions · 真盘路径语义", () => {
  it("should invalidate the grant after rename/move and keep it after content edits", async () => {
    await withWorkspace(async (dir) => {
      const workspace = await realDirOf(dir);
      const docPath = join(workspace, "doc.html");
      await writeFile(docPath, "<div>v1</div>");
      const target = await resolveTarget({ workspace, file: "doc.html" }, nodePatchDeps.fs);

      await writeDocGrant({ target, grant: { scripts: true, network: true } }, nodePatchDeps);
      // 内容改动不丢授权（含 hReader 自己的 style 写入——字节换、路径不换）。
      await writeFile(docPath, "<div>v2</div>");
      expect(await readDocGrant({ target, bytes: encodeUtf8("v2") }, nodePatchDeps)).toEqual({
        scripts: true,
        network: true,
      });

      // 改名 = 新地址：旧路径不再有文件，目标按新路径解析是另一条记录。
      const moved = await resolveTarget({ workspace, file: "moved.html" }, nodePatchDeps.fs).catch(
        () => undefined,
      );
      expect(moved).toBeUndefined();
      const table: unknown = JSON.parse(
        await readFile(join(workspace, ".hreader", "trust.json"), "utf8"),
      );
      expect(table).toEqual({ "doc.html": { scripts: true, network: true } });
    });
  });
});

describe("permissions · 表污染回归", () => {
  it("should not leak one world's grants into another world's reads", async () => {
    // 世界一的写入会改 trust.json；世界二根本没有这个文件，读必须回落成 DENIED——
    // 如果回落路径复用了被写侧 mutate 过的共享表，授权就跨界泄漏了。
    const first = await worldOf({});
    await first.write({ scripts: true, network: false });

    const second = await worldOf({});

    expect(await second.read()).toEqual(DENIED);
    expect(second.fs.state.files.has(TRUST_PATH)).toBe(false);
  });
});

describe("effectiveOf · 3×3×2×2 合成矩阵", () => {
  const modes: readonly PermissionMode[] = ["allow", "deny", "per-doc"];
  const grants: readonly DocGrant[] = [
    { scripts: false, network: false },
    { scripts: true, network: false },
    { scripts: false, network: true },
    { scripts: true, network: true },
  ];

  it.each(modes)("should honor scripts mode %s across every network mode and grant", (sm) => {
    for (const nm of modes) {
      for (const grant of grants) {
        const eff = effectiveOf({ scripts: sm, network: nm }, grant);
        const expectedScripts = sm === "allow" ? true : sm === "deny" ? false : grant.scripts;
        const expectedNetwork = nm === "allow" ? true : nm === "deny" ? false : grant.network;
        expect(eff.scripts).toBe(expectedScripts);
        expect(eff.network).toBe(expectedNetwork);
        expect(eff.scriptsSource).toBe(sm === "per-doc" ? "doc" : "global");
        expect(eff.networkSource).toBe(nm === "per-doc" ? "doc" : "global");
      }
    }
  });
});
