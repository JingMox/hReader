// The agent annotation surface end-to-end: a sidecar annotation created over
// the real `hr serve` HTTP wire shows up in stdio-MCP `hr_outline` and
// `hr_list_annotations`, `hr_resolve_annotation` resolves it, and the on-disk
// `.hreader/annotations/*.json` store carries the flipped status.
// Runs on a foreign doc — the sidecar store is doc-class agnostic and the
// journey exercises the MCP tools, not the reader.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq, parseJson } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { startMcp, toolJson, type McpClient } from "../harness/mcp.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const DOC = "agent-note.html";
const BODY = `<!doctype html><html><body><div><p>first paragraph</p><p>second paragraph</p></div></body></html>`;

type JsonMap = Record<string, unknown>;

const listOf = (body: JsonMap, key: string): readonly JsonMap[] =>
  (body[key] as readonly JsonMap[] | undefined) ?? [];

/** The only sidecar record in the sandbox store; `undefined` when the store has not been written yet. */
const sidecarRecord = async (ws: string): Promise<JsonMap | undefined> => {
  const dir = join(ws, ".hreader", "annotations");
  const names = await readdir(dir).catch(() => [] as string[]);
  const hit = names.find((name) => name.endsWith(".json"));
  if (hit === undefined) return undefined;
  const parsed: unknown = parseJson(await readFile(join(dir, hit), "utf8"), "sidecar record");
  assert(typeof parsed === "object" && parsed !== null, "sidecar record is not an object");
  return parsed as JsonMap;
};

describe("agent-annotations", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let mcp: McpClient;

  beforeAll(async () => {
    home = sandbox("agent-annotations");
    await writeFile(docPath(home.ws, DOC), BODY, "utf8");
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    mcp = await startMcp(home.ws);
  });

  afterAll(async () => {
    await mcp.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("HTTP sidecar add → outline/list see it → resolve → store on disk flips", async () => {
    // A sidecar annotation created over the HTTP wire (the same call the reader uses).
    const added = await api.postJson(`${docApi(DOC)}/sidecar`, {
      anchor: { exact: "second", prefix: "", suffix: "", start: 15 },
      selector: "body > div:nth-of-type(1) > p:nth-of-type(2)",
      note: "agent 可见性",
    });
    const id = added["id"];
    assert(typeof id === "string" && id.startsWith("an-"), `add reply: ${JSON.stringify(added)}`);

    // hr_outline: pending meta annotations stay in `pendingAnnotations`; the sidecar
    // entry rides in the additive `sidecarAnnotations` block.
    const outline = toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline");
    const sidecars = listOf(outline, "sidecarAnnotations");
    assertEq(sidecars.length, 1, "hr_outline sidecarAnnotations count");
    assertEq(sidecars[0]?.["id"], id, "hr_outline sidecar id");
    assertEq(sidecars[0]?.["source"], "sidecar", "hr_outline sidecar source");
    assertEq(sidecars[0]?.["status"], "pending", "hr_outline sidecar status");

    // hr_list_annotations, doc mode: the merged view carries the same entry.
    const listed = toolJson(
      await mcp.call("hr_list_annotations", { filePath: DOC }),
      "hr_list_annotations file",
    );
    const docEntries = listOf(listed, "annotations");
    assertEq(docEntries.length, 1, "hr_list_annotations doc count");
    assertEq(docEntries[0]?.["id"], id, "hr_list_annotations doc id");
    assertEq(docEntries[0]?.["file"], DOC, "hr_list_annotations doc file label");

    // hr_list_annotations, workspace scan mode: the doc surfaces with its file label.
    const scanned = toolJson(await mcp.call("hr_list_annotations", {}), "hr_list_annotations scan");
    const scanEntries = listOf(scanned, "annotations");
    const scanHit = scanEntries.find((entry) => entry["id"] === id);
    assert(scanHit !== undefined, `scan missed the sidecar entry: ${JSON.stringify(scanned)}`);
    assertEq(scanHit["file"], DOC, "scan entry file label");
    assertEq(scanned["truncated"], false, "scan truncated flag");

    // hr_resolve_annotation: meta misses the id, the sidecar fallback resolves it.
    const resolved = toolJson(
      await mcp.call("hr_resolve_annotation", { filePath: DOC, annotationId: id }),
      "hr_resolve_annotation",
    );
    assertEq(resolved["source"], "sidecar", "resolve source");
    const resolvedAnnotation = resolved["annotation"] as JsonMap | undefined;
    assertEq(resolvedAnnotation?.["status"], "resolved", "resolve status");

    // The on-disk store flipped — the daemon's merged read and the raw record agree.
    const after = await api.getJson(`${docApi(DOC)}/sidecar`);
    assertEq(listOf(after, "annotations")[0]?.["status"], "resolved", "HTTP list status");
    const record = await sidecarRecord(home.ws);
    const stored = listOf(record ?? {}, "annotations");
    assertEq(stored[0]?.["status"], "resolved", "on-disk record status");
  });

  test("an unknown id keeps the frozen not-found wording", async () => {
    const reply = await mcp.call("hr_resolve_annotation", {
      filePath: DOC,
      annotationId: "an-deadbeef",
    });
    assertEq(reply.isError, true, "unknown id should be an error result");
    assert(reply.text.includes("批注不存在"), `frozen wording drifted: ${reply.text}`);
  });
});
