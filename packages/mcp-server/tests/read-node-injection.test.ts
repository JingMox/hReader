// This layer: `hr_read_node`'s target-resolution semantics aligned with CLI `hr read`.
// The old implementation spliced nodeId verbatim into `[data-hr-id="${nodeId}"]`: the selector grammar rejects `"]`/`[` as illegal,
// so injection can only produce `invalid_selector` (never a second selector) — but it flattened away the whole second layer of
// "is the input a selector or an id" semantics: `hr read doc section` is a legal lookup in the CLI, yet permanently unfindable in MCP.
// Contract: same `locateTarget` as the CLI (selector first, retry unreachable characters as id, error only after both hops fail).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeOf, isErrorResultOf, sessionOf, textOf } from "./harness";

const DOC = [
  '<!doctype html><html><body><article data-hr-id="hr-0">',
  '<section data-hr-id="s1"><p data-hr-id="p-1">第一段</p></section>',
  '<section data-hr-id="s2"><img data-hr-id="i-1" alt="占位"></section>',
  "</article></body></html>",
].join("");

const call = async (nodeId: string): Promise<{ isError: boolean; code: string; text: string }> => {
  const session = await sessionOf();
  const result = await session.client.callTool({
    name: "hr_read_node",
    arguments: { filePath: "doc.html", nodeId },
  });
  await session.close();
  return { isError: isErrorResultOf(result), code: codeOf(result), text: textOf(result) };
};

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-read-node-"));
  process.chdir(workspace);
  await writeFile(join(workspace, "doc.html"), DOC, "utf8");
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("hr_read_node · target resolution", () => {
  it("should read a node by its data-hr-id like before", async () => {
    const result = await call("p-1");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("第一段");
  });

  it("should reject a nodeId crafted to rewrite the selector instead of returning the wrong node", async () => {
    // `x"],[data-hr-id="i-1` spliced into the template gives `[data-hr-id="x"],[data-hr-id="i-1"]`:
    // the selector grammar rejects characters after `]` — injection cannot build a second selector, only an error.
    // After switching to locateTarget this must still be an error (must not silently return some other node).
    const result = await call('x"],[data-hr-id="i-1');

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("占位");
  });

  it("should resolve a bare tag name like the CLI does (selector-first)", async () => {
    // CLI `hr read doc section` parses the input as a selector (hits the first <section>); the old MCP template looked
    // "section" up as an id (never found → node_not_found). Both sides must behave identically.
    const result = await call("section");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("第一段");
  });
});
