// 这层管：块 HTML → 纯文本（`c` 键的整块锚点、diff 的 after）。标签只在这里被剥一次，
// 因此 `main.ts` 保持"只做组装"（M2.2 max-lines 教训）。

import type { Host } from "../dom.ts";

export const textOfBlocks = (
  host: Host,
  documentHtml: string,
): ((id: string) => string | undefined) => {
  const blocks = host.blocks(documentHtml);
  return (id) => {
    const markup = blocks.get(id);
    return markup === undefined
      ? undefined
      : markup
          .replace(/<[^>]*>/gu, " ")
          .replace(/\s+/gu, " ")
          .trim();
  };
};
