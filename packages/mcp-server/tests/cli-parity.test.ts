// 这层管：MCP 与 CLI 的**字节级**行为一致（undo-parity 已有同构用例，这里扩到 import/style）。
// 它会因为什么而红：
// - `hr_import_doc` 与 `hr import` 的转换链路分叉（两份实现、或 MCP 绕过了 importForeign）；
// - `hr_apply_style` 与 `hr style --visual` 注入的主题块分叉；
// 判据是盘上字节逐字相等——同一序列走两条面，产物必须一份不差。

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
  // CLI 臂与 MCP 臂各一个子目录，同名同内容，比字节才算得上"同一份产物"。
  await mkdir(join(dir, "cli"));
  await mkdir(join(dir, "mcp"));
  process.chdir(join(dir, "mcp"));
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

describe("MCP ↔ CLI · import 字节一致", () => {
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

describe("MCP ↔ CLI · apply_style 字节一致", () => {
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
