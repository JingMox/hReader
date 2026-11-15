// 这层管：`~` 在 `filePath` 里的**两个方向**——过度拒绝（把 `a/~/b.html` 当非法）与欠拒绝
// （只挡 `~` 本身，放过 `~/doc.html`）都会伤到用户，所以两臂钉在同一个文件、同一个 describe 里。
// `~` 我们不展开，也绝不能把它当普通目录名：以前 `~/doc.html` 会静默落盘成 `<workspace>/~/doc.html`。
//
// 它会因为什么而红：
// - `tildeFreeOf` 过度拒绝（例如 `filePath.includes("~")`）→ `a/~/b.html` 那臂红；
// - `tildeFreeOf` 欠拒绝（只拒 `"~"` 不拒 `"~/"`）→ `~/deep/er/doc.html` 那臂红；
// - 路径策略回退到"只要含 `~` 就整条拒"或"完全不看 `~`"→ 两条至少红一条。

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeOf, isErrorResultOf, leaveWorkspace, sessionOf, workspaceIn } from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-tilde-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

const createOf = async (args: { filePath: string; title: string }): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({
    name: "hr_create_doc",
    arguments: args,
  });
  await session.close();
  return result;
};

describe("hr_create_doc · `~`", () => {
  it("should refuse a `~` path instead of creating a directory named `~`", async () => {
    const home = await createOf({ filePath: "~/doc.html", title: "家目录" });
    const bare = await createOf({ filePath: "~", title: "波浪" });

    expect(codeOf(home)).toBe("invalid_input");
    expect(codeOf(bare)).toBe("invalid_input");
    expect(await readdir(workspace)).not.toContain("~");
  });

  it("should refuse `~` at any depth but leave a later-segment `~` alone", async () => {
    const deep = await createOf({ filePath: "~/deep/er/doc.html", title: "深层家目录" });
    // `~` 只在首段才是"家目录"；`a/~/b.html` 是用户真想要的怪目录名，拒了就是误伤。
    const nested = await createOf({ filePath: "a/~/b.html", title: "嵌套波浪" });

    expect(codeOf(deep)).toBe("invalid_input");
    expect(isErrorResultOf(nested)).toBe(false);
    expect(await readFile(join(workspace, "a", "~", "b.html"), "utf8")).toContain("嵌套波浪");
    expect(await readdir(workspace)).not.toContain("~");
  });
});
