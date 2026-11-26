// This layer: how the process dies when the stdout/stderr consumer closes early (`| head -1`); only attaches an `'error'` listener, never touches the output.

/** Minimal surface needed on `process.stdout`/`stderr`: `on("error", …)`. A real EventEmitter satisfies it in tests. */
interface ErrorStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Node does not swallow EPIPE on `process.stdout`: when the consumer closes the read end early, an
 * unhandled `'error'` becomes an uncaught exception (exit 1 + a screenful of stack). EPIPE is not a
 * product failure — downstream left on its own — so settle quietly with the established exit code;
 * non-EPIPE errors are rethrown as-is rather than inventing a third way to die.
 */
export const epipeGuard = (stream: ErrorStream): void => {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    // Non-EPIPE is rethrown as-is — no third way to die invented for the runtime.
    if (error.code !== "EPIPE") throw error;
    process.exit(process.exitCode ?? 0);
  });
};
