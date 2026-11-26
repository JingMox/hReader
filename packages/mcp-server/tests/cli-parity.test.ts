// This layer: **byte-level** behavior parity between MCP and CLI (undo-parity already has the isomorphic case; here it extends to import/style).
// What makes it red:
// - the `hr_import_doc` and `hr import` conversion chains diverge (two implementations, or MCP bypasses importForeign);
// - the theme blocks injected by `hr_apply_style` and `hr style --visual` diverge;
// the verdict is byte-for-byte equality on disk — the same sequence through two surfaces must produce identical output.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isErrorResultOf, sessionOf, type Session } from "./harness";

const CLI_MAIN = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));

const FOREIGN = [
  "<!doctype html><html><head><title>外来演示</title>",
  "<script>boot()</script></head>",
  '<body><main><section><h1>页一</h1><p onclick="x()">要点</p></section>',
  "<section><h1>页二</h1><p>收束</p></section></main></body></html>",
].join("");

const runCli = async (args: readonly string[], cwd: string): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI_MAIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? -1);
    });
  });

const mcpCall = async (
  session: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<boolean> => {
  const result = await session.client.callTool({ name, arguments: args });
  return isErrorResultOf(result);
};

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hreader-mcp-cli-parity-"));
  // One subdirectory per arm (CLI vs MCP), same name, same content — only then is byte comparison "the same artifact".
  await mkdir(join(dir, "cli"));
  await mkdir(join(dir, "mcp"));
  process.chdir(join(dir, "mcp"));
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

describe("MCP ↔ CLI · import byte parity", () => {
  it("should produce the same managed document bytes via both surfaces", async () => {
    await writeFile(join(dir, "cli", "src.html"), FOREIGN, "utf8");
    await writeFile(join(dir, "mcp", "src.html"), FOREIGN, "utf8");

    const cliCode = await runCli(["import", "src.html"], join(dir, "cli"));
    const session = await sessionOf();
    const isError = await mcpCall(session, "hr_import_doc", { filePath: "src.html" });
    await session.close();

    expect(cliCode).toBe(0);
    expect(isError).toBe(false);
    expect(await readFile(join(dir, "mcp", "src.hr.html"), "utf8")).toBe(
      await readFile(join(dir, "cli", "src.hr.html"), "utf8"),
    );
  });
});

describe("MCP ↔ CLI · apply_style byte parity", () => {
  const DOC = [
    "<!doctype html><html><body>",
    '<article data-hr-id="hr-0"><h1 data-hr-id="h1">标题</h1>',
    '<section data-hr-id="s1"><p data-hr-id="p-1">正文</p></section></article>',
    "</body></html>",
  ].join("\n");

  it("should write the same theme block via both surfaces", async () => {
    await writeFile(join(dir, "cli", "doc.html"), DOC, "utf8");
    await writeFile(join(dir, "mcp", "doc.html"), DOC, "utf8");

    const cliCode = await runCli(
      ["style", "doc.html", "--visual", "atelier-editorial"],
      join(dir, "cli"),
    );
    const session = await sessionOf();
    const isError = await mcpCall(session, "hr_apply_style", {
      filePath: "doc.html",
      visualId: "atelier-editorial",
    });
    await session.close();

    expect(cliCode).toBe(0);
    expect(isError).toBe(false);
    expect(await readFile(join(dir, "mcp", "doc.html"), "utf8")).toBe(
      await readFile(join(dir, "cli", "doc.html"), "utf8"),
    );
  });
});
