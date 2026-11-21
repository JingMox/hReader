// 这层管：块 HTML → 纯文本（`c` 键的整块锚点、diff 的 after）。标签只在这里被剥一次，
// 因此 `main.ts` 保持"只做组装"（M2.2 max-lines 教训）。

import type { Host } from "../dom.ts";

export const textOfBlocks = (
  host: Host,
  documentHtml: string | (() => string),
): ((id: string) => string | undefined) => {
  const readHtml = typeof documentHtml === "function" ? documentHtml : () => documentHtml;
  let lastHtml: string | undefined;
  let blocks: ReadonlyMap<string, string> = new Map();
  return (id) => {
    const html = readHtml();
    if (html !== lastHtml) {
      blocks = host.blocks(html);
      lastHtml = html;
    }
    const markup = blocks.get(id);
    return markup === undefined
      ? undefined
      : markup
          .replace(/<[^>]*>/gu, " ")
          .replace(/\s+/gu, " ")
          .trim();
  };
};
