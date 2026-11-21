// 这层管：纯层 `ops/patchNode` 的五种 action 与请求边界（直接 import 纯函数，不经过 io）；不测落盘。

import { describe, expect, it } from "vitest";

import type { PatchOutcome, PatchRequest } from "../../src/ops/patchNode";
import { applyPatch } from "../../src/ops/patchNode";
import { attrValues, childIds, childTags, countOf, elementById, found, textIn } from "./tree-probe";

const DOC = [
  '<article data-hr-id="root" class="post" lang="zh-CN" data-site="hr">',
  '  <h2 data-hr-id="h1">标题</h2>',
  '  <section data-hr-id="empty"></section>',
  '  <section data-hr-id="box"><p data-hr-id="p0">零</p></section>',
  '  <p data-hr-id="p1" class="lead">第一段</p>',
  '  <p data-hr-id="p2">第二段</p>',
  "</article>",
].join("\n");

const ROOT_ATTRS = [
  ["data-hr-id", "root"],
  ["class", "post"],
  ["lang", "zh-CN"],
  ["data-site", "hr"],
] as const;

const onlyNewId = (outcome: PatchOutcome): string => {
  const [id] = outcome.newIds;
  if (id === undefined || outcome.newIds.length !== 1) {
    throw new Error(`期望恰好一个新 ID，实际 ${JSON.stringify(outcome.newIds)}`);
  }
  return id;
};

const patch = (request: PatchRequest, html = DOC): PatchOutcome => applyPatch(html, request);

/** 绕过类型层的"非法请求"入口：`action` 与 `html` 都要能传错值才测得到运行时校验。 */
const patchUnchecked = (request: unknown, html = DOC): unknown =>
  Reflect.apply(applyPatch, undefined, [html, request]);

const codeOf = (request: unknown, html = DOC): string => {
  try {
    patchUnchecked(request, html);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    return typeof code === "string" ? code : "no_code";
  }
  return "no_throw";
};

describe("insert_after / insert_before · 兄弟位置", () => {
  it("should place the fragment right after the target as a sibling, not a child", () => {
    const outcome = patch({ targetId: "p1", action: "insert_after", html: "<p>新段落</p>" });
    const id = onlyNewId(outcome);

    expect(outcome.changed).toBe(true);
    expect(childIds(outcome.html, "root")).toEqual(["h1", "empty", "box", "p1", id, "p2"]);
    expect(childIds(outcome.html, id)).toEqual([]);
    expect(childTags(outcome.html, id)).toEqual([]);
    expect(textIn(outcome.html, id)).toBe("新段落");
  });

  it("should place the fragment right before the last child", () => {
    const outcome = patch({ targetId: "p2", action: "insert_before", html: "<h3>标题三</h3>" });
    const id = onlyNewId(outcome);

    expect(childIds(outcome.html, "root")).toEqual(["h1", "empty", "box", "p1", id, "p2"]);
    expect(found(elementById(outcome.html, id), `#${id}`).chain.at(-1)?.tag).toBe("article");
    expect(countOf(outcome.html, "h3")).toBe(1);
  });
});

describe("append · 目标子节点末尾", () => {
  it("should append into an empty block element", () => {
    const outcome = patch({ targetId: "empty", action: "append", html: "<p>追加</p>" });
    const id = onlyNewId(outcome);

    expect(childIds(outcome.html, "empty")).toEqual([id]);
    expect(childTags(outcome.html, "empty")).toEqual(["p"]);
    expect(textIn(outcome.html, "empty")).toBe("追加");
    expect(childIds(outcome.html, "root")).toEqual(["h1", "empty", "box", "p1", "p2"]);
  });

  it("should append after the existing children of a non-empty target", () => {
    const outcome = patch({ targetId: "box", action: "append", html: "<p>尾巴</p>" });
    const id = onlyNewId(outcome);

    expect(childIds(outcome.html, "box")).toEqual(["p0", id]);
    expect(textIn(outcome.html, "box")).toBe("零尾巴");
  });
});

describe("delete · 节点移除", () => {
  it("should remove the target and allocate no new id", () => {
    const outcome = patch({ targetId: "p1", action: "delete" });

    expect(outcome.changed).toBe(true);
    expect(outcome.newIds).toEqual([]);
    expect(childIds(outcome.html, "root")).toEqual(["h1", "empty", "box", "p2"]);
    expect(elementById(outcome.html, "p1")).toBeUndefined();
    expect(countOf(outcome.html, "p")).toBe(2);
  });
});

describe("replace · 内容相同即幂等", () => {
  it("should report changed:false and return the input unchanged for identical content", () => {
    const outcome = patch({
      targetId: "p1",
      action: "replace",
      html: '<p data-hr-id="p1" class="lead">第一段</p>',
    });

    expect(outcome.changed).toBe(false);
    expect(outcome.newIds).toEqual([]);
    expect(outcome.html).toBe(DOC);
  });

  it("should swap the subtree but keep the target's own id when content differs", () => {
    // docs/05:57（M1.1 AC2「id 归产品所有」）：`replace` 的新根**继承目标自己的 id**，换内容不换锚点。
    const outcome = patch({ targetId: "p1", action: "replace", html: "<p>换掉</p>" });

    expect(outcome.changed).toBe(true);
    expect(outcome.newIds).toEqual([]);
    expect(outcome.replacedIds).toEqual([]);
    expect(childIds(outcome.html, "root")).toEqual(["h1", "empty", "box", "p1", "p2"]);
    expect(textIn(outcome.html, "p1")).toBe("换掉");
  });
});

