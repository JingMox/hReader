// This layer: `hr_undo` (revert the most recent write); snapshot chain, hash check, atomic restore, and error-code mapping are all in core's `revertLast`.

import { nodePatchDeps, revertLast } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { docIdOf, UI_URI_PREFIX } from "../ui";
import { FILE_PATH_HINT, coreFailureOf, documentTargetOf } from "./target";

export const undoShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
};

type UndoArgs = z.infer<z.ZodObject<typeof undoShape>>;

/**
 * What to pass as the third argument is decided here, once.
 * Not passed → core's default `{ lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS = 2000 }`.
 * We do not copy HTTP's `LOCK_WAIT_MS` (`server/handlers.ts:49`, 5000): it is not on core's public surface (`index.ts` only exports
 * `nodePatchDeps`/`patchFile`/`undoPatch`), so copying the number would be a second spelling of one fact; more importantly **two tools on the
 * same file must share one source** — `hr_patch_node` uses the default, and an undo waiting 5000 while patch waits 2000 would fork concurrency semantics.
 * 2000ms ≥ the lock's real hold time, so concurrent serialization still holds.
 */
export const undoCall = (args: UndoArgs): Promise<CallToolResult> =>
  guarded("hr_undo", async () => {
    const target = documentTargetOf(args.filePath, process.cwd());
    const result = await revertLast(
      { workspace: target.workspace, file: target.file },
      nodePatchDeps,
    ).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult(result, { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } });
  });
