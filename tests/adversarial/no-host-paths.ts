// Shared adversarial checker: user-facing output must never leak host filesystem paths.
//
// Why this exists: diagnostics, receipts and error text must name error codes and
// workspace-relative paths only — a `/Users/...` or `/private/tmp/...` fragment is an
// information leak and a sign the code returned its own internals. Any command/test that
// produces user-facing strings pipes them through here.
//
// The check is deliberately a dumb substring scan: callers pass the *output*, plus any
// extra roots that count as host paths for that test — typically the workspace's lexical
// path AND its realpath (symlinked tmpdirs differ on macOS: /var → /private/var).

/** Host roots that must never appear in user-facing output. */
const HOST_ROOTS = ["/Users", "/private", "/tmp", "/var", "/home"] as const;

/** Any Windows drive-qualified path, e.g. `C:\Users\x`. */
const WINDOWS_DRIVE = /[A-Za-z]:\\/;

/** Snippet around a hit for the failure message — long enough to identify the leak site. */
const contextOf = (output: string, index: number, length: number): string =>
  JSON.stringify(output.slice(Math.max(0, index - 40), index + length + 40));

const fail = (what: string, output: string, index: number): never => {
  throw new Error(
    `host path leaked into output: ${what} at index ${String(index)} (…${contextOf(output, index, what.length)}…)`,
  );
};

/**
 * Throws when `output` contains a host filesystem root: `/Users`, `/private`, `/tmp`,
 * `/var`, `/home`, a Windows drive path like `C:\…`, or any literal in `extra`.
 *
 * `extra` is for per-test roots — pass the workspace's lexical path and its realpath so
 * both spellings are covered. Empty strings are skipped (an empty root would flag all output).
 */
export const assertNoHostPaths = (output: string, extra: readonly string[] = []): void => {
  for (const root of HOST_ROOTS) {
    const at = output.indexOf(root);
    if (at !== -1) fail(root, output, at);
  }
  const drive = WINDOWS_DRIVE.exec(output);
  if (drive !== null) fail(drive[0], output, drive.index);
  for (const root of extra) {
    if (root === "") continue;
    const at = output.indexOf(root);
    if (at !== -1) fail(root, output, at);
  }
};
