// 这层管：`target.ts` 的 errno 翻译（调用点的"主修"）——码要诚实，文案要人话、且不带绝对路径。
// 兜底映射（`errors.ts`）另有单测；这里钉的是"哪个文件的哪次操作"这层上下文。

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

/** 收紧成 `HrError` 再断言：不用类型断言，顺便在"没抛 HrError"时给出真正的失败原因。 */
const asHrErrorOf = (value: unknown): HrError => {
  if (!(value instanceof HrError)) throw new Error(`期望 HrError，实际是：${String(value)}`);
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
    // `file` 仍是我们算给 core 的相对路径，和回显用的 `input` 分开。
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

describe("调用点的 errno 翻译", () => {
  it.each([
    // `EACCES` 在这里只能合成：非 root 跑测试造不出"目录存在但不可写"（root 会直接写成功）。
    // `ENOENT`/`EISDIR`/`ENAMETOOLONG` 都由下面的真 fs 用例触发——合成只能证明我们的表自洽，
    // 真 fs 才能证明我们把 Node 的错误读对了。
    ["EACCES", "io_failure", "写入失败（目录不可建或文件已存在）：doc.html"],
  ] as const)("should map %s to %s when writing", (errno, code, message) => {
    const target = documentTargetOf("doc.html", workspace);
    const failure = writeFailureOf(errnoOf(errno, "open"), target);

    expect(failure.code).toBe(code);
    expect(failure.message).toBe(message);
    // errno 原文与绝对路径都只进 stderr（`cause` 链），不进正文。
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

  it("should keep an HrError as it is, and treat a non-errno error as an io failure", () => {
    const target = documentTargetOf("doc.html", workspace);
    const mine = new HrError("invalid_input", "本来就对");

    expect(writeFailureOf(mine, target)).toBe(mine);
    expect(writeFailureOf(new TypeError("boom"), target).code).toBe("io_failure");
  });
});

describe("core 的因果翻成我们的码", () => {
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

    // code/文案原样保留（core 的绝对路径在这里被折，但这条没有路径可折）。
    expect(kept.code).toBe("node_not_found");
    expect(kept.message).toBe("找不到节点");
    expect(coreFailureOf(plain, target)).toBe(plain);
  });
});

describe("真实文件系统上的读路径", () => {
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
