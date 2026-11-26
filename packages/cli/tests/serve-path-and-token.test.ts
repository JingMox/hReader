// This layer covers whether the line `hr serve` prints is directly usable — the document path must be recognizable, and the address must carry credentials and open to real content.
//
// Sites always start in-process (closed via `run()`'s `stop` handle); a foreground `serve` subprocess would hang the whole suite.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run } from "../src/run";
import { fieldOf, parseJsonLine, withTempDir } from "./harness";
import { stopHandle } from "./serve-helpers";

const BODY = "下一季度只做三件事。";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="hr-c">' + BODY + "</p></article>",
  "</body></html>",
].join("\n");

interface Serving {
  readonly text: string;
  readonly code: number;
  readonly stop: () => void;
}

/** Start a real site and wait for its first printed line; the caller runs `stop()`. */
const serveOf = async (dir: string, extra: readonly string[] = []): Promise<Serving> => {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "d.html"), DOC);
  const out: string[] = [];
  const { stop, stopped } = stopHandle();
  const code = await run(["serve", "d.html", "--port", "0", "--home", home, ...extra], {
    cwd: dir,
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
    stop: stopped,
  });
  return { text: out.join(""), code, stop };
};

/** The human line must name the document, and the printed address opens to real content verbatim. */
const expectHumanLine = async (dir: string): Promise<void> => {
  const served = await serveOf(dir);
  try {
    expect(served.code).toBe(0);
    // The human line must show the path the user gave: `serving <dir> on …` (workspace absolute path) cannot name which document it is.
    expect(served.text).toMatch(
      /^serving d\.html on http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+ \(pid \d+\)\n$/u,
    );
    const url = /on (http:\/\/\S+)/u.exec(served.text)?.[1] ?? "";

    // Do what the user does: open that address verbatim. The first visit trades the token for a cookie and 302s back to a clean `/`.
    const first = await fetch(url, { redirect: "manual" });
    expect(first.status).toBe(302);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^hr=[\w-]+$/u);

    // The front page must have content: opening to nothing is this command's worst failure mode.
    const page = await fetch(new URL("/", url), { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(BODY);
  } finally {
    served.stop();
  }
};

/** The `--json` address carries credentials and no workspace absolute path. */
const expectJsonUrl = async (dir: string): Promise<void> => {
  const served = await serveOf(dir, ["--json"]);
  try {
    expect(served.code).toBe(0);
    const envelope = parseJsonLine(served.text);
    const url = String(fieldOf(fieldOf(envelope, "data"), "url"));

    // A bare address pasted into a browser is a 401: the credentials must ride inside this string — asking the user to assemble the token only assembles it wrong.
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
    expect(url).toContain(`:${String(fieldOf(fieldOf(envelope, "data"), "port"))}/`);
    // The address must not mix in a workspace absolute path: it is for the browser, whose path portion should be just `/`.
    expect(url).not.toContain(dir);
  } finally {
    served.stop();
  }
};

describe("serve · the printed path and credentials", () => {
  it("should name the document in the human line and serve its body behind that URL", async () => {
    await withTempDir(async (dir) => {
      await expectHumanLine(dir);
    }, 30_000);
  });

  it("should put the token in --json.data.url and keep the path relative", async () => {
    await withTempDir(async (dir) => {
      await expectJsonUrl(dir);
    }, 30_000);
  });
});
