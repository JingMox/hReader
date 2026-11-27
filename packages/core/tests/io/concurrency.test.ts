// 这层管：两个真实子进程同时 patch 同一文件——结果只能是一胜一 locked 或串行双成功，绝不允许混合。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile } from "../../src/io";
import { encodeUtf8 } from "../../src/io/bytes";
import { applyPatch } from "../../src/ops/patch-node";
import { ARTICLE_DOC, DOC_FILE } from "./fixtures";
import { childIds, elementById } from "./tree-probe";
import {
  historyNamesOf,
  lockPathAt,
  mkdirAt,
  readBytesAt,
  readTextAt,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "./harness";
import { fieldOf, spawnFixture } from "./spawn";

const A = "<p>甲</p>";
const B = "<p>乙</p>";

const idsOf = (html: string): string[] =>
  [...html.matchAll(/data-hr-id="([^"]+)"/gu)].flatMap((matched) => matched[1] ?? []);

const appendOf = (html: string, fragment: string): string =>
  applyPatch(html, { targetId: "box", action: "append", html: fragment }).html;

const shas = (): {
  readonly a: string;
  readonly b: string;
  readonly ab: string;
  readonly ba: string;
} => {
  const a = appendOf(ARTICLE_DOC, A);
  const b = appendOf(ARTICLE_DOC, B);
  return {
    a: sha256Of(encodeUtf8(a)),
    b: sha256Of(encodeUtf8(b)),
    ab: sha256Of(encodeUtf8(appendOf(a, B))),
    ba: sha256Of(encodeUtf8(appendOf(b, A))),
  };
};

const raceOf = async (
  dir: string,
): Promise<{
  readonly first: unknown;
  readonly second: unknown;
  readonly codes: readonly (number | null)[];
}> => {
  const one = spawnFixture("patch-worker.mjs", [dir, DOC_FILE, A, "0"]);
  const two = spawnFixture("patch-worker.mjs", [dir, DOC_FILE, B, "0"]);
  await one.next();
  await two.next();
  one.go();
  two.go();
  const first = await one.next();
  const second = await two.next();
  const codes = [(await one.exit).code, (await two.exit).code];
  return { first, second, codes };
};

describe("并发 · 两个子进程写同一文件", () => {
  it(
    "should end with exactly one serial result and no mixed tree",
    { timeout: 30_000 },
    async () => {
      await withWorkspace(async (dir) => {
        await writeTextAt(join(dir, DOC_FILE), ARTICLE_DOC);
        const { first, second, codes } = await raceOf(dir);
        const html = await readTextAt(join(dir, DOC_FILE));
        const ok = [fieldOf(first, "ok"), fieldOf(second, "ok")];
        const ids = idsOf(html);

        expect(codes).toEqual([0, 0]);
        expect(ok.filter((value) => value === true).length).toBeGreaterThanOrEqual(1);
        for (const result of [first, second]) {
          if (fieldOf(result, "ok") !== true) expect(fieldOf(result, "code")).toBe("locked");
        }
        if (ok[0] === true && ok[1] === true) {
          expect([shas().ab, shas().ba]).toContain(
            sha256Of(await readBytesAt(join(dir, DOC_FILE))),
          );
          // box 自带 p0：两单串行落进去后孩子是 p0 + 甲 + 乙共三个——
          // 断言 2 只在“一胜一负”分支成立，双胜分支里是错的预期。
          expect(childIds(html, "box")).toHaveLength(3);
        } else {
          const winner = ok[0] === true ? "a" : "b";
          expect(sha256Of(await readBytesAt(join(dir, DOC_FILE)))).toBe(shas()[winner]);
          expect(childIds(html, "box")).toHaveLength(2);
        }
        expect(new Set(ids).size).toBe(ids.length);
        expect(elementById(html, "box")?.node.tag).toBe("section");
        expect(new Set(ids).size).toBeGreaterThan(4);
      });
    },
  );
});

describe("并发 · 锁被活进程占住", () => {
  it(
    "should report locked to a real subprocess and leave the file alone",
    { timeout: 30_000 },
    async () => {
      await withWorkspace(async (dir) => {
        const file = join(dir, DOC_FILE);
        await writeTextAt(file, ARTICLE_DOC);
        const before = sha256Of(await readBytesAt(file));
        const lock = await lockPathAt(dir, DOC_FILE);
        await mkdirAt(join(dir, ".hreader", "locks"));
        await writeTextAt(
          lock,
          JSON.stringify({ pid: process.pid, nonce: "parentparent", at: Date.now() }),
        );
        const worker = spawnFixture("patch-worker.mjs", [dir, DOC_FILE, A, "0"]);
        await worker.next();
        worker.go();
        const result = await worker.next();

        expect(fieldOf(result, "ok")).toBe(false);
        expect(fieldOf(result, "code")).toBe("locked");
        expect(await worker.exit).toEqual({ code: 0, signal: null });
        expect(sha256Of(await readBytesAt(file))).toBe(before);
        expect(await readTextAt(lock)).toContain("parentparent");
      });
    },
  );
});

describe("并发 · 锁被活进程占住（续）", () => {
  it("should still apply a normal patch when no one holds the lock", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, DOC_FILE), ARTICLE_DOC);
      const result = await patchFile(
        { workspace: dir, file: DOC_FILE, request: { targetId: "p1", action: "delete" } },
        nodePatchDeps,
      );

      const html = await readTextAt(join(dir, DOC_FILE));
      expect(result.changed).toBe(true);
      expect(elementById(html, "p1")).toBeUndefined();
      expect(elementById(html, "p2")?.node.kind).toBe("element");
      expect(await historyNamesOf(dir, DOC_FILE)).toHaveLength(1);
    });
  });
});
