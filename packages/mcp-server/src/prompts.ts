// This layer: `prompts/*`. `use-hreader-style` hands the host the full language spec compiled by core,
// not a one-line "please use style X"; the valid toneId set is computed at call time via `discoverStyles()` (no hardcoded enum).

import { compileTone, HrError, loadStyle } from "@hreader/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { styleIdsOf } from "./resources";
import { styleDepsOf } from "./style-deps";

export const USE_STYLE_PROMPT = "use-hreader-style";

export const EXTRACT_TEMPLATE_PROMPT = "extract-template";

/** The agent-facing recipe is English (same language as the guide/style payloads it produces); the 1–5 sample paths arrive as prompt args. */
const extractTemplateText = (
  file1: string,
  rest: readonly string[],
  id: string,
  global: string | undefined,
): string => {
  const files = [file1, ...rest];
  const samples = files.map((file, index) => `${String(index + 1)}. ${file}`).join("\n");
  return `You are extracting a reusable hReader template from ${String(files.length)} sample page(s):

${samples}

Steps:
1. For each sample, call \`hr_outline\` to see its structure, then \`hr_read_node\` on the sections that look representative. Note what the samples share: heading skeleton, section order, recurring \`data-hr-component\` usages, and tone.
2. Distill the shared visual rules into a \`style\` body: selectors keyed by \`data-hr-component\` / \`data-hr-kind\` and CSS custom properties for the palette. The style must stay offline self-contained — no \`@import\`, no external URLs, and no \`<\` characters.
3. Distill the shared structure and writing rules into a \`guide\` draft: which sections are required and in what order, how long each should be, tone and vocabulary conventions, and which components to reuse.
4. Call \`hr_save_template\` with:
   - \`file\`: "${file1}" (or the most representative sample)
   - \`id\`: "${id}"
   - \`global\`: ${global === "true" ? "true" : "false"}
   - \`style\` / \`guide\`: the bodies you derived (omit either field to keep the auto-extracted value)
5. Verify with \`hr_get_template { "id": "${id}" }\`, then create a probe page via \`hr_create_from_template\` and check that it reproduces the shared shape.`;
};

const stylised = async (toneId: string, workspace: string): Promise<string> => {
  const ids = await styleIdsOf(workspace);
  if (!ids.includes(toneId)) {
    // The text must spell out which sources were searched: builtin presets are TS constants (not in themes/), and omitting them makes it look like only the on-disk pair exists.
    throw new HrError(
      "unknown_style",
      `未知 toneId：${toneId}；已查内置预设、~/.hreader/styles、内置 themes/；当前可用：${ids.join("、")}`,
    );
  }
  const loaded = await loadStyle({ id: toneId }, styleDepsOf(workspace));
  return compileTone(loaded.spec);
};

export const registerPrompts = (server: McpServer, workspace: string): void => {
  server.registerPrompt(
    USE_STYLE_PROMPT,
    {
      title: "按 hreader 风格写稿",
      description:
        "取一份风格的完整语言规约（人设/叙事规则/句律/词表/例句），写稿前先读它。可用 toneId 见 resources/list 的 `hreader://styles/{id}`",
      argsSchema: {
        toneId: z.string().min(1).describe("风格 id，例如 sharp-reviewer"),
      },
    },
    async ({ toneId }) => ({
      messages: [
        { role: "user", content: { type: "text", text: await stylised(toneId, workspace) } },
      ],
    }),
  );
  server.registerPrompt(
    EXTRACT_TEMPLATE_PROMPT,
    {
      title: "从样例页面提取模板",
      description:
        "读 1–5 篇样例页面，归纳出共享的 style.css 与 guide.md 规则并调 hr_save_template 存成模板",
      argsSchema: {
        file1: z.string().min(1).describe("样例页面路径（工作区相对或工作区内绝对路径）"),
        file2: z.string().min(1).optional().describe("样例页面 2（可选）"),
        file3: z.string().min(1).optional().describe("样例页面 3（可选）"),
        file4: z.string().min(1).optional().describe("样例页面 4（可选）"),
        file5: z.string().min(1).optional().describe("样例页面 5（可选）"),
        id: z.string().min(1).describe("新模板 id（小写 kebab-case）"),
        global: z
          .string()
          .optional()
          .describe('传 "true" 存到用户层 ~/.hreader/templates，缺省存工作区层'),
      },
    },
    ({ file1, file2, file3, file4, file5, id, global }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: extractTemplateText(
              file1,
              [file2, file3, file4, file5].filter((file): file is string => file !== undefined),
              id,
              global,
            ),
          },
        },
      ],
    }),
  );
};
