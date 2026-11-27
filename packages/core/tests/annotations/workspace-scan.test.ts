// This layer: `ops/annotation-scan.ts` — the bounded workspace scan behind `hr_list_annotations`
// (no file argument). All cases run on the in-memory fs so the caps are cheap to hit: discovery
// prunes `.hreader`/`.git`/`node_modules` and never follows symlinks; store records map back to
// docs through their own `path` field and degrade into per-record diagnostics, never a crash.

import { describe, expect, it } from "vitest";

import type { SidecarAnnotation } from "../../src/annotations/sidecar-model";
import { listWorkspaceAnnotations } from "../../src/ops/annotation-scan";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  sha1Of,
  systemError,
} from "../io/harness";

const CLOCK = fixedClock(Date.parse("2026-11-27T00:00:00.000Z")).clock;
const SLEEP = recordingSleep().sleep;

const WS = "/ws";

const deps = (fs: ReturnType<typeof fakeFs>["port"]) => depsOf(fs, CLOCK, SLEEP);

const record = (patch: Partial<SidecarAnnotation> = {}): SidecarAnnotation => ({
  id: "an-00000000",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "x", prefix: "", suffix: "", start: 0 },
  note: "n",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  author: "user",
  replies: [],
  ...patch,
});

const storeJson = (file: string, annotations: readonly unknown[]): string =>
  JSON.stringify({ version: 1, path: file, annotations });

const storeNameOf = (file: string): string => `${sha1Of(file)}.json`;

/** Every seeded dir level is explicit: fakeFs only mints the immediate parent of each file. */
const dirsOf = (fs: ReturnType<typeof fakeFs>, dirs: readonly string[]): void => {
  for (const dir of dirs) fs.state.dirs.add(dir);
};

const scan = (
  fs: ReturnType<typeof fakeFs>,
  input: { readonly status?: "pending" | "resolved" | "all" } = {},
) => listWorkspaceAnnotations({ workspace: WS, ...input }, deps(fs.port));

