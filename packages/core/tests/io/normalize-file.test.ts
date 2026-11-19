// 这层管：`normalizeFile` 的落盘编排（真实 fs）——补 id、`--write` 才落盘、第二次运行字节不变。
//
// 这里必须**在测试进程内直调**：CLI 的 `hr normalize` 用例都是 spawn 子进程，v8 只统计测试进程里跑过的行。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { normalizeFile } from "../../src/ops/normalizeFile";
import { withWorkspace, writeTextAt } from "./harness";

const DRAFT = "<article><h1>第一章</h1><p>正文。</p></article>";

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error: unknown) {
    const code: unknown = Reflect.get(Object(error), "code");
    return typeof code === "string" ? code : "no_code";
  }
  return "no_throw";
};

const normalizeAt = (dir: string, write: boolean): Promise<unknown> =>
  normalizeFile({ workspace: dir, file: "doc.html", write }, nodePatchDeps);

describe("normalizeFile · 不是文档", () => {
  it("should refuse a file without <article> instead of inventing ids on a fragment", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "doc.html"), "<p>随手记一段</p>");

      expect(await codeOf(() => normalizeAt(dir, true))).toBe("invalid_document");
      expect(readFileSync(join(dir, "doc.html"), "utf8")).toBe("<p>随手记一段</p>");
    });
  });
});

describe("normalizeFile · 只算不写", () => {
  it("should report what it would inject and leave the disk untouched", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "doc.html"), DRAFT);

      const result = await normalizeAt(dir, false);
      expect(Reflect.get(Object(result), "needsNormalize")).toBe(true);
      expect(Number(Reflect.get(Object(result), "injected"))).toBeGreaterThan(0);
      expect(Reflect.get(Object(result), "changed")).toBe(false);
      expect(String(Reflect.get(Object(result), "html"))).toContain("data-hr-id=");
      // 没给 `--write` 就一个字节都不许动。
      expect(readFileSync(join(dir, "doc.html"), "utf8")).toBe(DRAFT);
    });
  });
});

describe("normalizeFile · --write", () => {
  it("should persist the ids, report the post-write state and be a no-op the second time", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "doc.html"), DRAFT);

      const first = await normalizeAt(dir, true);
      // `needsNormalize` 描述的是写完之后磁盘的状态（P1-1：报 true 会让用户以为写回没生效）。
      expect(Reflect.get(Object(first), "needsNormalize")).toBe(false);
      expect(Reflect.get(Object(first), "changed")).toBe(true);
      const written = readFileSync(join(dir, "doc.html"), "utf8");
      expect(written).toContain("data-hr-id=");
      expect(written).toBe(String(Reflect.get(Object(first), "html")));

      const second = await normalizeAt(dir, true);
      expect(Reflect.get(Object(second), "injected")).toBe(0);
      expect(Reflect.get(Object(second), "changed")).toBe(false);
      expect(Reflect.get(Object(second), "needsNormalize")).toBe(false);
      // 已经合法的文档必须逐字节原样返回（再序列化一遍会改用户的引号/自闭合写法）。
      expect(readFileSync(join(dir, "doc.html"), "utf8")).toBe(written);
      expect(String(Reflect.get(Object(second), "html"))).toBe(written);
    });
  });
});
