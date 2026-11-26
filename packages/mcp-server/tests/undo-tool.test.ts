// This layer: `hr_undo`'s five user-visible behaviors, strict LIFO over two snapshot layers, three error codes' honesty,
// concurrency, and "snapshot deleted/corrupted externally" leaving no half-restored state and no no-op rung.
//
// What makes it red: swapping `revertLast` for `undoPatch` (`undo_unavailable` leaks into tool results),
// removing core's `runLocked` (both concurrent undos succeed), or undo "reporting success" without really writing bytes back.

import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  textOf,
  uiUriOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-undo-");
  process.chdir(workspace);
  await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

interface Outcome {
  readonly isError: boolean;
  readonly code: string;
  readonly text: string;
  readonly payload: Record<string, unknown>;
  readonly uri: string;
}

const callOf = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name, arguments: args });
  await session.close();
  const isError = isErrorResultOf(result);
  return {
    isError,
    code: isError ? codeOf(result) : "",
    text: textOf(result),
    // An error result's text is `[code] hint`, not JSON: only success results carry a parseable payload.
    payload: isError ? {} : payloadOf(result),
    uri: isError ? "" : uiUriOf(result),
  };
};

const undoOf = (filePath = "doc.html"): Promise<Outcome> => callOf("hr_undo", { filePath });

const patchOf = (nodeId: string, html: string): Promise<Outcome> =>
  callOf("hr_patch_node", { filePath: "doc.html", nodeId, action: "replace", htmlContent: html });

const bytesOf = (): Promise<string> => readFile(join(workspace, "doc.html"), "utf8");

const DOC_ID = "doc.html";

/** revision for frontend alignment = first 16 chars of the content sha256 (`revertLast`'s definition). */
const revisionOf = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);

describe("hr_undo · validity", () => {
  it("should put the pre-patch bytes back, and report the same revision the frontend would", async () => {
    const before = await bytesOf();
    await patchOf("p-1", "<p>新正文</p>");
    const patched = await bytesOf();
    const undo = await undoOf();

    expect(undo.isError).toBe(false);
    // Verdicts use file bytes, not "the tool did not error".
    expect(await bytesOf()).toBe(before);
    expect(patched).not.toBe(before);
    expect(undo.payload["revision"]).toBe(revisionOf(before));
    // `bytes` is the **restored** byte count (i.e. the byte count of the pre-write snapshot).
    expect(undo.payload["bytes"]).toBe(Buffer.byteLength(before, "utf8"));
    expect(String(undo.payload["restoredFrom"])).toContain(join(".hreader", "history"));
    expect(undo.uri).toBe(`ui://hreader/view/${Buffer.from(DOC_ID).toString("base64url")}`);
  });

  it("should keep hr_outline in sync with the restored content", async () => {
    const before = await callOf("hr_outline", { filePath: "doc.html" });
    await patchOf("p-1", "<p>临时改坏的一句</p>");
    const during = await callOf("hr_outline", { filePath: "doc.html" });
    await undoOf();
    const after = await callOf("hr_outline", { filePath: "doc.html" });

    expect(during.text).not.toBe(before.text);
    expect(after.text).toBe(before.text);
  });
});

describe("hr_undo · snapshot consumption", () => {
  it("should answer nothing_to_undo on the second undo (the only snapshot is consumed)", async () => {
    await patchOf("p-1", "<p>新正文</p>");
    const first = await undoOf();
    const second = await undoOf();

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(second.code).toBe("nothing_to_undo");
  });

  it("should answer nothing_to_undo for a doc that was never written to", async () => {
    const undo = await undoOf();
    expect(undo.isError).toBe(true);
    expect(undo.code).toBe("nothing_to_undo");
    expect(await bytesOf()).toBe(ANNOTATED_DOC);
  });
});

describe("hr_undo · error-code honesty", () => {
  it("should map a missing path to not_found and a directory to not_a_file", async () => {
    const missing = await undoOf("nope.html");
    const asDir = await undoOf(".");

    expect(missing.code).toBe("not_found");
    expect(asDir.code).toBe("not_a_file");
  });

  it("should never let the core-internal undo_unavailable reach the tool result", async () => {
    const cases = [
      await undoOf(),
      await undoOf("nope.html"),
      await undoOf("."),
      await undoOf("~/x.html"),
    ];
    for (const result of cases) {
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("undo_unavailable");
      // The reverse: neither a core-internal code nor the `internal` fallback.
      expect(result.code).not.toBe("internal");
    }
  });
});

