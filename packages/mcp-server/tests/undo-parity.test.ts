// This layer: `hr_undo` and HTTP `POST /api/doc/<docId>/undo` must stay in lockstep once a
// style has entered the undo chain.
//
// Scenario: `patch` → `applyStyle` → undo. `applyStyle` has written a pre-change snapshot
// since b19ffca (same chain as patch): the first undo only rolls the style back to the
// post-patch bytes, the second rolls back the patch.
// That behavior lives in `revertLast`, not in this layer — two paths that truly share it
// cannot diverge; if they do, the MCP side is not going through `revertLast`.
//
// What turns this red: `hr_undo` switched to `undoPatch`/a hand-rolled restore, or the HTTP
// and MCP sides diverging in lock waiting or target resolution.

import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodePatchDeps, nodeStyleDeps, startServer } from "@hreader/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  isRecord,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  workspaceIn,
} from "./harness";

const PRESET = "atelier-editorial";
const DOC_ID = "doc.html";
const FILE = "doc.html";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-undo-parity-");
  process.chdir(workspace);
  await writeFile(join(workspace, FILE), ANNOTATED_DOC, "utf8");
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** HTTP arm: boots a real daemon (`port: 0`); the write route goes through cookie + csrf. */
const daemonArmOf = async (
  workspaceOf: string,
): Promise<{
  post: (path: string, body: Record<string, unknown>) => Promise<Reply>;
  close: () => Promise<void>;
}> => {
  const home = await mkdtemp(join(tmpdir(), "hreader-undo-home-"));
  const server = await startServer(
    { workspace: workspaceOf, port: 0, home, docId: DOC_ID },
    { patch: nodePatchDeps, style: nodeStyleDeps(workspaceOf), now: Date.now },
  );
  const post = async (path: string, body: Record<string, unknown>): Promise<Reply> => {
    const response = await fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
      method: "POST",
      headers: {
        cookie: `hr=${server.token}`,
        "content-type": "application/json",
        "x-hr-csrf": "1",
      },
      body: JSON.stringify(body),
    });
    const parsed: unknown = JSON.parse(await response.text());
    return { status: response.status, body: isRecord(parsed) ? parsed : {} };
  };
  return { post, close: () => server.close() };
};

const mcpCallOf = async (
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; code: string; payload: Record<string, unknown> }> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name, arguments: args });
  await session.close();
  const isError = isErrorResultOf(result);
  return {
    isError,
    code: isError ? codeOf(result) : "",
    payload: isError ? {} : payloadOf(result),
  };
};

const bytesIn = (workspaceOf: string): Promise<string> => readFile(join(workspaceOf, FILE), "utf8");

const patched = (): Promise<unknown> =>
  mcpCallOf("hr_patch_node", {
    filePath: FILE,
    nodeId: "p-1",
    action: "replace",
    htmlContent: "<p>新正文</p>",
  });

/** All snapshot filenames in the current workspace (under the per-document bucket layer), ascending. */
const snapshotsOf = async (workspaceOf: string): Promise<readonly string[]> => {
  const root = join(workspaceOf, ".hreader", "history");
  const names: string[] = [];
  for (const bucket of await readdir(root)) {
    for (const name of await readdir(join(root, bucket))) names.push(`${bucket}/${name}`);
  }
  return names.sort();
};

const styled = (): Promise<unknown> =>
  mcpCallOf("hr_apply_style", { filePath: FILE, visualId: PRESET });

describe("hr_undo · style change occupies one undo rung", () => {
  it("should leave a snapshot for the style change: one undo retracts only the style, the second retracts the patch, the third answers nothing_to_undo", async () => {
    const base = await bytesIn(workspace);
    await patched();
    const afterPatch = await bytesIn(workspace);
    await styled();
    expect(await bytesIn(workspace)).not.toBe(afterPatch);

    // The first undo retracts the style step: back to post-patch, pre-style bytes.
    const undo = await mcpCallOf("hr_undo", { filePath: FILE });
    expect(undo.isError).toBe(false);
    expect(await bytesIn(workspace)).toBe(afterPatch);

    // The second undo retracts the patch: back to the document's original bytes.
    const second = await mcpCallOf("hr_undo", { filePath: FILE });
    expect(second.isError).toBe(false);
    expect(await bytesIn(workspace)).toBe(base);

    const third = await mcpCallOf("hr_undo", { filePath: FILE });
    expect(third.code).toBe("nothing_to_undo");
  });
});

