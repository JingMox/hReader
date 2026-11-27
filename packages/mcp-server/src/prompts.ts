// This layer: `prompts/*`. `use-hreader-style` hands the host the full language spec compiled by core,
// not a one-line "please use style X"; the valid toneId set is computed at call time via `discoverStyles()` (no hardcoded enum).

import { compileTone, HrError, loadStyle } from "@hreader/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { styleIdsOf } from "./resources";
import { styleDepsOf } from "./style-deps";

export const USE_STYLE_PROMPT = "use-hreader-style";

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
};
