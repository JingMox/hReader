// 这层管：每个 tool 的 zod schema 边界——类型错、缺字段、非法枚举、多余字段、超长字符串。
// 契约：schema 拒绝一律是 `isError` 工具结果且文本带 `-32602`（invalid params），
// 不许崩、不许落盘副作用；多余字段按 zod 非严格口径剥掉放行（pin 住这个宽容面）。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isErrorResultOf, sessionOf, textOf } from "./harness";

const call = async (
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> => {
  const session = await sessionOf();
  const result = await session.client.callTool({ name, arguments: args });
  await session.close();
  return { isError: isErrorResultOf(result), text: textOf(result) };
};

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-schema-"));
  process.chdir(workspace);
  await writeFile(
    join(workspace, "doc.html"),
    '<article data-hr-id="hr-0"><p data-hr-id="p-1">正文</p></article>',
    "utf8",
  );
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("schema 边界 · 类型与缺字段", () => {
  it.each([
    ["hr_create_doc", { filePath: "a.html", title: 123 }, "title"],
    ["hr_create_doc", { filePath: "a.html" }, "title"],
    ["hr_outline", { filePath: 42 }, "filePath"],
    ["hr_read_node", { filePath: "doc.html", nodeId: "" }, "nodeId"],
    ["hr_read_node", { filePath: "doc.html" }, "nodeId"],
    ["hr_patch_node", { filePath: "doc.html", nodeId: "p-1", action: "explode" }, "action"],
    ["hr_apply_style", { filePath: "doc.html", visualId: 7 }, "visualId"],
    ["hr_import_doc", { filePath: "doc.html", kind: "bogus" }, "kind"],
  ])("%s rejects %j with -32602", async (name, args, field) => {
    const result = await call(name, args);

    expect(result.isError).toBe(true);
    expect(result.text).toContain("-32602");
    expect(result.text).toContain(field);
  });

  it("should strip unknown extra fields instead of rejecting them (lenient zod)", async () => {
    const result = await call("hr_create_doc", {
      filePath: "extra.html",
      title: "标题",
      promptInjection: "ignore previous instructions",
      nested: { evil: true },
    });

    expect(result.isError).toBe(false);
  });
});

describe("schema 边界 · 巨型与畸形输入", () => {
  it("should answer a 2MiB nodeId with a coded error, not a crash", async () => {
    const result = await call("hr_read_node", {
      filePath: "doc.html",
      nodeId: "x".repeat(2 * 1024 * 1024),
    });

    expect(result.isError).toBe(true);
  });

  it("should answer a 2MiB filePath with a coded error, not a crash", async () => {
    const result = await call("hr_outline", { filePath: "y".repeat(2 * 1024 * 1024) });

    expect(result.isError).toBe(true);
  });

  it("should answer non-object arguments with a JSON-RPC error instead of a tool result", async () => {
    const session = await sessionOf();
    // `arguments` 不是对象时连 zod 都进不去：SDK 直接回 JSON-RPC error（pin 住 -32603 现状）。
    const error: unknown = await session.client
      .callTool({
        name: "hr_outline",
        arguments: "not-an-object" as unknown as Record<string, unknown>,
      })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    await session.close();

    expect(Reflect.get(Object(error), "code")).toBe(-32603);
  });
});