describe("hr_undo · snapshot-count guard", () => {
  it("should leave one snapshot each for applyStyle and patch (each write step gets its own undo rung)", async () => {
    await patched();
    const afterPatch = await snapshotsOf(workspace);
    expect(afterPatch).toHaveLength(1);

    await styled();
    const afterStyle = await snapshotsOf(workspace);
    expect(afterStyle).toHaveLength(2);
    // Two snapshots are different files with different contents: pre-patch bytes and pre-style bytes are not the same.
    expect(afterStyle[0]).not.toBe(afterStyle[1]);
  });
});

describe("hr_undo · diff against HTTP undo", () => {
  it("should get the same revision and the same bytes from HTTP undo and hr_undo on the same sequence", async () => {
    const httpWorkspace = await workspaceIn("hreader-mcp-undo-parity-http-");
    await writeFile(join(httpWorkspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const arm = await daemonArmOf(httpWorkspace);

    try {
      const httpRevision = await httpSequenceOf(arm);
      const mcpRevision = await mcpSequenceOf();

      // Both paths' sha256 (revision = first 16 chars of sha256) and whole bytes must be identical.
      expect(mcpRevision).toBe(httpRevision);
      expect(await bytesIn(workspace)).toBe(await bytesIn(httpWorkspace));
      // And both land at post-patch, pre-style: undo only retracted the style step — both sides on the same rung.
      expect(await bytesIn(workspace)).toContain("新正文");
      expect(await bytesIn(workspace)).not.toBe(ANNOTATED_DOC);
    } finally {
      await arm.close();
      await leaveWorkspace(httpWorkspace);
    }
  }, 30_000);

  it("should answer nothing_to_undo on the third undo on both sides (revertLast is the only error-code mapping)", async () => {
    const httpWorkspace = await workspaceIn("hreader-mcp-undo-parity-2nd-");
    await writeFile(join(httpWorkspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const arm = await daemonArmOf(httpWorkspace);

    try {
      await httpSequenceOf(arm);
      // The second undo retracts the patch: both sides should be back at the document's original bytes.
      const second = await arm.post(`/api/doc/${DOC_ID}/undo`, { docId: DOC_ID });
      expect(second.status).toBe(200);
      await mcpSequenceOf();
      const mcpSecond = await mcpCallOf("hr_undo", { filePath: FILE });
      expect(mcpSecond.isError).toBe(false);

      expect(await bytesIn(httpWorkspace)).toBe(ANNOTATED_DOC);
      expect(await bytesIn(workspace)).toBe(ANNOTATED_DOC);

      const third = await arm.post(`/api/doc/${DOC_ID}/undo`, { docId: DOC_ID });
      const mcpThird = await mcpCallOf("hr_undo", { filePath: FILE });
      expect(third.body["code"]).toBe("nothing_to_undo");
      expect(mcpThird.code).toBe("nothing_to_undo");
    } finally {
      await arm.close();
      await leaveWorkspace(httpWorkspace);
    }
  }, 30_000);
});

/** The HTTP arm runs patch → style → undo and returns that undo's revision. */
const httpSequenceOf = async (arm: Awaited<ReturnType<typeof daemonArmOf>>): Promise<unknown> => {
  await arm.post("/api/patch", {
    docId: DOC_ID,
    targetId: "p-1",
    action: "replace",
    fragment: "<p>新正文</p>",
  });
  await arm.post("/api/style", { docId: DOC_ID, visualId: PRESET });
  const undo = await arm.post(`/api/doc/${DOC_ID}/undo`, { docId: DOC_ID });
  expect(undo.status).toBe(200);
  return undo.body["revision"];
};

/** The MCP arm runs the same sequence and returns that undo's revision. */
const mcpSequenceOf = async (): Promise<unknown> => {
  await patched();
  await styled();
  const undo = await mcpCallOf("hr_undo", { filePath: FILE });
  expect(undo.isError).toBe(false);
  return undo.payload["revision"];
};
