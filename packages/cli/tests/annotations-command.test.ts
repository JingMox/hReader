// This layer covers `hr annotations <list|migrate>` end to end — both output modes, the merged
// meta+sidecar view, status filtering, usage/exit codes, migrate idempotence, and locale paths.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { serializeSidecarFile, type SidecarAnnotation } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { fieldOf, keysOf, parseJsonLine, withTempDir } from "./harness";
import { runIn, type Captured } from "./support/capture";

const jsonData = (result: Captured): Record<string, unknown> => {
  const envelope = parseJsonLine(result.stdout);
  return fieldOf(envelope, "data") as Record<string, unknown>;
};

const MANAGED = `<!doctype html>
<html><head><meta charset="utf-8"><title>t</title></head>
<body><article data-hr-id="a1">
<script id="hr-meta" type="application/json">{"version":"1.0","annotations":[{"id":"ann-1","nodeId":"p1","anchor":{"exact":"正文","prefix":"","suffix":"","start":0},"comment":"换成新数据","status":"pending","createdAt":"2026-11-01T00:00:00.000Z"},{"id":"ann-2","nodeId":"p1","anchor":{"exact":"正文","prefix":"","suffix":"","start":0},"comment":"已结","status":"resolved","createdAt":"2026-11-02T00:00:00.000Z"}]}</script>
<h1 data-hr-id="h1">标题</h1><p data-hr-id="p1">正文</p></article></body></html>`;

const FOREIGN = "<html><body><p>正文</p></body></html>";

const sidecarRecord = (patch: Partial<SidecarAnnotation> = {}): SidecarAnnotation => ({
  id: "an-side",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
  note: "侧车批注",
  status: "pending",
  createdAt: "2026-11-27T00:00:00.000Z",
  author: "user",
  replies: [],
  ...patch,
});

/** Where `annotationFileOf` looks: `.hreader/annotations/<sha1 of workspace-relative path>.json`. */
const seedStore = (dir: string, file: string, annotations: readonly SidecarAnnotation[]): void => {
  const store = join(
    dir,
    ".hreader",
    "annotations",
    `${createHash("sha1").update(file, "utf8").digest("hex")}.json`,
  );
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, serializeSidecarFile(file, annotations));
};

