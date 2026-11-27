// Journey (templates): hr template list/show over the real CLI → hr template save turns a real
// page into a workspace template → hr template new drafts from it → the same flow through the
// real stdio MCP server (list → get → create_from → save → list shows the new template) →
// cross-surface: the MCP-saved template is usable by the CLI and vice versa.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq, assertIncludes } from "../harness/check.ts";
import { dataOf, docPath, errorOf, hr, type JsonObject } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { startMcp, toolJson, type McpClient } from "../harness/mcp.ts";
import { killAllTracked } from "../harness/proc.ts";

const BUILTIN_IDS = ["blank-html", "brief", "minutes", "note", "report", "slides"];

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>样例页面</title>
<style id="hr-theme">body { color: #333 }</style></head>
<body><article data-hr-id="a1"><h1 data-hr-id="h1">样例页面</h1>
<section data-hr-id="s1"><h2>要点</h2><p>正文</p>
<img src="page_files/chart.png" alt=""></section></article></body></html>
`;

describe("templates journey", () => {
  let home: TestHome;
  let mcp: McpClient;

  beforeAll(async () => {
    home = sandbox("templates");
    await mkdir(docPath(home.ws, "page_files"), { recursive: true });
    await writeFile(docPath(home.ws, "page.html"), PAGE, "utf8");
    await writeFile(docPath(home.ws, "page_files/chart.png"), "PNG", "utf8");
    mcp = await startMcp(home.ws);
  });

  afterAll(async () => {
    await mcp.close();
    await killAllTracked();
    home.cleanup();
  });

  test("hr template list shows the six builtins, show gives one manifest + guide", async () => {
    const list = dataOf(
      await hr(["template", "list", "--workspace", home.ws, "--json"], {
        cwd: home.ws,
        env: { HREADER_HOME: home.home },
      }),
      "hr template list",
    );
    const templates = list["templates"];
    assert(Array.isArray(templates), "templates is not an array");
    const ids = (templates as JsonObject[]).map((tpl) => String(tpl["id"])).sort();
    assertEq(ids.join(","), [...BUILTIN_IDS].sort().join(","), "builtin template ids");
    assertEq(JSON.stringify(list["diagnostics"]), "[]", "diagnostics must be empty");

    const show = dataOf(
      await hr(["template", "show", "note", "--workspace", home.ws, "--json"], {
        cwd: home.ws,
        env: { HREADER_HOME: home.home },
      }),
      "hr template show",
    );
    assertEq((show["manifest"] as JsonObject)["id"], "note", "manifest id");
    assert(String(show["entry"]).includes("<title>"), "entry text missing");
    assert(String(show["guide"]).length > 0, "guide text missing");
  });

  test("hr template save → list → new round-trip through the real CLI", async () => {
    const saved = dataOf(
      await hr(
        ["template", "save", "page.html", "--id", "cli-tpl", "--workspace", home.ws, "--json"],
        { cwd: home.ws, env: { HREADER_HOME: home.home } },
      ),
      "hr template save",
    );
    assertEq(saved["id"], "cli-tpl", "saved id");
    assertEq(saved["scope"], "workspace", "saved scope");
    assert(
      existsSync(docPath(home.ws, ".hreader/templates/cli-tpl/index.html")),
      "template index.html missing",
    );

    const created = dataOf(
      await hr(
        [
          "template",
          "new",
          "from-tpl.html",
          "--template",
          "cli-tpl",
          "--workspace",
          home.ws,
          "--json",
        ],
        { cwd: home.ws, env: { HREADER_HOME: home.home } },
      ),
      "hr template new",
    );
    assertEq(created["template"], "cli-tpl", "created template");
    const html = await readFile(docPath(home.ws, "from-tpl.html"), "utf8");
    assertIncludes(html, "body { color: #333 }", "re-inlined theme css");
    assertIncludes(html, 'src="from-tpl_files/chart.png"', "rewritten asset ref");
    assertEq(
      await readFile(docPath(home.ws, "from-tpl_files/chart.png"), "utf8"),
      "PNG",
      "copied asset bytes",
    );

    // Re-saving the same id is a business refusal, not a crash.
    const again = await hr(
      ["template", "save", "page.html", "--id", "cli-tpl", "--workspace", home.ws, "--json"],
      { cwd: home.ws, env: { HREADER_HOME: home.home } },
    );
    assertEq(again.code, 1, "re-save exit code");
    assertEq(errorOf(again, "hr template save again").code, "file_exists", "re-save code");
  });

  test("hr new --template is the same intent as hr template new", async () => {
    const alias = await hr(
      ["new", "alias.html", "--template", "note", "--title", "T", "--workspace", home.ws],
      { cwd: home.ws, env: { HREADER_HOME: home.home } },
    );
    assertEq(alias.code, 0, "hr new --template exit code");

    const conflict = await hr(
      ["new", "c.html", "--template", "note", "--kind", "report", "--workspace", home.ws],
      { cwd: home.ws, env: { HREADER_HOME: home.home } },
    );
    assertEq(conflict.code, 2, "--template + --kind exit code");
    assert(!existsSync(docPath(home.ws, "c.html")), "conflict created a file anyway");
  });

  test("MCP list → get → create_from → save → list shows the new template", async () => {
    const list = toolJson(await mcp.call("hr_list_templates", {}), "hr_list_templates");
    const templates = list["templates"];
    assert(Array.isArray(templates), "templates is not an array");
    const ids = new Set((templates as JsonObject[]).map((tpl) => String(tpl["id"])));
    for (const id of BUILTIN_IDS) assert(ids.has(id), `builtin ${id} missing from MCP list`);

    const got = toolJson(await mcp.call("hr_get_template", { id: "note" }), "hr_get_template");
    assertEq((got["manifest"] as JsonObject)["id"], "note", "MCP manifest id");
    assert(String(got["entry"]).includes("<title>"), "MCP entry missing");

    const created = toolJson(
      await mcp.call("hr_create_from_template", { target: "mcp-doc.html" }),
      "hr_create_from_template",
    );
    assertEq(created["path"], "mcp-doc.html", "MCP create path");
    assert(existsSync(docPath(home.ws, "mcp-doc.html")), "MCP doc missing on disk");

    const saved = toolJson(
      await mcp.call("hr_save_template", { file: "page.html", id: "mcp-tpl" }),
      "hr_save_template",
    );
    assertEq(saved["scope"], "workspace", "MCP save scope");
    assertEq(saved["dir"], ".hreader/templates/mcp-tpl", "MCP save dir label");

    const list2 = toolJson(await mcp.call("hr_list_templates", {}), "hr_list_templates 2");
    const found = (list2["templates"] as JsonObject[]).find((tpl) => tpl["id"] === "mcp-tpl");
    assertEq(found?.["source"], "workspace", "MCP-saved source");

    const fromSaved = toolJson(
      await mcp.call("hr_create_from_template", { id: "mcp-tpl", target: "mcp-reuse.html" }),
      "hr_create_from_template mcp-tpl",
    );
    assertEq(fromSaved["path"], "mcp-reuse.html", "reuse path");
    const html = await readFile(docPath(home.ws, "mcp-reuse.html"), "utf8");
    assertIncludes(html, "body { color: #333 }", "MCP reuse theme");
    assertIncludes(html, 'src="mcp-reuse_files/chart.png"', "MCP reuse asset ref");
  });

  test("cross-surface: the CLI-saved template is usable by MCP and back", async () => {
    // cli-tpl was saved by the CLI earlier in this journey; the MCP server must already see it.
    const got = toolJson(
      await mcp.call("hr_get_template", { id: "cli-tpl" }),
      "hr_get_template cli-tpl",
    );
    assertEq(got["source"], "workspace", "cli-tpl source via MCP");

    const created = toolJson(
      await mcp.call("hr_create_from_template", { id: "cli-tpl", target: "cross.html" }),
      "hr_create_from_template cli-tpl",
    );
    assertEq(created["path"], "cross.html", "cross-surface create path");

    // Security: path escape attempts are refused over the wire.
    const escape = await mcp.call("hr_save_template", { file: "../outside.html", id: "esc" });
    assert(escape.isError, "outside file was not refused");
    assertIncludes(escape.text, "path_outside_workspace", "escape error code");
    const badId = await mcp.call("hr_save_template", { file: "page.html", id: "../x" });
    assert(badId.isError, "bad id was not refused");
  });
});
