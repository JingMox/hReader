// 这层管：`input.ts` 的字节→文本（严格 UTF-8、BOM 保留）与片段来源；不跑子进程。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { decodeStrict, readTextFile, sourceText } from "../src/input";
import { fieldOf } from "./harness";

const dir = mkdtempSync(join(tmpdir(), "hr-input-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const asError = (run: () => unknown): HrError => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("expected an HrError");
};

describe("decodeStrict", () => {
  it("should decode valid UTF-8 and keep a leading BOM as content", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(decodeStrict(bom, "x")).toBe("\uFEFFa");
    expect(decodeStrict(new TextEncoder().encode("中文"), "x")).toBe("中文");
  });

  it("should reject invalid byte sequences with invalid_utf8", () => {
    const error = asError(() => decodeStrict(new Uint8Array([0xff, 0xfe]), "<stdin>"));

    expect(error.code).toBe("invalid_utf8");
    expect(error.message).toBe("<stdin> 不是合法 UTF-8");
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe("readTextFile", () => {
  it("should read an existing file", async () => {
    const path = join(dir, "a.html");
    writeFileSync(path, "<p>x</p>");
    await expect(readTextFile(path)).resolves.toBe("<p>x</p>");
  });

  it("should map ENOENT to not_a_file", async () => {
    const path = join(dir, "missing.html");
    await expect(readTextFile(path)).rejects.toMatchObject({
      code: "not_a_file",
      message: `读取时路径不存在：${path}`,
    });
  });

  it("should map other read errors (directory) to io_failure", async () => {
    await expect(readTextFile(dir)).rejects.toMatchObject({
      code: "io_failure",
      message: `读取失败：${dir}`,
    });
  });

  it("should reject a file with invalid UTF-8 instead of substituting", async () => {
    const path = join(dir, "bad.html");
    writeFileSync(path, new Uint8Array([0x3c, 0xff]));
    await expect(readTextFile(path)).rejects.toMatchObject({ code: "invalid_utf8" });
  });
});

describe("sourceText", () => {
  it("should pass inline text through without touching stdin", async () => {
    let called = false;
    const text = await sourceText({ kind: "inline", text: "<p>i</p>" }, () => {
      called = true;
      return Promise.resolve(new Uint8Array());
    });

    expect(text).toBe("<p>i</p>");
    expect(called).toBe(false);
  });

  it("should read --html-file with the same strict decoder", async () => {
    const path = join(dir, "frag.html");
    writeFileSync(path, "<p>f</p>");
    await expect(
      sourceText({ kind: "file", path }, () => Promise.resolve(new Uint8Array())),
    ).resolves.toBe("<p>f</p>");
  });

  it("should decode stdin bytes for --html-stdin", async () => {
    await expect(
      sourceText({ kind: "stdin" }, () => Promise.resolve(new TextEncoder().encode("<p>s</p>"))),
    ).resolves.toBe("<p>s</p>");
  });

  it("should reject invalid stdin bytes with invalid_utf8", async () => {
    const error = await sourceText({ kind: "stdin" }, () =>
      Promise.resolve(new Uint8Array([0xff])),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HrError);
    expect(fieldOf(error, "code")).toBe("invalid_utf8");
    expect(fieldOf(error, "message")).toBe("<stdin> 不是合法 UTF-8");
  });
});
