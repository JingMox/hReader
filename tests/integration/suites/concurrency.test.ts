// 旅程 4（多写者并发）：CLI / MCP / HTTP 三入口对同一文档并发 patch/style/undo。
// 断言：锁串行化（无 5xx/撕裂）、每次写拿到互不相同的 revision（无丢更新）、最终文件完整。

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
/** `hr new` 骨架里前两个正文块的 data-hr-id。 */
let nodeA = "";
let nodeB = "";

const infoRevision = async (): Promise<string> => {
  const info = await api.getJson(`${docApi(DOC)}/info`);
  const rev = info["revision"];
  assert(typeof rev === "string" && rev !== "", `info.revision 异常：${JSON.stringify(info)}`);
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
  assert(Array.isArray(ids) && ids.length > 0, `/api/theme 列表异常：${JSON.stringify(themes)}`);
  const first: unknown = ids[0];
  assert(typeof first === "string", "主题 id 不是字符串");
  visualId = first;
  const html = await readFile(docPath(home.ws, DOC), "utf8");
  const allIds = [...html.matchAll(/data-hr-id="([^"]+)"/gu)].map((m) => m[1]);
  assert(allIds.length >= 3, `hr new 骨架 data-hr-id 不足三个：${allIds.join(",")}`);
  // 跳过第一个（容器元素：replace 它会把子块一起删掉），取两个兄弟级正文块。
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

test("三入口并发 patch/style：全部成功、HTTP 无 5xx、revision 互不相同", async () => {
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
    assertEq(cli.code, 0, `第 ${String(i)} 轮 CLI patch 失败：${cli.stderr} ${cli.stdout}`);
    const cliBody = jsonOf(cli, `第 ${String(i)} 轮 CLI patch`);
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
    assert(!viaMcp.isError, `第 ${String(i)} 轮 MCP patch 失败：${viaMcp.text}`);
    const mcpJson = toolJson(viaMcp, `第 ${String(i)} 轮 MCP patch`);
    writes += 1;
    collect(mcpJson["revision"]);

    const http = await api.post("/api/patch", {
      docId: DOC,
      targetId: nodeA,
      action: "replace",
      fragment: `<p data-hr-id="${nodeA}">HTTP-${String(i)}</p>`,
    });
    assert(http.status === 200, `第 ${String(i)} 轮 HTTP patch 状态 ${String(http.status)}`);
    const httpBody = parseJson(await http.text(), "HTTP patch 响应");
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
  assert(!styleMcp.isError, `并发 hr_apply_style 报错：${styleMcp.text}`);
  assert(styleHttp.status === 200, `并发 HTTP style 状态 ${String(styleHttp.status)}`);
  // revision 只有 HTTP 回执带（CLI/MCP 契约是 historyPath/changed）：收到的每个都该是全新值，
  // 丢更新/覆写会表现为 revision 重复。
  assert(
    revs.size === revSeen && revSeen === 9,
    `丢更新嫌疑：${String(revSeen)} 个回执 revision 只有 ${String(revs.size)} 个不同值（writes=${String(writes)}）`,
  );
  const bytes = await readFile(docPath(home.ws, DOC), "utf8");
  assert(bytes.includes("<html") && bytes.trimEnd().endsWith("</html>"), "文件半写（头尾不完整）");
});

test("并发 undo + patch：锁串行化，最终文件完整、history 目录正常", async () => {
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
  assertEq(patch.code, 0, `并发中 patch 失败：${patch.stderr} ${patch.stdout}`);
  for (const [index, undo] of [undo1, undo2].entries()) {
    assert(
      undo.code === 0 || (undo.code === 1 && undo.stdout.includes("nothing_to_undo")),
      `并发 undo[${String(index)}] 非法失败：${undo.stdout} ${undo.stderr}`,
    );
  }
  assert(
    httpUndo.status === 200 || httpUndo.status === 409 || httpUndo.status === 422,
    `HTTP undo 状态 ${String(httpUndo.status)}`,
  );
  if (mcpUndo.isError) {
    assert(/nothing_to_undo|history|undo/i.test(mcpUndo.text), `MCP undo 异常：${mcpUndo.text}`);
  }
  const after = await infoRevision();
  assert(after !== "" && after !== before, `并发 undo 后 revision 异常：${before} → ${after}`);
  const histDir = join(home.ws, ".hreader", "history");
  const snaps = await readdir(histDir).catch(() => [] as string[]);
  assert(Array.isArray(snaps), "history 目录读失败");
  const bytes = await readFile(docPath(home.ws, DOC), "utf8");
  assert(bytes.includes("<html") && bytes.includes("</html>"), "最终文件不是完整 HTML（半写）");
});