describe("hr annotations list", () => {
  it("should print one line per merged annotation in human mode", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);
      seedStore(dir, "doc.html", [sidecarRecord()]);

      const result = await runIn(dir, ["annotations", "list", "doc.html"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("annotations doc.html（共 3 条）");
      expect(result.stdout).toContain("[pending] ann-1 (meta)");
      expect(result.stdout).toContain("[pending] an-side (sidecar)");
      expect(result.stdout).toContain("[resolved] ann-2 (meta)");
      expect(result.stdout).toContain("已定位");
    });
  });

  it("should print the { path, annotations, diagnostics } envelope with --json", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);
      seedStore(dir, "doc.html", [sidecarRecord()]);

      const result = await runIn(dir, ["annotations", "list", "doc.html", "--json"]);

      expect(result.code).toBe(0);
      const data = jsonData(result);
      expect(keysOf(data)).toEqual(["path", "annotations", "diagnostics"]);
      const entries = data["annotations"] as Record<string, unknown>[];
      const byId = new Map(entries.map((entry) => [entry["id"], entry]));
      expect(byId.get("ann-1")?.["source"]).toBe("meta");
      expect(byId.get("an-side")?.["source"]).toBe("sidecar");
      expect(byId.get("an-side")?.["nodeId"]).toBeNull();
      const relocation = byId.get("an-side")?.["relocation"] as Record<string, unknown>;
      expect(relocation["ok"]).toBe(true);
    });
  });

  it("should cut a fat record's id/nodeId/selector at the field cap in both output modes", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), FOREIGN);
      const fat = "x".repeat(5000);
      seedStore(dir, "doc.html", [sidecarRecord({ id: fat, nodeId: fat, selector: fat })]);

      const human = await runIn(dir, ["annotations", "list", "doc.html"]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("x".repeat(200));
      expect(human.stdout).not.toContain(fat);

      const json = await runIn(dir, ["annotations", "list", "doc.html", "--json"]);
      const entries = jsonData(json)["annotations"] as Record<string, unknown>[];
      expect(entries[0]?.["id"]).toBe("x".repeat(200));
      expect(entries[0]?.["nodeId"]).toBe("x".repeat(200));
      expect(entries[0]?.["selector"]).toBe("x".repeat(200));
    });
  });

  it("should mark an unrelocatable annotation as 未定位 in human mode and ok:false in --json", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), FOREIGN);
      seedStore(dir, "doc.html", [
        sidecarRecord({
          id: "an-lost",
          selector: "body > p:nth-of-type(9)",
          anchor: { exact: "已删文本", prefix: "", suffix: "", start: 0 },
        }),
      ]);

      const human = await runIn(dir, ["annotations", "list", "doc.html"]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("未定位（");

      const json = await runIn(dir, ["annotations", "list", "doc.html", "--json"]);
      const entries = jsonData(json)["annotations"] as Record<string, unknown>[];
      const relocation = entries[0]?.["relocation"] as Record<string, unknown>;
      expect(relocation["ok"]).toBe(false);
      expect(typeof relocation["reason"]).toBe("string");
    });
  });

  it("should filter by --status", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);

      const resolved = await runIn(dir, [
        "annotations",
        "list",
        "doc.html",
        "--status",
        "resolved",
      ]);
      expect(resolved.code).toBe(0);
      expect(resolved.stdout).toContain("共 1 条");
      expect(resolved.stdout).toContain("ann-2");

      const pending = await runIn(dir, ["annotations", "list", "doc.html", "--status", "pending"]);
      expect(pending.stdout).toContain("ann-1");
      expect(pending.stdout).not.toContain("ann-2");
    });
  });

  it("should warn about a corrupt store on stderr without sinking the command", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), FOREIGN);
      const store = join(
        dir,
        ".hreader",
        "annotations",
        `${createHash("sha1").update("doc.html", "utf8").digest("hex")}.json`,
      );
      mkdirSync(dirname(store), { recursive: true });
      writeFileSync(store, "{{{");

      const result = await runIn(dir, ["annotations", "list", "doc.html"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("warning:");
      expect(result.stdout).toContain("共 0 条");
    });
  });

  it("should report a missing file as a frozen failure, not a crash", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["annotations", "list", "gone.html"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("不存在");
    });
  });

  it("should emit no host path anywhere — hostile store, both modes, migrate included", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);
      const storeDir = join(dir, ".hreader", "annotations");
      mkdirSync(storeDir, { recursive: true });
      const storeName = `${createHash("sha1").update("doc.html", "utf8").digest("hex")}.json`;
      // doc.html's own record claims an escaping path → mismatch diagnostic, never an echo.
      writeFileSync(
        join(storeDir, storeName),
        '{"version":1,"path":"../../etc/passwd","annotations":[]}',
      );
      writeFileSync(join(storeDir, "corrupt.json"), "{{{");
      writeFileSync(
        join(storeDir, "escape01.json"),
        serializeSidecarFile("../../etc/passwd", [sidecarRecord()]),
      );

      const surfaces = [];
      for (const argv of [
        ["annotations", "list", "doc.html"],
        ["annotations", "list", "doc.html", "--json"],
        ["annotations", "migrate", "doc.html", "--json"],
        ["annotations", "migrate", "doc.html"],
      ]) {
        surfaces.push(await runIn(dir, argv));
      }
      const blob = surfaces.map((r) => `${r.stdout}\n${r.stderr}`).join("\n");
      for (const banned of ["/Users", "/private", "/tmp", "/var", dir, realpathSync(dir)]) {
        expect(blob).not.toContain(banned);
      }
      // The migrate snapshot receipt stays useful: a workspace-relative history path.
      expect(blob).toContain(".hreader/history/");
      // The frozen missing-file wording echoes the resolved absolute — identical for every
      // file-targeting command (`hr check`, `hr patch`…) and pinned above; not a new leak.
      const missing = await runIn(dir, ["annotations", "list", "gone.html"]);
      expect(missing.code).not.toBe(0);
    });
  });
});

