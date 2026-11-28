// Document metadata end-to-end: the real `hr` binary writes tags + sourceUrl
// (`hr meta`), the real `hr serve` daemon answers `GET /api/doc/<docId>/meta`
// and broadcasts `doc.meta` on a POST, the real `hreader-mcp` stdio server
// answers `hr_get_meta` / `hr_set_meta` (agent provenance), and a tag written
// through any surface is searchable through all of them.

import { writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { dataOf, docPath, hr, type JsonObject } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api, type SseStream } from "../harness/http.ts";
import { startMcp, toolJson, type McpClient } from "../harness/mcp.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const DOC = "meta-doc.html";
const BODY = `<!doctype html><html><head><title>维修手册</title></head><body><p>摩托车 发动机 保养</p></body></html>`;

const resultsOf = (body: JsonObject): readonly JsonObject[] =>
  (body["results"] as readonly JsonObject[] | undefined) ?? [];

const tagsOf = (body: JsonObject): readonly string[] =>
  (body["tags"] as readonly string[] | undefined) ?? [];

describe("doc-meta", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let mcp: McpClient;
  let sse: SseStream;

  beforeAll(async () => {
    home = sandbox("meta");
    await writeFile(docPath(home.ws, DOC), BODY, "utf8");
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    sse = await api.openSse();
    // The stream's first frame is `ready`; consuming it now keeps later waits type-pure.
    assert((await sse.next("ready")) !== undefined, "SSE ready frame never arrived");
    mcp = await startMcp(home.ws);
  });

  afterAll(async () => {
    sse.close();
    await mcp.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("hr meta writes tags + sourceUrl read back by HTTP and MCP", async () => {
    const written = await hr(
      [
        "meta",
        DOC,
        "--workspace",
        home.ws,
        "--tag",
        "园艺",
        "--tag",
        "保养",
        "--source-url",
        "https://example.com/manual",
        "--json",
      ],
      { cwd: home.ws },
    );
    assertEq(written.code, 0, "hr meta write exit code");
    const data = dataOf(written, "hr meta write");
    assertEq(tagsOf(data).join(","), "园艺,保养", "cli tags");
    assertEq(data["sourceUrl"], "https://example.com/manual", "cli sourceUrl");
    assertEq(data["createdBy"], "user", "cli provenance");

    // HTTP read of what the CLI wrote — `by: user` survives.
    const http = await api.getJson(`${docApi(DOC)}/meta`);
    assertEq(tagsOf(http).join(","), "园艺,保养", "http tags");
    assertEq(http["createdBy"], "user", "http provenance preserved");

    // MCP read of the same row — the stable null/shape fields land on the wire.
    const reply = toolJson(await mcp.call("hr_get_meta", { filePath: DOC }), "hr_get_meta");
    assertEq(tagsOf(reply).join(","), "园艺,保养", "mcp tags");
    assertEq(reply["sourceUrl"], "https://example.com/manual", "mcp sourceUrl");
  });

  test("POST /api/doc/<docId>/meta merges and broadcasts doc.meta once", async () => {
    const posted = await api.postJson(`${docApi(DOC)}/meta`, {
      addTags: ["摘录"],
      removeTags: ["保养"],
      sourceUrl: null,
    });
    assertEq(tagsOf(posted).join(","), "园艺,摘录", "http merged tags");
    assertEq(posted["sourceUrl"], null, "http sourceUrl cleared");
    assertEq(posted["changed"], true, "http changed flag");

    const event = await sse.next("doc.meta");
    assert(event !== undefined, "doc.meta SSE event never arrived");
    assertEq(event.data["docId"], DOC, "doc.meta event docId");

    // CLI reads the HTTP write back.
    const read = await hr(["meta", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assertEq(tagsOf(dataOf(read, "hr meta read")).join(","), "园艺,摘录", "cli re-read tags");
  });

  test("hr_set_meta records agent provenance on first write and preserves it", async () => {
    // Provenance is a first-write fact: DOC already carries `user` from the CLI, so MCP
    // first-writes a fresh doc to prove `agent` lands — then user stays put on DOC.
    const FRESH = "meta-mcp-doc.html";
    await writeFile(docPath(home.ws, FRESH), BODY, "utf8");

    const set = toolJson(
      await mcp.call("hr_set_meta", {
        filePath: FRESH,
        tags: ["机读"],
        sourceUrl: "https://mcp.test/ref",
      }),
      "hr_set_meta",
    );
    assertEq(tagsOf(set).join(","), "机读", "mcp write tags");
    assertEq(set["createdBy"], "agent", "mcp provenance");
    assertEq(set["changed"], true, "mcp changed");

    const http = await api.getJson(`${docApi(FRESH)}/meta`);
    assertEq(http["createdBy"], "agent", "http sees agent provenance");
    assert(!JSON.stringify(http).includes(home.ws), "absolute path leaked");

    // And on the CLI-written doc the earlier `user` stamp survives the MCP write path.
    const kept = toolJson(
      await mcp.call("hr_set_meta", { filePath: DOC, addTags: ["机读"] }),
      "hr_set_meta merge",
    );
    assertEq(kept["createdBy"], "user", "first-write provenance preserved");
  });

  test("a tag written through any surface is searchable through all of them", async () => {
    // The CLI write lands in the index's tag field — HTTP/CLI/MCP search all find it.
    const tagged = await hr(
      ["meta", DOC, "--workspace", home.ws, "--tag", "罕见检索词", "--json"],
      { cwd: home.ws },
    );
    assertEq(tagged.code, 0, "hr meta tag exit code");

    const httpSearch = await api.getJson(`/api/search?q=${encodeURIComponent("罕见检索词")}`);
    assertEq(resultsOf(httpSearch).length, 1, "http tag hit count");
    assertEq(resultsOf(httpSearch)[0]?.["path"], DOC, "http tag hit path");
    assertEq(
      (resultsOf(httpSearch)[0]?.["tags"] as readonly string[] | undefined)?.includes("罕见检索词"),
      true,
      "hit carries the tag list",
    );

    const cliSearch = await hr(["search", "罕见检索词", "--workspace", home.ws, "--json"], {
      cwd: home.ws,
    });
    assertEq(resultsOf(dataOf(cliSearch, "hr search by tag")).length, 1, "cli tag hit count");

    const mcpSearch = toolJson(
      await mcp.call("hr_search", { query: "罕见检索词" }),
      "hr_search by tag",
    );
    assertEq(resultsOf(mcpSearch).length, 1, "mcp tag hit count");
    assertEq(resultsOf(mcpSearch)[0]?.["path"], DOC, "mcp tag hit path");
  });
});
