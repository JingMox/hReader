// This layer: assembles a serve intent into `ServeInput` (other commands' assembly stays in `run.ts`).
// A separate file purely for responsibility boundaries: `run.ts` only dispatches, and serve is the only command needing all three of `--app-dir` / `--allow-host` / the watchdog.

import { existsSync } from "node:fs";

import { HrError } from "@hreader/core";

import type { Intent } from "./args";
import { serveCommand } from "./commands/serve";
import { displayedPathOf } from "./output";

/** The three things the dispatch layer already normalized: `--home`'s location, the stop handle, and the single "capture parent pid once" capture. */
interface ServeWiring {
  /** Where `--home` lands when omitted (`run` already normalized `homedir()` into this). */
  readonly home: string;
  /** Current working directory: error paths echo from the user's view (relative to cwd), same convention as receipts. Defaults to the process cwd. */
  readonly cwd?: string | undefined;
  readonly stop: Promise<void>;
  /** Parent pid the process shell captured before the first `await`; no fallback here — reading `process.ppid` late would miss "parent already dead at launch". */
  readonly launchParentPid: number;
  /** core's diagnostics outlet; leaving it unwired silences "something else listening on `::`" and "stale daemon.json cleanup". */
  readonly diagnose: (message: string) => void;
  /** Document path printed in the receipt (user's view, converted by `run.ts` against cwd); unset = print the workspace-relative name. */
  readonly displayPath?: string | undefined;
}

export const serveCommandOf = (
  intent: Extract<Intent, { kind: "serve" }>,
  paths: { readonly workspace: string; readonly file: string },
  wiring: ServeWiring,
): Promise<string> => {
  // An explicit `--app-dir` must really exist (exit 2): depcruise bars commands/* from fs, and the default still comes from core.
  if (intent.appDirGiven && intent.appDir !== undefined && !existsSync(intent.appDir)) {
    throw new HrError(
      "invalid_input",
      `--app-dir 目录不存在：${displayedPathOf(intent.appDir, wiring.cwd ?? process.cwd())}`,
    );
  }
  // core's `diagnose` emits one message with no newline; the CLI's stderr is a line channel, so this layer adds it.
  const diagnose = (message: string): void => {
    wiring.diagnose(`${message}\n`);
  };
  return serveCommand({
    file: paths.file,
    workspace: paths.workspace,
    port: intent.port,
    home: wiring.home,
    ...(intent.appDir === undefined ? {} : { appDir: intent.appDir }),
    json: intent.json,
    allowHosts: intent.allowHosts,
    stop: wiring.stop,
    exitWithParent: intent.exitWithParent,
    launchParentPid: wiring.launchParentPid,
    diagnose,
    displayPath: wiring.displayPath,
  });
};
