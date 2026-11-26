// This layer: thin adapter for `hr serve` (start core's local server -> print the port/token line; shutdown is signal-driven).

import { HrError, nodePatchDeps, nodeStyleDeps, startServer } from "@hreader/core";

import { withNormalizeAdvice } from "../document-normalize";
import { dataServe, humanServe, jsonOk } from "../output";
import {
  PARENT_POLL_MS,
  orphanedAtLaunch,
  parentGone,
  parentWatchOf,
  type ParentWatch,
} from "../parent-guard";

export interface ServeInput {
  /** Already converted to a workspace-relative path (same convention as patch/style). */
  readonly file: string;
  readonly workspace: string;
  readonly port: number;
  /** Parent directory of `~/.hreader/daemon.json`. */
  readonly home: string;
  readonly json: boolean;
  /** Build-artifact directory (root of `GET /`, `/assets/*`); `undefined` = unconfigured (core answers the index with a 200 fallback). */
  readonly appDir?: string;
  /** `--allow-host`: wholesale replacement of the default loopback Host set. */
  readonly allowHosts?: readonly string[] | undefined;
  /** Shutdown signal resolved from SIGTERM/SIGINT by `main.ts`. */
  readonly stop: Promise<void>;
  /** `--exit-with-parent`: shut down when the parent (shell) disappears; `false` = do not watch the parent (default, for user-started daemons). */
  readonly exitWithParent?: boolean | undefined;
  /** core's diagnostics outlet (something else listening on `::`, stale `daemon.json` cleanup): without it both events stay silent. */
  readonly diagnose?: ((message: string) => void) | undefined;
  /** Document path printed in the receipt (user's view): falls back to the workspace-relative name when not given. */
  readonly displayPath?: string | undefined;
  /** Parent pid captured by `main.ts` before the first `await`; kept here so "when it was captured" has a single source. */
  readonly launchParentPid: number;
}

export const serveCommand = async (input: ServeInput): Promise<string> => {
  // Reaching here means the shell is already dead: do not build the server or write `daemon.json` — exit with a readable error, or this becomes an orphan nobody reaps.
  if (shouldWatchParent(input.exitWithParent) && orphanedAtLaunch(input.launchParentPid)) {
    throw new HrError(
      "invalid_input",
      `--exit-with-parent 但启动时父进程已是 init（ppid=${String(input.launchParentPid)}）：父进程在启动窗口期就退了`,
    );
  }
  const appDir = input.appDir;
  const running = await startServer(
    {
      workspace: input.workspace,
      port: input.port,
      home: input.home,
      docId: input.file,
      ...(appDir === undefined ? {} : { appDir }),
      ...(input.diagnose === undefined ? {} : { diagnose: input.diagnose }),
      ...(input.allowHosts === undefined ? {} : { allowHosts: input.allowHosts }),
    },
    { patch: nodePatchDeps, style: nodeStyleDeps(input.workspace), now: Date.now },
  ).catch((error: unknown): never => {
    throw withNormalizeAdvice(error, input.file);
  });
  // Record the launch-time ppid, then re-read it on each poll: when the shell is kill -9'd the ppid changes (re-parented to 1 or launchd) —
  // that is the only way a daemon can notice the shell is gone.
  const disposeWatch = watchParent(
    shouldWatchParent(input.exitWithParent) ? parentWatchOf(input.launchParentPid) : undefined,
    running,
  );
  // Drop the watchdog before closing the server: a timer surviving `close()` keeps the event loop busy and the process never exits after SIGTERM.
  void input.stop.then(async () => {
    disposeWatch();
    await running.close();
  });
  return input.json
    ? jsonOk(dataServe(running.info))
    : humanServe(running.info, input.displayPath ?? input.file);
};

/** Only watch the parent when the shell explicitly asks: the default (user-started daemon) must not create a single timer. */
export const shouldWatchParent = (exitWithParent: boolean | undefined): boolean =>
  exitWithParent === true;

/** Disposer used when no watchdog exists: the call site needs no null check. */
const nothingToDispose = (): void => undefined;

/// Poll the parent once a second: a shell killed with `kill -9` gets no chance to signal, so the daemon must notice the re-parenting itself.
/// Returns a disposer: the caller (`serveCommand`'s stop path) must drop the timer before closing the server, or after `close()` finishes
/// a 1s timer still hangs on the event loop and the process never exits — exactly why `--exit-with-parent` failed to die on SIGTERM.
/// Exported only for unit tests (the real path needs a running server; a fake `running` plus fake clock covers all three branches).
export const watchParent = (
  watch: ParentWatch | undefined,
  running: { readonly close: () => Promise<void> },
): (() => void) => {
  if (watch === undefined) return nothingToDispose;
  const timer = setInterval(() => {
    if (!parentGone(watch)) return;
    clearInterval(timer);
    void running.close();
  }, PARENT_POLL_MS);
  // Same convention as core's heartbeat (`server/hub.ts`): a timer must not be the only reason the process stays alive.
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};
