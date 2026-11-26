// This layer covers **what the user sees** when `serve` cannot start.
//
// Three kinds of "cannot start" must stay apart, because the next step differs entirely:
//   · the port is taken by someone else → `port_in_use` (change the port)
//   · this home already runs a daemon  → `daemon_already_running` (stop the old one / delete daemon.json)
//   · daemon.json is a corpse left by a kill -9 → **must not block**, just take over

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir } from "./harness";
import { homeOf, startServe } from "./serve-harness";

const DOC = '<article data-hr-id="hr-a"><h1 data-hr-id="hr-b">章</h1></article>';

const seed = (dir: string): void => {
  writeFileSync(join(dir, "doc.html"), DOC);
};

/** Start a second serve and return "exit code + refusal envelope" (shared by both "cannot start" readings). */
const secondServe = async (
  dir: string,
  port: string,
  home: string,
): Promise<{ code: number | null; envelope: unknown }> => {
  const result = checked(
    await runCli(["serve", "doc.html", "--port", port, "--home", home, "--json"], { cwd: dir }),
  );
  const envelope = parseJsonLine(result.stdout);
  expect(fieldOf(envelope, "ok")).toBe(false);
  return { code: result.code, envelope };
};

describe("hr serve · port taken by someone else", () => {
  it("should say port_in_use when another server holds the port", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const running = await startServe("doc.html", { json: true, home: homeOf(dir), cwd: dir });
      try {
        // In json mode it must also be the string the program itself printed: lose `?token=` and this goes red.
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
        // Another home + the same port: the user thinks "a different workspace can start another one" — it cannot.
        const otherHome = join(dir, "home-other");
        mkdirSync(otherHome, { recursive: true });
        const { code, envelope } = await secondServe(dir, String(running.port), otherHome);

        expect(code).toBe(2);
        expect(fieldOf(envelope, "code")).toBe("port_in_use");
        // The message must carry the real port so the user can confirm "it is the port I meant".
        expect(textOf(fieldOf(envelope, "message"))).toContain(String(running.port));
        expect(textOf(fieldOf(envelope, "message"))).toContain("--port");
      } finally {
        await running.stop();
      }
    }, 30_000);
  });
});

describe("hr serve · this home already has one running", () => {
  it("should say daemon_already_running (with the port) when this home already serves", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const home = homeOf(dir);
      const running = await startServe("doc.html", { json: true, home, cwd: dir });
      try {
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
        const { code, envelope } = await secondServe(dir, "0", home);

        expect(fieldOf(envelope, "code")).toBe("daemon_already_running");
        // An existing daemon is a "state conflict" (1), not "bad arguments" (2) — the two must be tellable apart by exit code.
        expect(code).toBe(1);
        expect(textOf(fieldOf(envelope, "message"))).toContain("daemon.json");
        expect(textOf(fieldOf(envelope, "message"))).toContain(String(running.port));
      } finally {
        await running.stop();
      }
    }, 30_000);
  });
});

describe("hr serve · a daemon.json left behind by kill -9", () => {
  it("should take over a stale daemon.json left behind by kill -9", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const home = homeOf(dir);
      // The last daemon was kill -9'd: daemon.json remains while its pid is long gone.
      mkdirSync(join(home, ".hreader"), { recursive: true });
      writeFileSync(
        join(home, ".hreader", "daemon.json"),
        JSON.stringify({ port: 1, pid: 2_000_000_000, token: "stale", workspace: dir }),
      );

      const running = await startServe("doc.html", { json: true, home, cwd: dir });
      try {
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
        // Takeover succeeds: a new daemon.json replaces it (pid and token both changed).
        const written: unknown = JSON.parse(
          readFileSync(join(home, ".hreader", "daemon.json"), "utf8"),
        );

        expect(fieldOf(written, "port")).toBe(running.port);
        expect(fieldOf(written, "token")).toBe(running.token);
        expect(fieldOf(written, "token")).not.toBe("stale");
      } finally {
        await running.stop();
      }
    }, 30_000);
  });
});
