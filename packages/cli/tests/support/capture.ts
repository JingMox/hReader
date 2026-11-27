// This layer captures io when running `run()` in-process (one copy each of stdout / stderr); no assertions.

import { run, type CliIo } from "../../src/run";

export interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `cwd` doubles as the default workspace: cases pass a temp dir and never need `--workspace` again. */
export const runIn = async (
  cwd: string,
  argv: readonly string[],
  extra: Partial<CliIo> = {},
): Promise<Captured> => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
    ...extra,
  };
  const code = await run(argv, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
};
