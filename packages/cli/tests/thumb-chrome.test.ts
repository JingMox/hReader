// This layer runs the thumbnail pipeline on **real Chrome**: `renderThumbOf`
// (and the shared `createThumbRender` service end-to-end) over a spawned
// browser, with the same skip contract and leak-guard registration as
// export-foreign-chrome.test.ts.
//
// Asserted:
//   - the output is exactly 600x400 (IHDR readback, not the reported size);
//   - a managed doc renders through the print-sheet source end to end, and the
//     service leaves a `<workspace>/.hreader/thumbs/<sha256>.png` cache entry;
//   - a foreign doc's scripts never run — the thumbnail is pixel-identical to
//     its unscripted twin and no script beacon is ever attempted;
//   - network off: a referenced external image produces zero hits on the
//     local listener (the wire-level canary), served or not.
//
// Skip contract: no Chrome or HREADER_SKIP_CHROME=1 prints SKIPPED + reason.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { pngSizeOf } from "../src/chrome/png";
import { chromeProcessOf, type ChromeDeps } from "../src/chrome/process";
import { chromeDepsOf } from "../src/chrome/session";
import { skipLineOf, skipReasonOf } from "../src/commands/print-skip";
import { createThumbRender } from "../src/thumbs/service";
import { registerChild } from "../../../tests/leak-guard/registry.ts";

const SYSTEM_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const chromeFoundOf = (): string | undefined => {
  const override = process.env["HREADER_CHROME"];
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : undefined;
  }
  return SYSTEM_CHROME.find((path) => existsSync(path));
};

const SKIP_REASON = skipReasonOf({ ...process.env, CHROME_BIN: chromeFoundOf() ?? "" });
if (SKIP_REASON !== null) process.stdout.write(skipLineOf(SKIP_REASON));

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const rootOf = (tag: string): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), tag)));
  dirs.push(root);
  return root;
};

/** Chrome spawn goes through leak-guard registration; the session layer reaps it deterministically on every path. */
const depsOf = (): ChromeDeps => {
  const base = chromeDepsOf({ ...process.env, HREADER_CHROME: chromeFoundOf() });
  return {
    ...base,
    spawn: (file, args, options) => {
      const child = spawn(file, [...args], options);
      registerChild(child, { group: process.platform !== "win32", tag: "chrome" });
      return chromeProcessOf(child);
    },
  };
};

const NEVER = new Promise<void>(() => undefined);

interface ExtSite {
  readonly url: string;
  readonly hits: string[];
  readonly close: () => Promise<void>;
}

const startExtSite = async (): Promise<ExtSite> => {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(200, { "content-type": "image/png" });
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    hits,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

// Zero <article> elements: classifyDocument calls this foreign, so the render
// takes the gated capability-URL path with scripts off.
const foreignHtmlOf = (head: string, body = ""): string =>
  `<!DOCTYPE html><html><head>${head}</head><body><h1>plain page</h1><p>stable text</p>${body}</body></html>`;

const MANAGED_HTML = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p></article>',
  "</body></html>",
].join("\n");

const thumbRenderOf = (ws: string, home: string) =>
  createThumbRender({
    workspace: ws,
    home,
    env: { ...process.env, HREADER_CHROME: chromeFoundOf() },
    stop: NEVER,
    timeoutMs: 30_000,
    warn: () => undefined,
    // The service's default session path runs for real — `chromeDeps` routes
    // the spawn through leak-guard so every started Chrome is registered.
    chromeDeps: depsOf(),
  });

const sha256Of = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe.skipIf(SKIP_REASON !== null)("thumbnails on real Chrome", () => {
  it("renders a managed doc through the sheet source to exactly 600x400 and caches it by content hash", async () => {
    const root = rootOf("hr-thumb-m-");
    const ws = join(root, "ws");
    const home = join(root, "home");
    mkdirSync(ws, { recursive: true });
    mkdirSync(home, { recursive: true });
    const doc = join(ws, "doc.html");
    writeFileSync(doc, MANAGED_HTML);

    const render = thumbRenderOf(ws, home);
    const bytes = await render({ path: doc, hash: sha256Of(doc) });

    expect([pngSizeOf(bytes).width, pngSizeOf(bytes).height]).toEqual([600, 400]);
    // The cache entry exists at the content-hash name, not anywhere near the doc name.
    const cached = join(ws, ".hreader", "thumbs", `${sha256Of(doc)}.png`);
    expect(readFileSync(cached)).toEqual(Buffer.from(bytes));
    // A second request is a cache hit: identical bytes back.
    expect(await render({ path: doc, hash: sha256Of(doc) })).toEqual(bytes);
  }, 90_000);

  it("never runs a foreign doc's scripts: the thumbnail is pixel-identical to the unscripted twin", async () => {
    const ext = await startExtSite();
    try {
      const root = rootOf("hr-thumb-js-");
      const ws = join(root, "ws");
      const home = join(root, "home");
      mkdirSync(ws, { recursive: true });
      mkdirSync(home, { recursive: true });

      const scripted = join(ws, "scripted.html");
      const twin = join(ws, "twin.html");
      writeFileSync(
        scripted,
        foreignHtmlOf(
          `<script>fetch("${ext.url}/beacon.png");document.body.innerHTML="<h1>PWNED</h1>";</script>`,
        ),
      );
      writeFileSync(twin, foreignHtmlOf(""));

      const render = thumbRenderOf(ws, home);
      const scriptedPng = await render({ path: scripted, hash: sha256Of(scripted) });
      const twinPng = await render({ path: twin, hash: sha256Of(twin) });

      // Scripts off: no beacon, no rewritten body — byte-identical to the twin.
      expect(ext.hits.filter((h) => h.includes("beacon"))).toEqual([]);
      expect(scriptedPng).toEqual(twinPng);
      expect([pngSizeOf(scriptedPng).width, pngSizeOf(scriptedPng).height]).toEqual([600, 400]);
    } finally {
      await ext.close();
    }
  }, 90_000);

  it("keeps a foreign doc's network closed: zero hits on the local listener", async () => {
    const ext = await startExtSite();
    try {
      const root = rootOf("hr-thumb-net-");
      const ws = join(root, "ws");
      const home = join(root, "home");
      mkdirSync(ws, { recursive: true });
      mkdirSync(home, { recursive: true });
      const doc = join(ws, "net.html");
      // No trust grant at all: the effective network permission is closed.
      writeFileSync(doc, foreignHtmlOf("", `<img src="${ext.url}/beacon.png">`));

      const render = thumbRenderOf(ws, home);
      const bytes = await render({ path: doc, hash: sha256Of(doc) });

      expect(ext.hits).toEqual([]);
      expect([pngSizeOf(bytes).width, pngSizeOf(bytes).height]).toEqual([600, 400]);
    } finally {
      await ext.close();
    }
  }, 90_000);
});
