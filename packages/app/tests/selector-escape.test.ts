// 这层管：所有把 `data-hr-id` / `data-toc-id` 拼进 CSS 选择器的写点都必须过 `escapeAttr`。
// 恶意/损坏的 id（`"`、`]`、`\`）不能闭合选择器——未转义会让 `querySelector` 抛
// SyntaxError，更糟的是 `doc.changed` 事件的整条重载管线被那一次异常掐断。

import { describe, expect, it } from "vitest";

import { createDomHost } from "../src/dom.ts";
import { flashChanged } from "../src/flash.ts";
import { escapeAttr } from "../src/escape-attr.ts";
import { mountCanvas } from "../src/widgets/canvas.ts";
import { mountLibrary } from "../src/widgets/library.ts";
import { createFakeDocument, fakeElement } from "./support/fake-dom.ts";
import { createFakeHost, stateOf } from "./support/fake-host.ts";

const ROOT = "#hr-root";

/** 三个方向的攻击字符：闭合引号、闭合方括号、吃掉下一个字符的反斜杠。 */
const HOSTILE = 'a"b]c\\d';

const escaped = (id: string): string => `[data-hr-id="${escapeAttr(id)}"]`;

describe("selector 转义 · 拼进选择器的 id 必须过 escapeAttr", () => {
  it("should escape ids coming from the SSE changedNodes payload", () => {
    const fake = createFakeHost();
    flashChanged(fake.host, [HOSTILE], () => () => undefined);

    const selector = fake.calls.find((call) => call.op === "cls")?.args[0];
    expect(selector).toBe(escaped(HOSTILE));
  });

  it("should escape ids when the canvas toggles the active-block class", () => {
    const fake = createFakeHost();
    mountCanvas({
      host: fake.host,
      parent: ROOT,
      state: stateOf({ blocks: [] }),
      input: { html: "", themes: [] },
      onIntent: () => undefined,
    }).update(stateOf({ blocks: [HOSTILE], activeId: HOSTILE }));

    const selector = fake.calls.find(
      (call) => call.op === "cls" && String(call.args[0]).includes("data-hr-id"),
    )?.args[0];
    expect(selector).toBe(`${ROOT} ${escaped(HOSTILE)}`);
  });

  it("should escape toc ids when the library highlights and scrolls", () => {
    const fake = createFakeHost();
    mountLibrary(fake.host, ROOT, stateOf(), () => undefined).update(
      stateOf({ blocks: [HOSTILE], activeId: HOSTILE }),
    );

    const selector = fake.calls.find(
      (call) => call.op === "cls" && String(call.args[0]).includes("data-toc-id"),
    )?.args[0];
    expect(selector).toBe(`${ROOT} [data-toc-id="${escapeAttr(HOSTILE)}"]`);

    fake.fire(`${ROOT} #hr-toc`, "click", { tocId: HOSTILE });
    const scrolled = fake.calls.find((call) => call.op === "scrollTo")?.args[0];
    expect(scrolled).toBe(`${ROOT} ${escaped(HOSTILE)}`);
  });
});

describe("selector 转义 · dom host 的按 id 寻址", () => {
  const docWith = (selector: string) => {
    const doc = createFakeDocument();
    const element = fakeElement("p");
    doc.bySelector.set(selector, element);
    return { doc, element };
  };

  it("should reach the element whose id contains selector metachars in blockHtml", () => {
    const { doc, element } = docWith(escaped(HOSTILE));
    createDomHost(doc).blockHtml(HOSTILE, "<em>x</em>");
    expect(element.innerHTML).toBe("<em>x</em>");
  });

  it("should reach the element whose id contains selector metachars in removeBlock", () => {
    const { doc, element } = docWith(escaped(HOSTILE));
    let removed = false;
    const target = { ...element, remove: () => (removed = true) };
    doc.bySelector.set(escaped(HOSTILE), target);
    createDomHost(doc).removeBlock(HOSTILE);
    expect(removed).toBe(true);
  });
});
