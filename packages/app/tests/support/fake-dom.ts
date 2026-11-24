// 这层管：`dom.ts` 需要的最小假 `document`——按选择器查元素、记属性/文本/监听器。
// 不够格当浏览器用，够格断言"哪个 API 被调用了几次"（"只写变化"的序列断言在 fake-host）。

import type { ElementLike, TargetLike } from "../../src/dom.ts";

/** 参数类型故意写成 `ElementLike`（与接口一致），因此本类型结构上就是 `ElementLike`。 */
export interface FakeElement {
  tag: string;
  tagName: string;
  value?: string;
  parentElement: FakeElement | null;
  nextElementSibling: ElementLike | null;
  calls: string[];
  listeners: string[];
  attrs: Map<string, string>;
  classes: Map<string, boolean>;
  children: ElementLike[];
  innerHTML: string;
  htmlWrites: string[];
  textContent: string | null;
  querySelectorAll: (selector: string) => readonly ElementLike[];
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  getAttribute: (name: string) => string | null;
  classList: { toggle: (name: string, on?: boolean) => void };
  replaceChildren: (...nodes: ElementLike[]) => void;
  appendChild: (node: ElementLike) => void;
  insertBefore: (node: ElementLike, ref: ElementLike | null) => void;
  replaceWith: (node: ElementLike) => void;
  addEventListener: (type: string, handler: (event: { target: TargetLike }) => void) => void;
  removeEventListener: (type: string, handler: (event: { target: TargetLike }) => void) => void;
  fire: (type: string, target: TargetLike) => void;
  scrollIntoView?: (options: { block: "start" }) => void;
}

export interface FakeDocument {
  readonly body: { getAttribute: (name: string) => string | null };
  readonly created: FakeElement[];
  readonly bySelector: Map<string, FakeElement>;
  readonly querySelector: (selector: string) => FakeElement | null;
  createElement: (tag: string) => FakeElement;
  readonly listenersOf: (selector: string) => readonly string[];
  readonly fire: (selector: string, type: string, target: TargetLike) => void;
}

const handleOf = (element: FakeElement, withHandles: boolean): void => {
  if (withHandles)
    element.scrollIntoView = (options) => element.calls.push(`scroll:${options.block}`);
};

const fakeRegistry = new WeakMap<ElementLike, FakeElement>();

const relink = (parent: FakeElement): void => {
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i];
    const fakeChild = child === undefined ? undefined : fakeRegistry.get(child);
    if (fakeChild !== undefined) {
      fakeChild.parentElement = parent;
      fakeChild.nextElementSibling = parent.children[i + 1] ?? null;
    }
  }
};

const wireTree = (element: FakeElement): void => {
  element.replaceChildren = (...nodes) => {
    element.children.splice(0, element.children.length, ...nodes);
    relink(element);
  };
  element.appendChild = (node) => {
    element.children.push(node);
    relink(element);
  };
  element.insertBefore = (node, ref) => {
    const oldAt = element.children.indexOf(node);
    if (oldAt !== -1) element.children.splice(oldAt, 1);
    const refAt = ref === null ? -1 : element.children.indexOf(ref);
    if (refAt === -1) element.children.push(node);
    else element.children.splice(refAt, 0, node);
    relink(element);
  };
  element.replaceWith = (node) => {
    element.calls.push("replaceWith");
    const parent = element.parentElement;
    if (parent === null) return;
    const at = parent.children.indexOf(element);
    if (at !== -1) parent.children.splice(at, 1, node);
    relink(parent);
  };
};

const wireOf = (element: FakeElement): void => {
  const handlers = new Map<string, (event: { target: TargetLike }) => void>();
  element.setAttribute = (name, value) => {
    element.attrs.set(name, value);
  };
  element.removeAttribute = (name) => {
    element.attrs.delete(name);
  };
  element.getAttribute = (name) => element.attrs.get(name) ?? null;
  element.classList = {
    toggle: (name, on) => {
      element.classes.set(name, on ?? !(element.classes.get(name) ?? false));
    },
  };
  wireTree(element);
  element.addEventListener = (type, handler) => {
    element.listeners.push(type);
    handlers.set(type, handler);
  };
  element.removeEventListener = (type) => {
    element.listeners.splice(element.listeners.indexOf(type), 1);
    handlers.delete(type);
  };
  element.fire = (type, target) => {
    handlers.get(type)?.({ target });
  };
};

const markupOf = (element: FakeElement): void => {
  let markup = "";
  Object.defineProperty(element, "innerHTML", {
    get: () => markup,
    set: (value: string) => {
      markup = value;
      element.htmlWrites.push(value);
    },
  });
};

export const fakeElement = (tag: string, withHandles = true): FakeElement => {
  const element: FakeElement = {
    tag,
    tagName: tag.toUpperCase(),
    parentElement: null,
    nextElementSibling: null,
    calls: [],
    listeners: [],
    attrs: new Map(),
    classes: new Map(),
    children: [],
    htmlWrites: [],
    innerHTML: "",
    textContent: null,
    querySelectorAll: () => [],
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    getAttribute: () => null,
    classList: { toggle: () => undefined },
    replaceChildren: () => undefined,
    appendChild: () => undefined,
    insertBefore: () => undefined,
    replaceWith: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    fire: () => undefined,
  };
  fakeRegistry.set(element, element);
  wireOf(element);
  markupOf(element);
  handleOf(element, withHandles);
  return element;
};

/** 假 document：`bySelector` 就是"页面上有哪些元素"的全部真相。 */
export const createFakeDocument = (): FakeDocument => {
  const bySelector = new Map<string, FakeElement>();
  const created: FakeElement[] = [];
  const doc: FakeDocument = {
    body: { getAttribute: () => null },
    created,
    bySelector,
    querySelector: (selector) => bySelector.get(selector) ?? null,
    createElement: (tag) => {
      const element = fakeElement(tag);
      created.push(element);
      return element;
    },
    listenersOf: (selector) => bySelector.get(selector)?.listeners ?? [],
    fire: (selector, type, target) => {
      bySelector.get(selector)?.fire(type, target);
    },
  };
  return doc;
};

/** `Host.blocks` 输入：给容器塞块（`querySelectorAll("[data-hr-id]:not(...)")` 返回它们）。 */
export const withBlocks = (container: FakeElement, blocks: readonly FakeElement[]): void => {
  container.querySelectorAll = (selector) => (selector.includes("[data-hr-id]") ? blocks : []);
  for (const block of blocks) container.appendChild(block);
};
