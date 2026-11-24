import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, toDocumentModel } from "../src/index";
import type { DocumentModel } from "../src/index";

// 模型契约：模型节点与数组深层冻结、写操作无效或抛 TypeError、
// 两次派生深等但非同一引用（不可共享可变子结构）。这里用迭代遍历，4000 深也不会自伤。

const SAMPLE = [
  "<article>",
  "<header><h2>t</h2><p>lead</p></header>",
  '<section data-hr-component="kpi-bento"><h2>k</h2><ul><li>a</li><li>b</li></ul></section>',
  "<section><p>tail</p></section>",
  "</article>",
].join("");

const modelOf = (html: string): DocumentModel =>
  toDocumentModel(injectNodeIds(parseHtml(html)).parsed);

/** 先序收集整棵模型（含各层 children 数组），用于"逐个检查"而不是抽查根节点。 */
const walk = (root: DocumentModel): readonly DocumentModel[] => {
  const seen: DocumentModel[] = [];
  const stack: DocumentModel[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    seen.push(node);
    for (const childModel of node.children) {
      stack.push(childModel);
    }
  }
  return seen;
};

const rootOf = (model: DocumentModel): DocumentModel => model;

describe("DocumentModel · 深层冻结", () => {
  it("should freeze every node and every children array", () => {
    const nodes = walk(modelOf(SAMPLE));

    expect(nodes.length).toBeGreaterThan(6);
    expect(nodes.filter((node) => !Object.isFrozen(node))).toEqual([]);
    expect(nodes.filter((node) => !Object.isFrozen(node.children))).toEqual([]);
  });

  it("should throw TypeError when a frozen property is redefined", () => {
    const root = rootOf(modelOf(SAMPLE));

    expect(() => {
      Object.defineProperty(root, "text", { value: "hacked" });
    }).toThrow(TypeError);
  });

  it("should refuse a property write through Reflect.set", () => {
    const root = modelOf(SAMPLE);

    expect(Reflect.set(root, "text", "hacked")).toBe(false);
    expect(root.text).toBe("");
  });

  it("should throw TypeError when pushing into a frozen children array", () => {
    const root = modelOf(SAMPLE);

    expect(() => Reflect.apply(Array.prototype.push, root.children, ["x"])).toThrow(TypeError);
    expect(root.children).toHaveLength(3);
  });

  it("should throw TypeError when splicing a frozen children array", () => {
    const root = modelOf(SAMPLE);

    expect(() => {
      Reflect.apply(Array.prototype.splice, root.children, [0, 1]);
    }).toThrow(TypeError);
  });
});

describe("DocumentModel · 纯数据与多次派生", () => {
  it("should survive structuredClone unchanged", () => {
    const model = modelOf(SAMPLE);
    const clone: DocumentModel = structuredClone(model);

    expect(clone).toEqual(model);
    expect(clone).not.toBe(model);
    expect(Object.isFrozen(clone)).toBe(false);
  });

  it("should return deep-equal models that share no references across calls", () => {
    const injected = injectNodeIds(parseHtml(SAMPLE));
    const first = toDocumentModel(injected.parsed);
    const second = toDocumentModel(injected.parsed);
    const other = walk(second);
    const shared = walk(first).filter((node, index) => node === other[index]);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.children).not.toBe(second.children);
    // 逐节点比对引用：只要任何一层复用了同一个对象，这里就会抓到。
    expect(shared).toEqual([]);
  });
});

describe("DocumentModel · 纯数据与多次派生 · 续", () => {
  it("should not be affected by mutating a clone", () => {
    const model = modelOf(SAMPLE);
    const clone: DocumentModel = structuredClone(model);

    // clone 未冻结，所以可以直接 push；原模型若与 clone 共享数组，这里会一起变长。
    Reflect.apply(Array.prototype.push, clone.children, [clone]);

    expect(model.children).toHaveLength(3);
    expect(injectNodeIds(parseHtml(SAMPLE)).parsed).not.toBe(undefined);
    expect(toDocumentModel(injectNodeIds(parseHtml(SAMPLE)).parsed)).toEqual(model);
  });

  it("should re-derive fresh nodes after the source tree changes", () => {
    const before = modelOf(SAMPLE);
    const changed = modelOf(SAMPLE.replace("lead", "LEAD"));
    const textsOf = (model: DocumentModel): readonly string[] =>
      walk(model)
        .filter((node) => node.tag === "p")
        .map((node) => node.text);

    expect(before).not.toEqual(changed);
    expect(textsOf(before)).toContain("lead");
    expect(textsOf(changed)).toContain("LEAD");
    expect(textsOf(changed)).not.toContain("lead");
  });
});
