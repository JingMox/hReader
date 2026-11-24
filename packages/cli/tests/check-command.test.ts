// 这层管：`hr check`——排版约束与文档级诊断的两种输出（人读 / JSON），以及读不到文件时的退出码。

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCommand } from "../src/commands/check";
import { dataCheck, dataNew, humanCheck, humanNew } from "../src/output";
import { DOC, seed } from "./cli-support";
import { atOf, fieldOf, keysOf, parseJsonLine, withTempDir } from "./harness";
import { runIn } from "./support/capture";

const BAD = DOC.replace(
  "</article>",
  '<div data-hr-component="split-compare" data-hr-id="hr-d" style="gap:0"><div data-hr-id="hr-e">A</div></div></article>',
);

describe("hr check · 人读输出", () => {
  it("should print one ok line for a clean document", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      expect(await runIn(dir, ["check", "a.html"])).toEqual({
        code: 0,
        stdout: "ok a.html（没有排版问题）\n",
        stderr: "",
      });
    });
  });

  it("should list each issue with its path and end with a count", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", BAD);
      const lines = (await runIn(dir, ["check", "a.html"])).stdout.split("\n");

      expect(lines).toEqual([
        'warning: inline_style — <div data-hr-id="hr-d"> 带内联 style：长相交给主题，请删掉 style 属性 @ html[1]>body[1]>article[1]>div[3]',
        'warning: component_shape — 组件 split-compare 的直接子元素应为恰好 2 个，<div data-hr-id="hr-d"> 里有 1 个 @ html[1]>body[1]>article[1]>div[3]',
        "a.html：2 条问题",
        "",
      ]);
    });
  });

  it("should print a diagnostic without a path as a bare line", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "plain.html"), "<p>不是文档</p>");

      expect((await runIn(dir, ["check", "plain.html"])).stdout).toBe(
        "error: missing_article — 文档里没有 <article>\nplain.html：1 条问题\n",
      );
    });
  });
});

describe("hr check · JSON 与错误", () => {
  it("should print { issues, count } with a null path when there is no location", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "plain.html"), "<p>不是文档</p>");
      const data = fieldOf(
        parseJsonLine((await runIn(dir, ["check", "plain.html", "--json"])).stdout),
        "data",
      );
      const first = atOf(fieldOf(data, "issues"), 0);

      expect(keysOf(data)).toEqual(["issues", "count"]);
      expect(fieldOf(data, "count")).toBe(1);
      expect(keysOf(first)).toEqual(["code", "severity", "message", "path"]);
      expect(fieldOf(first, "path")).toBeNull();
    });
  });

  it("should exit 3 when the file does not exist", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["check", "nope.html", "--json"]);

      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("not_a_file");
    });
  });

  it("should print the real path when called without a display path", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);

      expect(await checkCommand({ path, json: false })).toBe(`ok ${path}（没有排版问题）\n`);
    });
  });
});

describe("output · check/new 形状", () => {
  it("should keep the issue path in JSON when there is one", () => {
    const issue = { code: "inline_style", severity: "warning", message: "m", path: "p[0]" };

    expect(dataCheck([issue])).toBe(
      '{"issues":[{"code":"inline_style","severity":"warning","message":"m","path":"p[0]"}],"count":1}',
    );
    expect(humanCheck([issue], "a.html")).toBe(
      "warning: inline_style — m @ p[0]\na.html：1 条问题\n",
    );
  });

  it("should format the new-document receipt both ways", () => {
    const report = { path: "/ws/a.html", kind: "note", title: "标题", bytes: 12 };

    expect(dataNew(report)).toBe('{"path":"/ws/a.html","kind":"note","title":"标题","bytes":12}');
    expect(humanNew(report, "a.html")).toBe("created a.html (note, 12 bytes)\n");
  });
});
