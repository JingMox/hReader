// This layer: the only "user-perceivable" main chain, run on the **deliverable** (`dist/main.js` as a real subprocess):
// create → outline → patch body using the id the outline gave → outline again (new id addressable) → undo → bytes back to creation.
//
// What makes it red (link by link):
// - creation stops injecting ids → step 2's `nodes` is empty or `outline_node_without_id` is non-empty;
// - patching no longer recomputes ids (id drift changed to "keep old id" or "drop id") → step 3's outline has no addressable h1;
// - the write leaves half a file / an extra BOM → the final byte comparison fails (stricter than "contains some word": one missing newline goes red);
// - the snapshot is not "pre-write bytes" or undo does not consume it → final bytes differ, and a second undo must report `undo_unavailable`.
//
// Note: id drift is established design (the tool description says "do not cache ids"), so what is asserted here is
// "the new id is addressable", **not** "the id stayed the same".

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { nodePatchDeps, undoPatch } from "@hreader/core";

import { isRecord, workspaceIn, leaveWorkspace } from "./harness";
import {
  INITIALIZE,
  INITIALIZED,
  binPathOf,
  buildDist,
  byIdOf,
  linesOf,
  probeOf,
  resultOf,
  textOf,
} from "./probe";

beforeAll(buildDist, 180_000);

const outlineOf = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
};

const nodesOf = (outline: Record<string, unknown>): readonly Record<string, unknown>[] => {
  const nodes = outline["nodes"];
  return Array.isArray(nodes) ? nodes.filter(isRecord) : [];
};

const headingIdOf = (nodes: readonly Record<string, unknown>[]): unknown =>
  nodes.find((node) => node["tag"] === "h1")?.["id"];

const diagnosticsOf = (outline: Record<string, unknown>): readonly unknown[] => {
  const diagnostics = outline["diagnostics"];
  return Array.isArray(diagnostics) ? diagnostics : [];
};

const callIn = async (
  workspace: string,
  lines: readonly string[],
  expected: number,
): Promise<Map<unknown, Record<string, unknown>>> => {
  const { frames } = await probeOf(await binPathOf(), { lines, expected, cwd: workspace });
  return byIdOf(frames);
};

interface Step {
  readonly workspace: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** One process per step: the SDK executes `tools/call`s received on the same pipe concurrently, so "create then read" needs two handshakes. */
const resultIn = async ({ workspace, tool, args }: Step): Promise<string> => {
  const frames = await callIn(
    workspace,
    linesOf([
      INITIALIZE,
      INITIALIZED,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    ]),
    1,
  );
  const frame = frames.get(2);
  expect(resultOf(frame)["isError"]).toBeUndefined();
  return textOf(frame);
};

/** Create → first outline: returns the created bytes and the heading ids from the outline (`expect` lives here; `it` only reads results). */
const createAndOutlineOf = async (
  workspace: string,
): Promise<{ createdBytes: Buffer; oldId: unknown }> => {
  await resultIn({
    workspace,
    tool: "hr_create_doc",
    args: { filePath: "loop.html", title: "闭环" },
  });
  const outlineResult = await resultIn({
    workspace,
    tool: "hr_outline",
    args: { filePath: "loop.html" },
  });
  const outline = outlineOf(outlineResult);
  const nodes = nodesOf(outline);
  expect(nodes.length).toBeGreaterThan(0);
  expect(diagnosticsOf(outline)).toEqual([]);
  const oldId = headingIdOf(nodes);
  expect(typeof oldId).toBe("string");
  return { createdBytes: await readFile(join(workspace, "loop.html")), oldId };
};

/** Patch the body using the outline's id, then outline + read-node: the id must **still be that same one** and truly addressable.
 *  `replace`'s new root inherits the target's own id, so the heading's anchor survives the edit. */
const patchAndReadBackOf = async (workspace: string, oldId: unknown): Promise<void> => {
  await resultIn({
    workspace,
    tool: "hr_patch_node",
    args: {
      filePath: "loop.html",
      nodeId: oldId,
      action: "replace",
      htmlContent: "<h1>改过的标题</h1>",
    },
  });
  const again = await resultIn({
    workspace,
    tool: "hr_outline",
    args: { filePath: "loop.html" },
  });
  const newId = headingIdOf(nodesOf(outlineOf(again)));
  expect(typeof newId).toBe("string");
  // ids belong to the product: editing content does not move the anchor; the outline keeps pointing at the block with the same id.
  expect(newId).toBe(oldId);

  const readBack = await resultIn({
    workspace,
    tool: "hr_read_node",
    args: { filePath: "loop.html", nodeId: newId },
  });
  const node = outlineOf(readBack);
  expect(node["html"]).toBe(`<h1 data-hr-id="${String(newId)}">改过的标题</h1>`);
  expect(node["truncated"]).toBe(false);
};

/**
 * undo: the snapshot is "pre-write bytes", so this returns to the moment of creation.
 * This E2E covers two relations: byte alignment of the **MCP stdio tool surface ↔ core in-process primitives**, and that **the built artifact really boots**
 * (`probe.ts` runs `buildDist` — a real `pnpm build` — then spawns `spawn(process.execPath, [entry])` for a stdio handshake).
 * The undo step **deliberately** uses in-process `undoPatch` rather than the tool: this file's read/patch side already compared return values and old ids verbatim,
 * and undo needs exactly the CLI-side `UndoResult` (`restoredFrom`/byte counts); through the tool surface only mapped text is available.
 * MCP's outward entry is `hr_undo` (`src/tools/undo.ts`, via `revertLast`); same semantics, different codes:
 * `undo_unavailable` is a core-layer code that the tool surface translates to `nothing_to_undo` — so the
 * `undo_unavailable` asserted below is this function **deliberately** staying at the core layer, not tool-surface behavior.
 */
const undoBackOf = async (workspace: string, createdBytes: Buffer): Promise<void> => {
  const restored = await undoPatch({ workspace, file: "loop.html" }, nodePatchDeps);
  expect(restored.restoredFrom).toContain(join(".hreader", "history"));
  expect((await readFile(join(workspace, "loop.html"))).equals(createdBytes)).toBe(true);
  // The snapshot was consumed: a second undo must say "no history to roll back" instead of silently "succeeding".
  await expect(undoPatch({ workspace, file: "loop.html" }, nodePatchDeps)).rejects.toMatchObject({
    code: "undo_unavailable",
  });
};

describe("dist/main.js · main-chain loop", () => {
  it("should take a created doc through outline, patch, outline again, then undo back to the exact bytes", async () => {
    const workspace = await workspaceIn("hreader-mcp-loop-");
    try {
      const { createdBytes, oldId } = await createAndOutlineOf(workspace);
      await patchAndReadBackOf(workspace, oldId);
      await undoBackOf(workspace, createdBytes);
    } finally {
      await leaveWorkspace(workspace);
    }
  }, 60_000);
});
