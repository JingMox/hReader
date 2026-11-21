// 这层管：`exportPrintCommand` 的进程内行为（json 键集 / dropped_images / 4 MiB 上限 / 落盘与错误归口）；不起子进程。

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { exportPrintCommand } from "../src/commands/exportPrint";
import { keysOf, withTempDir } from "./harness";
import {
  ARTICLE,
  LIMIT,
  dataOf,
  fieldOfData,
  inputOf,
  jsonOf,
  writeProductOfBytes,
} from "./export-print-fixtures";

/**
 * 一律拿**真实路径**当 workspace：`run.ts` 在调命令前已把 workspace 与 `--out` 都真实化，
 * 而 macOS 的 `$TMPDIR` 是 `/var/...`、`realpath` 后是 `/private/var/...`——两侧不统一，
 * 词法越界判定会把同一个目录当成两个。
 */
const withRealDir = async (
  run: (dir: string) => Promise<void>,
  timeoutMs?: number,
): Promise<void> =>
  withTempDir(async (raw) => {
    await run(realpathSync(raw));
  }, timeoutMs);

describe("exportPrintCommand · --json 键集精确", () => {
  // 键集是**精确**契约（docs/05）：不多不少这四个，`out:null` / `droppedImages:0` 都不省键。
  it("should emit exactly ok/data with the four contract data keys", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      writeFileSync(path, ARTICLE);
      const envelope = await jsonOf(inputOf(path, { json: true }));
      expect(keysOf(envelope)).toEqual(["ok", "data"]);
      expect(keysOf(dataOf(envelope))).toEqual(["html", "bytes", "droppedImages", "out"]);
    });
  });
});

describe("exportPrintCommand · dropped_images", () => {
  it("should count only <img> and svg <image>, not <video>", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "mixed.html");
      writeFileSync(
        path,
        [
          "<article><h1>媒体</h1><p>一段。</p>",
          '<img src="https://cdn.example/a.png" alt="一">',
          '<svg><image href="https://cdn.example/b.png"></image></svg>',
          '<video src="https://cdn.example/c.mp4"></video>',
          "</article>",
        ].join(""),
      );
      const warnings: string[] = [];
      const envelope = await jsonOf(
        inputOf(path, { json: true, warn: (message) => warnings.push(message) }),
      );
      expect(fieldOfData(envelope, "droppedImages")).toBe(2);
      expect(warnings).toEqual(["已移除 2 个外部图片\n"]);
    });
  });

  it("should keep droppedImages=0 in json and stay silent on stderr", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "clean.html");
      writeFileSync(path, "<article><h1>干净</h1><p>一句。</p></article>");
      const warnings: string[] = [];
      const envelope = await jsonOf(
        inputOf(path, { json: true, warn: (message) => warnings.push(message) }),
      );
      expect(fieldOfData(envelope, "droppedImages")).toBe(0);
      expect(warnings).toEqual([]);
    });
  });
});

describe("exportPrintCommand · stdout 与人读行", () => {
  it("should print the raw printable html when --json is off", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      writeFileSync(path, ARTICLE);
      expect(await exportPrintCommand(inputOf(path))).toContain("<!DOCTYPE html>");
    });
  });

  it("should reject a --out whose parent is a regular file", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      writeFileSync(path, ARTICLE);
      writeFileSync(join(dir, "not-dir"), "x");
      await expect(
        exportPrintCommand(inputOf(path, { out: join(dir, "not-dir/print.html") })),
      ).rejects.toMatchObject({ code: "io_failure" });
    });
  });
});

describe("exportPrintCommand · 4 MiB 三档（契约是 > limit 才拒）", () => {
  it("should accept limit-1 / limit and reject limit+1", async () => {
    await withRealDir(async (dir) => {
      for (const target of [LIMIT - 2, LIMIT - 1, LIMIT]) {
        const out = join(dir, `out-${String(target)}.html`);
        const envelope = await jsonOf(
          inputOf(await writeProductOfBytes(dir, target), { out, json: true }),
        );
        expect(fieldOfData(envelope, "bytes")).toBe(target);
        expect(statSync(out).size).toBe(target);
      }

      const overOut = join(dir, "over.html");
      await expect(
        exportPrintCommand(inputOf(await writeProductOfBytes(dir, LIMIT + 1), { out: overOut })),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(existsSync(overOut)).toBe(false);
    }, 120_000);
  }, 120_000);
});

describe("exportPrintCommand · 落盘与错误归口", () => {
  it("should refuse an existing target with a --force hint", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      const out = join(dir, "print.html");
      writeFileSync(path, ARTICLE);
      writeFileSync(out, "旧内容");
      const message = await exportPrintCommand(inputOf(path, { out })).catch((error: unknown) =>
        error instanceof HrError ? error.message : "",
      );
      expect(message).toContain("--force");
      expect(readFileSync(out, "utf8")).toBe("旧内容");
    });
  });

  it("should overwrite an existing target under --force", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      const out = join(dir, "print.html");
      writeFileSync(path, ARTICLE);
      writeFileSync(out, "旧内容");
      await exportPrintCommand(inputOf(path, { out, force: true }));
      expect(readFileSync(out, "utf8")).toContain("<!DOCTYPE html>");
    });
  });
});

describe("exportPrintCommand · 原子写与逃逸", () => {
  it("should leave no target and no tmp residue when the parent dir is unwritable", async () => {
    if (process.getuid?.() === 0) return;
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      writeFileSync(path, ARTICLE);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      try {
        const out = join(locked, "print.html");
        await expect(exportPrintCommand(inputOf(path, { out }))).rejects.toMatchObject({
          code: "io_failure",
        });
        expect(existsSync(out)).toBe(false);
        expect(readdirSync(locked).filter((name) => name.startsWith(".hr-tmp."))).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    });
  }, 60_000);

  // 换回 `writeFile` 时目标符号链接会被跟随写入：连同"链接目标未被改动"一起杀掉那个变异。
  it("should refuse a symlinked target and keep the link target untouched", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      writeFileSync(path, ARTICLE);
      const outside = join(dir, "outside.html");
      writeFileSync(outside, "别动我");
      const link = join(dir, "link.html");
      symlinkSync(outside, link);
      await expect(
        exportPrintCommand(inputOf(path, { out: link, force: true })),
      ).rejects.toMatchObject({ code: "path_outside_workspace" });
      expect(readFileSync(outside, "utf8")).toBe("别动我");
    });
  });
});
