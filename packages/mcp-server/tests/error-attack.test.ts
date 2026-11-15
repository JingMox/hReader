// 这层管：错误归因的**反向攻击**。前面几组问"码是对的吗"，这里问"能不能骗它把一类失败说成另一类"，
// 以及"哪个格子里还藏着 internal 这个垃圾桶"。
//
// 它会因为什么而红：
// - 同一个失败经工具出口说 `unknown_style`、经资源出口说 `not_found`（宿主按码分流就会分叉）；
// - 一条非 `ENOENT` 的 fs 失败（`EACCES`/`ENOTDIR`）仍落进 `internal`——那等于告诉宿主"我们没料到"；
// - **合法**参数被误报：`..foo` 那次的老病。406 字符的相对路径在 `PATH_MAX=1024` 下完全合法，
//   它的失败原因只能是"文件不存在"（`not_found`），绝不能是"参数不合法"（`invalid_input`）。

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  isRecord,
  leaveWorkspace,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-attack-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

/** 深 200 层、406 个字符：合法（`PATH_MAX=1024`），所以"不存在"才是它的真因。 */
const DEEP_BUT_LEGAL = `${"a/".repeat(200)}x.html`;
/** 4006 个字符：确实超长。 */
const TOO_LONG = `${"a/".repeat(2000)}x.html`;

const errorOf = (error: unknown): { code: unknown; data: unknown; message: unknown } => ({
  code: Reflect.get(Object(error), "code"),
  data: Reflect.get(Object(error), "data"),
  message: Reflect.get(Object(error), "message"),
});

const toolCodeOf = async (tool: string, args: Record<string, unknown>): Promise<string> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name: tool, arguments: args });
  await session.close();
  expect(isErrorResultOf(result)).toBe(true);
  return codeOf(result);
};

interface Parity {
  readonly name: string;
  readonly uri: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly code: string;
}

const PARITIES: readonly Parity[] = [
  {
    name: "未知风格：工具出口与资源出口",
    uri: "hreader://styles/no-such-style",
    tool: "hr_apply_style",
    args: { filePath: "doc.html", visualId: "no-such-style" },
    code: "unknown_style",
  },
  {
    name: "未知 uri 前缀：只有资源出口",
    uri: "hreader://nothing/here",
    tool: "hr_outline",
    args: { filePath: "doc.html" },
    code: "not_found",
  },
];

describe("错误归因 · 双入口同码", () => {
  it.each(PARITIES)(
    "$name → 资源出口的 data.code 与工具出口同一个",
    async (row) => {
      await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
      const session = await sessionOf();
      const rejected = await session.client.readResource({ uri: row.uri }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await session.close();

      const failure = errorOf(rejected);
      const data = isRecord(failure.data) ? failure.data : {};
      expect(data["code"]).toBe(row.code);
      // 工具出口的码必须是同一个（`not_found` 那行只是借用 `hr_outline` 的成功路径，不比工具码）。
      if (row.code !== "not_found" || row.uri.startsWith("hreader://styles/")) {
        expect(await toolCodeOf(row.tool, row.args)).toBe(row.code);
      }
    },
    30_000,
  );
});

describe("错误归因 · internal 不是垃圾桶", () => {
  it("should map EACCES on read to io_failure, not internal", async () => {
    const file = join(workspace, "locked.html");
    await writeFile(file, ANNOTATED_DOC, "utf8");
    await chmod(file, 0o000);
    try {
      const code = await toolCodeOf("hr_outline", { filePath: "locked.html" });
      expect(code).toBe("io_failure");
    } finally {
      await chmod(file, 0o644);
    }
  }, 30_000);

  it("should map ENOTDIR on create to io_failure, not internal", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const code = await toolCodeOf("hr_create_doc", { filePath: "doc.html/x.html", title: "x" });
    expect(code).toBe("io_failure");
  }, 30_000);

  it("should map a read-only parent directory to io_failure, not internal", async () => {
    await mkdir(join(workspace, "ro"));
    await chmod(join(workspace, "ro"), 0o500);
    try {
      const code = await toolCodeOf("hr_create_doc", { filePath: "ro/x.html", title: "x" });
      expect(code).toBe("io_failure");
    } finally {
      await chmod(join(workspace, "ro"), 0o755);
    }
  }, 30_000);
});

describe("错误归因 · 合法参数不许被误报", () => {
  it("should call a deep-but-legal path not_found, never invalid_input", async () => {
    const session = await sessionOf();
    const result: unknown = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: DEEP_BUT_LEGAL },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    // 误报"参数不合法"会教模型去改一个本来就对的参数（`..foo` 那次的同类错误）。
    expect(codeOf(result)).toBe("not_found");
    expect(textOf(result)).toContain("x.html");
  }, 30_000);

  it("should call a genuinely over-long path invalid_input", async () => {
    const code = await toolCodeOf("hr_outline", { filePath: TOO_LONG });
    expect(code).toBe("invalid_input");
  }, 30_000);
});

describe("错误归因 · 缺失的 UI 资源也不许装成功", () => {
  it("should answer ui://view/{missing} with a coded error instead of a shell page", async () => {
    const session = await sessionOf();
    const rejected = await session.client.readResource({ uri: "ui://hreader/view/ghost" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await session.close();

    const failure = errorOf(rejected);
    const data = isRecord(failure.data) ? failure.data : {};
    expect(rejected).not.toBeUndefined();
    expect(failure.code).toBe(-32002);
    expect(data["code"]).toBe("not_found");
  }, 30_000);
});

describe("错误归因 · 正文里不出现宿主布局", () => {
  it("should keep the workspace path and errno out of the tool text", async () => {
    const session = await sessionOf();
    const result: unknown = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: "nope.html" },
    });
    const locked = join(workspace, "locked2.html");
    await writeFile(locked, ANNOTATED_DOC, "utf8");
    await chmod(locked, 0o000);
    const second: unknown = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: "locked2.html" },
    });
    await chmod(locked, 0o644);
    await session.close();

    for (const one of [result, second]) {
      const text = textOf(one);
      expect(isErrorResultOf(one)).toBe(true);
      expect(text).not.toContain(workspace);
      expect(text).not.toContain("ENOENT");
      expect(text).not.toContain("EACCES");
    }
    expect(await readFile(locked, "utf8")).toBe(ANNOTATED_DOC);
  }, 30_000);
});
