// 这层管：`hr_apply_style`（换视觉 / 取调性规约）；CSS 注入与规约编译都在 core。

import { applyStyle, compileTone, HrError, loadStyle, nodeStyleDeps } from "@hreader/core";
import type { ApplyStyleResult } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { documentTargetOf } from "./target";

export const applyStyleShape = {
  filePath: z
    .string()
    .min(1)
    .describe("要换肤的 HTML 文档路径（工作区内，相对当前目录或绝对路径）"),
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
    : applyStyle({ workspace, file, visualId: args.visualId }, nodeStyleDeps(workspace));

const toneOf = async (toneId: string, workspace: string): Promise<string> =>
  compileTone((await loadStyle({ id: toneId }, nodeStyleDeps(workspace))).spec);

export const applyStyleCall = (args: ApplyStyleArgs): Promise<CallToolResult> =>
  guarded("hr_apply_style", async () => {
    if (args.visualId === undefined && args.toneId === undefined) {
      throw new HrError("invalid_input", "visualId 与 toneId 至少要给一个");
    }
    const target = documentTargetOf(args.filePath, process.cwd());
    const outcome: StyleOutcome = {
      visual: await visualOf(args, target.workspace, target.file),
      tone: args.toneId === undefined ? undefined : await toneOf(args.toneId, target.workspace),
    };
    return okResult(outcome);
  });
