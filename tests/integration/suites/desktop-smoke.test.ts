// Journey 7 (desktop shell smoke): the debug binary's --smoke headless path
// runs start daemon → open document → exit; at the end it asserts no orphan
// hr serve processes remain.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq, parseJson } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { CLI_BIN, DESKTOP_DEBUG_BIN, sandbox, type TestHome } from "../harness/env.ts";
import { killAllTracked, pidAlive, run } from "../harness/proc.ts";

const skip = existsSync(DESKTOP_DEBUG_BIN)
  ? undefined
  : `desktop debug binary not built: ${DESKTOP_DEBUG_BIN}`;

describe.skipIf(skip !== undefined)("desktop-smoke", () => {
  let home: TestHome;

  const daemonPids = (): number[] => {
    const dir = join(home.home, ".hreader");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith("daemon") && f.endsWith(".json"))
      .map((f) => {
        try {
          const j = parseJson(readFileSync(join(dir, f), "utf8"), f) as Record<string, unknown>;
          return typeof j["pid"] === "number" ? j["pid"] : -1;
        } catch {
          return -1;
        }
      })
      .filter((p) => p > 0);
  };

  const smoke = () =>
    run(
      DESKTOP_DEBUG_BIN,
      [
        "--smoke",
        "--home",
        home.home,
        "--workspace",
        home.ws,
        "--cli-path",
        CLI_BIN,
        "--open",
        "d.hr.html",
      ],
      { cwd: home.ws, timeoutMs: 90_000 },
    );

  beforeAll(async () => {
    home = sandbox("desktop");
    await writeFile(
      docPath(home.ws, "d.hr.html"),
      `<!DOCTYPE html><html><body><article><p data-hr-id="p">smoke</p></article></body></html>`,
      "utf8",
    );
  });

  afterAll(async () => {
    await killAllTracked();
    for (const pid of daemonPids()) {
      assert(!pidAlive(pid), `orphan hr serve process remains: pid=${String(pid)}`);
    }
    home.cleanup();
  });

  test("should run the --smoke headless path and emit one JSON line", async () => {
    const res = await smoke();
    assertEq(
      res.code,
      0,
      `desktop --smoke exit code (stdout: ${res.stdout.slice(0, 300)} stderr: ${res.stderr.slice(0, 300)})`,
    );
    const jsonLine = res.stdout
      .trim()
      .split("\n")
      .find((l) => l.trim().startsWith("{"));
    assert(jsonLine !== undefined, `--smoke stdout has no JSON line: ${res.stdout.slice(0, 300)}`);
  });

  test("should leave no orphan hr serve processes after --smoke exits", async () => {
    const res = await smoke();
    assertEq(res.code, 0, "desktop --smoke exit code");
    for (const pid of daemonPids()) {
      assert(!pidAlive(pid), `daemon process still alive after smoke exit: pid=${String(pid)}`);
    }
  });
});
