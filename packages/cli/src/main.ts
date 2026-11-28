// This layer: the process shell (resolve hook + real io + exit codes); no parsing, no formatting — all logic lives in `run.ts`.
// Reads nothing beyond `HR_DEBUG`: cwd / argv / stdin are taken from `process` only here and passed down as parameters.

import { registerHooks } from "node:module";

import { epipeGuard } from "./epipe.ts";
import { resolveFallback } from "./resolve-hook.ts";

registerHooks({ resolve: resolveFallback });

// Must be read before any `await`: the shell may die right after spawn, and once it is re-parented to 1 a later read
// cannot tell "the original parent" from "init" (`--exit-with-parent` once leaked exactly here).
const launchParentPid = process.ppid;

const { run } = await import("./run");

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array)) throw new Error("stdin 片段不是字节");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** Either signal once shuts down; a second is left unhandled so the runtime's default behavior takes over. */
const stop = new Promise<void>((resolve) => {
  process.once("SIGTERM", () => {
    resolve();
  });
  process.once("SIGINT", () => {
    resolve();
  });
});

// The EPIPE guard must be attached before `run`: the first stdout write can already hit an early-closed downstream.
epipeGuard(process.stdout);
epipeGuard(process.stderr);

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  // `hr thumb`'s binary channel: PNG bytes must reach the pipe untouched — the string `stdout` would re-encode them.
  stdoutBytes: (bytes) => {
    process.stdout.write(bytes);
  },
  isStdoutTty: process.stdout.isTTY,
  stderr: (text) => {
    process.stderr.write(text);
  },
  readStdin,
  debug: process.env["HR_DEBUG"] === "1",
  env: process.env,
  stop,
  launchParentPid,
});

process.exitCode = code;
