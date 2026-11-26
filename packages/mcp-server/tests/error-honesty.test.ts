// This layer: error-code honesty (guards against "misattribution": blaming the wrong cause costs more than missing functionality).
//
// What makes it red:
// - some failure class lands in `[internal]` (telling the host "we blew up" when it is really the argument/target's problem);
// - one failure class produces two codes (hosts routing on codes diverge);
// - raw node errnos appear in the text (`ENOENT:` / `EISDIR:` / `ENAMETOOLONG:`) — implementation details the host
//   can neither retry on nor fix arguments with, only paste into a log.
//
// Note: even absolute paths are banned from the text — `errors.ts`'s `humanMessageOf` folds the workspace root into a relative one,
// so the rule applies to **all** codes; on out-of-bounds the user sees the relative path they passed in.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-errors-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

const RAW_ERRNO = ["ENOENT", "EISDIR", "ENAMETOOLONG", "ENOTDIR", "EACCES", "EPERM"];

interface Case {
  readonly name: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /**
   * The allowed `HrError.code` set: which specific one is an implementation choice (core's vocabulary has precedent for both `not_a_file` and `not_found`);
   * this case only pins two things that must not blur — **`internal` may not be a trash bin**, and **one failure class gets exactly one code** (the set only holds same-semantics neighbors).
   */
  readonly codes: readonly string[];
  readonly prepare?: () => Promise<void>;
}

const CASES: readonly Case[] = [
  {
    name: "read a missing document",
    tool: "hr_outline",
    args: { filePath: "nope.html" },
    codes: ["not_found"],
  },
  {
    name: "patch a missing node",
    tool: "hr_patch_node",
    args: {
      filePath: "doc.html",
      nodeId: "hr-deadbeef",
      action: "replace",
      htmlContent: "<p>x</p>",
    },
    codes: ["node_not_found"],
  },
  {
    name: "patch a missing document",
    tool: "hr_patch_node",
    args: { filePath: "ghost.html", nodeId: "root", action: "replace", htmlContent: "<p>x</p>" },
    codes: ["not_found"],
  },
  {
    name: "create an existing document",
    tool: "hr_create_doc",
    args: { filePath: "doc.html", title: "撞名" },
    codes: ["file_exists"],
  },
  {
    name: "ask for a missing style",
    tool: "hr_apply_style",
    args: { filePath: "doc.html", visualId: "no-such-style" },
    codes: ["unknown_style"],
  },
  {
    name: "give neither (visualId and toneId both empty)",
    tool: "hr_apply_style",
    args: { filePath: "doc.html" },
    codes: ["invalid_input"],
  },
  {
    name: "an overlong path",
    tool: "hr_create_doc",
    args: { filePath: `${"a/".repeat(2500)}x.html`, title: "太长" },
    codes: ["invalid_input"],
  },
  {
    name: "read a directory as a document",
    tool: "hr_outline",
    args: { filePath: "sub" },
    codes: ["not_a_file"],
    prepare: async () => {
      await mkdir(join(workspace, "sub"), { recursive: true });
    },
  },
];

const runCase = async (row: Case): Promise<{ code: string; text: string }> => {
  await row.prepare?.();
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({
    name: row.tool,
    arguments: row.args,
  });
  await session.close();
  expect(isErrorResultOf(result)).toBe(true);
  return { code: codeOf(result), text: textOf(result) };
};

describe("error-code honesty · one code, one cause per failure class", () => {
  it.each(CASES)(
    "$name → honest code, not internal",
    async (row) => {
      await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
      const { code, text } = await runCase(row);

      expect(row.codes).toContain(code);
      // Only one code may appear in the body, and it must be that one (`[code] message`).
      expect(text.startsWith(`[${code}] `)).toBe(true);
      expect(text.match(/^\[[a-z_]+\]/gu)).toHaveLength(1);
      for (const errno of RAW_ERRNO) expect(text).not.toContain(errno);
      // Absolute paths are banned from the body too: the user sees the relative path they passed in.
      expect(text).not.toContain(workspace);
    },
    30_000,
  );
});

describe("error-code honesty · two exits of one source must not disagree", () => {
  it("should report an unknown style with one code through the resource and through the tool", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const session = await sessionOf();
    const tool = await session.client.callTool({
      name: "hr_apply_style",
      arguments: { filePath: "doc.html", visualId: "no-such-style" },
    });
    const resource = await session.client
      .readResource({ uri: "hreader://styles/no-such-style" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await session.close();

    expect(codeOf(tool)).toBe("unknown_style");
    // The resource arm goes through a JSON-RPC error (no tool-result shell): both `McpError`'s `message` and `code` must be readable.
    const rpcCode: unknown = Reflect.get(Object(resource), "code");
    const rpcMessage: unknown = Reflect.get(Object(resource), "message");
    // Measured: `rpcCode` is always -32603, and only `message` carries the real cause — "right code, wrong text" and "right text, wrong code"
    // are the same thing to the host: it cannot route on the code. This assertion is the probe for "the resource exit also carries the true code".
    expect(rpcMessage).toContain("no-such-style");
    // `-32603 Internal error` is the SDK's fallback code: a business failure landing here is "misattribution".
    expect(rpcCode).not.toBe(-32603);
  }, 30_000);
});
