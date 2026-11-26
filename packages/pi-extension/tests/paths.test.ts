// daemon.json parsing, docId resolution rules, and reader URL assembly.
// docId rule: docId = the target's path relative to `daemon.workspace`, `/`-separated; relative input resolves
// against the workspace (not Pi's cwd); the workspace itself and out-of-bounds paths are not documents.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  daemonFileOf,
  docIdOf,
  parseDaemon,
  readDaemonOf,
  readerUrlOf,
  type DaemonInfo,
} from "../pi-hreader.ts";
import { fakeDepsOf } from "./fakes.ts";

const INFO: DaemonInfo = { port: 7331, token: "tok-1", pid: 4242, workspace: "/work" };
const VALID = JSON.stringify(INFO);
const depsOf = (files: Readonly<Record<string, string>> = {}) =>
  fakeDepsOf({ home: "/home/u", files }).deps;

describe("parseDaemon", () => {
  it("should parse the four fields out of a valid daemon.json", () => {
    expect(parseDaemon(VALID)).toEqual(INFO);
  });

  it("should count non-JSON or a non-object JSON as no daemon", () => {
    expect(parseDaemon("{ not json")).toBeUndefined();
    expect(parseDaemon("[1,2]")).toBeUndefined();
    expect(parseDaemon("null")).toBeUndefined();
  });

  it("should count a non-positive-integer port as no daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, port: 0 }))).toBeUndefined();
  });

  it("should count a non-positive-integer pid as no daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, pid: -1 }))).toBeUndefined();
  });

  it("should count an empty token as no daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, token: "" }))).toBeUndefined();
  });

  it("should count an empty workspace as no daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, workspace: "" }))).toBeUndefined();
  });
});

describe("daemonFileOf / readDaemonOf", () => {
  it("should place daemon.json under `<home>/.hreader/`", () => {
    expect(daemonFileOf("/home/u")).toBe("/home/u/.hreader/daemon.json");
  });

  it("should parse the record when the file reads", async () => {
    await expect(readDaemonOf(depsOf({ "/home/u/.hreader/daemon.json": VALID }))).resolves.toEqual(
      INFO,
    );
  });

  it("should count a missing file or read failure as no daemon without throwing", async () => {
    await expect(readDaemonOf(depsOf({}))).resolves.toBeUndefined();
  });
});

describe("docIdOf", () => {
  it("should resolve a relative path against the daemon workspace", () => {
    expect(docIdOf("/work", "docs/x.html")).toEqual({ ok: true, docId: "docs/x.html" });
  });

  it("should also accept an absolute path inside the workspace", () => {
    expect(docIdOf("/work", "/work/a/b.md")).toEqual({ ok: true, docId: "a/b.md" });
  });

  it("should normalize `.` and `..` in an absolute path before judging", () => {
    expect(docIdOf("/work", "/work/a/./b/../c.md")).toEqual({ ok: true, docId: "a/c.md" });
  });
});

describe("docIdOf out-of-bounds detection", () => {
  it("should not count the workspace itself as a document", () => {
    expect(docIdOf("/work", ".")).toEqual({ ok: false, reason: "outside_workspace" });
  });

  it("should not count a path escaping to a parent directory as a document", () => {
    expect(docIdOf("/work", "..")).toEqual({ ok: false, reason: "outside_workspace" });
  });

  it("should not count a sibling directory outside the workspace as a document", () => {
    expect(docIdOf("/work", "/etc/passwd")).toEqual({ ok: false, reason: "outside_workspace" });
  });

  it("should reach the same verdict when workspace ends in `/` (the likely shape of a real daemon.json)", () => {
    expect(docIdOf("/work/", "a.md")).toEqual({ ok: true, docId: "a.md" });
    expect(docIdOf("/work/", "/work/a.md")).toEqual({ ok: true, docId: "a.md" });
  });

  it("should not treat a shared prefix as a subdirectory: `/tmp/wsfoo` is not under `/tmp/ws`", () => {
    expect(docIdOf("/tmp/ws", "/tmp/wsfoo/a.md")).toEqual({
      ok: false,
      reason: "outside_workspace",
    });
    expect(docIdOf("/tmp/ws", "/tmp/wsx")).toEqual({ ok: false, reason: "outside_workspace" });
  });
});

describe("docIdOf shared-prefix hole (real directories)", () => {
  it("should not treat `<base>/ws` and `<base>/wsfoo` as parent and child", async () => {
    const base = await mkdtemp(join(tmpdir(), "hr-docid-"));
    const workspace = join(base, "ws");
    const sibling = join(base, "wsfoo");
    await mkdir(workspace);
    await mkdir(sibling);
    await writeFile(join(sibling, "a.md"), "# a\n");
    expect(docIdOf(workspace, join(sibling, "a.md"))).toEqual({
      ok: false,
      reason: "outside_workspace",
    });
    await writeFile(join(workspace, "a.md"), "# a\n");
    expect(docIdOf(workspace, join(workspace, "a.md"))).toEqual({ ok: true, docId: "a.md" });
  });
});

describe("readerUrlOf", () => {
  it("should put the daemon.json token in the URL's t (`GET /s/:docId` is token-auth)", () => {
    expect(readerUrlOf(INFO, "docs/x.html")).toBe("http://127.0.0.1:7331/s/docs%2Fx.html?t=tok-1");
  });

  it("should escape spaces in docId and reserved characters in the token", () => {
    expect(readerUrlOf({ ...INFO, token: "a b&c" }, "带 空格.md")).toBe(
      "http://127.0.0.1:7331/s/%E5%B8%A6%20%E7%A9%BA%E6%A0%BC.md?t=a%20b%26c",
    );
  });
});
