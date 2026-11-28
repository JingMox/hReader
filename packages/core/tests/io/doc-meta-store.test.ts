// This layer: `io/doc-meta-store.ts` — table naming, corruption-tolerant reads (every bad
// file reads as empty + one code-only diagnostic), and the locked-write pipeline (size cap
// refusal, corrupt backup rename, atomic landing). The fake fs injects every failure mode.

import { describe, expect, it } from "vitest";

import { DOC_META_LIMITS, serializeDocMetaFile, type DocMetaRecord } from "../../src/docmeta";
import {
  META_REL,
  metaLockOf,
  metaPathOf,
  readDocMetaFile,
  writeDocMetaFile,
} from "../../src/io/doc-meta-store";
import { resolveTarget } from "../../src/io/paths";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  sha1Of,
  systemError,
} from "./harness";

const CLOCK = fixedClock(Date.parse("2026-11-27T00:00:00.000Z")).clock;
const SLEEP = recordingSleep().sleep;

const DOC = "<html><body><p>x</p></body></html>";
const seed = { "/ws/doc.html": DOC };

const targetOf = async (fs: ReturnType<typeof fakeFs>["port"], file = "doc.html") =>
  resolveTarget({ workspace: "/ws", file }, fs);

const deps = (fs: ReturnType<typeof fakeFs>["port"]) => depsOf(fs, CLOCK, SLEEP);

const storePath = "/ws/.hreader/meta.json";
const RECORD = { tags: ["维修"], sourceUrl: "https://example.com/x" };
const tableJson = (docs: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ version: 1, docs });

/** The store's internal representation is a Map — doc names may be `__proto__`-shaped. */
const tableOf = (
  docs: Readonly<Record<string, DocMetaRecord>>,
): ReadonlyMap<string, DocMetaRecord> => new Map(Object.entries(docs));

/** Pad a valid table with trailing JSON whitespace to an exact byte count. */
const tableJsonAtBytes = (bytes: number): string => {
  const base = tableJson({ "doc.html": { tags: [] } });
  return `${base}${" ".repeat(bytes - new TextEncoder().encode(base).length)}`;
};

/** Names of every `.corrupt-*` backup in the fake fs. */
const corruptBackups = (fs: ReturnType<typeof fakeFs>): readonly [string, Uint8Array][] =>
  [...fs.state.files.entries()].filter(([name]) => name.includes(".corrupt-"));

describe("metaPathOf · naming", () => {
  it("should name the shared table meta.json under .hreader and hash META_REL for the lock", async () => {
    const fs = fakeFs(seed);
    const target = await targetOf(fs.port);

    expect(metaPathOf(target.storeDir)).toBe(storePath);
    expect(metaLockOf(target.storeDir)).toBe(`/ws/.hreader/locks/${sha1Of(META_REL)}.lock`);
  });
});

