// F16-5（docs/05:114 / AC「4 MiB 硬上限」）：`hr export` 帮助里必须写明 4 MiB，超限时必须拒绝拼接
// 并给出「按章拆分」的出路。两半都钉：只说上限不给办法、或只报错不说上限，都算红。

import { existsSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** 4 MiB = 4194304；这里造 ~4.7 MiB 的正文，确保拼接后的打印稿真的越线。 */
const OVER_SIZED_PATHS = 7000;
const PARAGRAPH_TEXT = "y".repeat(700);

const bigDoc = (): string => {
  let body = "";
  for (let index = 0; index < OVER_SIZED_PATHS; index += 1) body += `<p>${PARAGRAPH_TEXT}</p>`;
  return [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    `<article>${body}</article>`,
    "</body></html>",
  ].join("\n");
};

describe("hr export · 4 MiB 上限", () => {
  it("should state the 4 MiB limit in `hr export --help`", async () => {
    const help = checked(await runCli(["export", "--help"]));

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("4 MiB");
    expect(help.stdout).toContain("4194304");
    expect(help.stdout).toContain("按章拆分");
  });

  it("should refuse an oversized print sheet and tell the user to split by chapter", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/big.html`, bigDoc(), "utf8");

      const json = checked(
        await runCli(["export", "big.html", "--out", "big.out.html", "--json"], { cwd: dir }),
      );

      expect(json.code).toBe(1);
      const envelope = parseJsonLine(json.stdout);
      expect(fieldOf(envelope, "code")).toBe("invalid_input");
      const message = String(fieldOf(envelope, "message"));
      expect(message).toContain("4 MiB");
      expect(message).toContain("按章拆分");
      // 越线就得在拼接前拒掉：不许留半成品产物。
      expect(existsSync(`${dir}/big.out.html`)).toBe(false);
    });
  });
});
