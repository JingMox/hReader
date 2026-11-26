// This layer: `~` inside `filePath`, **both directions** — over-rejecting (treating `a/~/b.html` as illegal) and under-rejecting
// (blocking only `~` itself while letting `~/doc.html` through) both hurt users, so both arms are pinned in one file, one describe.
// We do not expand `~`, and it must never be treated as a normal directory name: `~/doc.html` once silently landed as `<workspace>/~/doc.html`.
//
// What makes it red:
// - `tildeFreeOf` over-rejects (e.g. `filePath.includes("~")`) → the `a/~/b.html` arm goes red;
// - `tildeFreeOf` under-rejects (rejects `"~"` but not `"~/"`) → the `~/deep/er/doc.html` arm goes red;
// - path policy regresses to "reject anything containing `~`" or "ignore `~` entirely" → at least one arm goes red.

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
    // `~` is only "home" in the first segment; `a/~/b.html` is a weird directory name the user really wants — rejecting it would be friendly fire.
    const nested = await createOf({ filePath: "a/~/b.html", title: "嵌套波浪" });

    expect(codeOf(deep)).toBe("invalid_input");
    expect(isErrorResultOf(nested)).toBe(false);
    expect(await readFile(join(workspace, "a", "~", "b.html"), "utf8")).toContain("嵌套波浪");
    expect(await readdir(workspace)).not.toContain("~");
  });
});
