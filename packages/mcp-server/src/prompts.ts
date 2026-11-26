// 这层管：`prompts/*`。`use-hreader-style` 把 core 编译出的完整语言规约交给宿主，
// 而不是一句"请用 X 风格"；toneId 的合法集合在调用时按 `discoverStyles()` 现算（不硬编码枚举）。

import { compileTone, HrError, loadStyle } from "@hreader/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { styleIdsOf } from "./resources";
import { styleDepsOf } from "./style-deps";

export const USE_STYLE_PROMPT = "use-hreader-style";

const stylised = async (toneId: string, workspace: string): Promise<string> => {
  const ids = await styleIdsOf(workspace);
  if (!ids.includes(toneId)) {
    // 文案必须把"查了哪些源"写出来：内置预设是 TS 常量（不在 styles/ 里），漏掉它会让人以为只有盘上两份。
    throw new HrError(
      "unknown_style",
      `未知 toneId：${toneId}；已查内置预设、~/.hreader/styles、仓库 styles/；当前可用：${ids.join("、")}`,
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
