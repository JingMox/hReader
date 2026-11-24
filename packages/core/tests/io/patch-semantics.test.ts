// 这层管：v2 裁定（AC4' 源码区间拼接 / changed 按写盘字节 / undo 哈希自证 / 锁接管与 tmp pid）。
// 实现未落地时这些用例是红的——红是返工清单，不许改断言迁就实现。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile, undoPatch } from "../../src/io";
import { encodeUtf8 } from "../../src/io/bytes";
import { sha256Hex } from "../../src/io/digest";
import { DOC_FILE } from "./fixtures";
import {
  codeOfAsync,
  depsOf,
  existsAt,
  fakeFs,
  fixedClock,
  historyDirAt,
  historyNamesOf,
  readBytesAt,
  readTextAt,
  recordingSleep,
  sha1Of,
  sha256Of,
  withWorkspace,
  writeBytesAt,
  writeTextAt,
} from "./harness";

const deps = nodePatchDeps;

/** CRLF + 单引号 + 实体 + BOM：整篇重排会在这些地方留下可检测的痕迹。 */
const SPLICE_DOC = [
  "\uFEFF<!DOCTYPE html>",
  "<html lang='zh-CN'><head>",
  "<meta charset='utf-8'>",
  "<title>M1.5 拼接待测</title>",
  "</head><body>",
  "<article data-hr-id='root' class='post'>",
  "<p data-hr-id='p1' class='lead'>第一段&nbsp;实体</p>",
  "<p data-hr-id='p2'>第二段&nbsp;&amp;保留</p>",
  "</article>",
  "</body></html>",
].join("\r\n");

const p1Start = (html: string): number => html.indexOf("<p data-hr-id='p1'");
const p1End = (html: string): number => html.indexOf("</p>", p1Start(html)) + "</p>".length;

describe("patch · 只改目标源码区间", () => {
  it("should keep CRLF, single quotes, entities and the BOM byte-identical outside the target", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, SPLICE_DOC);
      await patchFile(
        {
          workspace: dir,
          file: DOC_FILE,
          request: { targetId: "p1", action: "replace", html: "<p>换</p>" },
        },
        deps,
      );
      const patched = await readTextAt(file);
      const start = p1Start(SPLICE_DOC);
      const end = p1End(SPLICE_DOC);

      expect(patched.slice(0, start)).toBe(SPLICE_DOC.slice(0, start));
      expect(patched.endsWith(SPLICE_DOC.slice(end))).toBe(true);
      expect(patched.startsWith("\uFEFF")).toBe(true);
      expect(patched.slice(1).includes("\uFEFF")).toBe(false);
      expect(patched).toContain("<p data-hr-id='p2'>第二段&nbsp;&amp;保留</p>");
      expect(patched).not.toContain("</p>\n");
    });
  });
});

describe("patch · 只改目标源码区间（续）", () => {
  it("should remove exactly the target interval when deleting", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, SPLICE_DOC);
      await patchFile(
        { workspace: dir, file: DOC_FILE, request: { targetId: "p1", action: "delete" } },
        deps,
      );
      const patched = await readTextAt(file);
      const start = p1Start(SPLICE_DOC);
      const end = p1End(SPLICE_DOC);

      expect(patched).toBe(`${SPLICE_DOC.slice(0, start)}${SPLICE_DOC.slice(end)}`);
      expect(patched).toContain("data-hr-id='p2'");
    });
  });
});

// v3 裁定 #12 覆盖了 v2#2 的字面读法：幂等按"剥 ID 后的内容"判定，
// 内容等价时直接返回原字节（不重注入 ID、changed:false、不留历史）。
describe("patch · 内容等价即原字节返回", () => {
  it("should keep the original bytes and history when only the entity spelling differs", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      const source = '<article data-hr-id="root"><p data-hr-id="p2">第二段&#160;</p></article>';
      await writeTextAt(file, source);
      const before = sha256Of(await readBytesAt(file));
      const result = await patchFile(
        {
          workspace: dir,
          file: DOC_FILE,
          request: { targetId: "p2", action: "replace", html: "<p>第二段\u00A0</p>" },
        },
        deps,
      );

      expect(result.changed).toBe(false);
      expect(sha256Of(await readBytesAt(file))).toBe(before);
      expect(await historyNamesOf(dir, DOC_FILE)).toHaveLength(0);
    });
  });
});

