// 这层管：`parentElementOf` 的**防御分支**——目标不在树里时返回 `undefined`，而不是抛错或返回错的人。
//
// 不是症状覆盖：`applyPatch` 只在定位成功后才问父容器，正常路径走不到这里；
// 但它决定了"父容器判定"在退化输入下的行为（返回空 = 由调用方决定怎么报），所以单独钉住。

import { describe, expect, it } from "vitest";

import { parseHtml } from "../../src/html/parse";
import { parentElementOf } from "../../src/ops/patchNode/locate";

describe("parentElementOf · 找不到父元素", () => {
  it("should return undefined when the child is not in the tree at all", () => {
    const root = parseHtml("<article><p>x</p></article>").root;
    const orphan = { kind: "element", tag: "p", attrs: [], children: [] } as const;

    // 找不到就返回空：拿"最近的外层元素"顶上会让 `replace` 把片段插到不相干的位置。
    expect(parentElementOf(root, orphan)).toBeUndefined();
  });
});

describe("parentElementOf · 父节点不是元素", () => {
  it("should return undefined when the parent is the document node", () => {
    const child = { kind: "element", tag: "article", attrs: [], children: [] } as const;
    const root = { kind: "document", children: [child] } as const;

    // 父是 document 时没有"容器元素"可判：返回空，让调用方自己决定怎么报，而不是把 document 当容器。
    expect(parentElementOf(root, child)).toBeUndefined();
  });
});
