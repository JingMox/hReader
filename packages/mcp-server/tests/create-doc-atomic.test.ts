// This layer: `hr_create_doc`'s write semantics aligned with CLI `hr new`.
// The old implementation used bare `writeFile(wx)`: ① EEXIST on an existing target fell into the `io_failure` fallback — CLI `hr new`
// reports `file_exists` for the same scene, so hosts routing on the code would diverge; ② the write was not atomic —
// a process dying midway left half a "new document". Contract: existing target → `file_exists`; writes go through tmp+link
// atomic creation (EEXIST judged by the kernel; no tmp left, no torn file).

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeOf, isErrorResultOf, sessionOf, textOf } from "./harness";

const call = async (
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; code: string; text: string }> => {
  const session = await sessionOf();
  const result = await session.client.callTool({ name, arguments: args });
  await session.close();
  return { isError: isErrorResultOf(result), code: codeOf(result), text: textOf(result) };
};

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-create-"));
  process.chdir(workspace);
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("hr_create_doc · write semantics", () => {
  it("should report file_exists when the target is taken (same code as hr new)", async () => {
    await writeFile(join(workspace, "doc.html"), "已占用", "utf8");

    const result = await call("hr_create_doc", { filePath: "doc.html", title: "标题" });

    expect(result.isError).toBe(true);
    expect(result.code).toBe("file_exists");
  });

  it("should leave no temp file behind when the create fails", async () => {
    await mkdir(join(workspace, "sub"));
    await writeFile(join(workspace, "sub", "doc.html"), "已占用", "utf8");

    await call("hr_create_doc", { filePath: "sub/doc.html", title: "标题" });

    // The failure path must sweep tmp clean: the directory may only hold the one "taken" file.
    expect(await readdir(join(workspace, "sub"))).toEqual(["doc.html"]);
  });

  it("should reject an overlong filename upstream as invalid_input", async () => {
    // Filename over NAME_MAX: the path check rejects before any write — pins this early-exit contract.
    const result = await call("hr_create_doc", {
      filePath: `${"x".repeat(300)}.html`,
      title: "标题",
    });

    expect(result.isError).toBe(true);
    expect(result.code).toBe("invalid_input");
  });

  it("should create parent directories and land the document atomically", async () => {
    const result = await call("hr_create_doc", {
      filePath: "a/b/doc.html",
      title: "标题",
    });

    expect(result.isError).toBe(false);
    // Atomic writes leave no residue: on success the directory holds only the target file.
    expect(await readdir(join(workspace, "a", "b"))).toEqual(["doc.html"]);
  });
});
