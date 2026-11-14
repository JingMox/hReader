// 可见性判据（P0-1 的回归网）：模板的**初始** hidden 状态从文件读，
// 后续状态用假 Host 记录的 `attr(…, "hidden", …)` 调用序列回放——
// 真实浏览器里"按钮看得见"等价于这个属性被摘掉，不是"有人 fire 过 click"。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FakeHost } from "./fake-host.ts";

const TEMPLATE = readFileSync(join(import.meta.dirname, "..", "..", "static/index.html"), "utf8");

/** 模板里该 id 的元素是否带 `hidden`（没有这个元素也算隐藏：点不到）。 */
export const templateHiddenOf = (id: string): boolean => {
  const tag = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(TEMPLATE)?.[0];
  return tag === undefined || /\shidden(?:\s|=|>)/.test(tag);
};

/** 回放 `attr(…, "hidden", …)`：值 `<removed>` 表示摘掉，其余表示挂上。 */
export const hiddenOf = (fake: FakeHost, id: string): boolean =>
  fake.calls
    .filter((call) => call.op === "attr" && call.args[0]?.endsWith(`#${id}`) === true)
    .filter((call) => call.args[1] === "hidden")
    .reduce((_previous, call) => call.args[2] !== "<removed>", templateHiddenOf(id));