describe("listWorkspaceAnnotations · merged view across the workspace", () => {
  it("should list meta and sidecar annotations of the docs it walks, tagged with their file", async () => {
    const managed =
      '<html><body><article data-hr-id="a"><script id="hr-meta" type="application/json">' +
      '{"version":"1.0","annotations":[{"id":"an-meta","nodeId":"a","anchor":{"exact":"x"},"note":"meta note","status":"pending","createdAt":"t"}]}' +
      '</script><p data-hr-id="p">x</p></article></body></html>';
    const fs = fakeFs({
      [`${WS}/managed.html`]: managed,
      [`${WS}/foreign.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("foreign.html")}`]: storeJson("foreign.html", [
        record({ id: "an-side", note: "side note" }),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.truncated).toBe(false);
    expect(result.docsScanned).toBe(2);
    const byId = new Map(result.annotations.map((entry) => [entry.annotation.id, entry]));
    expect(byId.get("an-meta")).toMatchObject({ file: "managed.html", source: "meta" });
    expect(byId.get("an-side")).toMatchObject({ file: "foreign.html", source: "sidecar" });
    expect(byId.get("an-side")?.anchor).toMatchObject({ ok: true });
  });

  it("should report an empty result for an empty workspace, with the missing store unread as a diagnostic", async () => {
    const fs = fakeFs({ [`${WS}/readme.txt`]: "not a doc" });
    dirsOf(fs, [WS]);

    const result = await scan(fs);

    expect(result).toEqual({
      annotations: [],
      diagnostics: [],
      docsScanned: 0,
      truncated: false,
    });
  });

  it("should recurse into subdirectories and pick up .htm and upper-case .HTML too", async () => {
    const fs = fakeFs({
      [`${WS}/sub/a.htm`]: "<html><body><p>x</p></body></html>",
      [`${WS}/UP.HTML`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("sub/a.htm")}`]: storeJson("sub/a.htm", [
        record({ id: "an-sub" }),
      ]),
      [`${WS}/.hreader/annotations/${storeNameOf("UP.HTML")}`]: storeJson("UP.HTML", [
        record({ id: "an-up" }),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/sub`, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.annotations.map((entry) => entry.file).sort()).toEqual(["UP.HTML", "sub/a.htm"]);
  });

  it("should skip .hreader, .git and node_modules trees and never follow a directory symlink", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.git/hidden.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/node_modules/dep.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/state.html`]: "<html><body><p>x</p></body></html>",
    });
    dirsOf(fs, [WS, `${WS}/.git`, `${WS}/node_modules`, `${WS}/.hreader`]);
    fs.state.links.set(`${WS}/escape`, "/outside");

    const result = await scan(fs);

    // Only the workspace doc counts: internal segments are pruned and the escape link is never resolved.
    expect(result.docsScanned).toBe(1);
    expect(result.annotations).toEqual([]);
  });

  it("should filter by status: pending and resolved both honor the argument, all is the default", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("doc.html")}`]: storeJson("doc.html", [
        record({ id: "an-p", status: "pending" }),
        record({
          id: "an-r",
          status: "resolved",
          anchor: { exact: "x", prefix: "", suffix: "", start: 0 },
        }),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const pending = await scan(fs, { status: "pending" });
    expect(pending.annotations.map((entry) => entry.annotation.id)).toEqual(["an-p"]);

    const resolved = await scan(fs, { status: "resolved" });
    expect(resolved.annotations.map((entry) => entry.annotation.id)).toEqual(["an-r"]);

    const all = await scan(fs);
    expect(all.annotations).toHaveLength(2);
  });
});

describe("listWorkspaceAnnotations · store-record discovery", () => {
  it("should surface annotations for a non-HTML doc through its record, even though the walk never sees it", async () => {
    const fs = fakeFs({
      [`${WS}/note.txt`]: "plain text body",
      [`${WS}/.hreader/annotations/${storeNameOf("note.txt")}`]: storeJson("note.txt", [
        record({ anchor: { exact: "text", prefix: "", suffix: "", start: 6 } }),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]).toMatchObject({ file: "note.txt", source: "sidecar" });
  });

  it("should not double-list a record whose doc the walk already covered", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("doc.html")}`]: storeJson("doc.html", [
        record({ id: "an-1" }),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.annotations).toHaveLength(1);
    expect(result.docsScanned).toBe(1);
  });

  it("should diagnose a record whose doc is gone and one whose path escapes the workspace", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("gone.html")}`]: storeJson("gone.html", [
        record(),
      ]),
      [`${WS}/.hreader/annotations/deadbeef.json`]: storeJson("../outside.html", [record()]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.annotations).toEqual([]);
    expect(result.diagnostics.some((line) => line.includes("gone.html"))).toBe(true);
    expect(result.diagnostics.some((line) => line.includes("deadbeef.json"))).toBe(true);
  });

  it("should diagnose a record missing a usable path field, including unparseable JSON", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${sha1Of("a")}.json`]: '{"version":1,"annotations":[]}',
      [`${WS}/.hreader/annotations/${sha1Of("b")}.json`]: "{{{ not json",
      [`${WS}/.hreader/annotations/${sha1Of("c")}.json`]: '{"path":42}',
      [`${WS}/.hreader/annotations/${sha1Of("d")}.json`]: '{"path":""}',
      [`${WS}/.hreader/annotations/${sha1Of("e")}.json`]: "null",
      [`${WS}/.hreader/annotations/${sha1Of("f")}.json`]: "42",
      [`${WS}/.hreader/annotations/readme.txt`]: "not a record",
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(
      result.diagnostics.filter((line) => line.includes("缺少可用的 path")).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("should diagnose a record whose filename does not match sha1(path), without reading it as that doc's store", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/misnamed.json`]: storeJson("doc.html", [
        record({ id: "ghost" }),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    // `doc.html`'s real store is `sha1(doc.html).json`, not `misnamed.json`: the entry is unreachable litter.
    expect(result.annotations.map((entry) => entry.annotation.id)).not.toContain("ghost");
    expect(result.diagnostics.some((line) => line.includes("与文件名不符"))).toBe(true);
  });

  it("should diagnose a record file that cannot be read and a store directory that cannot be listed", async () => {
    // `note.txt` is not HTML: only the record pass ever reads its store file, so the failure lands exactly there.
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/note.txt`]: "tail doc",
      [`${WS}/.hreader/annotations/${storeNameOf("note.txt")}`]: storeJson("note.txt", [record()]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);
    fs.fail("readFile", systemError("EACCES"), (path) => path.endsWith(storeNameOf("note.txt")));

    const blocked = await scan(fs);
    expect(blocked.diagnostics.some((line) => line.includes("不可读"))).toBe(true);

    const fs2 = fakeFs({ [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>" });
    dirsOf(fs2, [WS, `${WS}/.hreader`, `${WS}/.hreader/annotations`]);
    fs2.fail("readdir", systemError("EACCES"), (dir) => dir.includes("annotations"));

    const sealed = await scan(fs2);
    expect(sealed.diagnostics.some((line) => line.includes("侧车目录不可读"))).toBe(true);
  });

  it("should diagnose an unreadable workspace root itself as '.'", async () => {
    const fs = fakeFs({ [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>" });
    dirsOf(fs, [WS]);
    fs.fail("readdir", systemError("EACCES"), (dir) => dir === WS);

    const result = await scan(fs);

    expect(result.diagnostics.some((line) => line.includes("目录不可读：.（"))).toBe(true);
  });

  it("should still not crash on a code-less fs failure, reporting a generic internal code", async () => {
    const fs = fakeFs({ [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>" });
    dirsOf(fs, [WS, `${WS}/.hreader`, `${WS}/.hreader/annotations`]);
    fs.fail("readdir", "plain failure", (dir) => dir.includes("annotations"));

    const result = await scan(fs);

    // No code on the error at all → the generic marker, never the raw thrown text.
    expect(result.diagnostics.some((line) => line.includes("（internal）"))).toBe(true);
    expect(result.diagnostics.join("\n")).not.toContain("plain failure");
  });

  it("should emit error codes only — never message text that can embed resolved absolute paths", async () => {
    const fs = fakeFs({
      [`${WS}/bad.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("gone.html")}`]: storeJson("gone.html", [
        record(),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);
    fs.fail("readFile", systemError("EACCES"), (path) => path.endsWith("bad.html"));

    const result = await scan(fs);

    // A `file 逃出了 workspace：…` style message would carry the resolved absolute, which no
    // elision can fold back: the diagnostic carries the code and the claimed name, that's all.
    expect(
      result.diagnostics.some((line) => line.includes("指向不可达文档 gone.html（not_a_file）")),
    ).toBe(true);
    expect(result.diagnostics.some((line) => line.startsWith("文档 bad.html：io_failure"))).toBe(
      true,
    );
    for (const line of result.diagnostics) {
      expect(line).not.toContain(`${WS}/`);
      expect(line).not.toContain("：/ws/");
    }
  });

  it("should survive the whole hostile store without a single absolute path leaking", async () => {
    const fat = "x".repeat(6 * 1024 * 1024);
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/corrupt.json`]: "{{{",
      [`${WS}/.hreader/annotations/escape01.json`]: storeJson("../../etc/passwd", [record()]),
      [`${WS}/.hreader/annotations/abs01.json`]: storeJson("/etc/passwd", [record()]),
      [`${WS}/.hreader/annotations/link01.json`]: storeJson("escape/hosts", [record()]),
      [`${WS}/.hreader/annotations/${storeNameOf("gone.html")}`]: storeJson("gone.html", [
        record(),
      ]),
      [`${WS}/.hreader/annotations/misnamed.json`]: storeJson("doc.html", [
        record({ id: "ghost" }),
      ]),
      [`${WS}/.hreader/annotations/fat.json`]: `{"version":1,"path":"gone2.html","annotations":[],"pad":"${fat}"}`,
      [`${WS}/.hreader/annotations/${storeNameOf("doc.html")}`]: storeJson("doc.html", [record()]),
      "/outside/hosts": "root:x:0:0",
    });
    dirsOf(fs, [WS, `${WS}/.hreader`, "/outside"]);
    fs.state.links.set(`${WS}/escape`, "/outside");

    const result = await scan(fs);

    expect(result.annotations).toHaveLength(1);
    const joined = result.diagnostics.join("\n");
    expect(joined).toContain(
      "批注侧车记录 escape01.json 指向不可达文档 ../../etc/passwd（path_outside_workspace）",
    );
    // An absolute claim is host data: the name is replaced, the code still says why.
    expect(joined).toContain("指向不可达文档 <绝对路径>（path_outside_workspace）");
    expect(joined).toContain("指向不可达文档 escape/hosts（path_outside_workspace）");
    expect(joined).toContain("指向不可达文档 gone.html（not_a_file）");
    expect(joined).toContain("指向不可达文档 gone2.html（not_a_file）");
    expect(joined).toContain("缺少可用的 path 字段");
    expect(joined).toContain("与文件名不符");
    for (const banned of ["/Users", "/private", "/tmp", "/var", "/outside", WS]) {
      expect(joined).not.toContain(banned);
    }
  });

  it("should not fold anything when the workspace root itself is /", async () => {
    const fs = fakeFs({ "/doc.html": "<html><body><p>x</p></body></html>" });
    dirsOf(fs, ["/"]);
    fs.fail("readdir", systemError("EACCES"), (dir) => dir === "/");

    const result = await listWorkspaceAnnotations({ workspace: "/" }, deps(fs.port));

    // A "/" root prefixes every absolute path: folding it would mangle the text, so it stays.
    expect(result.diagnostics.some((line) => line.includes("目录不可读：.（"))).toBe(true);
  });
});

