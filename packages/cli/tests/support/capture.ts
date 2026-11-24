// 这层管：进程内跑 `run()` 时的 io 捕获（stdout / stderr 各收一份）；不做断言。

import { run, type CliIo } from "../../src/run";

export interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `cwd` 同时是默认 workspace：用例传临时目录即可，不必再给 `--workspace`。 */
export const runIn = async (cwd: string, argv: readonly string[]): Promise<Captured> => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
  };
  const code = await run(argv, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
};
