// 这层管：MCP-UI 视图资源（`ui://hreader/view/{docId}`）。docId 由相对路径可逆编码，
// 服务重启后同一个 URI 仍能读出同一份文档；视图只**引用**已跑的 daemon，不代管进程。

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

/** 解不回来就 `undefined`：这是 URI 解析，不是路径校验层，坏 id 一律走"视图已失效"页。 */
export const relativePathOfDocId = (docId: string): string | undefined => {
  const decoded = Buffer.from(docId, "base64url").toString("utf8");
  const segments = decoded.split("/");
  if (decoded.length === 0 || segments.some((one) => one === "" || one === "..")) return undefined;
  return decoded;
};

/** daemon 的端口只从 core 的落点文件读：写死端口会让视图在换端口后指向空气。 */
const portOf = (value: unknown): number | undefined => {
  if (typeof value !== "object" || value === null || !("port" in value)) return undefined;
  const { port } = value;
  return typeof port === "number" ? port : undefined;
};

/** 本仓唯一一处 `~/.hreader/daemon.json` 路径拼写：core 只导出 `startServer`，未导出 `daemonStatePath()`
 * （`daemonFileOf` 收在 `core/src/server/index.ts`，不在包入口）；core 若日后导出即改为引用。
 * 视图只读这个落点拿端口，不写它。 */
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
 * 视图里的文档不是可信 HTML：工作区里的外来文件也能走到这里。复用 core 最强的
 * `import` 清洗口径（可执行面/事件属性/外链资源/`data-hr-*`/内联样式全剥），
 * 再加两道视图特有规则：`<style>` 元素整删（文档级 CSS 会改写整个视图页）、
 * 注释整删（注释 data 不转义，串行化会原样放出）。
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

/** 文档整树净化后再包 `<article>`：剥掉的是可执行/外链/样式面，正文结构原样留下。 */
const safeDocumentHtmlOf = (text: string): string =>
  sanitizedNodes([parseHtml(text).root])
    .map((node) => serializeHtml({ root: node, diagnostics: [] }))
    .join("");

/** 无 daemon 不是错误（宿主 UI 不该因为后台没开就拿不到资源）；**文档读不出来才是**——
 * 以前回一页"文档不可读"的壳，对宿主是假成功（跟 `unknown_style` 撒谎同类）。 */
export const viewHtmlOf = async (target: DocumentTarget): Promise<string> => {
  const banner = daemonBanner(await daemonBaseUrlOf(homedir()));
  const text = await readInsideWorkspace(target);
  return PAGE(target.file, banner, `<article>${safeDocumentHtmlOf(text)}</article>`);
};