describe("listWorkspaceAnnotations · walk resilience", () => {
  it("should diagnose an unreadable directory and an entry that vanishes mid-scan", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/sub/doc2.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/locked/a.html`]: "<html><body><p>x</p></body></html>",
    });
    dirsOf(fs, [WS, `${WS}/sub`, `${WS}/locked`]);
    fs.fail("readdir", systemError("EACCES"), (dir) => dir.endsWith("locked"));
    fs.fail("lstat", systemError("ENOENT"), (path) => path.endsWith("doc2.html"));

    const result = await scan(fs);

    expect(result.docsScanned).toBe(1);
    expect(result.diagnostics.some((line) => line.includes("目录不可读"))).toBe(true);
    expect(result.diagnostics.some((line) => line.includes("条目不可读"))).toBe(true);
  });

  it("should diagnose a doc whose merged read fails, not abort the scan", async () => {
    const fs = fakeFs({
      [`${WS}/bad.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/good.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("good.html")}`]: storeJson("good.html", [
        record({ id: "an-good" }),
      ]),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);
    fs.fail("readFile", systemError("EACCES"), (path) => path.endsWith("bad.html"));

    const result = await scan(fs);

    expect(result.annotations.map((entry) => entry.annotation.id)).toEqual(["an-good"]);
    expect(result.diagnostics.some((line) => line.includes("bad.html"))).toBe(true);
  });

  it("should carry a corrupt store's diagnostics through the doc's merged read", async () => {
    const fs = fakeFs({
      [`${WS}/doc.html`]: "<html><body><p>x</p></body></html>",
      // The canonical store file for doc.html holds garbage: the doc's own read degrades, and the
      // record pass flags the same file for its missing path field — neither is fatal.
      [`${WS}/.hreader/annotations/${storeNameOf("doc.html")}`]: "{{{",
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.diagnostics.some((line) => line.includes("侧车"))).toBe(true);
  });
});

describe("listWorkspaceAnnotations · bounds", () => {
  it("should stop at 500 walked docs and count record-resolved docs inside the same budget", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 501; index += 1) {
      seed[`${WS}/doc-${String(index)}.html`] = "<html><body><p>x</p></body></html>";
    }
    seed[`${WS}/note.txt`] = "tail doc";
    seed[`${WS}/.hreader/annotations/${storeNameOf("note.txt")}`] = storeJson("note.txt", [
      record({ id: "an-tail" }),
    ]);
    const fs = fakeFs(seed);
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.docsScanned).toBe(500);
    expect(result.truncated).toBe(true);
    // The record's doc was never reached: the walk already spent the whole docs budget.
    expect(result.annotations.map((entry) => entry.annotation.id)).not.toContain("an-tail");
  });

  it("should cap returned annotations at 1000 and flag truncation", async () => {
    const many = Array.from({ length: 1001 }, (_unused, index) =>
      record({ id: `an-${String(index)}` }),
    );
    const fs = fakeFs({
      [`${WS}/big.html`]: "<html><body><p>x</p></body></html>",
      [`${WS}/.hreader/annotations/${storeNameOf("big.html")}`]: storeJson("big.html", many),
    });
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.annotations).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it("should cap records at 500 and collapse diagnostics past 100 into a trailing summary line", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 501; index += 1) {
      seed[`${WS}/.hreader/annotations/${String(index).padStart(40, "0")}.json`] = storeJson(
        `gone-${String(index)}.html`,
        [],
      );
    }
    const fs = fakeFs(seed);
    dirsOf(fs, [WS, `${WS}/.hreader`]);

    const result = await scan(fs);

    expect(result.truncated).toBe(true);
    expect(result.diagnostics.length).toBeLessThanOrEqual(101);
    expect(result.diagnostics[result.diagnostics.length - 1]).toContain("已省略");
  });
});

describe("listWorkspaceAnnotations · input boundary", () => {
  it("should fail as not_a_file when the workspace itself cannot be resolved", async () => {
    const fs = fakeFs({ "/elsewhere/doc.html": "<html><body><p>x</p></body></html>" });
    dirsOf(fs, ["/elsewhere"]);

    expect(await codeOfAsync(() => scan(fs))).toBe("not_a_file");
  });
});
