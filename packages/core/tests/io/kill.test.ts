// 这层管：真实子进程 SIGKILL 的崩溃现场——原文件 sha 不变、tmp 残留、下一次写入清掉它。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile } from "../../src/io";
import { DOC_FILE } from "./fixtures";
import { ARTICLE_DOC } from "./fixtures";
import {
  existsAt,
  readBytesAt,
  readTextAt,
  sha256Of,
  tmpLeftovers,
  withWorkspace,
  writeTextAt,
} from "./harness";
import { fieldOf, spawnFixture } from "./spawn";

const deps = nodePatchDeps;

const rewrite = (dir: string): Promise<unknown> =>
  patchFile(
    {
      workspace: dir,
      file: DOC_FILE,
      request: { targetId: "p1", action: "replace", html: "<p>后</p>" },
    },
    deps,
  );

describe("kill · 写到 tmp 后被 SIGKILL", () => {
  it("should leave the target byte-identical with the tmp still on disk", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, ARTICLE_DOC);
      const before = sha256Of(await readBytesAt(file));
      const worker = spawnFixture("kill-writer.mjs", [file]);
      const ready = await worker.next();
      const tmp = String(fieldOf(ready, "tmp"));

      expect(fieldOf(ready, "ready")).toBe(true);
      expect(await existsAt(tmp)).toBe(true);
      worker.child.kill("SIGKILL");
      expect(await worker.exit).toEqual({ code: null, signal: "SIGKILL" });
      expect(sha256Of(await readBytesAt(file))).toBe(before);
      expect(await existsAt(tmp)).toBe(true);
    });
  });

  it("should sweep the leftover tmp on the next patch and only then change the file", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, ARTICLE_DOC);
      const before = sha256Of(await readBytesAt(file));
      const worker = spawnFixture("kill-writer.mjs", [file]);
      const tmp = String(fieldOf(await worker.next(), "tmp"));
      worker.child.kill("SIGKILL");
      await worker.exit;

      await rewrite(dir);
      expect(await existsAt(tmp)).toBe(false);
      expect(await tmpLeftovers(dir)).toEqual([]);
      expect(sha256Of(await readBytesAt(file))).not.toBe(before);
    });
  });
});

describe("kill · barrier 确实挡在 rename 之前（对照组）", () => {
  it("should change the file when the barrier is released instead of killing", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, ARTICLE_DOC);
      const before = sha256Of(await readBytesAt(file));
      const worker = spawnFixture("kill-writer.mjs", [file]);
      const tmp = String(fieldOf(await worker.next(), "tmp"));
      worker.go();

      expect(await worker.exit).toEqual({ code: 0, signal: null });
      expect(sha256Of(await readBytesAt(file))).not.toBe(before);
      expect(await readTextAt(file)).toBe("half-written payload");
      expect(await existsAt(tmp)).toBe(false);
    });
  });
});
