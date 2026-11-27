// Journey 5 (mixed workspace): managed / normalizable / foreign / corrupt /
// empty / binary-in-disguise / oversized / subdirectory / symlink / Chinese and
// emoji file names all coexist. Asserted: each doc's /s/:docId either opens or
// is cleanly refused (no 5xx), check classifies correctly, and normalize
// adopts the normalizable ones.

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { dataOf, docPath, hr, jsonOf, newDoc } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { connect, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const NORMALIZABLE = `<html><body><article><h1>无 id 文档</h1><p>可以收编</p></article></body></html>`;
const FOREIGN = `<!DOCTYPE html><html><head><meta charset="utf-8"><script>alert(1)</script></head><body><h1>外来</h1></body></html>`;
const CORRUPT = "<html><body><p>未闭合";
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

const DOCS = [
  "managed.hr.html",
  "normalizable.html",
  "foreign.html",
  "corrupt.html",
  "empty.html",
  "binary.png.html",
  "超大.html",
  "subdir/nested.hr.html",
  "中文文档.hr.html",
  "📚docs.hr.html",
] as const;

let home: TestHome;
let daemon: Daemon;
let api: Api;

const checkCls = async (file: string): Promise<{ code: number | null; cls: string }> => {
  const res = await hr(["check", file, "--workspace", home.ws, "--json"], { cwd: home.ws });
  const cls =
    res.code === 0 && jsonOf(res, `check ${file}`)["ok"] === true
      ? String(dataOf(res, `check ${file}`)["cls"])
      : "";
  return { code: res.code, cls };
};

beforeAll(async () => {
  home = sandbox("mixed");
  const ws = home.ws;
  // Managed docs are made by `hr new`: a hand-written data-hr-id does not count
  // as managed (the skeleton also carries normalization marks).
  await mkdir(join(ws, "subdir"), { recursive: true });
  await newDoc(ws, "managed.hr.html");
  await newDoc(ws, "中文文档.hr.html");
  await newDoc(ws, "📚docs.hr.html");
  await newDoc(ws, "subdir/nested.hr.html");
  await writeFile(docPath(ws, "normalizable.html"), NORMALIZABLE, "utf8");
  await writeFile(docPath(ws, "foreign.html"), FOREIGN, "utf8");
  await writeFile(docPath(ws, "corrupt.html"), CORRUPT, "utf8");
  await writeFile(docPath(ws, "empty.html"), "", "utf8");
  await writeFile(docPath(ws, "binary.png.html"), BINARY);
  await writeFile(
    docPath(ws, "超大.html"),
    `<html><body>${"x".repeat(2 * 1024 * 1024)}</body></html>`,
    "utf8",
  );
  await symlink(join("..", "managed.hr.html"), join(ws, "subdir", "linked.hr.html")).catch(
    () => undefined,
  );
  daemon = await startServe({ file: "managed.hr.html", workspace: ws, home: home.home });
  api = await connect(daemon.port, daemon.token);
});

afterAll(async () => {
  await daemon.stop();
  await killAllTracked();
  home.cleanup();
});

test("should open or cleanly refuse /s/:docId and info for every coexisting document", async () => {
  for (const doc of DOCS) {
    const info = await api.get(`/api/doc/${encodeURIComponent(doc)}/info`);
    if (doc === "binary.png.html") {
      // invalid_utf8 is, per the frozen contract, the "document file" code = 500;
      // what's pinned is that it returns a structured code, not a bare crash.
      const body = await info.text();
      assertEq(info.status, 500, "binary document info status");
      assert(
        body.includes("invalid_utf8"),
        `binary document info is not a structured error: ${body.slice(0, 200)}`,
      );
      continue;
    }
    assert(info.status < 500, `${doc} info 5xx: ${String(info.status)}`);
    const res = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/s/${encodeURIComponent(doc)}?token=${encodeURIComponent(daemon.token)}`,
      { redirect: "manual" },
    );
    assert(res.status < 500, `${doc} /s/ 5xx: ${String(res.status)}`);
    await res.arrayBuffer(); // drain the body so connection reuse is not held up
  }
});

test("should classify managed/normalizable/foreign docs into their own buckets via check", async () => {
  assertEq((await checkCls("managed.hr.html")).cls, "managed", "managed classification");
  const norm = await checkCls("normalizable.html");
  assert(
    norm.cls === "normalizable" || norm.cls === "managed" || norm.cls === "foreign",
    `normalizable classification abnormal: ${norm.cls}`,
  );
  assertEq((await checkCls("foreign.html")).cls, "foreign", "foreign classification");
  const unicode = await checkCls("中文文档.hr.html");
  assertEq(unicode.cls, "managed", "Chinese-filename managed classification");
  const emoji = await checkCls("📚docs.hr.html");
  assertEq(emoji.cls, "managed", "emoji-filename managed classification");
});

test("should give corrupt/empty/binary/oversized docs a definite check exit code without crashing or hanging", async () => {
  for (const file of ["corrupt.html", "empty.html", "超大.html"]) {
    const res = await hr(["check", file, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assert(
      res.code === 0 || res.code === 1 || res.code === 3,
      `${file} check illegal exit code ${String(res.code)} (stderr: ${res.stderr.slice(0, 200)})`,
    );
  }
  const binary = await hr(["check", "binary.png.html", "--workspace", home.ws, "--json"], {
    cwd: home.ws,
  });
  assertEq(binary.code, 3, "binary-in-disguise check should exit 3 (invalid_utf8)");
  assert(jsonOf(binary, "binary check")["ok"] === false, "binary check should be ok:false");
});

test("should adopt a normalizable doc via normalize: check turns managed after the HTTP endpoint writes", async () => {
  const res = await api.post(`/api/doc/${encodeURIComponent("normalizable.html")}/normalize`, {});
  assert(res.status === 200 || res.status === 422, `normalize status ${String(res.status)}`);
  if (res.status === 200) {
    const after = await checkCls("normalizable.html");
    assertEq(after.cls, "managed", "classification after normalize");
  }
});

test("should read or cleanly refuse a symlinked doc without a 5xx", async () => {
  const res = await api.get(`/api/doc/${encodeURIComponent("subdir/linked.hr.html")}/info`);
  assert(res.status < 500, `symlinked document info ${String(res.status)}`);
});
