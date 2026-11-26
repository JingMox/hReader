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

/** HTTP 臂：真起一个 daemon（`port: 0`），写路由走 cookie + csrf。 */
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

/** 当前 workspace 里所有快照文件名（按文档分桶的那层之下），升序。 */
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

describe("hr_undo · 换样式占一个撤销台阶的语义", () => {
  it("换样式留快照：一次 undo 只退样式，第二次退 patch，第三次 nothing_to_undo", async () => {
    const base = await bytesIn(workspace);
    await patched();
    const afterPatch = await bytesIn(workspace);
    await styled();
    expect(await bytesIn(workspace)).not.toBe(afterPatch);

    // 第一次 undo 退掉的是样式那一步：回到 patch 后、样式前的字节。
    const undo = await mcpCallOf("hr_undo", { filePath: FILE });
    expect(undo.isError).toBe(false);
    expect(await bytesIn(workspace)).toBe(afterPatch);

    // 第二次 undo 退掉 patch：回到全文最初的字节。
    const second = await mcpCallOf("hr_undo", { filePath: FILE });
    expect(second.isError).toBe(false);
    expect(await bytesIn(workspace)).toBe(base);

    const third = await mcpCallOf("hr_undo", { filePath: FILE });
    expect(third.code).toBe("nothing_to_undo");
  });
});

describe("hr_undo · 快照数量的守卫", () => {
  it("applyStyle 与 patch 各留一份快照（每步写各有一个撤销台阶）", async () => {
    await patched();
    const afterPatch = await snapshotsOf(workspace);
    expect(afterPatch).toHaveLength(1);

    await styled();
    const afterStyle = await snapshotsOf(workspace);
    expect(afterStyle).toHaveLength(2);
    // 两份快照是不同内容的不同文件：patch 前字节与样式前字节不是同一份。
    expect(afterStyle[0]).not.toBe(afterStyle[1]);
  });
});

describe("hr_undo · 与 HTTP undo 的差分", () => {
  it("同一序列走 HTTP undo，与 hr_undo 得到同一个 revision 与同一份字节", async () => {
    const httpWorkspace = await workspaceIn("hreader-mcp-undo-parity-http-");
    await writeFile(join(httpWorkspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const arm = await daemonArmOf(httpWorkspace);

    try {
      const httpRevision = await httpSequenceOf(arm);
      const mcpRevision = await mcpSequenceOf();

      // 两条路径的 sha256（revision = sha256 前 16 位）与整份字节都必须逐字相等。
      expect(mcpRevision).toBe(httpRevision);
      expect(await bytesIn(workspace)).toBe(await bytesIn(httpWorkspace));
      // 并且都停在 patch 后、样式前：undo 只退掉了样式那一步，两侧同台阶。
      expect(await bytesIn(workspace)).toContain("新正文");
      expect(await bytesIn(workspace)).not.toBe(ANNOTATED_DOC);
    } finally {
      await arm.close();
      await leaveWorkspace(httpWorkspace);
    }
  }, 30_000);

  it("两侧对第三次 undo 都报 nothing_to_undo（错误码映射只有 revertLast 一份）", async () => {
    const httpWorkspace = await workspaceIn("hreader-mcp-undo-parity-2nd-");
    await writeFile(join(httpWorkspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const arm = await daemonArmOf(httpWorkspace);

    try {
      await httpSequenceOf(arm);
      // 第二次 undo 退 patch：两侧都应回到全文最初的字节。
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

/** HTTP 臂跑 patch → style → undo，返回那次 undo 的 revision。 */
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

/** MCP 臂跑同一序列，返回那次 undo 的 revision。 */
const mcpSequenceOf = async (): Promise<unknown> => {
  await patched();
  await styled();
  const undo = await mcpCallOf("hr_undo", { filePath: FILE });
  expect(undo.isError).toBe(false);
  return undo.payload["revision"];
};
