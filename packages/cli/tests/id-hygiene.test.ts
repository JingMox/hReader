// `data-hr-id` 必须匹配 `^[A-Za-z][A-Za-z0-9_-]{0,63}$` 且全文唯一。
// 两侧分工：`normalize` 把不合规/重复的 id 改名（保留第一个），读/写入口（`read`/`outline`/`patch`）
// 遇到重复 id 直接报 `duplicate_id`（exit 2）并点名 `hr normalize <file> --write`。

import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const HR_ID_SHAPE = /^hr-[0-9a-f]{8}$/u;
const TOO_LONG = "a".repeat(65);
const REASSIGNED = [`1abc`, "中文", TOO_LONG, "a b"]
  .map((raw) => `<p data-hr-id="${raw}">X</p>`)
  .join("");

const docOf = (body: string): string =>
  ["<!doctype html>", "<html><head><title>t</title></head><body>", body, "</body></html>"].join(
    "\n",
  );

const idAttributesIn = (html: string): readonly string[] =>
  [...html.matchAll(/data-hr-id="([^"]*)"/gu)].map((match) => String(match[1]));

describe("normalize · id 卫生", () => {
  it("should reassign every id outside the pattern and leave valid ones alone", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, docOf(`<article>${REASSIGNED}</article>`));

      const result = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));

      expect(result.code).toBe(0);
      const ids = idAttributesIn(readFileSync(`${dir}/a.html`, "utf8"));
      // 四个不合规 id 一个都不许留在盘上：`1abc` 首位不是字母、`中文` 非 ASCII、65 字符超长、`a b` 带空格。
      for (const raw of ["1abc", "中文", TOO_LONG, "a b"]) expect(ids).not.toContain(raw);
      // 剩下的全是 hreader 自己的 id 形状（`<article>` + 四个 `<p>`），且互不相同。
      expect(ids).toHaveLength(5);
      expect(ids.every((id) => HR_ID_SHAPE.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it("should keep the first of two duplicated ids and rename the later one", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(
        `${dir}/a.html`,
        docOf('<article><p data-hr-id="dup">甲</p><p data-hr-id="dup">乙</p></article>'),
      );

      checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));

      const ids = idAttributesIn(readFileSync(`${dir}/a.html`, "utf8"));
      // 保留第一个（它合规且先出现），后面的那个换成新 id：`<article>` + `dup` + 新 id。
      expect(ids.filter((id) => id === "dup")).toHaveLength(1);
      expect(ids).toHaveLength(3);
      expect(ids.filter((id) => id !== "dup").every((id) => HR_ID_SHAPE.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(3);
    });
  });
});

/** 同一文档里两个元素共用 `hr-c`：加载侧（`read`/`outline`/`patch`）都该拒。 */
const DUPLICATED = docOf(
  '<article data-hr-id="hr-a"><p data-hr-id="hr-c">甲</p><p data-hr-id="hr-c">乙</p></article>',
);
const NEED_NORMALIZE_HINT = "先跑 hr normalize";

/** 跑一次必然被拒的调用，返回退出码与 `--json` 信封（只剩“这两件事对不对”要断）。 */
const refusalOf = async (
  dir: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly envelope: unknown }> => {
  const result = checked(await runCli([...args, "--json"], { cwd: dir }));
  return { code: result.code, envelope: parseJsonLine(result.stdout) };
};

const expectDuplicateRefusalOf = async (dir: string, args: readonly string[]): Promise<void> => {
  const { code, envelope } = await refusalOf(dir, args);
  expect(code).toBe(2);
  expect(fieldOf(envelope, "code")).toBe("duplicate_id");
  expect(String(fieldOf(envelope, "message"))).toContain(NEED_NORMALIZE_HINT);
};

describe("read/outline/patch · 重复 id 的加载侧", () => {
  it("should refuse `read` on both human and --json channels", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUPLICATED);

      const human = checked(await runCli(["read", "a.html", "hr-c"], { cwd: dir }));

      expect(human.code).toBe(2);
      expect(human.stderr).toContain(NEED_NORMALIZE_HINT);

      const { code, envelope } = await refusalOf(dir, ["read", "a.html", "hr-c"]);

      expect(code).toBe(2);
      expect(fieldOf(envelope, "ok")).toBe(false);
      expect(fieldOf(envelope, "code")).toBe("duplicate_id");
      expect(String(fieldOf(envelope, "message"))).toContain(NEED_NORMALIZE_HINT);
    });
  });

  it("should refuse `outline`", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUPLICATED);
      await expectDuplicateRefusalOf(dir, ["outline", "a.html"]);
    });
  });

  it("should refuse `patch` without touching a byte", async () => {
    await withTempDir(async (dir) => {
      const file = `${dir}/a.html`;
      writeFileSync(file, DUPLICATED);
      const before = readFileSync(file);

      await expectDuplicateRefusalOf(dir, ["patch", "a.html", "hr-c", "--action", "delete"]);
      // 拒写：加载侧拒绝时一个字节都不许动。
      expect(readFileSync(file).equals(before)).toBe(true);
    });
  });
});
