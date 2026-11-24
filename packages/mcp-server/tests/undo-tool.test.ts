// 这层管：`hr_undo` 的五条用户可见行为、两层快照的严格 LIFO、三条错误码的诚实性、
// 并发、以及"快照被外部删掉/改坏"时不留半还原状态、无 no-op 台阶。
//
// 它会因为什么而红：把 `revertLast` 换成 `undoPatch`（`undo_unavailable` 会漏进工具结果）、
// 去掉 core 的 `runLocked`（两个并发 undo 都成功）、或 undo 只"报告成功"而不真写回字节。

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
    // 错误结果的 text 是 `[code] 提示` 而非 JSON：只有成功结果才有一份可解析的报文。
    payload: isError ? {} : payloadOf(result),
    uri: isError ? "" : uiUriOf(result),
  };
};

const undoOf = (filePath = "doc.html"): Promise<Outcome> => callOf("hr_undo", { filePath });

const patchOf = (nodeId: string, html: string): Promise<Outcome> =>
  callOf("hr_patch_node", { filePath: "doc.html", nodeId, action: "replace", htmlContent: html });

const bytesOf = (): Promise<string> => readFile(join(workspace, "doc.html"), "utf8");

const DOC_ID = "doc.html";

/** 前端对齐用的 revision = 内容 sha256 的前 16 位（`revertLast` 的定义）。 */
const revisionOf = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);

describe("hr_undo · 有效性", () => {
  it("should put the pre-patch bytes back, and report the same revision the frontend would", async () => {
    const before = await bytesOf();
    await patchOf("p-1", "<p>新正文</p>");
    const patched = await bytesOf();
    const undo = await undoOf();

    expect(undo.isError).toBe(false);
    // 判定用文件字节，不是"工具没报错"。
    expect(await bytesOf()).toBe(before);
    expect(patched).not.toBe(before);
    expect(undo.payload["revision"]).toBe(revisionOf(before));
    // `bytes` 是**还原后**的字节数（就是写前那份快照的字节数）。
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

describe("hr_undo · 快照消费", () => {
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

describe("hr_undo · 错误码诚实性", () => {
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
      // 反向：既不是 core 内部码，也不是兜底的 `internal`。
      expect(result.code).not.toBe("internal");
    }
  });
});

describe("hr_undo · 并发与残缺", () => {
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
    // 快照没了 = 没有历史可退；目标文件必须原地不动（不是半还原）。
    expect(undo.code).toBe("nothing_to_undo");
    expect(await bytesOf()).toBe(patched);
  });
});

describe("hr_undo · 两层快照严格 LIFO", () => {
  it("两次 patch 后逐次 undo 严格退最近一份（不是退任意一份）", async () => {
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

    // 每一步的 revision 就是"该步还原后"的内容哈希，且三步互不相等。
    expect(first.payload["revision"]).toBe(revisionOf(s1));
    expect(second.payload["revision"]).toBe(revisionOf(s0));
    expect(new Set([revisionOf(s0), revisionOf(s1), revisionOf(s2)]).size).toBe(3);
    expect(third.code).toBe("nothing_to_undo");
  });
});

describe("hr_undo · 快照被改坏", () => {
  it("哈希不符时拒绝写回（io_failure），目标文件不动且快照不被消费", async () => {
    await patchOf("p-1", "<p>新正文</p>");
    const patched = await bytesOf();
    // 快照目录按文档路径分桶：`.hreader/history/<docId 的 sha1>/<hash16>-<ts>-<seq>.html`。
    const root = join(workspace, ".hreader", "history");
    const buckets = await readdir(root);
    expect(buckets).toHaveLength(1);
    const dir = join(root, String(buckets[0]));
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    await writeFile(join(dir, String(names[0])), "garbage", "utf8");

    const undo = await undoOf();
    expect(undo.code).toBe("io_failure");
    // ① 目标文件字节不变（不是写回半截内容）。
    expect(await bytesOf()).toBe(patched);
    // ② 快照仍在：坏快照也不消费，否则真历史一起丢。
    expect(await readdir(dir)).toEqual(names);
  });
});

describe("hr_undo · 批注在场时 undo（C）", () => {
  it("退回到 patch 前，`pending_ai` 批注原样保留并在 hr_outline 里仍可见", async () => {
    await patchOf("p-1", "<p>改后的正文</p>");
    const undo = await undoOf();
    expect(undo.isError).toBe(false);

    expect(await bytesOf()).toBe(ANNOTATED_DOC);
    expect(await bytesOf()).toContain('"id":"ann-01"');
    const outline = await callOf("hr_outline", { filePath: "doc.html" });
    expect(outline.text).toContain("ann-01");
  });
});

describe("hr_undo · 无 no-op 台阶（D）", () => {
  it("没改动就不出快照（changed/undoable=false、historyPath=null），undo 仍是 nothing_to_undo", async () => {
    const noop = await patchOf("p-1", '<p data-hr-id="p-1">正文</p>');

    expect(noop.payload["changed"]).toBe(false);
    expect(noop.payload["undoable"]).toBe(false);
    expect(noop.payload["historyPath"]).toBe(null);
    const undo = await undoOf();
    expect(undo.code).toBe("nothing_to_undo");
    expect(await bytesOf()).toBe(ANNOTATED_DOC);
  });
});