describe("hr annotations migrate", () => {
  it("should move hr-meta annotations into the sidecar file, idempotently", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);

      const first = await runIn(dir, ["annotations", "migrate", "doc.html"]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("migrated doc.html");
      expect(first.stdout).toContain("迁移 2 条");
      // The meta annotations are now in the sidecar store and gone from the document.
      const store = join(
        dir,
        ".hreader",
        "annotations",
        `${createHash("sha1").update("doc.html", "utf8").digest("hex")}.json`,
      );
      const stored = JSON.parse(readFileSync(store, "utf8")) as Record<string, unknown>;
      expect((stored["annotations"] as unknown[]).length).toBe(2);
      expect(readFileSync(join(dir, "doc.html"), "utf8")).not.toContain('"ann-1"');

      const second = await runIn(dir, ["annotations", "migrate", "doc.html"]);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("unchanged");
    });
  });

  it("should report { path, migrated, skipped, changed, historyPath, diagnostics } with --json", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);

      const result = await runIn(dir, ["annotations", "migrate", "doc.html", "--json"]);

      expect(result.code).toBe(0);
      const data = jsonData(result);
      expect(keysOf(data)).toEqual([
        "path",
        "migrated",
        "skipped",
        "changed",
        "historyPath",
        "diagnostics",
      ]);
      expect(data["migrated"]).toBe(2);
      expect(data["skipped"]).toBe(0);
      expect(data["changed"]).toBe(true);
      expect(typeof data["historyPath"]).toBe("string");
    });
  });

  it("should warn on stderr about a corrupt destination store and still migrate", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);
      const store = join(
        dir,
        ".hreader",
        "annotations",
        `${createHash("sha1").update("doc.html", "utf8").digest("hex")}.json`,
      );
      mkdirSync(dirname(store), { recursive: true });
      writeFileSync(store, "{{{");

      const result = await runIn(dir, ["annotations", "migrate", "doc.html"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("warning:");
      expect(result.stdout).toContain("migrated doc.html");
    });
  });

  it("should report nothing to migrate on a foreign doc", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "plain.html"), FOREIGN);

      const result = await runIn(dir, ["annotations", "migrate", "plain.html"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("unchanged");
    });
  });
});

describe("hr annotations · usage boundary", () => {
  it("should fail exit 2 without a subcommand, on an unknown one, and on a missing file", async () => {
    await withTempDir(async (dir) => {
      const bare = await runIn(dir, ["annotations"]);
      expect(bare.code).toBe(2);
      expect(bare.stderr).toContain("annotations 缺少子命令");

      const unknown = await runIn(dir, ["annotations", "nuke", "doc.html"]);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("未知的 annotations 子命令：nuke");

      const missing = await runIn(dir, ["annotations", "list"]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("list 缺少 <file>");

      const extra = await runIn(dir, ["annotations", "migrate", "a.html", "b.html"]);
      expect(extra.code).toBe(2);
      expect(extra.stderr).toContain("migrate 只接受 1 个位置参数");

      const listExtra = await runIn(dir, ["annotations", "list", "a.html", "b.html"]);
      expect(listExtra.code).toBe(2);
      expect(listExtra.stderr).toContain("list 只接受 1 个位置参数");

      const migrateMissing = await runIn(dir, ["annotations", "migrate"]);
      expect(migrateMissing.code).toBe(2);
      expect(migrateMissing.stderr).toContain("migrate 缺少 <file>");
    });
  });

  it("should fail exit 2 on a bad --status and an unknown flag", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), MANAGED);

      const bad = await runIn(dir, ["annotations", "list", "doc.html", "--status", "wat"]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("--status 必须是 pending | resolved | all 之一");

      const flag = await runIn(dir, ["annotations", "list", "doc.html", "--force"]);
      expect(flag.code).toBe(2);
      expect(flag.stderr).toContain("--force");
    });
  });

  it("should serve its own help section under hr annotations --help", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["annotations", "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("hr annotations list <file>");
      expect(result.stdout).toContain("hr annotations migrate <file>");
    });
  });
});

describe("hr annotations · locale paths", () => {
  it("should handle a doc under a Chinese/spaced directory name", async () => {
    await withTempDir(async (dir) => {
      const nested = join(dir, "中文 目录");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "稿 件.html"), MANAGED);
      seedStore(dir, "中文 目录/稿 件.html", [sidecarRecord()]);

      const result = await runIn(dir, ["annotations", "list", "中文 目录/稿 件.html"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("共 3 条");
      expect(result.stdout).toContain("an-side");
    });
  });
});
