// This layer: the MCP-UI view resource (`ui://hreader/view/{docId}`). docId is a reversible encoding of the relative path,
// so the same URI still reads the same document after a restart; the view only **references** a running daemon, it does not manage the process.

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { readInsideWorkspace, type DocumentTarget } from "./tools/target";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

import {
  hasExternalResource,
  isDroppedNode,
  parseHtml,
  sanitizedAttributesOf,
  serializeHtml,
  type HtmlNode,
} from "@hreader/core";

export const UI_URI_PREFIX = "ui://hreader/view/";

export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export const docIdOf = (relativePath: string): string =>
  Buffer.from(normalize(relativePath).split(sep).join("/"), "utf8").toString("base64url");

/** Undecodable input → `undefined`: this is URI parsing, not the path-validation layer; bad ids all go to the "view expired" page. */
export const relativePathOfDocId = (docId: string): string | undefined => {
  const decoded = Buffer.from(docId, "base64url").toString("utf8");
  const segments = decoded.split("/");
  if (decoded.length === 0 || segments.some((one) => one === "" || one === "..")) return undefined;
  return decoded;
};

/** The daemon's port is only read from core's drop file: a hardcoded port would point the view at thin air after a port change. */
const portOf = (value: unknown): number | undefined => {
  if (typeof value !== "object" || value === null || !("port" in value)) return undefined;
  const { port } = value;
  return typeof port === "number" ? port : undefined;
};

/** The repo's single spelling of the `~/.hreader/daemon.json` path: core only exports `startServer`, not `daemonStatePath()`
 * (`daemonFileOf` lives in `core/src/server/index.ts`, off the package entry); switch to a reference if core ever exports it.
 * The view only reads this drop file for the port — it never writes it. */
const DAEMON_STATE_FILE = join(".hreader", "daemon.json");

const daemonBaseUrlOf = async (home: string): Promise<string | undefined> => {
  try {
    const raw: unknown = JSON.parse(await readFile(join(home, DAEMON_STATE_FILE), "utf8"));
    const port = portOf(raw);
    return port === undefined ? undefined : `http://127.0.0.1:${String(port)}/`;
  } catch {
    return undefined;
  }
};

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const daemonBanner = (base: string | undefined): string =>
  base === undefined
    ? '<p class="banner off">daemon 未启动：只显示静态内容，交互与批注不可用。</p>'
    : `<p class="banner on">daemon 在跑：<a href="${escapeHtml(base)}" target="_blank" rel="noreferrer">${escapeHtml(base)}</a></p>`;

const PAGE = (title: string, banner: string, body: string): string => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
:root{--hr-bg:#faf8f5;--hr-fg:#1b1a17}
body{margin:0;padding:1.5rem;background:var(--hr-bg);color:var(--hr-fg);font:16px/1.7 system-ui,sans-serif}
.banner{margin:0 0 1rem;padding:.5rem .75rem;border-radius:.5rem;font-size:.9rem}
.banner.on{background:#e8f3e8}.banner.off{background:#f6e7e7}
</style>
</head>
<body>
${banner}
${body}
</body>
</html>
`;

/**
 * Documents inside a view are not trusted HTML: foreign files in the workspace can reach this path too. We reuse core's strongest
 * `import` sanitization (executable surface / event attributes / external resources / `data-hr-*` / inline styles all stripped),
 * plus two view-specific rules: `<style>` elements are deleted outright (document-level CSS would rewrite the whole view page),
 * and comments are deleted outright (comment data is not escaped and would serialize out verbatim).
 */
const sanitizeNode = (node: HtmlNode): HtmlNode | undefined => {
  if (node.kind === "comment") return undefined;
  if (node.kind === "element") {
    if (
      node.tag === "style" ||
      isDroppedNode(node, "import") ||
      hasExternalResource(node, "import")
    ) {
      return undefined;
    }
    return {
      ...node,
      attrs: sanitizedAttributesOf(node, "import"),
      children: sanitizedNodes(node.children),
    };
  }
  if (node.kind === "document") return { ...node, children: sanitizedNodes(node.children) };
  return node;
};

const sanitizedNodes = (nodes: readonly HtmlNode[]): HtmlNode[] =>
  nodes.flatMap((node) => {
    const kept = sanitizeNode(node);
    return kept === undefined ? [] : [kept];
  });

/** Sanitize the whole document tree before wrapping it in `<article>`: the executable/external/style surface is stripped; body structure stays as-is. */
const safeDocumentHtmlOf = (text: string): string =>
  sanitizedNodes([parseHtml(text).root])
    .map((node) => serializeHtml({ root: node, diagnostics: [] }))
    .join("");

/** No daemon is not an error (host UI should not lose the resource just because nothing runs in the background); **an unreadable document is** —
 * we used to return a "document unreadable" shell page, which is a fake success to the host (same family as lying with `unknown_style`). */
export const viewHtmlOf = async (target: DocumentTarget): Promise<string> => {
  const banner = daemonBanner(await daemonBaseUrlOf(homedir()));
  const text = await readInsideWorkspace(target);
  return PAGE(target.file, banner, `<article>${safeDocumentHtmlOf(text)}</article>`);
};
