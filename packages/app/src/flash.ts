// 这层管：`doc.changed` 后"改动块闪一下"——只往 DOM 加/删一个类，2 秒后由**注入的** timer 收回。
// 纯接线：`schedule` 由 `boot` 注入（真实现是 `setTimeout`），因此这里可测且没有全局。

import type { Host } from "./dom.ts";
import { escapeAttr } from "./escape-attr.ts";

/** 闪烁时长：2 秒。 */
const FLASH_MS = 2000;

const FLASH_CLASS = "hr-flash";

export type Schedule = (ms: number, run: () => void) => () => void;

/** `doc.changed` 载荷里的 `changedNodes`：只认字符串数组，任何偏差都当空（脏载荷不白屏）。 */
export const changedNodesOf = (raw: unknown): readonly string[] => {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const nodes: unknown = Reflect.get(parsed, "changedNodes");
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((item): item is string => typeof item === "string" && item !== "");
};

/** 给每个块加类，`FLASH_MS` 后逐个收回；返回的 cancel 供 destroy/测试使用。 */
export const flashChanged = (
  host: Host,
  ids: readonly string[],
  schedule: Schedule,
): (() => void) => {
  const cancels = ids.map((id) => {
    const selector = `[data-hr-id="${escapeAttr(id)}"]`;
    host.cls(selector, FLASH_CLASS, true);
    return schedule(FLASH_MS, () => {
      host.cls(selector, FLASH_CLASS, false);
    });
  });
  return () => {
    for (const cancel of cancels) cancel();
  };
};
