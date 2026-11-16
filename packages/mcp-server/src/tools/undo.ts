// 这层管：`hr_undo`（撤销最近一次写）；快照链、哈希校验、原子还原、错误码映射全在 core 的 `revertLast`。

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
 * D8：第三参传什么由这里定死。
 * 不传 → core 的默认 `{ lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS = 2000 }`。
 * 不抄 HTTP 的 `LOCK_WAIT_MS`（`server/handlers.ts:49`，5000）：它不在 core 的公开面上（`index.ts` 只导出
 * `nodePatchDeps`/`patchFile`/`undoPatch`），抄数字就是同一事实的第二份拼写；更重要的是**同一个文件上
 * 两个工具必须同源**——`hr_patch_node` 用的就是默认值，undo 等 5000 而 patch 等 2000 会让并发语义分叉。
 * 2000ms ≥ 锁的实际持有时长，AC-4 的串行化照样成立。
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
