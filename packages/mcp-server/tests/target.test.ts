// This layer: `target.ts`'s errno translation (the call sites' "main translation") — codes stay honest, wording stays human, no absolute paths.
// The fallback mapping (`errors.ts`) has its own unit tests; what is pinned here is the "which file, which operation" context.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertInsideWorkspace,
  coreFailureOf,
  documentTargetOf,
  readInsideWorkspace,
  writeFailureOf,
} from "../src/tools/target";

let workspace = "";

beforeEach(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-target-"));
  process.chdir(workspace);
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

/** Narrow to `HrError` before asserting: no type assertion, and it surfaces the real failure reason when what was thrown is not an HrError. */
const asHrErrorOf = (value: unknown): HrError => {
  if (!(value instanceof HrError)) throw new Error(`expected an HrError, got: ${String(value)}`);
  return value;
};

const failureOf = async (promise: Promise<unknown>): Promise<HrError> =>
  asHrErrorOf(await promise.catch((thrown: unknown) => thrown));

const errnoOf = (code: string, syscall?: string): Error =>
  Object.assign(new Error(`${code}: raw text with /abs/path`), { code, syscall });

describe("documentTargetOf", () => {
  it("should echo the path the caller gave, absolute or relative", () => {
    expect(documentTargetOf("/etc/passwd", workspace).input).toBe("/etc/passwd");
    expect(documentTargetOf("./doc.html", workspace).input).toBe("./doc.html");
    // `file` is still the relative path we compute for core — separate from `input`, which is what gets echoed.
    expect(documentTargetOf("doc.html", workspace).file).toBe("doc.html");
  });

  it("should refuse a `~` path outright rather than expanding or treating it as a name", () => {
    for (const filePath of ["~", "~/x.html"]) {
      const failure = (() => {
        try {
          documentTargetOf(filePath, workspace);
          return undefined;
        } catch (error: unknown) {
          return asHrErrorOf(error);
        }
      })();

      expect(failure?.code).toBe("invalid_input");
      expect(failure?.message).toContain("不接受 `~` 展开");
    }
  });
});

describe("errno translation at the call site", () => {
  it.each([
    // `EACCES` can only be synthesized here: a non-root test run cannot create "directory exists but not writable" (root would just write successfully).
    // `ENOENT`/`EISDIR`/`ENAMETOOLONG` are all triggered by the real-fs cases below — synthesis only proves our table is self-consistent;
    // only real fs proves we read Node's errors right.
    ["EACCES", "io_failure", "写入失败（目录不可建或文件已存在）：doc.html"],
  ] as const)("should map %s to %s when writing", (errno, code, message) => {
    const target = documentTargetOf("doc.html", workspace);
    const failure = writeFailureOf(errnoOf(errno, "open"), target);

    expect(failure.code).toBe(code);
    expect(failure.message).toBe(message);
    // The raw errno and the absolute path only go to stderr (the `cause` chain), never the body.
    expect(failure.message).not.toContain(errno);
    expect(failure.message).not.toContain(workspace);
    expect(failure.cause).toBeDefined();
  });

  it("should name the length instead of dumping the whole path when it is too long", () => {
    const long = `${"a".repeat(300)}.html`;
    const failure = writeFailureOf(
      errnoOf("ENAMETOOLONG", "mkdir"),
      documentTargetOf(long, workspace),
    );

    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain(`共 ${String(long.length)} 字符`);
    expect(failure.message).toContain("…");
  });

  it("should not split a surrogate pair when the 64-char cut lands inside an emoji", () => {
    // 63 'a' + 😀 + 300 'b': the 64-unit cut falls between the emoji's halves — drop the high half.
    const long = `${"a".repeat(63)}😀${"b".repeat(300)}.html`;
    const failure = writeFailureOf(
      errnoOf("ENAMETOOLONG", "mkdir"),
      documentTargetOf(long, workspace),
    );

    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toBe(`路径过长：${"a".repeat(63)}…（共 ${String(long.length)} 字符）`);
    expect(failure.message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(failure.message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it("should keep an HrError as it is, and treat a non-errno error as an io failure", () => {
    const target = documentTargetOf("doc.html", workspace);
    const mine = new HrError("invalid_input", "本来就对");

    expect(writeFailureOf(mine, target)).toBe(mine);
    expect(writeFailureOf(new TypeError("boom"), target).code).toBe("io_failure");
  });
});

describe("core's cause mapped to our code", () => {
  it("should turn core's not_a_file + cause ENOENT into not_found", () => {
    const target = documentTargetOf("ghost.html", workspace);
    const core = new HrError(
      "not_a_file",
      `realpath时路径不存在：${join(workspace, "ghost.html")}`,
      {
        cause: errnoOf("ENOENT", "realpath"),
      },
    );
    const failure = asHrErrorOf(coreFailureOf(core, target));

    expect(failure.code).toBe("not_found");
    expect(failure.message).toBe("文档不存在：ghost.html");
  });

  it("should keep any other core error's code and wording, and pass plain errors through", () => {
    const target = documentTargetOf("doc.html", workspace);
    const other = new HrError("node_not_found", "找不到节点");
    const kept = asHrErrorOf(coreFailureOf(other, target));
    const plain = new Error("boom");

    // code/wording preserved verbatim (core's absolute path would fold here, but this one has no path to fold).
    expect(kept.code).toBe("node_not_found");
    expect(kept.message).toBe("找不到节点");
    expect(coreFailureOf(plain, target)).toBe(plain);
  });
});

describe("read path on the real filesystem", () => {
  it("should answer a directory with not_a_file", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    const failure = await failureOf(readInsideWorkspace(documentTargetOf("sub", workspace)));

    expect(failure.code).toBe("not_a_file");
    expect(failure.message).toBe("不是普通文件：sub");
  });

  it("should answer a missing file with not_found", async () => {
    const failure = await failureOf(readInsideWorkspace(documentTargetOf("nope.html", workspace)));

    expect(failure.code).toBe("not_found");
    expect(failure.message).toBe("文档不存在：nope.html");
  });

  it("should still reject a target outside the workspace before touching the disk", async () => {
    await mkdir(join(tmpdir(), "hreader-mcp-outside"), { recursive: true });
    await writeFile(join(tmpdir(), "hreader-mcp-outside", "x.html"), "<p>x</p>", "utf8");
    const failure = await failureOf(
      assertInsideWorkspace(documentTargetOf("../../hreader-mcp-outside/x.html", workspace)),
    );

    expect(failure.code).toBe("path_outside_workspace");
  });
});