describe("root 目标 · <article> 自身与属性", () => {
  it("should append inside <article> and keep every attribute", () => {
    const outcome = patch({ targetId: "root", action: "append", html: "<p>尾</p>" });
    const id = onlyNewId(outcome);

    expect(attrValues(outcome.html, "root")).toEqual(ROOT_ATTRS);
    expect(childIds(outcome.html, "root")).toEqual(["h1", "empty", "box", "p1", "p2", id]);
  });

  it("should replace all children but keep <article> and its attributes", () => {
    const outcome = patch({ targetId: "root", action: "replace", html: "<p>唯一</p>" });
    const id = onlyNewId(outcome);

    expect(attrValues(outcome.html, "root")).toEqual(ROOT_ATTRS);
    expect(childIds(outcome.html, "root")).toEqual([id]);
    expect(elementById(outcome.html, "h1")).toBeUndefined();
  });
});

describe("root 目标 · 幂等判定与拒绝", () => {
  it("should be idempotent for a compact document with identical content", () => {
    const compact = '<article data-hr-id="root" class="post"><p data-hr-id="p1">x</p></article>';

    const outcome = patch(
      { targetId: "root", action: "replace", html: '<p data-hr-id="p1">x</p>' },
      compact,
    );

    expect(outcome.changed).toBe(false);
    expect(outcome.html).toBe(compact);
  });

  it("should treat surrounding whitespace as different content", () => {
    const pretty = '<article data-hr-id="root">\n  <p data-hr-id="p1">x</p>\n</article>';

    const outcome = patch({ targetId: "root", action: "replace", html: "<p>x</p>" }, pretty);

    expect(outcome.changed).toBe(true);
    expect(childIds(outcome.html, "root")).toEqual([onlyNewId(outcome)]);
  });

  it("should reject delete / insert_* on the root target", () => {
    expect(codeOf({ targetId: "root", action: "delete" })).toBe("invalid_input");
    expect(codeOf({ targetId: "root", action: "insert_after", html: "<p>x</p>" })).toBe(
      "invalid_input",
    );
    expect(codeOf({ targetId: "root", action: "insert_before", html: "<p>x</p>" })).toBe(
      "invalid_input",
    );
  });
});

describe("请求校验 · action 与 html 的配对", () => {
  it("should reject an unknown action", () => {
    expect(codeOf({ targetId: "p1", action: "upsert", html: "<p>x</p>" })).toBe("invalid_input");
  });

  it("should reject html on delete and a missing html elsewhere", () => {
    expect(codeOf({ targetId: "p1", action: "delete", html: "<p>x</p>" })).toBe("invalid_input");
    expect(codeOf({ targetId: "p1", action: "replace" })).toBe("invalid_input");
    expect(codeOf({ targetId: "p1", action: "append" })).toBe("invalid_input");
  });

  it("should reject an empty targetId and an unknown target", () => {
    expect(codeOf({ targetId: "", action: "delete" })).toBe("invalid_input");
    expect(codeOf({ targetId: "zzz", action: "delete" })).toBe("node_not_found");
  });

  it("should reject a target that is not block level", () => {
    const inline =
      '<article data-hr-id="root"><p data-hr-id="p1">a<span data-hr-id="sp">b</span></p></article>';

    expect(codeOf({ targetId: "sp", action: "delete" }, inline)).toBe("invalid_input");
  });

  it("should reject root when the document has no <article>", () => {
    expect(
      codeOf({ targetId: "root", action: "append", html: "<p>x</p>" }, '<p data-hr-id="p1">x</p>'),
    ).toBe("node_not_found");
  });
});

describe("请求校验 · 未 normalize 的文档", () => {
  it("should say needs_normalize when the document has no data-hr-id at all", () => {
    // 全文一个 id 都没有不是“id 写错了”，是这份文档从没 normalize 过（B-03）：两条报错的后手不一样。
    expect(
      codeOf(
        { targetId: "p1", action: "replace", html: "<p>新</p>" },
        "<article><p>旧</p></article>",
      ),
    ).toBe("needs_normalize");
  });
});

describe("请求校验 · 非字符串 html", () => {
  it("should reject a non-string html through the parser", () => {
    expect(codeOf({ targetId: "p1", action: "append", html: 42 })).toBe("invalid_html");
  });
});

describe("ID 分配 · 只补新的、可复现", () => {
  it("should allocate one id per new element in document order, reusing the target's id", () => {
    // docs/05:57：`replace` 的新根继承目标 id（`empty`），只有片段内部的节点才算新 id。
    const outcome = patch({
      targetId: "empty",
      action: "replace",
      html: "<section><p>甲</p><p>乙</p></section>",
    });

    expect(outcome.newIds).toHaveLength(2);
    expect(childIds(outcome.html, "root")).toEqual(["h1", "empty", "box", "p1", "p2"]);
    expect(textIn(outcome.html, "empty")).toBe("甲乙");
    expect(childIds(outcome.html, "empty")).toEqual([
      String(outcome.newIds[0]),
      String(outcome.newIds[1]),
    ]);
  });

  it("should keep every existing id and produce identical output twice", () => {
    const request: PatchRequest = { targetId: "p1", action: "insert_after", html: "<p>稳定</p>" };
    const first = patch(request);
    const second = patch(request);

    expect(second.html).toBe(first.html);
    expect(second.newIds).toEqual(first.newIds);
    const tags = ["root", "h1", "empty", "box", "p1", "p2"].map(
      (id) => found(elementById(first.html, id), `#${id}`).node.tag,
    );

    expect(tags).toEqual(["article", "h2", "section", "section", "p", "p"]);
  });
});
