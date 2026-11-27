// This layer owns: start/stop of the long-lived `hr serve` process (receipt
// line → DaemonInfo; SIGTERM teardown verifies daemon.json is removed).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { assert, parseJson } from "./check.ts";
import type { JsonObject } from "./cli.ts";
import { APP_DIR, CLI_BIN } from "./env.ts";
import { live, stopProc, type LiveProc } from "./proc.ts";

export interface Daemon {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly pid: number;
  readonly proc: LiveProc;
  readonly home: string;
  /** SIGTERM → wait for exit; returns the exit code (null when killed by a signal). */
  readonly stop: () => Promise<number | null>;
}

export interface ServeOptions {
  readonly file: string;
  readonly workspace: string;
  readonly home: string;
  readonly extraArgs?: readonly string[];
}

export const daemonJsonPath = (home: string): string => join(home, ".hreader", "daemon.json");

export const daemonFileExists = (home: string): boolean => existsSync(daemonJsonPath(home));

/**
 * `--port 0` is kernel-assigned: tests (and parallel agents) never collide on
 * ports. The receipt is the first `--json` stdout line; no line means startup
 * failed, and stderr comes along with the report.
 */
export const startServe = async (options: ServeOptions): Promise<Daemon> => {
  const proc = live(
    process.execPath,
    [
      CLI_BIN,
      "serve",
      options.file,
      "--workspace",
      options.workspace,
      "--home",
      options.home,
      "--app-dir",
      APP_DIR,
      "--port",
      "0",
      "--json",
      // When the spawning process dies (worker SIGKILLed, crashed, interrupted)
      // the daemon must reap itself: afterAll never gets to run on that path.
      "--exit-with-parent",
      ...(options.extraArgs ?? []),
    ],
    { cwd: options.workspace },
  );
  // Failed start-up (no receipt / malformed receipt) must reap the spawned
  // process before rethrowing: an escaping error plus a live daemon is the leak.
  try {
    const line = await proc.nextLine(20_000);
    assert(
      line !== undefined,
      `hr serve printed no receipt (stderr: ${proc.out.err().slice(0, 400)})`,
    );
    const parsed = parseJson(line, "hr serve receipt");
    assert(
      typeof parsed === "object" && parsed !== null,
      `hr serve receipt is not an object: ${line}`,
    );
    assert(Reflect.get(parsed, "ok") === true, `hr serve receipt is not ok: ${line}`);
    const dataRaw: unknown = Reflect.get(parsed, "data");
    assert(
      typeof dataRaw === "object" && dataRaw !== null,
      `hr serve receipt is missing data: ${line}`,
    );
    const data = dataRaw as JsonObject;
    const port = data["port"];
    const token = data["token"];
    const url = data["url"];
    const pid = data["pid"];
    assert(
      typeof port === "number" && typeof token === "string" && typeof url === "string",
      `hr serve receipt fields are incomplete: ${line}`,
    );
    return {
      port,
      token,
      url,
      pid: typeof pid === "number" ? pid : proc.pid,
      proc,
      home: options.home,
      stop: async () => await stopProc(proc),
    };
  } catch (error: unknown) {
    await stopProc(proc);
    throw error;
  }
};
