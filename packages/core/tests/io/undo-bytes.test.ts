// 这层管：undo 的字节级还原（BOM / CRLF / 非 ASCII / 无末尾换行）与 undo 的失败路径；不测历史裁剪。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile, undoPatch } from "../../src/io";
import { encodeUtf8 } from "../../src/io/bytes";
import { ARTICLE_DOC, DOC_FILE } from "./fixtures";
import {
  codeOfAsync,
  existsAt,
  fixedClock,
  fakeFs,
  depsOf,
  historyDirAt,
  historyNamesOf,
  lockPathAt,
  readBytesAt,
  recordingSleep,
  writeBytesAt,
  withWorkspace,
  sha1Of,
  sha256Of,
} from "./harness";

const deps = nodePatchDeps;

interface ByteCase {
  readonly name: string;
  readonly content: string;
}

const BASE = `${ARTICLE_DOC}\n`;

const BYTE_CASES: ByteCase[] = [
  { name: "BOM", content: `\uFEFF${BASE}` },
  { name: "CRLF", content: BASE.replaceAll("\n", "\r\n") },
  { name: "non-ASCII", content: BASE.replace("第二段", "第二段 🎉 &amp; &#128512; 中文") },
  { name: "no trailing newline", content: ARTICLE_DOC },
];

const patchOne = (dir: string): ReturnType<typeof patchFile> =>
  patchFile(
    {
      workspace: dir,
      file: DOC_FILE,
      request: { targetId: "p1", action: "replace", html: "<p>改</p>" },
    },
    deps,
  );

describe("undo · 字节级还原", () => {
  it.each(BYTE_CASES)("should restore $name byte for byte", async ({ content }) => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeBytesAt(file, new TextEncoder().encode(content));
      const beforeBytes = await readBytesAt(file);
      const before = sha256Of(beforeBytes);
      const patched = await patchOne(dir);
      expect(patched.changed).toBe(true);
      expect(sha256Of(await readBytesAt(file))).not.toBe(before);
      const names = await historyNamesOf(dir, DOC_FILE);
      expect(names).toHaveLength(1);
      const snapshotPath = join(await historyDirAt(dir, DOC_FILE), names[0] ?? "<missing>");
      expect(sha256Of(await readBytesAt(snapshotPath))).toBe(before);
      const undone = await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      expect(undone.sha256).toBe(before);
      expect(undone.bytes).toBe(beforeBytes.length);
      expect(undone.restoredFrom).toBe(snapshotPath);
      expect(Array.from(await readBytesAt(file))).toEqual(Array.from(beforeBytes));
      expect(await existsAt(snapshotPath)).toBe(false);
      expect(await existsAt(await lockPathAt(dir, DOC_FILE))).toBe(false);
    });
  });
});

describe("undo · 无快照与失败路径", () => {
  it("should report undo_unavailable and leave the file alone", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeBytesAt(file, new TextEncoder().encode(ARTICLE_DOC));
      const before = sha256Of(await readBytesAt(file));
      const code = await codeOfAsync(() => undoPatch({ workspace: dir, file: DOC_FILE }, deps));
      expect(code).toBe("undo_unavailable");
      expect(sha256Of(await readBytesAt(file))).toBe(before);
    });
  });

  it("should keep the snapshot and the file when the atomic restore fails", async () => {
    const snapshot = `/abs/ws/.hreader/history/${sha1Of(DOC_FILE)}/${sha256Of(encodeUtf8("OLD")).slice(0, 16)}-2026-01-01T00:00:00.000Z-1.html`;
    const fs = fakeFs({ "/abs/ws/post.html": ARTICLE_DOC, [snapshot]: "OLD" });
    const clock = fixedClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const sleep = recordingSleep();
    fs.fail("writeFileAtomic", Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    const code = await codeOfAsync(() =>
      undoPatch(
        { workspace: "/abs/ws", file: DOC_FILE },
        depsOf(fs.port, clock.clock, sleep.sleep),
      ),
    );
    expect(code).toBe("io_failure");
    expect(fs.textAt("/abs/ws/post.html")).toBe(ARTICLE_DOC);
    expect(fs.state.files.has(snapshot)).toBe(true);
    expect(fs.state.files.has(`/abs/ws/.hreader/locks/${sha1Of(DOC_FILE)}.lock`)).toBe(false);
  });
});