describe("readDocMetaFile · read outcomes", () => {
  it("should report an empty non-corrupt table when the file does not exist", async () => {
    const fs = fakeFs(seed);
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read).toEqual({
      exists: false,
      corrupt: false,
      docs: new Map(),
      diagnostics: [],
    });
  });

  it("should map a non-ENOENT read failure to io_failure", async () => {
    const fs = fakeFs(seed);
    fs.fail("readFile", systemError("EACCES"), (path) => path.includes("meta.json"));
    const target = await targetOf(fs.port);

    expect(await codeOfAsync(() => readDocMetaFile(target, deps(fs.port)))).toBe("io_failure");
  });

  it("should read a valid table back to its records", async () => {
    const fs = fakeFs({ ...seed, [storePath]: tableJson({ "doc.html": RECORD }) });
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read.exists).toBe(true);
    expect(read.corrupt).toBe(false);
    expect(read.docs.get("doc.html")).toEqual(RECORD);
    expect(read.diagnostics).toEqual([]);
  });

  it("should read a file exactly at the file-size cap as a valid table", async () => {
    const fs = fakeFs({
      ...seed,
      [storePath]: tableJsonAtBytes(DOC_META_LIMITS.fileBytes),
    });
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(false);
    expect(read.docs.get("doc.html")).toEqual({ tags: [] });
  });

  it("should read a file one byte over the cap as empty and corrupt", async () => {
    const fs = fakeFs({
      ...seed,
      [storePath]: tableJsonAtBytes(DOC_META_LIMITS.fileBytes + 1),
    });
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read.exists).toBe(true);
    expect(read.corrupt).toBe(true);
    expect(read.docs).toEqual(new Map());
    expect(read.diagnostics).toEqual(["doc_meta_corrupt:too_large"]);
  });

  it("should read invalid UTF-8 bytes as empty and corrupt", async () => {
    const fs = fakeFs(seed);
    fs.state.files.set(storePath, new Uint8Array([0xff, 0xfe, 0xfd]));
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(true);
    expect(read.diagnostics).toEqual(["doc_meta_corrupt:bad_utf8"]);
  });

  it.each([
    ["{broken", "not_object"],
    ["[]", "not_object"],
    ["null", "not_object"],
    [JSON.stringify({ version: 2, docs: {} }), "bad_version"],
    [JSON.stringify({ version: 1, docs: [] }), "bad_docs"],
    [JSON.stringify({ version: 1, docs: { "doc.html": 42 } }), "bad_record"],
    [JSON.stringify({ version: 1, docs: { "doc.html": { tags: "oops" } } }), "bad_record"],
    [JSON.stringify({ version: 1, docs: { "doc.html": { tags: [1] } } }), "bad_record"],
    [JSON.stringify({ version: 1, docs: { "doc.html": { createdBy: "robot" } } }), "bad_record"],
  ])("should read %s as empty and corrupt", async (text, reason) => {
    const fs = fakeFs({ ...seed, [storePath]: text });
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(true);
    expect(read.docs).toEqual(new Map());
    expect(read.diagnostics).toEqual([`doc_meta_corrupt:${reason}`]);
  });

  it.each(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString"])(
    "should read a table with a %s doc key as a normal entry, without pollution",
    async (key) => {
      const text = `{"version":1,"docs":{${JSON.stringify(key)}:{"tags":["x"]}}}`;
      const fs = fakeFs({ ...seed, [storePath]: text });
      const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

      expect(read.corrupt).toBe(false);
      expect(read.docs.get(key)).toEqual({ tags: ["x"] });
      expect(read.diagnostics).toEqual([]);
      // The table's keyspace must never reach the prototype chain.
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
      expect(Reflect.get(Object.prototype, "x")).toBeUndefined();
    },
  );

  it.each(["__proto__", "constructor", "prototype"])(
    "should read a table with a %s top-level key as corrupt",
    async (key) => {
      const text = `{"version":1,${JSON.stringify(key)}:{},"docs":{}}`;
      const fs = fakeFs({ ...seed, [storePath]: text });
      const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

      expect(read.corrupt).toBe(true);
      expect(read.diagnostics).toEqual(["doc_meta_corrupt:dangerous_key"]);
    },
  );

  it("should read a dangerous key nested inside a record as corrupt", async () => {
    // A literal string: JSON.stringify can never emit a __proto__ own key (it sets the
    // prototype instead); only hand-written text produces one after JSON.parse.
    const text = '{"version":1,"docs":{"doc.html":{"tags":[{"__proto__":{"x":1}}]}}}';
    const fs = fakeFs({ ...seed, [storePath]: text });
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(true);
    expect(read.diagnostics).toEqual(["doc_meta_corrupt:dangerous_key"]);
  });

  it("should surface unknown record fields as a non-corrupt diagnostic", async () => {
    const text = JSON.stringify({
      version: 1,
      docs: { "doc.html": { tags: ["x"], bogus: true } },
    });
    const fs = fakeFs({ ...seed, [storePath]: text });
    const read = await readDocMetaFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(false);
    expect(read.docs.get("doc.html")).toEqual({ tags: ["x"] });
    expect(read.diagnostics).toEqual(["doc_meta_unknown_fields"]);
  });
});

