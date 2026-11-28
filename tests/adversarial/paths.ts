// Shared adversarial corpus: hostile paths, hostile file names, and a symlink-escape
// fixture builder for filesystem-facing tests.
//
// `path` values are inputs to whatever resolves, reads, writes or echoes them — they
// must never be treated as display-safe, shell-safe or workspace-safe by default.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One hostile path or file name. `why` states the attack the string carries. */
export interface PathCase {
  /** Stable id so a failure can name the case across reports and tickets. */
  readonly id: string;
  readonly path: string;
  readonly why: string;
}

/** Path-shaped attacks: traversal, encoding tricks, absolute escapes, length limits. */
export const HOSTILE_PATHS: readonly PathCase[] = [
  { id: "dotdot", path: "..", why: "the parent directory itself" },
  { id: "dotdot-child", path: "../x", why: "one-level relative escape" },
  {
    id: "dotdot-chain",
    path: "../../etc/passwd",
    why: "multi-level traversal to a system file",
  },
  {
    id: "pct-dotdot",
    path: "%2e%2e",
    why: "percent-encoded '..' — resolvers that normalize before decoding escape silently",
  },
  {
    id: "pct-dotdot-slash",
    path: "%2e%2e%2fetc%2fpasswd",
    why: "fully encoded traversal including the separators",
  },
  {
    id: "pct-slash",
    path: "%2fetc%2fpasswd",
    why: "encoded absolute path — one decode turns it into a root-relative escape",
  },
  {
    id: "mixed-encoding",
    path: "..%2f..%2fetc",
    why: "half-encoded traversal — single-decode consumers split it differently",
  },
  { id: "absolute-posix", path: "/etc/passwd", why: "absolute POSIX path outside any workspace" },
  { id: "absolute-root", path: "/", why: "the filesystem root itself" },
  {
    id: "absolute-win",
    path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
    why: "absolute Windows path with drive letter",
  },
  {
    id: "win-unc",
    path: "\\\\server\\share\\x",
    why: "UNC path — a network share read as a local file",
  },
  {
    id: "win-device",
    path: "\\\\?\\C:\\boot.ini",
    why: "Windows device-namespace path bypasses ordinary normalization",
  },
  {
    id: "nul-in-name",
    path: "a\0b.html",
    why: "NUL truncates the path in C-level syscalls while the string keeps going",
  },
  {
    id: "nul-in-dir",
    path: "dir/\0/x",
    why: "NUL inside a directory component — same truncation, one level down",
  },
  {
    id: "long-name-300",
    path: "a".repeat(300),
    why: "a 300-char single component exceeds NAME_MAX (255) on Linux and macOS",
  },
  {
    id: "long-path-joined",
    path: `${"d".repeat(240)}/${"f".repeat(240)}`,
    why: "each component is legal but the joined path stresses PATH_MAX bounds",
  },
  {
    id: "trailing-dot",
    path: "name.",
    why: "trailing dots are stripped by Windows but kept by POSIX — split-brain file identity",
  },
  { id: "trailing-dots", path: "name...", why: "several trailing dots in a row" },
  {
    id: "trailing-space",
    path: "name ",
    why: "a trailing space is legal POSIX but stripped by Windows",
  },
  {
    id: "leading-space",
    path: " name",
    why: "a leading space is easy to miss in logs, diffs and listings",
  },
  { id: "dotfile", path: ".hidden", why: "a dotfile invisible to default listings" },
  {
    id: "hreader-meta",
    path: ".hreader/trust.json",
    why: "a path under .hreader/ attacks the tool's own state directory",
  },
  {
    id: "hreader-escape",
    path: ".hreader/../outside.html",
    why: "traversal that roots itself inside the tool directory first",
  },
];

