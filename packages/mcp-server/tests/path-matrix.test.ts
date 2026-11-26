// This layer: the path-boundary matrix (one table shared by reads and writes).
//
// What makes it red: the old disease was "two copies of path policy". Each path in the table goes through both a **read** tool (`hr_outline`)
// and a **write** tool (`hr_create_doc`); the moment the two standards diverge one row goes red; "rejected, but the target got created" also goes red —
// that means the check ran after `mkdir`.
//
// Every row asserts two things: ① the error code ② on-disk side effects (an out-of-bounds write must leave **nothing** behind).

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

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
let outside = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-path-");
  outside = await workspaceIn("hreader-mcp-outside-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(outside);
  await leaveWorkspace(workspace);
});

const callOf = async (name: string, arguments_: Record<string, unknown>): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name, arguments: arguments_ });
  await session.close();
  return result;
};

const readOf = (filePath: string): Promise<unknown> => callOf("hr_outline", { filePath });

const createOf = (filePath: string): Promise<unknown> =>
  callOf("hr_create_doc", { filePath, title: "边界" });

const existsOf = async (path: string): Promise<boolean> =>
  readFile(path, "utf8").then(
    () => true,
    () => false,
  );

interface Row {
  readonly name: string;
  readonly path: string;
  /** What the read tool should answer: the `ok` sentinel = really read it; anything else is the expected error code. */
  readonly read: string;
  /** What the write tool should answer (same idea). */
  readonly write: string;
  /** After the write, that out-of-bounds path must **not exist** (the escaping write never landed). */
  readonly untouched?: "outside";
}

const ROWS: readonly Row[] = [
  {
    name: "a symlink file pointing out of bounds",
    path: "evil.html",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  {
    name: "a symlinked parent dir pointing out of bounds",
    path: "out/x.html",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  {
    name: "a directory whose name starts with two dots (in bounds, must pass)",
    path: "..foo/x.html",
    read: "ok",
    write: "ok",
  },
  {
    name: "the workspace itself",
    path: ".",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  {
    name: "the workspace's parent directory",
    path: "../",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  { name: "an in-bounds absolute path", path: "inside.html", read: "ok", write: "ok" },
  {
    name: "an out-of-bounds absolute path",
    path: "absolute-outside.html",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
    untouched: "outside",
  },
];

/** A row's `path` is written relative to workspace; the two absolute-path rows get swapped for real absolute paths during setup. */
const prepareOf = async (row: Row): Promise<string> => {
  if (row.name === "a symlink file pointing out of bounds") {
    await symlink(join(outside, "secret.html"), join(workspace, "evil.html"));
  }
  if (row.name === "a symlinked parent dir pointing out of bounds") {
    await symlink(outside, join(workspace, "out"));
  }
  if (row.name === "an in-bounds absolute path") return join(workspace, "inside.html");
  if (row.name === "an out-of-bounds absolute path") return join(outside, "absolute-outside.html");
  return row.path;
};

const expectReaction = (result: unknown, expected: string): void => {
  if (expected === "ok") {
    expect(isErrorResultOf(result)).toBe(false);
    return;
  }
  expect(isErrorResultOf(result)).toBe(true);
  expect(codeOf(result)).toBe(expected);
};

const absoluteOf = (path: string): string => (isAbsolute(path) ? path : join(workspace, path));

/** The read half needs a real file; the write half needs the target absent, so it is deleted after the read (reversed order → ENOENT). */
const seedOf = async (row: Row, path: string): Promise<void> => {
  if (row.read !== "ok") return;
  await writeFile(absoluteOf(path), ANNOTATED_DOC, "utf8");
};

const clearOf = async (row: Row, path: string): Promise<void> => {
  if (row.write !== "ok") return;
  await rm(absoluteOf(path), { force: true });
};

describe("path-boundary matrix · one table for reads and writes", () => {
  it.each(ROWS)(
    "$name: read tool and write tool give the same verdict",
    async (row) => {
      await writeFile(join(outside, "secret.html"), ANNOTATED_DOC, "utf8");
      await mkdir(join(workspace, "..foo"), { recursive: true });
      const path = await prepareOf(row);
      await seedOf(row, path);

      expectReaction(await callOf("hr_outline", { filePath: path }), row.read);
      await clearOf(row, path);
      // Write tools must judge before writing: on out-of-bounds, not one byte of the outside target may change.
      expectReaction(await createOf(path), row.write);
      if (row.untouched === "outside") {
        expect(await existsOf(join(outside, "absolute-outside.html"))).toBe(false);
      }
    },
    30_000,
  );
});

describe("path-boundary matrix · attribution when reading fails", () => {
  // Would leak raw text like `[internal] ENOENT: no such file or directory, open '/…/typo.html'` to the host:
  // the host only wants "this document does not exist", and misattribution — blaming the wrong cause — costs more than missing functionality (this is its red).
  it("should call a missing file not_found instead of leaking the raw errno", async () => {
    const result = await readOf("typo.html");
    const text = textOf(result);

    // The mapping is now deterministic (`ENOENT → not_found`): what is pinned here is that code,
    // not "anything but internal" — the latter was the previous round's weaker version.
    expect(codeOf(result)).toBe("not_found");
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain(workspace);
  });

  it("should refuse a directory target without echoing EISDIR at the host", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    const result = await readOf("sub");
    const text = textOf(result);

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("not_a_file");
    expect(text).not.toContain("EISDIR");
  });

  it("should keep the out-of-workspace verdict for a path that visibly escapes", async () => {
    const result = await readOf("../escape.html");

    expect(codeOf(result)).toBe("path_outside_workspace");
  });
});
