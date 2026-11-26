// This layer: "pin the status quo" cases for known limits. Every comment spells out: **this pins a current known limit, not desired behavior**.
// Their job is to surface "the limit quietly changed", not to declare this the contract.
//
// What makes it red: the limit actually got fixed (the case should then be rewritten to assert the new behavior and the matching `L-` entry deleted) —
// the only kind of red worth celebrating.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeOf, leaveWorkspace, sessionOf, textOf, workspaceIn } from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-limits-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

describe("known limits · special files", () => {
  it("should answer a FIFO target with an error instead of blocking the server", async () => {
    // The limit: `writeFile(..., "wx")` on an **existing** FIFO throws `EEXIST` outright, so it cannot block here;
    // but "target is a non-regular file that does not exist yet" is still unhandled (an unregistered known limit).
    // What this pins is "at least it does not hang the server" — an implementation that opens-then-checks the type would time out red here.
    execFileSync("mkfifo", [join(workspace, "pipe.html")]);
    const session = await sessionOf();
    const result: unknown = await session.client.callTool({
      name: "hr_create_doc",
      arguments: { filePath: "pipe.html", title: "管道" },
    });
    await session.close();

    expect(codeOf(result)).toBe("file_exists");
    expect(textOf(result)).not.toContain("EEXIST");
  }, 10_000);
});

describe("ui:// missing docId · fake success closed", () => {
  it("should answer a missing document with a not_found JSON-RPC error", async () => {
    // It used to return a shell page (`<!doctype html>` + empty body): the host saw "document is empty" instead of "this document does not exist" —
    // same family as the `unknown_style` lie. Now it goes through `-32002` + `data.code`.
    const session = await sessionOf();
    const error: unknown = await session.client
      .readResource({ uri: "ui://hreader/view/ghost" })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    await session.close();

    expect(Reflect.get(Object(error), "code")).toBe(-32002);
    expect(Reflect.get(Object(Reflect.get(Object(error), "data")), "code")).toBe("not_found");
  }, 10_000);
});
