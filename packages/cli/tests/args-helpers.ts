// This layer holds the shared fixtures for the `parseArgs` tables (parse / expectFailure / CWD); no assertions.

import { expect } from "vitest";

import { parseArgs } from "../src/args";

export const CWD = "/repo";

/** The command-list string for a missing top-level command: it grows long enough to be folded by prettier, so it lives here to keep cases under the line limit. */
export const COMMAND_LIST_HINT =
  "缺少命令：new | import | normalize | outline | read | patch | check | style | undo | export | pdf | png | serve";

export const parse = (argv: readonly string[], cwd: string = CWD) => parseArgs(argv, cwd);

/**
 * The failure envelope is **always** `{ ok:false, message, topic }`: `parseArgs` types carry no json flag;
 * "errors must honor --json" is decided by `run.ts` from argv (see the `run.test.ts` cases).
 * So here we only assert "exactly these three fields in the envelope".
 */
export const expectFailure = (
  argv: readonly string[],
  message: string,
  topic: string | undefined,
): void => {
  expect(parse(argv)).toEqual({ ok: false, message, topic });
};
