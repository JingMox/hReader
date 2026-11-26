// This layer covers `hr check --strict`, `hr style --lint --strict`, and the CLI feedback for foreign documents
// (cls fields, human explanation lines, normalize's stderr guidance, `--strict` usage errors).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { styleCommand } from "../src/commands/style";
import { StrictFailure } from "../src/errors";
import { DOC, seed } from "./cli-support";
import { fieldOf, parseJsonLine, withTempDir } from "./harness";
import { runIn } from "./support/capture";

const FOREIGN = "<p>不是文档</p>";

const NORMALIZABLE = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  "<article><h2>标题</h2><p>正文</p></article>",
  "</body></html>",
].join("\n");

const DUPLICATE_ID = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="hr-a">重复</p></article>',
  "</body></html>",
].join("\n");

const WARN_ONLY = DOC.replace(
  "</article>",
  '<div data-hr-component="split-compare" data-hr-id="hr-d" style="gap:0"><div data-hr-id="hr-e">A</div></div></article>',
);

const LINT_HIT = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="hr-c">总而言之，赋能</p></article>',
  "</body></html>",
].join("\n");

const write = (dir: string, name: string, html: string): void => {
  writeFileSync(join(dir, name), html);
};

describe("hr check · foreign HTML grading", () => {
  it.each([
    ["a.html", DOC, "managed"],
    ["b.html", NORMALIZABLE, "normalizable"],
    ["c.html", FOREIGN, "foreign"],
  ])("should classify %s as %s in JSON mode", async (name, html, cls) => {
    await withTempDir(async (dir) => {
      write(dir, name, html);
      const result = await runIn(dir, ["check", name, "--json"]);
      const data = fieldOf(parseJsonLine(result.stdout), "data");

      expect(result.code).toBe(0);
      expect(fieldOf(data, "cls")).toBe(cls);
      if (cls === "foreign") expect(fieldOf(data, "reason")).toContain("<article>");
      else expect(fieldOf(data, "reason")).toBeUndefined();
    });
  });

  it("should append the read-only note after the report for a foreign document", async () => {
    await withTempDir(async (dir) => {
      write(dir, "f.html", FOREIGN);
      const result = await runIn(dir, ["check", "f.html"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        "error: missing_article — 文档里没有 <article>\n" +
          "f.html：1 条问题\n" +
          "外来 HTML 文档：hReader 会以只读方式打开，不支持按块编辑\n",
      );
    });
  });

  it("should not print the note for managed or normalizable documents", async () => {
    await withTempDir(async (dir) => {
      write(dir, "m.html", DOC);
      write(dir, "n.html", NORMALIZABLE);

      for (const name of ["m.html", "n.html"]) {
        const result = await runIn(dir, ["check", name]);
        expect(result.stdout).not.toContain("外来");
      }
    });
  });
});

describe("hr check · --strict", () => {
  it("should still exit 0 with warnings when --strict is bare", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", WARN_ONLY);
      const result = await runIn(dir, ["check", "a.html", "--strict"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("a.html：2 条问题");
      expect(result.stderr).toBe("");
    });
  });

  it("should exit 1 on error-level diagnostics and keep the report on stdout", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", DUPLICATE_ID);
      const result = await runIn(dir, ["check", "a.html", "--strict"]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("duplicate_id");
      expect(result.stderr).toContain("--strict");
    });
  });

  it("should keep stdout as one JSON line under --strict --json", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", DUPLICATE_ID);
      const result = await runIn(dir, ["check", "a.html", "--strict", "--json"]);
      const data = fieldOf(parseJsonLine(result.stdout), "data");

      expect(result.code).toBe(1);
      expect(fieldOf(data, "cls")).toBe("managed");
      expect(result.stderr).toContain("--strict");
    });
  });

  it("should exit 0 on a clean document", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runIn(dir, ["check", "a.html", "--strict"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("ok a.html（没有排版问题）\n");
    });
  });

  it("should fail on warnings too with --strict=warning", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", WARN_ONLY);
      const result = await runIn(dir, ["check", "a.html", "--strict=warning"]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("a.html：2 条问题");
      expect(result.stderr).toContain("--strict");
    });
  });

  it("should accept the inline form of other flags next to a bare --strict", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", WARN_ONLY);
      const result = await runIn(dir, ["check", "a.html", "--strict", "--json"]);

      expect(result.code).toBe(0);
      expect(fieldOf(fieldOf(parseJsonLine(result.stdout), "data"), "count")).toBe(2);
    });
  });
});

describe("hr check · --strict usage errors", () => {
  it("should exit 2 on an unknown --strict value", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runIn(dir, ["check", "a.html", "--strict=foo"]);

      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("未知的 --strict：foo（可选：error | warning）");
      expect(result.stderr).toContain("用法：hr check");
    });
  });
});

describe("hr style · --lint --strict", () => {
  it("should exit 1 on lint hits and keep the report on stdout", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", LINT_HIT);
      const result = await runIn(dir, ["style", "a.html", "--lint", "--strict"]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("总而言之");
      expect(result.stderr).toContain("--strict");
    });
  });

  it("should exit 1 under --strict=warning as well", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", LINT_HIT);
      const result = await runIn(dir, ["style", "a.html", "--lint", "--strict=warning"]);

      expect(result.code).toBe(1);
    });
  });

  it("should name the raw path in the failure when no display path is given", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", LINT_HIT);
      const failure = await styleCommand({
        path: "a.html",
        mode: { kind: "lint" },
        workspace: dir,
        json: false,
        strict: "error",
      }).then(
        () => {
          throw new Error("expected StrictFailure");
        },
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(StrictFailure);
      if (failure instanceof StrictFailure) {
        expect(failure.message).toBe("a.html：2 条禁用词命中（--strict）");
        expect(failure.report).toContain("总而言之");
      }
    });
  });

  it("should exit 0 when the vocabulary has no hits", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runIn(dir, ["style", "a.html", "--lint", "--strict"]);

      expect(result.code).toBe(0);
    });
  });

  it("should exit 2 when --strict is given without --lint", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runIn(dir, [
        "style",
        "a.html",
        "--visual",
        "atelier-editorial",
        "--strict",
      ]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--strict 只与 --lint 同用");
    });
  });
});

describe("hr normalize · guidance for foreign documents", () => {
  it("should append the read-only hint to stderr after the frozen error", async () => {
    await withTempDir(async (dir) => {
      write(dir, "f.html", FOREIGN);
      const result = await runIn(dir, ["normalize", "f.html"]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "文档里没有 <article>：这不是可规范化的文档\n" +
          "提示：这份文件可以直接在 hReader 阅读器里以只读方式打开\n",
      );
    });
  });

  it("should not print the hint under --json", async () => {
    await withTempDir(async (dir) => {
      write(dir, "f.html", FOREIGN);
      const result = await runIn(dir, ["normalize", "f.html", "--json"]);

      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("invalid_document");
      expect(result.stderr).toBe("");
    });
  });
});
