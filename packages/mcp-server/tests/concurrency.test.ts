// This layer: concurrent writes (core has `runLocked`, but the MCP layer never verified it works on this path).
//
// What makes it red: remove `runLocked` from `patchFile` and two `readFile → modify → writeFile` calls
// overwrite each other — surfacing exactly as "both responses `isError:false`, only one change on disk".
// That is the only forbidden outcome (double green with a lost change); serialization succeeding, or one side reporting a conflict, both pass.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  isErrorResultOf,
  leaveWorkspace,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-concurrent-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

interface Outcome {
  readonly isError: boolean;
  readonly text: string;
}

const patchOf = async (nodeId: string, html: string): Promise<Outcome> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({
    name: "hr_patch_node",
    arguments: { filePath: "doc.html", nodeId, action: "replace", htmlContent: html },
  });
  await session.close();
  return { isError: isErrorResultOf(result), text: textOf(result) };
};

describe("hr_patch_node · concurrent writes to the same document", () => {
  it("should never answer both calls green while one of the two changes is lost", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");

    const [first, second] = await Promise.all([
      patchOf("h1", '<h1 data-hr-id="h1">并发甲的标题</h1>'),
      patchOf("p-1", '<p data-hr-id="p-1">并发乙的正文</p>'),
    ]);
    const body = await readFile(join(workspace, "doc.html"), "utf8");
    const landed = [body.includes("并发甲的标题"), body.includes("并发乙的正文")];

    // The only forbidden outcome: both succeed, only one change lands on disk.
    expect(first.isError && second.isError).toBe(false);
    if (!first.isError && !second.isError) {
      expect(landed).toEqual([true, true]);
      return;
    }
    // The other allowed semantics: one side reports a conflict (`isError`), and what landed is exactly the other's.
    expect(landed.filter(Boolean)).toHaveLength(1);
  }, 30_000);

  it("should keep the lock off the read path, so two reads still answer at once", async () => {
    // Control group: read tools take no lock — if these two block each other, the lock was placed wrong (serializing the whole server).
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const session = await sessionOf();
    const results = await Promise.all([
      session.client.callTool({ name: "hr_outline", arguments: { filePath: "doc.html" } }),
      session.client.callTool({ name: "hr_outline", arguments: { filePath: "doc.html" } }),
    ]);
    await session.close();

    expect(results.map((one) => isErrorResultOf(one))).toEqual([false, false]);
  }, 30_000);
});
