// 这层管：`hr_apply_style`（换视觉 / 取调性规约）；CSS 注入与规约编译都在 core。

import { applyStyle, compileTone, HrError, loadStyle } from "@hreader/core";
import type { ApplyStyleResult } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { foldedOf, guarded, okResult } from "../errors";
import { styleDepsOf } from "../style-deps";
import { FILE_PATH_HINT, coreFailureOf, documentTargetOf } from "./target";

export const applyStyleShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
  visualId: z
    .string()
    .min(1)
    .optional()
    .describe('视觉风格 id：只换 `<style id="hr-theme">` 的内容，不动正文'),
  toneId: z
    .string()
    .min(1)
    .optional()
    .describe("调性 id：返回这份风格完整的语言规约（Markdown），写稿前读它，不改文件"),
};

type ApplyStyleArgs = z.infer<z.ZodObject<typeof applyStyleShape>>;

interface StyleOutcome {
  readonly visual: ApplyStyleResult | undefined;
  readonly tone: string | undefined;
}

const visualOf = async (
  args: ApplyStyleArgs,
  workspace: string,
  file: string,
): Promise<ApplyStyleResult | undefined> =>
  args.visualId === undefined
    ? undefined
    : applyStyle({ workspace, file, visualId: args.visualId }, styleDepsOf(workspace));

const toneOf = async (toneId: string, workspace: string): Promise<string> => {
  // 风格解析的文案来自 core：绝对路径在这个出口折掉（用户传的 `filePath` 不经过这里）。
  const loaded = await loadStyle({ id: toneId }, styleDepsOf(workspace)).catch((error: unknown) => {
    throw foldedOf(error);
  });
  return compileTone(loaded.spec);
};

export const applyStyleCall = (args: ApplyStyleArgs): Promise<CallToolResult> =>
  guarded("hr_apply_style", async () => {
    if (args.visualId === undefined && args.toneId === undefined) {
      throw new HrError("invalid_input", "visualId 与 toneId 至少要给一个");
    }
    const target = documentTargetOf(args.filePath, process.cwd());
    const outcome: StyleOutcome = {
      visual: await visualOf(args, target.workspace, target.file).catch((error: unknown) => {
        throw coreFailureOf(error, target);
      }),
      tone: args.toneId === undefined ? undefined : await toneOf(args.toneId, target.workspace),
    };
    return okResult(outcome);
  });
