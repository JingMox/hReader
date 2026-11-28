// Journey (document thumbnails end-to-end): `hr serve` answers
// `GET /api/doc/<docId>/thumb` — cookie auth, `image/png` 600×400, etag = the
// document's sha256 with `If-None-Match` → 304 — while
// `<ws>/.hreader/thumbs/<sha256>.png` collects the cache entry; a content edit
// regenerates under a new hash. `hr thumb` writes the same bytes via `--out`
// and binary stdout, and `--json` reports the receipt.

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { dataOf, docPath, hr, jsonOf, newDoc } from "../harness/cli.ts";
import { CLI_BIN, chromeSkipReason, sandbox, sha256File, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked, runSh } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

/** PNG magic + IHDR: width/height are the first two uint32s of the IHDR payload. */
const pngDimsOf = (bytes: Uint8Array): { readonly width: number; readonly height: number } => {
  assert(bytes.length > 24, "thumbnail is shorter than a PNG header");
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert(
    MAGIC.every((byte, index) => bytes[index] === byte),
    "thumbnail is not a PNG",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert(view.getUint32(12) === 0x49484452, "first PNG chunk is not IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const skip = chromeSkipReason();
describe.skipIf(skip !== undefined)("thumb-journey", () => {
  const DOC = "doc.hr.html";
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let docBytes: Uint8Array;

  const thumbPath = (): string =>
    join(home.ws, ".hreader", "thumbs", `${sha256File(docBytes)}.png`);

  const thumbOf = async (headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(daemon.port)}${docApi(DOC)}/thumb`, {
      headers: { cookie: api.cookie, ...headers },
    });

  beforeAll(async () => {
    home = sandbox("thumb");
    await newDoc(home.ws, DOC);
    docBytes = readFileSync(docPath(home.ws, DOC));
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
  });

  afterAll(async () => {
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("should serve image/png 600x400 with the content-hash etag and the cache entry on disk", async () => {
    const res = await thumbOf();
    assertEq(res.status, 200, "thumb status");
    assertEq(res.headers.get("content-type"), "image/png", "thumb content-type");
    assertEq(
      res.headers.get("cache-control"),
      "private, max-age=0, must-revalidate",
      "thumb cache-control",
    );
    assertEq(
      res.headers.get("etag"),
      `"${sha256File(docBytes)}"`,
      "thumb etag is the document's sha256",
    );
    const body = new Uint8Array(await res.arrayBuffer());
    const dims = pngDimsOf(body);
    assertEq(dims.width, 600, "thumb width");
    assertEq(dims.height, 400, "thumb height");
    // The generation landed in the content-hash cache — the file name never derives from the doc path.
    assert(existsSync(thumbPath()), `cache entry missing at ${thumbPath()}`);
    assertEq(
      Buffer.compare(Buffer.from(readFileSync(thumbPath())), Buffer.from(body)),
      0,
      "cache entry differs from the served bytes",
    );
  }, 90_000);

  test("should answer 304 on If-None-Match and 200 on a stale tag", async () => {
    const etag = `"${sha256File(docBytes)}"`;
    const hit = await thumbOf({ "if-none-match": etag });
    assertEq(hit.status, 304, "If-None-Match did not short-circuit to 304");
    assertEq((await hit.arrayBuffer()).byteLength, 0, "304 carried a body");

    const miss = await thumbOf({ "if-none-match": '"0000"' });
    assertEq(miss.status, 200, "a stale etag did not regenerate");
    await miss.arrayBuffer();
  }, 90_000);

  test("should refuse an unauthenticated fetch and a .hreader/** docId", async () => {
    const bare = await fetch(`http://127.0.0.1:${String(daemon.port)}${docApi(DOC)}/thumb`);
    assertEq(bare.status, 401, "thumb without a cookie must be 401");

    const hidden = await api.get(`${docApi(".hreader/thumbs/x.png")}/thumb`);
    assert(hidden.status !== 200, `.hreader/** docId was served (${String(hidden.status)})`);
  }, 30_000);

  test("should regenerate under a new hash after the document changes", async () => {
    const path = docPath(home.ws, DOC);
    const next = `${readFileSync(path, "utf8")}\n<!-- edit -->\n`;
    await writeFile(path, next, "utf8");
    docBytes = readFileSync(path);

    const res = await thumbOf();
    assertEq(res.status, 200, "thumb after edit");
    assertEq(
      res.headers.get("etag"),
      `"${sha256File(docBytes)}"`,
      "etag did not track the content hash",
    );
    await res.arrayBuffer();
    assert(existsSync(thumbPath()), "no cache entry for the new hash");
  }, 90_000);

  test("should write the same 600x400 bytes through hr thumb --out and binary stdout", async () => {
    const env = { HREADER_HOME: home.home };
    const out = docPath(home.ws, "via-out.png");
    const written = await hr(["thumb", DOC, "--workspace", home.ws, "--out", out], {
      cwd: home.ws,
      env,
    });
    assertEq(written.code, 0, `hr thumb --out exit code (stderr: ${written.stderr.slice(0, 300)})`);
    const outBytes = readFileSync(out);
    const dims = pngDimsOf(outBytes);
    assertEq(dims.width, 600, "hr thumb --out width");
    assertEq(dims.height, 400, "hr thumb --out height");

    // Binary stdout through a real shell redirect — the pipe path, not --out.
    const piped = docPath(home.ws, "via-stdout.png");
    const sh = await runSh(
      `"${process.execPath}" "${CLI_BIN}" thumb "${DOC}" --workspace "${home.ws}" > "${piped}"`,
      { cwd: home.ws, env },
    );
    assertEq(sh.code, 0, `hr thumb >file exit code (stderr: ${sh.stderr.slice(0, 300)})`);
    assertEq(
      Buffer.compare(readFileSync(piped), outBytes),
      0,
      "stdout bytes differ from --out bytes",
    );
    // The same content hash means the same cache entry the server wrote: no second file, no respawn.
    assert(existsSync(thumbPath()), "cache entry missing after hr thumb");
  }, 120_000);

  test("should answer --json with the png payload and a null out on stdout mode", async () => {
    const env = { HREADER_HOME: home.home };
    const res = await hr(["thumb", DOC, "--workspace", home.ws, "--json"], {
      cwd: home.ws,
      env,
    });
    assertEq(res.code, 0, `hr thumb --json exit code (stderr: ${res.stderr.slice(0, 300)})`);
    const data = dataOf(res, "hr thumb --json");
    assertEq(data["width"], 600, "json width");
    assertEq(data["height"], 400, "json height");
    assertEq(data["out"], null, "json out on stdout mode");
    const png = data["png"];
    assert(typeof png === "string", "json png payload is not a base64 string");
    pngDimsOf(Buffer.from(png, "base64"));

    // The receipt mirrors --out too: the path lands in `out` when one was given.
    const out = docPath(home.ws, "json-out.png");
    const withOut = await hr(["thumb", DOC, "--workspace", home.ws, "--out", out, "--json"], {
      cwd: home.ws,
      env,
    });
    const json = jsonOf(withOut, "hr thumb --out --json");
    assert(json["ok"] === true, `hr thumb --out --json failed ${JSON.stringify(json)}`);
  }, 120_000);
});
