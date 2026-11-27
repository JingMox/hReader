// This layer: decide whether a source exports as a foreign document, and build the plan
// Chrome renders it under — the capability-minted URL on the fake hreader origin, the
// /f/ serving verdicts shared with the server, and the network gate from effective
// permissions. No argv checks, no exit codes.
//
// Export is a one-shot snapshot of the rendered page, and document scripts NEVER run
// during it — not even for a doc holding a scripts grant. That grant exists for the
// interactive reader (an inert script tag printed by a snapshot would be a lying
// artifact); the browser-level kill switch in chrome/render.ts is the enforcement,
// and this layer only ever computes the network dimension.

import { basename, dirname, join, relative } from "node:path";

import {
  classifyDocument,
  createCapabilityBook,
  decodeParams,
  docAssetReply,
  effectiveOf,
  isInside,
  matchRoute,
  nodePatchDeps,
  nodeStyleDeps,
  paramOf,
  parseHtml,
  readDocGrant,
  readGlobalModes,
  resolveTarget,
  type FileSystem,
  type HandlerContext,
  type PatchDeps,
  type Reply,
  type ResolvedTarget,
} from "@hreader/core";

import type { ExportGateAnswer, ForeignPagePlan } from "../chrome/types";
import { readTextFile } from "../input";

/**
 * The origin the foreign page lives on during export. It is never resolved:
 * request interception fulfills every URL on it from the /f/ serving layer.
 * `.invalid` is RFC-2606 reserved, so even a gate bug that let the hostname
 * leak still fails closed at DNS rather than reaching a real machine.
 */
const EXPORT_ORIGIN = "http://hreader-export.invalid";

/** Schemes that reach a real socket: only ever continued for a network-granted page. */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Requests that touch no socket: inline `data:`/`blob:` resources and `about:`.
 * The CSP already bounds what these may carry; counting them as "network" would
 * deny pages whose every asset is inline.
 */
const INLINE_SCHEMES: ReadonlySet<string> = new Set(["data:", "blob:", "about:"]);

const DENY: ExportGateAnswer = { kind: "deny" };
const ALLOW: ExportGateAnswer = { kind: "allow" };

/**
 * D41: export is read-only — every store access the plan performs runs on
 * this fs facade, whose write verbs always reject. The one write a read can
 * reach is `readDocGrant`'s lazy legacy migration (locks/trust.lock plus a
 * rewritten trust.json); that write already fails soft inside `readDocGrant`,
 * so the grant still resolves — it just never lands on disk.
 */
// Stryker disable next-line ArrowFunction,StringLiteral: a no-op or message-less rejection crashes the same write verbs a hop later — the "nothing lands on disk" oracle cannot tell the two apart.
const writeDenied = (): Promise<never> => Promise.reject(new Error("export is read-only"));

const readOnlyFs: FileSystem = {
  readFile: nodePatchDeps.fs.readFile,
  lstat: nodePatchDeps.fs.lstat,
  readdir: nodePatchDeps.fs.readdir,
  realpath: nodePatchDeps.fs.realpath,
  writeFile: writeDenied,
  writeFileAtomic: writeDenied,
  rename: writeDenied,
  unlink: writeDenied,
  mkdir: writeDenied,
  open: writeDenied,
  close: writeDenied,
};

const readOnlyDeps: PatchDeps = { ...nodePatchDeps, fs: readOnlyFs };

/**
 * Uniform 404 for anything on the export origin that is not the /f/ route —
 * the same answer doc-assets gives every failure (no existence oracle).
 */
