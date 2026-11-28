// Library search, verified end-to-end: a real `hr serve` daemon answers
// `GET /api/search`, the real `hr` binary answers `hr search`, and the real
// `hreader-mcp` stdio server answers `hr_search` — all over the same sandbox
// workspace, including annotation hits and a live edit picked up by the
// query-time incremental scan.

import { writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { dataOf, docPath, hr, type JsonObject } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { startMcp, toolJson, type McpClient } from "../harness/mcp.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const DOC = "search-doc.html";
const OTHER = "search-other.html";
const BODY_A = `<!doctype html><html><head><title>维修手册</title></head><body><p>摩托车 发动机 保养</p></body></html>`;
const BODY_B = `<!doctype html><html><head><title>账本</title></head><body><p>支出 收入 结余</p></body></html>`;

const resultsOf = (body: JsonObject): readonly JsonObject[] =>
  (body["results"] as readonly JsonObject[] | undefined) ?? [];

const kindsOf = (body: JsonObject): readonly string[] =>
  resultsOf(body).map((hit) => String(hit["kind"]));

describe("library-search", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let mcp: McpClient;

  beforeAll(async () => {
    home = sandbox("search");
    await writeFile(docPath(home.ws, DOC), BODY_A, "utf8");
    await writeFile(docPath(home.ws, OTHER), BODY_B, "utf8");
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    // Seed one sidecar annotation through the real HTTP route so the index
    // sees the same store the daemon writes.
    const added = await api.postJson(`${docApi(DOC)}/sidecar`, {
      anchor: { exact: "发动机", prefix: "", suffix: "", start: 4 },
      selector: "body > p:nth-of-type(1)",
      note: "下次换全合成机油",
    });
    assert(typeof added["id"] === "string", `sidecar add failed: ${JSON.stringify(added)}`);
    mcp = await startMcp(home.ws);
  });

  afterAll(async () => {
    await mcp.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("GET /api/search returns doc and annotation hits", async () => {
    const doc = await api.getJson(`/api/search?q=${encodeURIComponent("摩托车")}`);
    assertEq(resultsOf(doc).length, 1, "doc hit count");
    assertEq(resultsOf(doc)[0]?.["path"], DOC, "doc hit path");
    assertEq(resultsOf(doc)[0]?.["kind"], "doc", "doc hit kind");

    const note = await api.getJson(`/api/search?q=${encodeURIComponent("全合成机油")}`);
    assertEq(kindsOf(note).includes("annotation"), true, "annotation hit kind");
    assertEq(resultsOf(note)[0]?.["path"], DOC, "annotation hit path");
    assert(typeof resultsOf(note)[0]?.["annotationId"] === "string", "annotationId present");
    // No absolute host path anywhere in the payload.
    assert(!JSON.stringify(note).includes(home.ws), "absolute path leaked");
  });

  test("hr search --json returns the same hits", async () => {
    const result = await hr(["search", "摩托车", "--workspace", home.ws, "--json"], {
      cwd: home.ws,
    });
    assertEq(result.code, 0, "hr search exit code");
    const data = dataOf(result, "hr search");
    assertEq(resultsOf(data).length, 1, "cli doc hit count");
    assertEq(resultsOf(data)[0]?.["path"], DOC, "cli doc hit path");

    const note = await hr(["search", "全合成机油", "--workspace", home.ws, "--json"], {
      cwd: home.ws,
    });
    assertEq(kindsOf(dataOf(note, "hr search note")).includes("annotation"), true, "cli note hit");
  });

  test("hr_search over stdio returns the same hits", async () => {
    const reply = toolJson(await mcp.call("hr_search", { query: "摩托车" }), "hr_search doc");
    assertEq(resultsOf(reply).length, 1, "mcp doc hit count");
    assertEq(resultsOf(reply)[0]?.["path"], DOC, "mcp doc hit path");

    const note = toolJson(await mcp.call("hr_search", { query: "全合成机油" }), "hr_search note");
    assertEq(kindsOf(note).includes("annotation"), true, "mcp note hit");
  });

  test("a doc edit shows up on the next query without a restart", async () => {
    await writeFile(docPath(home.ws, OTHER), BODY_B.replace("结余", "结余 定期检修"), "utf8");
    const result = await hr(["search", "定期检修", "--workspace", home.ws, "--json"], {
      cwd: home.ws,
    });
    const data = dataOf(result, "hr search after edit");
    assertEq(resultsOf(data).length, 1, "post-edit hit count");
    assertEq(resultsOf(data)[0]?.["path"], OTHER, "post-edit hit path");
  });
});
