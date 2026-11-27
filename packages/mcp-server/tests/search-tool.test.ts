// This layer covers `hr_search` — the workspace-wide full-text search tool: hits shape,
// bounded output, schema bounds, and the no-absolute-paths rule over the wire.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serializeSidecarFile } from "@hreader/core";

import {
  isErrorResultOf,
  isRecord,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  textOf,
  workspaceIn,
  type Session,
} from "./harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

let workspace = "";
let session: Session | undefined;

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-search-");
  process.chdir(workspace);
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  await leaveWorkspace(workspace);
});

const clientOf = async (): Promise<Session["client"]> => {
  session = await sessionOf();
  return session.client;
};

const seedSidecar = async (file: string, note: string): Promise<void> => {
  const dir = join(workspace, ".hreader", "annotations");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${createHash("sha1").update(file).digest("hex")}.json`),
    serializeSidecarFile(file, [
      {
        id: "an-deadbeef",
        selector: "body > p:nth-of-type(1)",
        anchor: { exact: "机油", prefix: "", suffix: "", start: 0 },
        note,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        author: "user",
        replies: [],
      },
    ]),
    "utf8",
  );
};

const resultsOf = (result: unknown): readonly Record<string, unknown>[] => {
  const results = payloadOf(result)["results"];
  return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
};

describe("hr_search", () => {
  it("finds a doc with the bounded wire shape", async () => {
    await writeFile(join(workspace, "a.html"), DOC("维修手册", "摩托车 发动机 保养"), "utf8");
    const client = await clientOf();
    const result = await client.callTool({ name: "hr_search", arguments: { query: "摩托车" } });
    const payload = payloadOf(result);
    const results = resultsOf(result);
    expect(results.length).toBe(1);
    const hit = results[0];
    expect(hit?.["path"]).toBe("a.html");
    expect(hit?.["kind"]).toBe("doc");
    expect(typeof hit?.["snippet"]).toBe("string");
    expect(Array.isArray(hit?.["highlights"])).toBe(true);
    expect(payload["total"]).toBe(1);
    expect(payload["truncated"]).toBe(false);
    // No absolute host path anywhere in the payload.
    expect(textOf(result).includes(workspace)).toBe(false);
  });

  it("returns annotation hits with the annotation id", async () => {
    await writeFile(join(workspace, "a.html"), DOC("维修手册", "换了机油"), "utf8");
    await seedSidecar("a.html", "下次换全合成机油");
    const client = await clientOf();
    const result = await client.callTool({ name: "hr_search", arguments: { query: "全合成" } });
    const hit = resultsOf(result)[0];
    expect(hit?.["kind"]).toBe("annotation");
    expect(hit?.["annotationId"]).toBe("an-deadbeef");
    expect(hit?.["path"]).toBe("a.html");
  });

  it("honors the limit argument", async () => {
    for (const name of ["a.html", "b.html", "c.html"]) {
      await writeFile(join(workspace, name), DOC("t", "共享词条 检索词"), "utf8");
    }
    const client = await clientOf();
    const result = await client.callTool({
      name: "hr_search",
      arguments: { query: "检索词", limit: 2 },
    });
    expect(resultsOf(result).length).toBe(2);
  });

  it("rejects out-of-shape arguments before core sees them", async () => {
    const client = await clientOf();
    for (const args of [
      { query: "" },
      { query: "检".repeat(201) },
      { query: "a", limit: 0 },
      { query: "a", limit: 101 },
      { query: "a", limit: 1.5 },
    ]) {
      const result = await client.callTool({ name: "hr_search", arguments: args });
      expect(isErrorResultOf(result)).toBe(true);
    }
  });

  it("folds a core failure into an error result", async () => {
    const client = await clientOf();
    // Deleting the cwd makes `searchLibrary`'s realpath fail — the tool must answer an
    // isError receipt, not throw out of the SDK handler.
    await rm(workspace, { recursive: true, force: true });
    const result = await client.callTool({ name: "hr_search", arguments: { query: "摩托" } });
    expect(isErrorResultOf(result)).toBe(true);
  });

  it("reports a clean answer for an empty workspace", async () => {
    const client = await clientOf();
    const result = await client.callTool({ name: "hr_search", arguments: { query: "摩托" } });
    expect(isRecord(payloadOf(result))).toBe(true);
    expect(resultsOf(result)).toEqual([]);
  });
});