describe("writeDocMetaFile · landing", () => {
  it("should write a serialized table that reads back identically (sorted doc keys)", async () => {
    const fs = fakeFs(seed);
    const target = await targetOf(fs.port);
    const prior = await readDocMetaFile(target, deps(fs.port));

    await writeDocMetaFile(
      target,
      deps(fs.port),
      prior,
      tableOf({
        "b.html": { tags: ["b"] },
        "doc.html": RECORD,
      }),
    );

    expect(fs.textAt(storePath)).toBe(
      serializeDocMetaFile(tableOf({ "b.html": { tags: ["b"] }, "doc.html": RECORD })),
    );
    // Insertion order must not leak into the bytes: both spellings sort to the same table.
    expect(serializeDocMetaFile(tableOf({ "doc.html": RECORD, "b.html": { tags: ["b"] } }))).toBe(
      fs.textAt(storePath),
    );
    const read = await readDocMetaFile(target, deps(fs.port));
    expect(read.docs.get("doc.html")).toEqual(RECORD);
    expect(read.corrupt).toBe(false);
  });

  it("should refuse a payload above the file-size cap with invalid_payload and keep the old file", async () => {
    const previous = tableJson({ "doc.html": { tags: ["旧"] } });
    const fs = fakeFs({ ...seed, [storePath]: previous });
    const target = await targetOf(fs.port);
    const prior = await readDocMetaFile(target, deps(fs.port));

    const code = await codeOfAsync(() =>
      writeDocMetaFile(
        target,
        deps(fs.port),
        prior,
        tableOf({
          "doc.html": { tags: ["x".repeat(DOC_META_LIMITS.fileBytes)] },
        }),
      ),
    );

    expect(code).toBe("invalid_payload");
    expect(fs.textAt(storePath)).toBe(previous);
    expect(corruptBackups(fs)).toEqual([]);
  });

  it("should preserve an undecodable file's bytes aside on the next write", async () => {
    const original = new Uint8Array([0xff, 0xfe, 0xfd]);
    const fs = fakeFs(seed);
    fs.state.files.set(storePath, original);
    const target = await targetOf(fs.port);
    const prior = await readDocMetaFile(target, deps(fs.port));
    expect(prior).toMatchObject({ exists: true, corrupt: true });

    await writeDocMetaFile(target, deps(fs.port), prior, tableOf({ "doc.html": RECORD }));

    const backups = corruptBackups(fs);
    expect(backups.map(([name]) => name)).toHaveLength(1);
    expect(backups[0]?.[1]).toEqual(original);
    expect(fs.textAt(storePath)).toContain('"tags"');
  });

  it("should not rename a healthy table aside when overwriting it", async () => {
    const fs = fakeFs({ ...seed, [storePath]: tableJson({ "doc.html": { tags: ["x"] } }) });
    const target = await targetOf(fs.port);
    const prior = await readDocMetaFile(target, deps(fs.port));

    await writeDocMetaFile(target, deps(fs.port), prior, tableOf({ "doc.html": { tags: ["y"] } }));

    expect(corruptBackups(fs)).toEqual([]);
    expect(fs.textAt(storePath)).toContain('"y"');
  });

  describe("corrupt backup naming", () => {
    const stamp = CLOCK.now().toISOString().replaceAll(/[-:.]/gu, "");
    const stem = `/ws/.hreader/meta.corrupt-${stamp}`;

    const corruptReadAt = async (fs: ReturnType<typeof fakeFs>, bytes: string) => {
      fs.state.files.set(storePath, new TextEncoder().encode(bytes));
      return readDocMetaFile(await targetOf(fs.port), deps(fs.port));
    };

    it("should name the backup with a filename-safe stamp", async () => {
      const fs = fakeFs({ ...seed, [storePath]: "{broken" });
      const prior = await corruptReadAt(fs, "{broken");
      await writeDocMetaFile(
        await targetOf(fs.port),
        deps(fs.port),
        prior,
        tableOf({
          "doc.html": RECORD,
        }),
      );

      expect(corruptBackups(fs).map(([name]) => name)).toEqual([`${stem}.json`]);
    });

    it("should keep the earlier backup when two corruptions land in the same millisecond", async () => {
      const fs = fakeFs(seed);
      const target = await targetOf(fs.port);

      const first = await corruptReadAt(fs, "{broken one");
      await writeDocMetaFile(target, deps(fs.port), first, tableOf({ "doc.html": RECORD }));
      const second = await corruptReadAt(fs, "{broken two");
      await writeDocMetaFile(target, deps(fs.port), second, tableOf({ "doc.html": RECORD }));

      const names = corruptBackups(fs).map(([name]) => name);
      expect(names).toEqual(expect.arrayContaining([`${stem}.json`, `${stem}-1.json`]));
      expect(fs.textAt(`${stem}.json`)).toBe("{broken one");
      expect(fs.textAt(`${stem}-1.json`)).toBe("{broken two");
    });

    it("should fail closed rather than overwrite an earlier backup when every candidate is taken", async () => {
      const taken = Object.fromEntries(
        [
          `${stem}.json`,
          ...Array.from({ length: 9 }, (_u, i) => `${stem}-${String(i + 1)}.json`),
        ].map((name, i) => [name, `old-${String(i)}`]),
      );
      const fs = fakeFs({ ...seed, [storePath]: "{broken", ...taken });
      const target = await targetOf(fs.port);
      const prior = await readDocMetaFile(target, deps(fs.port));

      const code = await codeOfAsync(() =>
        writeDocMetaFile(target, deps(fs.port), prior, tableOf({ "doc.html": RECORD })),
      );

      expect(code).toBe("io_failure");
      expect(fs.textAt(storePath)).toBe("{broken");
      for (const [name, text] of Object.entries(taken)) {
        expect(fs.textAt(name)).toBe(text);
      }
    });

    it("should take the next suffix when a rename loses the race for a name", async () => {
      const fs = fakeFs({ ...seed, [storePath]: "{broken" });
      fs.fail("rename", systemError("EEXIST"));
      const target = await targetOf(fs.port);
      const prior = await readDocMetaFile(target, deps(fs.port));

      await writeDocMetaFile(target, deps(fs.port), prior, tableOf({ "doc.html": RECORD }));

      expect(corruptBackups(fs).map(([name]) => name)).toEqual([`${stem}-1.json`]);
      expect(fs.textAt(`${stem}-1.json`)).toBe("{broken");
      expect(fs.textAt(storePath)).toContain('"tags"');
    });

    it("should fail the write when probing backup names errors", async () => {
      const fs = fakeFs({ ...seed, [storePath]: "{broken" });
      fs.fail("lstat", systemError("EACCES"), (name) => name.includes(".corrupt-"));
      const target = await targetOf(fs.port);
      const prior = await readDocMetaFile(target, deps(fs.port));

      const code = await codeOfAsync(() =>
        writeDocMetaFile(target, deps(fs.port), prior, tableOf({ "doc.html": RECORD })),
      );

      expect(code).toBe("io_failure");
      expect(fs.textAt(storePath)).toBe("{broken");
    });
  });

  it("should still write when the corrupt file vanished between read and write", async () => {
    const fs = fakeFs({ ...seed, [storePath]: "{broken" });
    const target = await targetOf(fs.port);
    const prior = await readDocMetaFile(target, deps(fs.port));
    fs.state.files.delete(storePath);

    await writeDocMetaFile(target, deps(fs.port), prior, tableOf({ "doc.html": RECORD }));

    expect(fs.textAt(storePath)).toContain('"tags"');
  });

  it("should abort the write when the corrupt backup cannot be made", async () => {
    const fs = fakeFs({ ...seed, [storePath]: "{broken" });
    fs.fail("rename", systemError("EACCES"));
    const target = await targetOf(fs.port);
    const prior = await readDocMetaFile(target, deps(fs.port));

    const code = await codeOfAsync(() =>
      writeDocMetaFile(target, deps(fs.port), prior, tableOf({ "doc.html": RECORD })),
    );

    expect(code).toBe("io_failure");
    expect(fs.textAt(storePath)).toBe("{broken");
  });
});
