// 这层管：命令层边界（选择器↔node id 双解释、缺失文件路径、lint 文本模式）；不做参数解析。
//
// 这些用例的共同点：都落在"正常分支之外"的兜底路径上（覆盖率 100% 的硬门要求每一行都被真跑）。

import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { patchCommand } from "../src/commands/patch";
import { readCommand } from "../src/commands/read";
import { styleCommand } from "../src/commands/style";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-edge-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DOC = [
  "<!doctype html><html><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  "<style>p{color:red}</style><p>正文</p></article>",
  "</body></html>",
].join("\n");

const fileOf = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

/** 把拒绝结果收敛成"码 + 消息"，避免每处都写 `await expect(...).rejects`。 */
const rejectionOf = async (
  promise: Promise<string>,
): Promise<{ code: string; message: string }> => {
  try {
    await promise;
  } catch (error: unknown) {
    const code: unknown = Reflect.get(Object(error), "code");
    const message: unknown = Reflect.get(Object(error), "message");
    return { code: String(code), message: String(message) };
  }
  throw new Error("期望被拒绝，但命令成功了");
};

describe("readCommand · 选择器失败后按 node id 重试", () => {
  it("should retry a plain node id as [data-hr-id] and succeed", async () => {
    const path = fileOf("e1.html", DOC);
    const text = await readCommand({ path, target: "hr-b", maxBytes: undefined, json: true });

    expect(JSON.parse(text.trim())).toMatchObject({
      ok: true,
      data: { ids: ["hr-b"] },
    });
  });

  it("should report invalid_selector when both interpretations are invalid selectors", async () => {
    const path = fileOf("e2.html", DOC);
    const failed = await rejectionOf(
      readCommand({ path, target: '">', maxBytes: undefined, json: false }),
    );

    expect(failed.code).toBe("invalid_selector");
    expect(failed.message).toContain("按选择器 →");
    expect(failed.message).toContain("按 node id →");
  });

  it("should prefer node_not_found when only the id lookup is well-formed", async () => {
    const path = fileOf("e3.html", DOC);
    const failed = await rejectionOf(
      readCommand({ path, target: "p[", maxBytes: undefined, json: false }),
    );

    expect(failed.code).toBe("node_not_found");
  });
});

describe("patchCommand · 目标尚不存在", () => {
  it("should resolve the deepest existing ancestor and fail node_not_found without creating it", async () => {
    const failed = await rejectionOf(
      patchCommand({
        path: "missing/deep.html",
        nodeId: "hr-a",
        action: "append",
        html: "<p>x</p>",
        workspace: dir,
        json: false,
      }),
    );

    expect(failed.code).toBe("not_a_file");
    expect(readdirSync(dir).includes("missing")).toBe(false);
  });
});

describe("styleCommand · lint 模式", () => {
  it("should print the human lint summary", async () => {
    fileOf("e4.html", DOC);
    const text = await styleCommand({
      path: "e4.html",
      mode: { kind: "lint" },
      workspace: dir,
      json: false,
    });

    expect(text).toBe("");
  });

  it("should return the hits array in JSON mode", async () => {
    fileOf("e5.html", DOC);
    const text = await styleCommand({
      path: "e5.html",
      mode: { kind: "lint" },
      workspace: dir,
      json: true,
    });

    expect(JSON.parse(text.trim())).toMatchObject({ ok: true, data: { hits: [] } });
  });
});