describe("hr_undo · concurrency and corruption", () => {
  it("should let exactly one of two concurrent undos win", async () => {
    await patchOf("p-1", "<p>新正文</p>");
    const [first, second] = await Promise.all([undoOf(), undoOf()]);
    const winners = [first, second].filter((one) => !one.isError);
    const losers = [first, second].filter((one) => one.isError);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.code).toBe("nothing_to_undo");
    expect(await bytesOf()).toBe(ANNOTATED_DOC);
  }, 30_000);

  it("should stay whole when the snapshot dir was deleted behind its back", async () => {
    await patchOf("p-1", "<p>快照会被删</p>");
    const patched = await bytesOf();
    await rm(join(workspace, ".hreader", "history"), { recursive: true, force: true });

    const undo = await undoOf();
    // Snapshot gone = no history to retract; the target file must sit untouched (not half-restored).
    expect(undo.code).toBe("nothing_to_undo");
    expect(await bytesOf()).toBe(patched);
  });
});

describe("hr_undo · strict LIFO over two snapshot layers", () => {
  it("should retract strictly the most recent snapshot after two patches (not any arbitrary one)", async () => {
    const s0 = await bytesOf();
    await patchOf("h1", "<h1>标题一</h1>");
    const s1 = await bytesOf();
    await patchOf("p-1", "<p>正文二</p>");
    const s2 = await bytesOf();
    expect(s1).not.toBe(s0);
    expect(s2).not.toBe(s1);

    const first = await undoOf();
    expect(await bytesOf()).toBe(s1);
    const second = await undoOf();
    expect(await bytesOf()).toBe(s0);
    const third = await undoOf();

    // Each step's revision is the content hash "after that step's restore", and the three differ from each other.
    expect(first.payload["revision"]).toBe(revisionOf(s1));
    expect(second.payload["revision"]).toBe(revisionOf(s0));
    expect(new Set([revisionOf(s0), revisionOf(s1), revisionOf(s2)]).size).toBe(3);
    expect(third.code).toBe("nothing_to_undo");
  });
});

describe("hr_undo · corrupted snapshot", () => {
  it("should refuse to write back on hash mismatch (io_failure), leaving the target untouched and the snapshot unconsumed", async () => {
    await patchOf("p-1", "<p>新正文</p>");
    const patched = await bytesOf();
    // The snapshot directory is bucketed by document path: `.hreader/history/<docId sha1>/<hash16>-<ts>-<seq>.html`.
    const root = join(workspace, ".hreader", "history");
    const buckets = await readdir(root);
    expect(buckets).toHaveLength(1);
    const dir = join(root, String(buckets[0]));
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    await writeFile(join(dir, String(names[0])), "garbage", "utf8");

    const undo = await undoOf();
    expect(undo.code).toBe("io_failure");
    // ① The target file's bytes unchanged (no half-written content).
    expect(await bytesOf()).toBe(patched);
    // ② The snapshot still there: a corrupt snapshot is not consumed, or real history goes down with it.
    expect(await readdir(dir)).toEqual(names);
  });
});

describe("hr_undo · undo with annotations present (C)", () => {
  it("should return to pre-patch bytes with the `pending_ai` annotation preserved and still visible in hr_outline", async () => {
    await patchOf("p-1", "<p>改后的正文</p>");
    const undo = await undoOf();
    expect(undo.isError).toBe(false);

    expect(await bytesOf()).toBe(ANNOTATED_DOC);
    expect(await bytesOf()).toContain('"id":"ann-01"');
    const outline = await callOf("hr_outline", { filePath: "doc.html" });
    expect(outline.text).toContain("ann-01");
  });
});

describe("hr_undo · no no-op rung (D)", () => {
  it("should produce no snapshot when nothing changed (changed/undoable=false, historyPath=null), with undo still answering nothing_to_undo", async () => {
    const noop = await patchOf("p-1", '<p data-hr-id="p-1">正文</p>');

    expect(noop.payload["changed"]).toBe(false);
    expect(noop.payload["undoable"]).toBe(false);
    expect(noop.payload["historyPath"]).toBe(null);
    const undo = await undoOf();
    expect(undo.code).toBe("nothing_to_undo");
    expect(await bytesOf()).toBe(ANNOTATED_DOC);
  });
});
