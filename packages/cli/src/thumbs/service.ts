// This layer: the thumbnail renderer both hosts share — `hr serve` injects it as
// `ServerOptions.thumb`, `hr thumb` calls it directly. Pipeline: cache hit ->
// queue single-flight -> source build (foreign plan or managed print sheet) ->
// Chrome session -> cache put. Nothing here knows argv or HTTP; both hosts wire
// env/stop/warn at the composition boundary.

import { join } from "node:path";

import { nodePatchDeps, type PatchDeps, type ThumbRender } from "@hreader/core";

import type { ChromeDeps } from "../chrome/process";
import { chromeDepsOf, renderThumbOf } from "../chrome/session";
import type { RenderSource } from "../chrome/types";
import { foreignPlanOf } from "../commands/export-foreign";
import { printProductOf } from "../commands/export-print";
import { createThumbCache, type ThumbCache } from "./cache";
import { createRenderQueue, type RenderQueue } from "./queue";

/** The cache anchors at the workspace the server/command runs against: `<workspace>/.hreader/thumbs/`. */
const THUMB_CACHE_DIR = join(".hreader", "thumbs");

/** Same render deadline as the export commands' default (`--timeout 60`). */
export const THUMB_TIMEOUT_MS = 60_000;

/** Session-level seam: one Chrome session for the source — tests substitute bytes, never a browser. */
export type ThumbSession = (source: RenderSource) => Promise<Uint8Array>;

interface ThumbServiceInput {
  /** The resolved workspace root: cache anchor + permission-store root for foreign docs. */
  readonly workspace: string;
  /** User config root for the foreign-doc permission lookup (`HREADER_HOME` semantics). */
  readonly home: string;
  /** Chrome discovery env (`HREADER_CHROME`); the spawned browser inherits `HOME` itself. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Interrupt handle: serve passes its SIGTERM/SIGINT promise; one-shot commands pass a never-settling one. */
  readonly stop: Promise<void>;
  readonly timeoutMs: number;
  /** Non-fatal notices (print sheet drops external images); serve routes it to stderr. */
  readonly warn: (message: string) => void;
  /** Print-sheet theme for managed docs (`--visual`); `undefined` = the document's embedded theme, default theme when it has none. Serve leaves it unset. */
  readonly visual?: string | undefined;
  /** Injectable seams for tests: fs port, Chrome deps, session render, queue, cache — Chrome never starts in unit tests. */
  readonly deps?: PatchDeps;
  /** Chrome spawn/discovery override — real-Chrome tests route it through leak-guard; `render` short-circuits the session entirely. */
  readonly chromeDeps?: ChromeDeps;
  readonly render?: ThumbSession;
  readonly queue?: RenderQueue;
  readonly cache?: ThumbCache;
}

/**
 * Per request: cache hit wins; a miss queues one generation per (doc,hash).
 * Inside the queue the cache is re-checked — a same-hash request that waited
 * behind another generation finds the bytes already written (cross-process
 * wins too: `hr thumb` may have filled the entry while a request queued).
 * A failed generation writes nothing: partial entries can never be served.
 */
export const createThumbRender = (input: ThumbServiceInput): ThumbRender => {
  const deps = input.deps ?? nodePatchDeps;
  const queue = input.queue ?? createRenderQueue();
  const cache =
    input.cache ?? createThumbCache({ dir: join(input.workspace, THUMB_CACHE_DIR), deps });
  const render: ThumbSession =
    input.render ??
    (async (source) =>
      (
        await renderThumbOf({
          source,
          timeoutMs: input.timeoutMs,
          stop: input.stop,
          deps: input.chromeDeps ?? chromeDepsOf(input.env),
        })
      ).bytes);
  return async (request) => {
    const cached = await cache.get(request.hash);
    if (cached !== undefined) return cached;
    return await queue.submit(request.hash, async () => {
      const again = await cache.get(request.hash);
      if (again !== undefined) return again;
      const foreign = await foreignPlanOf({
        path: request.path,
        workspace: input.workspace,
        home: input.home,
      });
      const source: RenderSource =
        foreign !== undefined
          ? { kind: "foreign", page: foreign }
          : {
              kind: "sheet",
              html: (
                await printProductOf({
                  path: request.path,
                  visual: input.visual,
                  // Tall images lay out at A4 content width; thumbnails keep the same convention (the 1200px viewport then decides the fold).
                  paper: "a4",
                  workspace: input.workspace,
                  warn: input.warn,
                })
              ).html,
            };
      const bytes = await render(source);
      await cache.put(request.hash, bytes);
      return bytes;
    });
  };
};
