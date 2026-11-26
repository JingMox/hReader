// The reader must never cause a /favicon.ico request: the daemon ships no icon, so every
// page load produced a 404 — and Chrome logs a console.error on top of the failed
// response, which no error whitelist can separate from a real module failure without
// also hiding real ones. The fix lives in the markup: both HTML entries (the
// daemon-served reader page and the desktop webview shell) declare an inline data: icon,
// which every browser accepts as "the icon is empty" and never falls back to
// /favicon.ico. `img-src 'self' data:` in the reader CSP already permits it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");

/** Every top-level page hReader serves or loads, keyed by its on-disk path. */
const ENTRY_PAGES: Readonly<Record<string, string>> = {
  "daemon reader (dist is built from static/)": join(APP_DIR, "static", "index.html"),
  "desktop webview shell": join(APP_DIR, "..", "desktop", "src-tauri", "ui", "index.html"),
};

describe("entry page favicon", () => {
  for (const [label, path] of Object.entries(ENTRY_PAGES)) {
    it(`should declare an inline data: icon so no /favicon.ico request happens in ${label}`, () => {
      const html = readFileSync(path, "utf8");
      // `<link rel="icon" href="data:,">` — an empty data URL is a complete, fetch-free
      // icon declaration; a network href would just move the request, not remove it.
      expect(html).toMatch(/<link\s+rel="icon"\s+href="data:,"/);
    });
  }
});