/** File-name-shaped attacks: names that become markup, URLs or control output when echoed. */
export const HOSTILE_FILENAMES: readonly PathCase[] = [
  {
    id: "markup-img",
    path: 'x"><img src=x onerror=alert(1)>.html',
    why: "a name that becomes live markup when echoed unescaped into HTML",
  },
  {
    id: "markup-svg",
    path: 'a"><svg onload=alert(1)>b.html',
    why: "attribute-injection shape inside an ordinary-looking name",
  },
  {
    id: "query",
    path: "a?b.html",
    why: "'?' is a wildcard on Windows and a query separator when echoed into a URL",
  },
  {
    id: "fragment",
    path: "a#b.html",
    why: "'#' truncates a URL path into a fragment identifier",
  },
  {
    id: "percent-slash",
    path: "a%2fb.html",
    why: "'%2f' decodes to '/' — one filename that is two different paths",
  },
  {
    id: "percent-25",
    path: "%25.html",
    why: "'%25' decodes to '%' — double-decode confusion",
  },
  {
    id: "newline",
    path: "a\nb.html",
    why: "a newline splits log lines and terminal output into two entries",
  },
  {
    id: "carriage-return",
    path: "a\rb.html",
    why: "CR overwrites the current terminal line — log forgery",
  },
  {
    id: "backslash",
    path: "a\\b.html",
    why: "backslash is a separator on Windows but a plain character on POSIX",
  },
  {
    id: "control-bel",
    path: "a\u0007b.html",
    why: "BEL rings terminals and pollutes captured output",
  },
  {
    id: "rtl-override",
    path: "a\u202Egnp.html",
    why: "RLO flips display order — shows '.png' where the bytes say '.html'",
  },
  {
    id: "case-variant",
    path: "Doc.HTML",
    why: "a case-only variant of doc.html — identity diverges on case-insensitive filesystems",
  },
  {
    id: "unicode-nfd",
    path: "e\u0301.html",
    why: "NFD form of é — macOS rewrites NFC to NFD, so two byte forms name one file",
  },
  {
    id: "hreader-meta-name",
    path: ".hreader/notes.json",
    why: "a file name inside the tool's own state directory",
  },
];

/** Case-only renames of the same logical file — divergent on case-insensitive APFS vs case-sensitive ext4. */
export const CASE_ONLY_PAIRS: readonly (readonly [string, string])[] = [
  ["doc.html", "Doc.html"],
  ["README.md", "readme.md"],
  [".hreader", ".HREADER"],
  ["Sub/Dir.html", "sub/dir.html"],
];

/** A workspace with a built-in escape: `link` (and `fileLink`) inside `workspace` resolve outside it. */
export interface SymlinkEscapeFixture {
  /** The temp root holding everything; remove it recursively after use. */
  readonly base: string;
  /** `<base>/ws` — the workspace under test. */
  readonly workspace: string;
  /** `<base>/outside` — the escape target directory. */
  readonly outside: string;
  /** `<base>/outside/escaped.html` — a real file outside the workspace. */
  readonly outsideFile: string;
  /** `<base>/ws/escape` — a directory symlink pointing at `outside`. */
  readonly link: string;
  /** `<base>/ws/escaped-link.html` — a file symlink pointing at `outsideFile`. */
  readonly fileLink: string;
}

/**
 * Builds a symlink-escape fixture under `baseDir` (a fresh mkdtemp dir when omitted).
 * The workspace holds no real copy of `outside` — only links — so any reader that
 * resolves realpaths sees the escape, and any that doesn't sees in-workspace names.
 */
export const symlinkEscapeFixture = (baseDir?: string): SymlinkEscapeFixture => {
  const base = baseDir ?? mkdtempSync(join(tmpdir(), "hr-adv-symlink-"));
  const workspace = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const outsideFile = join(outside, "escaped.html");
  writeFileSync(outsideFile, "<p>outside the workspace</p>", "utf8");
  const link = join(workspace, "escape");
  const fileLink = join(workspace, "escaped-link.html");
  symlinkSync(outside, link, "dir");
  symlinkSync(outsideFile, fileLink, "file");
  return { base, workspace, outside, outsideFile, link, fileLink };
};