describe("undo · 快照哈希自证", () => {
  it("should name the snapshot with the sha256-16 prefix of the original bytes", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, SPLICE_DOC);
      const before = await readBytesAt(file);
      await patchFile(
        { workspace: dir, file: DOC_FILE, request: { targetId: "p1", action: "delete" } },
        deps,
      );
      const names = await historyNamesOf(dir, DOC_FILE);
      const [name] = names;

      expect(names).toHaveLength(1);
      expect(name).toMatch(/^[0-9a-f]{16}-\d{4}-\d{2}-\d{2}T[\d:.]+Z-\d+\.html$/u);
      expect(name?.startsWith(`${sha256Hex(before).slice(0, 16)}-`)).toBe(true);
    });
  });

  it("should refuse a corrupted snapshot with io_failure and not consume it", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, SPLICE_DOC);
      await patchFile(
        { workspace: dir, file: DOC_FILE, request: { targetId: "p1", action: "delete" } },
        deps,
      );
      const [name] = await historyNamesOf(dir, DOC_FILE);
      const snapshot = join(await historyDirAt(dir, DOC_FILE), name ?? "<missing>");
      await writeBytesAt(snapshot, encodeUtf8("<article dat"));
      const patched = sha256Of(await readBytesAt(file));
      const code = await codeOfAsync(() => undoPatch({ workspace: dir, file: DOC_FILE }, deps));

      expect(code).toBe("io_failure");
      expect(sha256Of(await readBytesAt(file))).toBe(patched);
      expect(await existsAt(snapshot)).toBe(true);
    });
  });
});

const NOW = Date.parse("2026-03-04T05:06:07.008Z");
const WS = "/abs/ws";
const DOC = `${WS}/post.html`;
const LOCK = `${WS}/.hreader/locks/${sha1Of(DOC_FILE)}.lock`;
const DEAD_PID = 999_999;

const fakeDeps = (fake: ReturnType<typeof fakeFs>): ReturnType<typeof depsOf> => {
  const clock = fixedClock(NOW);
  return depsOf(fake.port, clock.clock, recordingSleep(clock).sleep);
};

const patchOnFake = (fake: ReturnType<typeof fakeFs>): ReturnType<typeof patchFile> =>
  patchFile(
    {
      workspace: WS,
      file: DOC_FILE,
      request: { targetId: "p1", action: "replace", html: "<p>换</p>" },
    },
    fakeDeps(fake),
    { lockTimeoutMs: 0 },
  );

describe("patch · 锁接管条件", () => {
  it("should not take over a lock whose pid is alive but 90s old", async () => {
    const fake = fakeFs({
      [DOC]: '<article data-hr-id="root"><p data-hr-id="p1">a</p></article>',
      [LOCK]: JSON.stringify({ pid: process.pid, nonce: "alive-old", at: NOW - 90_000 }),
    });
    const code = await codeOfAsync(() => patchOnFake(fake));

    expect(code).toBe("locked");
    expect(fake.textAt(DOC)).toBe('<article data-hr-id="root"><p data-hr-id="p1">a</p></article>');
    expect(fake.textAt(LOCK)).toContain("alive-old");
  });

  it("should take over a dead-pid lock and leave no steal leftovers", async () => {
    const fake = fakeFs({
      [DOC]: '<article data-hr-id="root"><p data-hr-id="p1">a</p></article>',
      [LOCK]: JSON.stringify({ pid: DEAD_PID, nonce: "dead", at: NOW }),
    });
    const result = await patchOnFake(fake);

    expect(result.changed).toBe(true);
    expect(fake.textAt(DOC)).toContain("换");
    expect(
      [...fake.state.files.keys()].filter((path) => path.startsWith(`${WS}/.hreader/locks/`)),
    ).toEqual([]);
  });
});

describe("patch · tmp 只清死进程", () => {
  it("should keep a live pid tmp and delete a dead pid tmp", async () => {
    const live = `${WS}/.hr-tmp.${String(process.pid)}.live.post.html`;
    const dead = `${WS}/.hr-tmp.${String(DEAD_PID)}.dead.post.html`;
    const fake = fakeFs({
      [DOC]: '<article data-hr-id="root"><p data-hr-id="p1">a</p></article>',
      [live]: "live",
      [dead]: "dead",
    });
    await patchOnFake(fake);

    expect(fake.state.files.has(live)).toBe(true);
    expect(fake.state.files.has(dead)).toBe(false);
  });
});
