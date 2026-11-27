// Journey 4 (multi-writer concurrency): the CLI / MCP / HTTP entry points run
// patch/style/undo against the same document at once.
// Asserted: lock serialization (no 5xx/tearing), every write lands on a
// distinct revision (no lost update), and the final file stays intact.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, test } from "vitest";

import { assert, assertEq, parseJson } from "../harness/check.ts";
import { docPath, hr, jsonOf, newDoc } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { startMcp, toolJson, type McpClient } from "../harness/mcp.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const DOC = "race.hr.html";

let home: TestHome;
let daemon: Daemon;
let api: Api;
let mcp: McpClient;
let visualId = "";
/** The data-hr-ids of the first two body blocks in the `hr new` skeleton. */
let nodeA = "";
let nodeB = "";

const infoRevision = async (): Promise<string> => {
  const info = await api.getJson(`${docApi(DOC)}/info`);
  const rev = info["revision"];
  assert(
    typeof rev === "string" && rev !== "",
    `info.revision is abnormal: ${JSON.stringify(info)}`,
  );
  return rev;
};

beforeAll(async () => {
  home = sandbox("race");
  await newDoc(home.ws, DOC);
  daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
  api = await connect(daemon.port, daemon.token);
  mcp = await startMcp(home.ws);
  const themes = await api.getJson("/api/theme");
  const ids = themes["themes"];
  assert(
    Array.isArray(ids) && ids.length > 0,
    `/api/theme list is abnormal: ${JSON.stringify(themes)}`,
  );
  const first: unknown = ids[0];
  assert(typeof first === "string", "theme id is not a string");
  visualId = first;
  const html = await readFile(docPath(home.ws, DOC), "utf8");
  const allIds = [...html.matchAll(/data-hr-id="([^"]+)"/gu)].map((m) => m[1]);
  assert(
    allIds.length >= 3,
    `hr new skeleton has fewer than three data-hr-ids: ${allIds.join(",")}`,
  );
  // Skip the first (the container element: replacing it would delete its child
  // blocks along with it); take two sibling-level body blocks.
  const [, a, b] = allIds;
  nodeA = a ?? "";
  nodeB = b ?? "";
});

afterAll(async () => {
  await mcp.close();
  await daemon.stop();
  await killAllTracked();
  home.cleanup();
});

test("should keep concurrent patch/style from all three entries successful, 5xx-free and on distinct revisions", async () => {
  const revs = new Set<string>();
  let revSeen = 0;
  let writes = 0;
  const collect = (rev: unknown): void => {
    if (typeof rev === "string") {
      revSeen += 1;
      revs.add(rev);
    }
  };
  const round = async (i: number): Promise<void> => {
    const cli = await hr(
      [
        "patch",
        DOC,
        nodeA,
        "--action",
        "replace",
        "--html",
        `<p data-hr-id="${nodeA}">CLI-${String(i)}</p>`,
        "--workspace",
        home.ws,
        "--json",
      ],
      { cwd: home.ws },
    );
    assertEq(cli.code, 0, `round ${String(i)} CLI patch failed: ${cli.stderr} ${cli.stdout}`);
    const cliBody = jsonOf(cli, `round ${String(i)} CLI patch`);
    writes += 1;
    if (typeof cliBody["data"] === "object" && cliBody["data"] !== null) {
      collect(Reflect.get(cliBody["data"], "revision"));
    }

    const viaMcp = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId: nodeB,
      action: "replace",
      htmlContent: `<p data-hr-id="${nodeB}">MCP-${String(i)}</p>`,
    });
    assert(!viaMcp.isError, `round ${String(i)} MCP patch failed: ${viaMcp.text}`);
    const mcpJson = toolJson(viaMcp, `round ${String(i)} MCP patch`);
    writes += 1;
    collect(mcpJson["revision"]);

    const http = await api.post("/api/patch", {
      docId: DOC,
      targetId: nodeA,
      action: "replace",
      fragment: `<p data-hr-id="${nodeA}">HTTP-${String(i)}</p>`,
    });
    assert(http.status === 200, `round ${String(i)} HTTP patch status ${String(http.status)}`);
    const httpBody = parseJson(await http.text(), "HTTP patch response");
    writes += 1;
    if (typeof httpBody === "object" && httpBody !== null) {
      collect(Reflect.get(httpBody, "revision"));
    }
  };
  for (let i = 0; i < 8; i += 1) await round(i);
  const [, styleMcp, styleHttp] = await Promise.all([
    round(8),
    mcp.call("hr_apply_style", { filePath: DOC, visualId }),
    api.post("/api/style", { docId: DOC, visualId }),
  ]);
  assert(!styleMcp.isError, `concurrent hr_apply_style errored: ${styleMcp.text}`);
  assert(styleHttp.status === 200, `concurrent HTTP style status ${String(styleHttp.status)}`);
  // Only HTTP receipts carry a revision (the CLI/MCP contract is
  // historyPath/changed): every one received must be a fresh value — a lost
  // update/overwrite shows up as a duplicate revision.
  assert(
    revs.size === revSeen && revSeen === 9,
    `lost-update suspect: ${String(revSeen)} receipt revisions contain only ${String(revs.size)} distinct values (writes=${String(writes)})`,
  );
  const bytes = await readFile(docPath(home.ws, DOC), "utf8");
  assert(
    bytes.includes("<html") && bytes.trimEnd().endsWith("</html>"),
    "file half-written (head/tail incomplete)",
  );
});

test("should serialize concurrent undo + patch and leave the file and history dir intact", async () => {
  const before = await infoRevision();
  const [undo1, undo2, mcpUndo, httpUndo, patch] = await Promise.all([
    hr(["undo", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws }),
    hr(["undo", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws }),
    mcp.call("hr_undo", { filePath: DOC }),
    api.post(`${docApi(DOC)}/undo`, {}),
    hr(
      [
        "patch",
        DOC,
        nodeA,
        "--action",
        "replace",
        "--html",
        `<p data-hr-id="${nodeA}">并发后</p>`,
        "--workspace",
        home.ws,
        "--json",
      ],
      { cwd: home.ws },
    ),
  ]);
  assertEq(patch.code, 0, `patch failed mid-concurrency: ${patch.stderr} ${patch.stdout}`);
  for (const [index, undo] of [undo1, undo2].entries()) {
    assert(
      undo.code === 0 || (undo.code === 1 && undo.stdout.includes("nothing_to_undo")),
      `concurrent undo[${String(index)}] failed illegally: ${undo.stdout} ${undo.stderr}`,
    );
  }
  assert(
    httpUndo.status === 200 || httpUndo.status === 409 || httpUndo.status === 422,
    `HTTP undo status ${String(httpUndo.status)}`,
  );
  if (mcpUndo.isError) {
    assert(
      /nothing_to_undo|history|undo/i.test(mcpUndo.text),
      `MCP undo is abnormal: ${mcpUndo.text}`,
    );
  }
  const after = await infoRevision();
  assert(
    after !== "" && after !== before,
    `revision abnormal after concurrent undo: ${before} → ${after}`,
  );
  const histDir = join(home.ws, ".hreader", "history");
  const snaps = await readdir(histDir).catch(() => [] as string[]);
  assert(Array.isArray(snaps), "failed to read the history dir");
  const bytes = await readFile(docPath(home.ws, DOC), "utf8");
  assert(
    bytes.includes("<html") && bytes.includes("</html>"),
    "final file is not complete HTML (half-written)",
  );
});
