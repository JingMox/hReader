// Shared adversarial checker: user-facing output must never leak host filesystem paths.
//
// Why this exists: diagnostics, receipts and error text must name error codes and
// workspace-relative paths only — a `/Users/...` or `/private/tmp/...` fragment is an
// information leak and a sign the code returned its own internals. Any command/test that
// produces user-facing strings pipes them through here.
//
// How it scans:
// - a host root must start an absolute path — at the string start, after a non-path
//   delimiter (whitespace, quotes, brackets, `=`, `,`, `:`, `<`, `>`, `;`, `|`, `&`),
//   or right after `file://`. This keeps substring hits like `out/tmp/x.html` or
//   `docs/home/p.html` from misfiring while every true leak stays caught;
// - Windows drive paths (`C:\x`, `c:/x`) and UNC shares (`\\s\s`, `//s/s` — the `//`
//   form only when it is not the `//` of a URL scheme like `https://`) count too;
// - the same scan runs over decoded copies — JSON slash/backslash escapes (`\/`, `\\`)
//   and percent escapes (`%2F`) — so an encoding can't launder a leak.
//
// `extra` is for per-test roots — typically the workspace's lexical path AND its
// realpath (symlinked tmpdirs differ on macOS: /var → /private/var).

/** Host roots that must never appear in user-facing output. */
const HOST_ROOTS = ["/Users", "/private", "/tmp", "/var", "/home"] as const;

/** A drive-qualified path on Windows, either slash direction: `C:\x`, `c:/x`. */
const DRIVE = /[A-Za-z]:[\\/]/gu;

/** A UNC share prefix: `\\server` or `//server`. */
const UNC = /\\\\|\/\//gu;

/**
 * A character that can precede a real path — whitespace, quotes, brackets and the
 * usual separators. Anything else (letters, `/`, `\`, `.`, `-`, `_`, `~`, `%`, `+`)
 * means the match sits inside a longer path, not at its root.
 */
const PATH_DELIMITER = /[\s"'`(){}[\]<>=,:;|&]/u;

/** Whether `index` begins an absolute path: start, a delimiter, or a `file://` prefix. */
const atBoundary = (output: string, index: number): boolean =>
  index === 0 ||
  PATH_DELIMITER.test(output.charAt(index - 1)) ||
  output.slice(0, index).endsWith("file://");

/**
 * Decodes `%XX` escapes byte-wise (Latin-1 is enough for the ASCII roots). Never
 * throws — malformed escapes simply pass through undecoded.
 */
const percentDecode = (output: string): string =>
  output.replace(/%[0-9a-fA-F]{2}/gu, (match) =>
    String.fromCharCode(Number.parseInt(match.slice(1), 16)),
  );

/** The spellings a leak can wear: raw, JSON-unescaped, percent-decoded — each scanned. */
const variantsOf = (output: string): Map<string, string> => {
  const variants = new Map<string, string>();
  variants.set(output, "");
  const slashes = output.replaceAll("\\/", "/");
  const backslashes = output.replaceAll("\\\\", "\\");
  variants.set(slashes, " (JSON slash escapes decoded)");
  variants.set(backslashes, " (JSON backslash escapes decoded)");
  variants.set(slashes.replaceAll("\\\\", "\\"), " (JSON escapes decoded)");
  for (const [variant, label] of [...variants]) {
    variants.set(percentDecode(variant), `${label} (percent-decoded)`);
  }
  return variants;
};

/** Snippet around a hit for the failure message — long enough to identify the leak site. */
const contextOf = (output: string, index: number, length: number): string =>
  JSON.stringify(output.slice(Math.max(0, index - 40), index + length + 40));

const fail = (what: string, output: string, index: number): never => {
  throw new Error(
    `host path leaked into output: ${what} at index ${String(index)} (…${contextOf(output, index, what.length)}…)`,
  );
};

const scan = (output: string, label: string, extra: readonly string[]): void => {
  for (const root of HOST_ROOTS) {
    let at = output.indexOf(root);
    while (at !== -1) {
      if (atBoundary(output, at)) fail(`${root}${label}`, output, at);
      at = output.indexOf(root, at + 1);
    }
  }
  for (const match of output.matchAll(DRIVE)) {
    if (atBoundary(output, match.index)) fail(`${match[0]}…${label}`, output, match.index);
  }
  for (const match of output.matchAll(UNC)) {
    const at = match.index;
    const prev = output.charAt(at - 1);
    // `https://host` is a scheme, not a share — only the `//` form defers to it.
    if (match[0] === "//" && prev === ":") continue;
    if (at !== 0 && !PATH_DELIMITER.test(prev)) continue;
    const after = output.charAt(at + 2);
    if (after === "" || PATH_DELIMITER.test(after)) continue;
    fail(`UNC share ${match[0]}…${label}`, output, at);
  }
  for (const root of extra) {
    if (root === "") continue;
    let at = output.indexOf(root);
    while (at !== -1) {
      if (atBoundary(output, at)) fail(`${root}${label}`, output, at);
      at = output.indexOf(root, at + 1);
    }
  }
};

/**
 * Throws when `output` contains a host filesystem root: `/Users`, `/private`, `/tmp`,
 * `/var`, `/home` at a path boundary, a Windows drive or UNC path, or any literal in
 * `extra` — in raw, JSON-escaped or percent-encoded spelling.
 *
 * `extra` is for per-test roots — pass the workspace's lexical path and its realpath so
 * both spellings are covered. Empty strings are skipped (an empty root would flag all output).
 */
export const assertNoHostPaths = (output: string, extra: readonly string[] = []): void => {
  for (const [variant, label] of variantsOf(output)) scan(variant, label, extra);
};
