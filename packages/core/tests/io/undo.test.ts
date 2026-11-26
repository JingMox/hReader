// 这层管：undo 的错误分支与"历史/快照工具"的读目录、裁剪、排序细节（假 fs 精确控错）。

import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../src/io/bytes";
import {
  HISTORY_LIMIT,
  latestOf,
  listSnapshots,
  pruneSnapshots,
  writeSnapshot,
} from "../../src/io/history";
import { undoPatch } from "../../src/io/undo";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  sha1Of,
  sha256Of,
  systemError,
  type FakeFs,
} from "./harness";

const NOW = 1_700_000_000_000;
const WS = "/ws";
const DOC = `${WS}/a.html`;
const HISTORY = `${WS}/.hreader/history/${sha1Of("a.html")}`;
const LOCK = `${WS}/.hreader/locks/${sha1Of("a.html")}.lock`;

/** 快照名带内容 sha 前缀，undo 前自证没被截断。 */
const snapName = (data: string, seq: number, at = "2026-01-02T03:04:05.006Z"): string =>
  `${HISTORY}/${sha256Of(encodeUtf8(data)).slice(0, 16)}-${at}-${String(seq)}.html`;
const SNAPSHOT = snapName("orig", 1);

const depsFor = (fake: FakeFs): ReturnType<typeof depsOf> => {
  const clock = fixedClock(NOW);
  return depsOf(fake.port, clock.clock, recordingSleep(clock).sleep);
};

const undoAt = (fake: FakeFs): Promise<unknown> =>
  undoPatch({ workspace: WS, file: "a.html" }, depsFor(fake));

describe("undoPatch · 还原", () => {
  it("should restore the snapshot bytes, delete it and report the sha", async () => {
    const fake = fakeFs({ [DOC]: "now", [SNAPSHOT]: "orig" });
    const result = await undoAt(fake);

    expect(fake.textAt(DOC)).toBe("orig");
    expect(fake.state.files.has(SNAPSHOT)).toBe(false);
    expect(Reflect.get(Object(result), "sha256")).toBe(sha256Of(encodeUtf8("orig")));
    expect(Reflect.get(Object(result), "bytes")).toBe(4);
    expect(Reflect.get(Object(result), "restoredFrom")).toBe(SNAPSHOT);
  });

  it("should restore binary snapshot bytes without decoding them", async () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00]);
    const name = `${HISTORY}/${sha256Of(binary).slice(0, 16)}-2026-01-02T03:04:05.006Z-1.html`;
    const fake = fakeFs({ [DOC]: "now", [name]: "placeholder" });
    fake.state.files.set(name, binary);
    await undoAt(fake);

    expect(Array.from(fake.state.files.get(DOC) ?? [])).toEqual([0xff, 0xfe, 0x00]);
  });

  it("should refuse with undo_unavailable and touch nothing when history is empty", async () => {
    const fake = fakeFs({ [DOC]: "now" });
    expect(await codeOfAsync(() => undoAt(fake))).toBe("undo_unavailable");
    expect(fake.textAt(DOC)).toBe("now");
  });
});

describe("undoPatch · 失败时原文件不动", () => {
  it("should keep the file when the restore write fails", async () => {
    const fake = fakeFs({ [DOC]: "now", [SNAPSHOT]: "orig" });
    fake.fail("writeFileAtomic", systemError("EXDEV"));

    expect(await codeOfAsync(() => undoAt(fake))).toBe("io_failure");
    expect(fake.textAt(DOC)).toBe("now");
    expect(fake.state.files.has(SNAPSHOT)).toBe(true);
  });

  it("should leave a restored file but report io_failure when the snapshot cannot be deleted", async () => {
    const fake = fakeFs({ [DOC]: "now", [SNAPSHOT]: "orig" });
    fake.fail("unlink", systemError("EACCES"), (path) => path === SNAPSHOT);

    expect(await codeOfAsync(() => undoAt(fake))).toBe("io_failure");
    expect(fake.textAt(DOC)).toBe("orig");
    expect(fake.state.files.has(SNAPSHOT)).toBe(true);
  });
});

