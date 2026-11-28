// Shared adversarial checker: user-facing output must never leak host filesystem paths.
//
// Why this exists: diagnostics, receipts and error text must name error codes and
// workspace-relative paths only — a `/Users/...` or `/private/tmp/...` fragment is an
// information leak and a sign the code returned its own internals. Any command/test that
// produces user-facing strings pipes them through here.
//
// How it scans:
// - a host root must start an absolute path — at the string start, after a non-path
//   delimiter (whitespace, quotes, brackets, `=`, `,`, `:`, `<`, `>`, `;`, `|`, `&`,
//   `*`, NUL), or right after a `file:` URL prefix — `file:`, `file://`,
//   `file:////`, `file://localhost`, `file://.`, any case. This keeps substring
//   hits like `out/tmp/x.html` or `docs/home/p.html` from misfiring while every
//   true leak stays caught;
// - the roots match case-insensitively (`/users/x`, `/TMP/x`), like the macOS
//   filesystems they name;
// - Windows drive paths (`C:\x`, `c:/x`) and UNC shares (`\\s\s`, `//s/s` — the `//`
//   form only when it is not the `//` of a URL scheme like `https://`) count too.
//   A bare `//host/path` is flagged as UNC even though it could be a
//   protocol-relative URL — flagging is the safe direction, documented below;
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
 * means the match sits inside a longer path, not at its root. NUL is checked
 * char-wise (a literal in the regex class would trip no-control-regex).
 */
const PATH_DELIMITER = /[\s"'`(){}[\]<>=,:;|&*]/u;

/** Whether the char AT `index` is a delimiter (NUL included, OOB is not). */
const isDelimiterAt = (output: string, index: number): boolean =>
  PATH_DELIMITER.test(output.charAt(index)) || output.charCodeAt(index) === 0;

/**
 * A `file:` URL prefix ending right before the match — any case, any number of
 * slashes, any (or no) authority: `file:`, `file://`, `file:////`,
 * `file://localhost`, `file://.`. The `file:` must not itself be glued to a
 * longer word, so `profile:` or `myfile:` do not count. Whitespace inside the
 * scheme (`fi le:`, `file :`) makes it not a resolvable `file:` URL either —
 * like `https://host`, it stays unchecked rather than flagged on suspicion.
 */
const FILE_PREFIX = /(?:^|[^A-Za-z])file:[/\\]*[^/\\\s]*$/iu;

/** Whether `index` begins an absolute path: start, a delimiter, or a `file:` prefix. */
const atBoundary = (output: string, index: number): boolean =>
  index === 0 || isDelimiterAt(output, index - 1) || FILE_PREFIX.test(output.slice(0, index));

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

/** Escapes a literal for regex use — extra roots can contain any characters. */
const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Case-insensitive root lookup — `/TMP/x` leaks exactly like `/tmp/x` on the
 * case-insensitive filesystems this checker defends. Regex indices are UTF-16
 * like the string's own indexing, so no lowercase-copy offset skew.
 */
const rootPattern = (root: string): RegExp => new RegExp(escapeRegExp(root), "giu");

const scan = (output: string, label: string, extra: readonly string[]): void => {
  for (const root of HOST_ROOTS) {
    for (const match of output.matchAll(rootPattern(root))) {
      if (atBoundary(output, match.index)) fail(`${match[0]}${label}`, output, match.index);
    }
  }
  for (const match of output.matchAll(DRIVE)) {
    if (atBoundary(output, match.index)) fail(`${match[0]}…${label}`, output, match.index);
  }
  for (const match of output.matchAll(UNC)) {
    const at = match.index;
    // `https://host` is a scheme, not a share — only the `//` form defers to it.
    if (match[0] === "//" && output.charAt(at - 1) === ":") continue;
    if (at !== 0 && !isDelimiterAt(output, at - 1)) continue;
    const after = output.charAt(at + 2);
    if (after === "" || isDelimiterAt(output, at + 2)) continue;
    fail(`UNC share ${match[0]}…${label}`, output, at);
  }
  for (const root of extra) {
    if (root === "") continue;
    for (const match of output.matchAll(rootPattern(root))) {
      if (atBoundary(output, match.index)) fail(`${match[0]}${label}`, output, match.index);
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
