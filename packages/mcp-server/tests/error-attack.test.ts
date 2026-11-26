// This layer: the **reverse attack** on error attribution. Earlier groups asked "is the code right"; here we ask "can it be tricked into calling one failure class another",
// and "which cell still hides the `internal` trash bin".
//
// What makes it red:
// - the same failure says `unknown_style` through the tool exit but `not_found` through the resource exit (hosts routing on codes diverge);
// - a non-`ENOENT` fs failure (`EACCES`/`ENOTDIR`) still lands in `internal` — telling the host "we did not expect this";
// - a **legal** argument gets misreported: the old `..foo` bug. A 406-char relative path is fully legal under `PATH_MAX=1024`,
//   so its only possible failure cause is "file does not exist" (`not_found`), never "invalid argument" (`invalid_input`).

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  isRecord,
  leaveWorkspace,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-attack-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

/** 200 levels deep, 406 characters: legal (`PATH_MAX=1024`), so "does not exist" is its true cause. */
const DEEP_BUT_LEGAL = `${"a/".repeat(200)}x.html`;
/** 5006 characters: over Linux `PATH_MAX=4096` and macOS `PATH_MAX=1024`. */
const TOO_LONG = `${"a/".repeat(2500)}x.html`;

const errorOf = (error: unknown): { code: unknown; data: unknown; message: unknown } => ({
  code: Reflect.get(Object(error), "code"),
  data: Reflect.get(Object(error), "data"),
  message: Reflect.get(Object(error), "message"),
});

const toolCodeOf = async (tool: string, args: Record<string, unknown>): Promise<string> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name: tool, arguments: args });
  await session.close();
  expect(isErrorResultOf(result)).toBe(true);
  return codeOf(result);
};

interface Parity {
  readonly name: string;
  readonly uri: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly code: string;
}

const PARITIES: readonly Parity[] = [
  {
    name: "unknown style: tool exit and resource exit",
    uri: "hreader://styles/no-such-style",
    tool: "hr_apply_style",
    args: { filePath: "doc.html", visualId: "no-such-style" },
    code: "unknown_style",
  },
  {
    name: "unknown uri prefix: resource exit only",
    uri: "hreader://nothing/here",
    tool: "hr_outline",
    args: { filePath: "doc.html" },
    code: "not_found",
  },
];

describe("error attribution · same code through both exits", () => {
  it.each(PARITIES)(
    "$name → the resource exit's data.code matches the tool exit's",
    async (row) => {
      await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
      const session = await sessionOf();
      const rejected = await session.client.readResource({ uri: row.uri }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await session.close();

      const failure = errorOf(rejected);
      const data = isRecord(failure.data) ? failure.data : {};
      expect(data["code"]).toBe(row.code);
      // The tool exit's code must be the same one (the `not_found` line just borrows `hr_outline`'s success path; tool codes are not compared there).
      if (row.code !== "not_found" || row.uri.startsWith("hreader://styles/")) {
        expect(await toolCodeOf(row.tool, row.args)).toBe(row.code);
      }
    },
    30_000,
  );
});

describe("error attribution · internal is not a trash bin", () => {
  it("should map EACCES on read to io_failure, not internal", async () => {
    const file = join(workspace, "locked.html");
    await writeFile(file, ANNOTATED_DOC, "utf8");
    await chmod(file, 0o000);
    try {
      const code = await toolCodeOf("hr_outline", { filePath: "locked.html" });
      expect(code).toBe("io_failure");
    } finally {
      await chmod(file, 0o644);
    }
  }, 30_000);

  it("should map ENOTDIR on create to io_failure, not internal", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const code = await toolCodeOf("hr_create_doc", { filePath: "doc.html/x.html", title: "x" });
    expect(code).toBe("io_failure");
  }, 30_000);

  it("should map a read-only parent directory to io_failure, not internal", async () => {
    await mkdir(join(workspace, "ro"));
    await chmod(join(workspace, "ro"), 0o500);
    try {
      const code = await toolCodeOf("hr_create_doc", { filePath: "ro/x.html", title: "x" });
      expect(code).toBe("io_failure");
    } finally {
      await chmod(join(workspace, "ro"), 0o755);
    }
  }, 30_000);
});

describe("error attribution · legal arguments must not be misreported", () => {
  it("should call a deep-but-legal path not_found, never invalid_input", async () => {
    const session = await sessionOf();
    const result: unknown = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: DEEP_BUT_LEGAL },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    // Misreporting "invalid argument" teaches the model to fix an argument that was already right (same class as the `..foo` bug).
    expect(codeOf(result)).toBe("not_found");
    expect(textOf(result)).toContain("x.html");
  }, 30_000);

  it("should call a genuinely over-long path invalid_input", async () => {
    const code = await toolCodeOf("hr_outline", { filePath: TOO_LONG });
    expect(code).toBe("invalid_input");
  }, 30_000);
});

describe("error attribution · a missing UI resource must not fake success", () => {
  it("should answer ui://view/{missing} with a coded error instead of a shell page", async () => {
    const session = await sessionOf();
    const rejected = await session.client.readResource({ uri: "ui://hreader/view/ghost" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await session.close();

    const failure = errorOf(rejected);
    const data = isRecord(failure.data) ? failure.data : {};
    expect(rejected).not.toBeUndefined();
    expect(failure.code).toBe(-32002);
    expect(data["code"]).toBe("not_found");
  }, 30_000);
});

describe("error attribution · no host layout in the body", () => {
  it("should keep the workspace path and errno out of the tool text", async () => {
    const session = await sessionOf();
    const result: unknown = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: "nope.html" },
    });
    const locked = join(workspace, "locked2.html");
    await writeFile(locked, ANNOTATED_DOC, "utf8");
    await chmod(locked, 0o000);
    const second: unknown = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: "locked2.html" },
    });
    await chmod(locked, 0o644);
    await session.close();

    for (const one of [result, second]) {
      const text = textOf(one);
      expect(isErrorResultOf(one)).toBe(true);
      expect(text).not.toContain(workspace);
      expect(text).not.toContain("ENOENT");
      expect(text).not.toContain("EACCES");
    }
    expect(await readFile(locked, "utf8")).toBe(ANNOTATED_DOC);
  }, 30_000);
});
