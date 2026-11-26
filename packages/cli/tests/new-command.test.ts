// This layer covers `hr new` — drafting by shape, applying a theme, atomic write, and the write rules (exists / out of bounds / missing parent dir / unknown theme).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { newDocCommand } from "../src/commands/new";
import { fieldOf, keysOf, parseJsonLine, withTempDir } from "./harness";
import { runIn } from "./support/capture";

describe("hr new · drafting", () => {
  it("should write a themed report skeleton that passes hr check", async () => {
    await withTempDir(async (dir) => {
      const created = await runIn(dir, ["new", "q4.html", "--kind", "report", "--title", "Q4"]);
      const html = readFileSync(join(dir, "q4.html"), "utf8");

      expect(created).toEqual({
        code: 0,
        stdout: `created q4.html (report, ${String(statSync(join(dir, "q4.html")).size)} bytes)\n`,
        stderr: "",
      });
      expect(html).toContain('<article data-hr-id="root" data-hr-kind="report">');
      expect(html).toContain('<style id="hr-theme">');
      expect((await runIn(dir, ["check", "q4.html"])).stdout).toBe("ok q4.html（没有排版问题）\n");
    });
  });

  it("should be readable by outline right away (ids already in place)", async () => {
    await withTempDir(async (dir) => {
      await runIn(dir, ["new", "deck.html", "--kind", "slides"]);
      const outline = await runIn(dir, ["outline", "deck.html"]);

      expect(outline.code).toBe(0);
      expect(outline.stdout).toContain("关键数字");
    });
  });

  it("should print { path, kind, title, bytes } with --json", async () => {
    await withTempDir(async (dir) => {
      const created = await runIn(dir, ["new", "a.html", "--json"]);
      const data = fieldOf(parseJsonLine(created.stdout), "data");

      expect(keysOf(data)).toEqual(["path", "kind", "title", "bytes"]);
      expect(fieldOf(data, "path")).toBe(join(dir, "a.html"));
      expect(fieldOf(data, "kind")).toBe("note");
      expect(fieldOf(data, "title")).toBe("a");
      expect(fieldOf(data, "bytes")).toBe(statSync(join(dir, "a.html")).size);
    });
  });
});

describe("hr new · write rules", () => {
  it("should refuse to overwrite without --force and overwrite with it", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.html"), "原文");
      const refused = await runIn(dir, ["new", "a.html", "--json"]);

      expect(refused.code).toBe(1);
      expect(fieldOf(parseJsonLine(refused.stdout), "code")).toBe("file_exists");
      expect(readFileSync(join(dir, "a.html"), "utf8")).toBe("原文");

      expect((await runIn(dir, ["new", "a.html", "--force"])).code).toBe(0);
      expect(readFileSync(join(dir, "a.html"), "utf8")).toContain('data-hr-kind="note"');
    });
  });

  it("should reject a path outside the workspace", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, "ws"));
      const result = await runIn(join(dir, "ws"), ["new", "../escape.html", "--json"]);

      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
      expect(existsSync(join(dir, "escape.html"))).toBe(false);
    });
  });
});

describe("hr new · unwritable targets", () => {
  it("should report io_failure when the parent directory does not exist", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["new", "missing/a.html", "--json"]);

      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("io_failure");
    });
  });

  it("should fail on an unknown theme before writing anything", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["new", "a.html", "--visual", "no-such-theme", "--json"]);

      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("unknown_style");
      expect(existsSync(join(dir, "a.html"))).toBe(false);
    });
  });
});

describe("newDocCommand · direct calls", () => {
  it("should fall back to the real path in the receipt when no display path is given", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "a.html");
      const receipt = await newDocCommand({
        path,
        docKind: "brief",
        title: "简报",
        visual: "atelier-editorial",
        workspace: dir,
        force: false,
        json: false,
      });

      expect(receipt).toBe(`created ${path} (brief, ${String(statSync(path).size)} bytes)\n`);
    });
  });
});