describe("undoPatch · 失败时原文件不动（续）", () => {
  it("should refuse a snapshot whose bytes no longer match its name", async () => {
    const fake = fakeFs({ [DOC]: "now", [SNAPSHOT]: "tampered" });

    expect(await codeOfAsync(() => undoAt(fake))).toBe("io_failure");
    expect(fake.textAt(DOC)).toBe("now");
    expect(fake.state.files.has(SNAPSHOT)).toBe(true);
  });

  it("should not write when another process holds the lock", async () => {
    const fake = fakeFs({
      [DOC]: "now",
      [SNAPSHOT]: "orig",
      [LOCK]: JSON.stringify({ pid: process.pid, nonce: "abcdefabcdef", at: NOW }),
    });
    expect(await codeOfAsync(() => undoAt(fake))).toBe("locked");
    expect(fake.textAt(DOC)).toBe("now");
    expect(fake.state.files.has(SNAPSHOT)).toBe(true);
  });

  it("should report io_failure when the history directory cannot be read", async () => {
    const fake = fakeFs({ [DOC]: "now", [`${HISTORY}/notes.txt`]: "x" });
    fake.fail("readdir", systemError("EACCES"));

    expect(await codeOfAsync(() => undoAt(fake))).toBe("io_failure");
    expect(fake.textAt(DOC)).toBe("now");
  });
});

describe("history · 工具层细节", () => {
  it("should order snapshots by sequence number, not by raw string", async () => {
    const fake = fakeFs({
      [DOC]: "x",
      [`${HISTORY}/0123456789abcdef-2026-01-02T03:04:05.006Z-9.html`]: "9",
      [`${HISTORY}/0123456789abcdef-2026-01-02T03:04:05.006Z-10.html`]: "10",
    });
    const snapshots = await listSnapshots(depsFor(fake), HISTORY);

    expect(snapshots.map((snapshot) => snapshot.seq)).toEqual([9, 10]);
    expect(latestOf(snapshots)?.seq).toBe(10);
  });

  it("should ignore names that do not carry a hash prefix", async () => {
    const fake = fakeFs({
      [DOC]: "x",
      [`${HISTORY}/2026-01-02T03:04:05.006Z-1.html`]: "legacy",
    });

    expect(await listSnapshots(depsFor(fake), HISTORY)).toEqual([]);
  });

  it("should surface a real readdir failure but treat a missing directory as empty", async () => {
    const missing = fakeFs({ [DOC]: "x" });
    expect(await listSnapshots(depsFor(missing), HISTORY)).toEqual([]);

    const broken = fakeFs({ [DOC]: "x", [`${HISTORY}/notes.txt`]: "x" });
    broken.fail("readdir", systemError("EACCES"));
    expect(await codeOfAsync(() => listSnapshots(depsFor(broken), HISTORY))).toBe("io_failure");
  });
});

describe("history · 工具层细节（续）", () => {
  it("should prune the oldest and fail loudly when a snapshot cannot be deleted", async () => {
    const seed: Record<string, string> = { [DOC]: "x" };
    for (let seq = 1; seq <= HISTORY_LIMIT + 2; seq += 1) {
      seed[`${HISTORY}/0123456789abcdef-2026-01-02T03:04:05.006Z-${String(seq)}.html`] =
        String(seq);
    }
    const fake = fakeFs(seed);
    await pruneSnapshots(depsFor(fake), HISTORY);
    const kept = (await listSnapshots(depsFor(fake), HISTORY)).map((snapshot) => snapshot.seq);
    expect(kept).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const failing = fakeFs(seed);
    failing.fail("unlink", systemError("EACCES"));
    expect(await codeOfAsync(() => pruneSnapshots(depsFor(failing), HISTORY))).toBe("io_failure");
  });
});

describe("history · 工具层细节（尾）", () => {
  it("should increment the sequence within the same millisecond and wrap write errors", async () => {
    const fake = fakeFs({ [DOC]: "x" });
    const deps = depsFor(fake);
    const first = await writeSnapshot(
      { dir: HISTORY, workspace: WS, data: encodeUtf8("one") },
      deps,
    );
    const second = await writeSnapshot(
      { dir: HISTORY, workspace: WS, data: encodeUtf8("one") },
      deps,
    );

    const at = new Date(NOW).toISOString();
    expect(first).toBe(`${HISTORY}/7692c3ad3540bb80-${at}-1.html`);
    expect(second).toBe(`${HISTORY}/7692c3ad3540bb80-${at}-2.html`);

    const failing = fakeFs({ [DOC]: "x" });
    failing.fail("mkdir", systemError("EACCES"));
    expect(
      await codeOfAsync(() =>
        writeSnapshot({ dir: HISTORY, workspace: WS, data: encodeUtf8("x") }, depsFor(failing)),
      ),
    ).toBe("io_failure");
  });
});
