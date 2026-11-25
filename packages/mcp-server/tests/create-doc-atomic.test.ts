// 这层管：`hr_create_doc` 的落盘口径与 CLI `hr new` 对齐。
// 旧实现裸 `writeFile(wx)`：① 目标已存在时 EEXIST 掉进 `io_failure` 兜底——CLI `hr new`
// 同场景报的是 `file_exists`，宿主按码分流就会分叉；② 写文件不是原子的，
// 进程中途死掉会留半份"新文档"。契约：已存在 → `file_exists`，落盘走 tmp+link
// 原子建文件（EEXIST 由内核判，不留 tmp、不撕文件）。

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

describe("hr_create_doc · 落盘口径", () => {
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

    // 失败路径必须把 tmp 收干净：目录里只许有那一份"已占用"。
    expect(await readdir(join(workspace, "sub"))).toEqual(["doc.html"]);
  });

  it("should reject an overlong filename upstream as invalid_input", async () => {
    // 文件名超 NAME_MAX：路径校验在落盘前就拦下——pin 住这个早退契约。
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
    // 原子写不留残渣：成功路径目录里只有目标文件。
    expect(await readdir(join(workspace, "a", "b"))).toEqual(["doc.html"]);
  });
});
