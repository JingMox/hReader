// This layer: `io/annotation-store.ts` — file naming, corruption-tolerant reads, and the
// locked-write pipeline (size cap refusal, corrupt backup rename, atomic landing).
// The fake fs port injects every failure mode a real disk can produce.

import { describe, expect, it } from "vitest";

import {
  annotationDirOf,
  annotationFileOf,
  readSidecarFile,
  writeSidecarFile,
} from "../../src/io/annotation-store";
import { resolveTarget } from "../../src/io/paths";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  sha1Of,
  systemError,
} from "../io/harness";

const CLOCK = fixedClock(Date.parse("2026-11-27T00:00:00.000Z")).clock;
const SLEEP = recordingSleep().sleep;

const DOC = "<html><body><p>x</p></body></html>";
const seed = { "/ws/doc.html": DOC };

const targetOf = async (fs: ReturnType<typeof fakeFs>["port"], file = "doc.html") =>
  resolveTarget({ workspace: "/ws", file }, fs);

const deps = (fs: ReturnType<typeof fakeFs>["port"]) => depsOf(fs, CLOCK, SLEEP);

const annotation = {
  id: "an-00000000",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "x", prefix: "", suffix: "", start: 0 },
  note: "批注",
  status: "pending" as const,
  createdAt: "2024-01-01T00:00:00.000Z",
  author: "user" as const,
  replies: [],
};

const storePathOf = (file = "doc.html") => `/ws/.hreader/annotations/${sha1Of(file)}.json`;

const storeJson = (file: string, annotations: readonly unknown[]): string =>
  JSON.stringify({ version: 1, path: file, annotations });

describe("annotationFileOf · naming", () => {
  it("should name the file <sha1 of the POSIX relative path>.json under .hreader/annotations", async () => {
    const fs = fakeFs(seed);
    const target = await targetOf(fs.port);

    expect(annotationDirOf(target)).toBe("/ws/.hreader/annotations");
    expect(annotationFileOf(target)).toBe(storePathOf());
  });
});

describe("readSidecarFile · read outcomes", () => {
  it("should report an empty non-corrupt store when the file does not exist", async () => {
    const fs = fakeFs(seed);
    const read = await readSidecarFile(await targetOf(fs.port), deps(fs.port));

    expect(read).toEqual({ exists: false, corrupt: false, annotations: [], diagnostics: [] });
  });

  it("should map a non-ENOENT read failure to io_failure", async () => {
    const fs = fakeFs(seed);
    fs.fail("readFile", systemError("EACCES"), (path) => path.includes("annotations"));
    const target = await targetOf(fs.port);

    expect(await codeOfAsync(() => readSidecarFile(target, deps(fs.port)))).toBe("io_failure");
  });

  it("should read a valid store back to its records", async () => {
    const fs = fakeFs({ ...seed, [storePathOf()]: storeJson("doc.html", [annotation]) });
    const read = await readSidecarFile(await targetOf(fs.port), deps(fs.port));

    expect(read.exists).toBe(true);
    expect(read.corrupt).toBe(false);
    expect(read.annotations).toEqual([annotation]);
    expect(read.diagnostics).toEqual([]);
  });

  it("should read an oversized file as empty and corrupt", async () => {
    const big = " ".repeat(5 * 1024 * 1024 + 1);
    const fs = fakeFs({ ...seed, [storePathOf()]: big });
    const read = await readSidecarFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(true);
    expect(read.annotations).toEqual([]);
    expect(read.diagnostics[0]).toContain("字节上限");
  });

  it("should read invalid UTF-8 bytes as empty and corrupt", async () => {
    const fs = fakeFs(seed);
    fs.state.files.set(storePathOf(), new Uint8Array([0xff, 0xfe, 0xfd]));
    const read = await readSidecarFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(true);
    expect(read.diagnostics).toEqual(["侧车批注文件不是合法 UTF-8，按空批注处理"]);
  });

  it("should surface per-record diagnostics without marking the file corrupt", async () => {
    const fs = fakeFs({ ...seed, [storePathOf()]: storeJson("doc.html", [null]) });
    const read = await readSidecarFile(await targetOf(fs.port), deps(fs.port));

    expect(read.corrupt).toBe(false);
    expect(read.annotations).toEqual([]);
    expect(read.diagnostics).toEqual(["annotations[0] 不是对象，已跳过"]);
  });
});

describe("writeSidecarFile · landing", () => {
  it("should write a serialized store that reads back identically", async () => {
    const fs = fakeFs(seed);
    const target = await targetOf(fs.port);
    const prior = await readSidecarFile(target, deps(fs.port));

    await writeSidecarFile(target, deps(fs.port), prior, [annotation]);
    const read = await readSidecarFile(target, deps(fs.port));

    expect(read.annotations).toEqual([annotation]);
    expect(read.corrupt).toBe(false);
  });

  it("should refuse a payload above the file-size cap with invalid_payload", async () => {
    const fs = fakeFs(seed);
    const target = await targetOf(fs.port);
    const prior = await readSidecarFile(target, deps(fs.port));
    const huge = Array.from({ length: 3_000 }, (_u, index) => ({
      ...annotation,
      id: `an-${String(index)}`,
      note: "n".repeat(2_000),
    }));

    const code = await codeOfAsync(() => writeSidecarFile(target, deps(fs.port), prior, huge));

    expect(code).toBe("invalid_payload");
    expect(await readSidecarFile(target, deps(fs.port))).toMatchObject({ exists: false });
  });

  it("should rename a corrupt file aside before writing the fresh one", async () => {
    const path = storePathOf();
    const original = "{broken json";
    const fs = fakeFs({ ...seed, [path]: original });
    const target = await targetOf(fs.port);
    const prior = await readSidecarFile(target, deps(fs.port));

    await writeSidecarFile(target, deps(fs.port), prior, [annotation]);

    const backup = `/ws/.hreader/annotations/${sha1Of("doc.html")}.corrupt-${CLOCK.now().toISOString()}.json`;
    expect(fs.textAt(backup)).toBe(original);
    expect(fs.textAt(path)).toBe(
      JSON.stringify({ version: 1, path: "doc.html", annotations: [annotation] }),
    );
    expect((await readSidecarFile(target, deps(fs.port))).annotations).toEqual([annotation]);
  });

  it("should still write when the corrupt file vanished between read and write", async () => {
    const path = storePathOf();
    const fs = fakeFs({ ...seed, [path]: "{broken" });
    const target = await targetOf(fs.port);
    const prior = await readSidecarFile(target, deps(fs.port));
    fs.state.files.delete(path);

    await writeSidecarFile(target, deps(fs.port), prior, [annotation]);

    expect(fs.textAt(path)).toContain('"annotations"');
  });

  it("should abort the write when the corrupt backup cannot be made", async () => {
    const path = storePathOf();
    const fs = fakeFs({ ...seed, [path]: "{broken" });
    fs.fail("rename", systemError("EACCES"));
    const target = await targetOf(fs.port);
    const prior = await readSidecarFile(target, deps(fs.port));

    const code = await codeOfAsync(() =>
      writeSidecarFile(target, deps(fs.port), prior, [annotation]),
    );

    expect(code).toBe("io_failure");
    // Never silently overwrite: the corrupt bytes stay in place when the backup fails.
    expect(fs.textAt(path)).toBe("{broken");
  });
});
