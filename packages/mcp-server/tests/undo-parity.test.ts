// 这层管：`hr_undo` 与 HTTP `POST /api/doc/<docId>/undo` 在**最反直觉的那个场景**下必须同样怪。
//
// 场景：`patch` → `applyStyle` → 一次 undo。`applyStyle` 不写快照（`packages/core/src/style/apply-file.ts`
// 全文无 `writeSnapshot`），所以那唯一的快照是 patch 前的内容：一次 undo 把正文和样式一起回退。
// 这不是本层实现的行为，而是 `revertLast` 的行为——两条路径只要真的共用它，就必然一致；
// 若不一致，说明 MCP 侧没走 `revertLast`。
//
// 它会因为什么而红：`hr_undo` 换成 `undoPatch`/自写还原、HTTP 与 MCP 的锁等待或目标解析分叉。

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

describe("hr_undo · 换样式不留快照的语义", () => {
  it("换样式不留快照：一次 undo 连正文一起回退，第二次 nothing_to_undo", async () => {
    const base = await bytesIn(workspace);
    await patched();
    await styled();
    expect(await bytesIn(workspace)).not.toBe(base);

    const undo = await mcpCallOf("hr_undo", { filePath: FILE });
    // 依据：`packages/core/src/style/apply-file.ts` 全文没有 `writeSnapshot`——
    // 所以 undo 回到的是 patch 前那份快照，样式改动跟着一起没了。
    expect(undo.isError).toBe(false);
    expect(await bytesIn(workspace)).toBe(base);

    const again = await mcpCallOf("hr_undo", { filePath: FILE });
    expect(again.code).toBe("nothing_to_undo");
  });
});

describe("hr_undo · 不留快照的第二个守卫", () => {
  it("applyStyle 不改快照数量（换样式不留撤销台阶）", async () => {
    await patched();
    const before = await snapshotsOf(workspace);
    // 非零下界：patch 那一层确实留下了快照，否则下面的相等是真空为真。
    expect(before).toHaveLength(1);

    await styled();
    expect(await snapshotsOf(workspace)).toEqual(before);
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
      // 并且都回到了 patch 前（再次确认这个语义在两边同样怪）。
      expect(await bytesIn(workspace)).toBe(ANNOTATED_DOC);
    } finally {
      await arm.close();
      await leaveWorkspace(httpWorkspace);
    }
  }, 30_000);

  it("两侧对第二次 undo 都报 nothing_to_undo（错误码映射只有 revertLast 一份）", async () => {
    const httpWorkspace = await workspaceIn("hreader-mcp-undo-parity-2nd-");
    await writeFile(join(httpWorkspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const arm = await daemonArmOf(httpWorkspace);

    try {
      await httpSequenceOf(arm);
      const second = await arm.post(`/api/doc/${DOC_ID}/undo`, { docId: DOC_ID });
      await mcpSequenceOf();
      const mcpSecond = await mcpCallOf("hr_undo", { filePath: FILE });

      expect(second.body["code"]).toBe("nothing_to_undo");
      expect(mcpSecond.code).toBe("nothing_to_undo");
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