const NOT_FOUND: Reply = {
  status: 404,
  headers: {
    "access-control-allow-origin": "null",
    "x-content-type-options": "nosniff",
    "content-type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({ code: "not_found" }),
};

/**
 * The serving half of the gate: only the /f/ route exists on the export
 * origin, and it answers exactly what the server's doc-assets route would —
 * cap lookup, directory scope, extension whitelist, the doc's own permission
 * CSP. Everything else is the same uniform 404.
 */
const serveOf = (ctx: HandlerContext, method: string, pathname: string): Promise<Reply> => {
  const lookup = matchRoute(method, pathname);
  // Stryker disable next-line ConditionalExpression: any other route shape still yields no cap param, so the answer is the same uniform 404.
  if (lookup.kind === "route" && lookup.route.kind === "docAsset") {
    const decoded = decodeParams(lookup.params);
    if (!decoded.ok) return Promise.resolve(NOT_FOUND);
    return docAssetReply(
      ctx,
      // Stryker disable next-line StringLiteral: docAsset's grammar always binds cap and path — the defaults exist only for the type signature.
      paramOf(decoded.params, "cap", ""),
      // Stryker disable next-line StringLiteral: docAsset's grammar always binds cap and path — the defaults exist only for the type signature.
      paramOf(decoded.params, "path", ""),
    );
  }
  return Promise.resolve(NOT_FOUND);
};

/**
 * An outside-workspace source is a legitimate export input (`hr pdf` reads
 * anywhere), but it can hold no per-document grant — a grant anchors to the
 * exporting workspace's `.hreader/` (D39). The capability still needs a
 * target to bind, so root one at the doc's own directory: the /f/ scope is
 * the same directory either way. The store anchor is the void path *under
 * the document file*: nothing can live under a regular file, so the grant
 * table is empty by construction — a `trust.json` planted beside the doc is
 * never read, and the lazy migration can never write there either.
 */
const exportTargetOf = async (path: string, workspace: string): Promise<ResolvedTarget> => {
  const realPath = await readOnlyFs.realpath(path);
  const workspaceReal = await readOnlyFs.realpath(workspace);
  if (isInside(workspaceReal, realPath)) {
    return resolveTarget(
      { workspace: workspaceReal, file: relative(workspaceReal, realPath) },
      readOnlyFs,
    );
  }
  const dir = dirname(realPath);
  const name = basename(realPath);
  // Stryker disable next-line StringLiteral: any child of the document file is equally un-plantable — "" resolves to realPath itself, which is just as dead.
  const voidStoreDir = join(realPath, ".hreader");
  return {
    realPath,
    relative: name,
    workspace: dir,
    storeDir: voidStoreDir,
    // Stryker disable next-line StringLiteral: ResolvedTarget requires the field but the export serve path never locks — reads only.
    lockPath: join(voidStoreDir, "locks", "export.lock"),
  };
};

export interface ForeignPlanInput {
  /** Absolute path of the source document. */
  readonly path: string;
  /** The resolved workspace root — grants anchor to its `.hreader/trust.json`. */
  readonly workspace: string;
  /** User config root: `<home>/.hreader/permissions.json` holds the global modes. */
  readonly home: string;
}

/**
 * `undefined` = not foreign — managed/normalizable docs keep the print-sheet
 * path byte-for-byte. A defined plan means: navigate to the capability URL,
 * answer /f/ requests with the shared doc-assets verdicts, and gate the
 * network by the document's effective permissions.
 */
export const foreignPlanOf = async (
  input: ForeignPlanInput,
): Promise<ForeignPagePlan | undefined> => {
  const html = await readTextFile(input.path);
  if (classifyDocument(parseHtml(html)).cls !== "foreign") return undefined;
  const target = await exportTargetOf(input.path, input.workspace);
  const ctx: HandlerContext = {
    workspace: input.workspace,
    // No reader app exists during export — only /f/ is served, and it never
    // reaches for appDir or styleDeps.
    // Stryker disable next-line StringLiteral: appDir is unused on the /f/ serving path — nothing reads it.
    appDir: "",
    home: input.home,
    deps: readOnlyDeps,
    styleDeps: nodeStyleDeps(input.workspace),
    caps: createCapabilityBook(),
  };
  // Same stores the server's documentServeOf resolves — one read per export;
  // documentServeOf re-reads them when it stamps the doc's CSP, keeping the
  // answer identical to the reader's.
  const bytes = await readOnlyFs.readFile(target.realPath);
  const [modes, grant] = await Promise.all([
    readGlobalModes(input.home, readOnlyDeps),
    readDocGrant({ target, bytes }, readOnlyDeps),
  ]);
  const network = effectiveOf(modes, grant).network;
  return {
    url: `${EXPORT_ORIGIN}${ctx.caps.frameUrlOf(target)}`,
    docName: basename(target.realPath),
    gate: async (rawUrl, method) => {
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return DENY;
      }
      // `origin` is also http://hreader-export.invalid for `blob:<export-url>`
      // — those are Chrome-internal fetches off the page's blob store, so they
      // continue like any other inline scheme rather than hitting /f/.
      if (
        // Stryker disable next-line ConditionalExpression,StringLiteral: `https:` is unreachable inside this conjunction — the origin pin already forces `http:` — it only exists for a future scheme change.
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin === EXPORT_ORIGIN
      ) {
        return { kind: "serve", reply: await serveOf(ctx, method, parsed.pathname) };
      }
      if (INLINE_SCHEMES.has(parsed.protocol)) return ALLOW;
      if (NETWORK_SCHEMES.has(parsed.protocol)) return network ? ALLOW : DENY;
      return DENY;
    },
  };
};
