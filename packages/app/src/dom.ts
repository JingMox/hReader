// 这层管：`Host` 接口 + 唯一真实 DOM 适配器 `createDomHost(document)`。
// **不引用 DOM lib**（本仓库 tsconfig 的 `lib` 只有 ES2023）：这里只声明"用到的那几个成员"的结构类型，
// `main.ts` 传入真实 `document`；widgets 因此只依赖 `Host`/`NodeSpec`，不碰实现。

export interface NodeSpec {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly children?: readonly NodeSpec[];
}

/** 镜像 `@hreader/core` 的 `TextAnchor`：app 不能依赖 core（会拉进 node 内建），故只镜像结构。 */
export interface AnchorSpec {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly start: number;
}

/** 镜像 `@hreader/core` 的 `ChunkKind | TextChunk`（同上，纯结构镜像）。 */
export type DiffKind = "same" | "ins" | "del";

export interface DiffChunk {
  readonly kind: DiffKind;
  readonly text: string;
}

/** 事件里我们用到的两个成员：`closest` 与 `value`。真实 target 用 `Reflect` 适配，不做类型断言。 */
export interface TargetLike {
  readonly closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null;
  readonly value?: string;
  /** 由 `Host.on` 预解析的 `[data-toc-id]`：widget 只读这一个字段，不碰选择器/属性名。 */
  readonly tocId?: string | undefined;
}

export interface Host {
  readonly text: (selector: string, value: string) => void;
  readonly attr: (selector: string, name: string, value: string | undefined) => void;
  readonly html: (selector: string, markup: string) => void;
  readonly cls: (selector: string, name: string, on: boolean) => void;
  readonly children: (selector: string, specs: readonly NodeSpec[]) => void;
  /** 把整篇 HTML 按 `data-hr-id` 拆成"块 id → 块 innerHTML"（正文增量更新的输入，AC2.4）。 */
  readonly blocks: (markup: string) => ReadonlyMap<string, string>;
  /** 只替换某一块的 innerHTML（不整篇重载，滚动位置因此不丢）。 */
  readonly blockHtml: (id: string, markup: string) => void;
  /** 块在新文档里不存在了：从 DOM 真正删掉（裁定 #8；**必选**，缺实现就是漏删块）。 */
  readonly removeBlock: (id: string) => void;
  readonly on: (
    selector: string,
    type: string,
    handler: (target: TargetLike) => void,
  ) => () => void;
  readonly scrollTo: (selector: string) => void;
  /** 锚点是否存在（裁定 #1：模板缺锚点必须**可见地失败**，不能静默跳过）。可选：假 host 可省。 */
  readonly has?: (selector: string) => boolean;
  readonly destroy: () => void;
}

/** `document` 的最小结构：查询、建元素、拿到 `<style>`/`<select>` 的那几个成员。 */
export interface DocumentLike {
  readonly body: { readonly getAttribute: (name: string) => string | null };
  readonly querySelector: (selector: string) => ElementLike | null;
  readonly createElement: (tag: string) => ElementLike;
  /** `Range` 的最小声明（裁定 #11 的字符偏移）；缺省表示不量偏移。 */
  readonly createRange?: () => {
    readonly selectNodeContents: (node: unknown) => void;
    readonly setEnd: (node: unknown, offset: number) => void;
    readonly toString: () => string;
  };
}

export interface ElementLike {
  readonly querySelectorAll: (selector: string) => readonly ElementLike[];
  readonly setAttribute: (name: string, value: string) => void;
  readonly removeAttribute: (name: string) => void;
  readonly getAttribute: (name: string) => string | null;
  innerHTML: string;
  textContent: string | null;
  readonly classList: { readonly toggle: (name: string, on?: boolean) => void };
  readonly replaceChildren: (...nodes: ElementLike[]) => void;
  readonly appendChild: (node: ElementLike) => void;
  readonly addEventListener: (
    type: string,
    handler: (event: { target: TargetLike }) => void,
  ) => void;
  readonly removeEventListener: (
    type: string,
    handler: (event: { target: TargetLike }) => void,
  ) => void;
  readonly remove?: () => void;
  readonly scrollIntoView?: (options: { block: "start" }) => void;
}

const found = (root: DocumentLike, selector: string): ElementLike | undefined =>
  root.querySelector(selector) ?? undefined;

const paint = (root: DocumentLike, spec: NodeSpec): ElementLike => {
  const element = root.createElement(spec.tag);
  for (const [name, value] of Object.entries(spec.attrs ?? {})) element.setAttribute(name, value);
  if (spec.text !== undefined) element.textContent = spec.text;
  for (const child of spec.children ?? []) element.appendChild(paint(root, child));
  return element;
};

/** 结构/事件无关的那一半（纯读改写）。 */
const paintOps = (
  root: DocumentLike,
): Pick<Host, "children" | "blocks" | "blockHtml" | "removeBlock"> => ({
  children: (selector, specs) => {
    const element = found(root, selector);
    if (element !== undefined) element.replaceChildren(...specs.map((spec) => paint(root, spec)));
  },
  blocks: (markup) => {
    const box = root.createElement("div");
    // 游离 `<div>` 解析：不进活动文档，只为量出每块的 innerHTML（裁定 #7 的三处之一）。
    box.innerHTML = markup;
    const index = new Map<string, string>();
    // 只取最外层：嵌套的 `[data-hr-id]` 属于父块的内容，不能单独成"块"（裁定 #8）。
    const outer = box.querySelectorAll("[data-hr-id]:not([data-hr-id] [data-hr-id])");
    for (const node of outer) {
      const id = node.getAttribute("data-hr-id");
      if (id !== null) index.set(id, node.innerHTML);
    }
    return index;
  },
  blockHtml: (id, markup) => {
    const element = found(root, `[data-hr-id="${id}"]`);
    // 第二处：块级替换（内容来自服务器，已过白名单；不整篇重载所以滚动位置不丢）。
    if (element !== undefined && element.innerHTML !== markup) element.innerHTML = markup;
  },
  removeBlock: (id) => {
    found(root, `[data-hr-id="${id}"]`)?.remove?.();
  },
});

/** 只碰文本/属性/类名的那些。 */
const textOps = (
  root: DocumentLike,
): Pick<Host, "text" | "attr" | "html" | "cls" | "scrollTo" | "has"> => ({
  text: (selector, value) => {
    const element = found(root, selector);
    if (element !== undefined && element.textContent !== value) element.textContent = value;
  },
  attr: (selector, name, value) => {
    const element = found(root, selector);
    if (element === undefined) return;
    if (value === undefined) element.removeAttribute(name);
    else element.setAttribute(name, value);
  },
  html: (selector, markup) => {
    const element = found(root, selector);
    if (element !== undefined && element.innerHTML !== markup) element.innerHTML = markup;
  },
  cls: (selector, name, on) => {
    found(root, selector)?.classList.toggle(name, on);
  },
  scrollTo: (selector) => {
    found(root, selector)?.scrollIntoView?.({ block: "start" });
  },
  has: (selector) => found(root, selector) !== undefined,
});

export const createDomHost = (root: DocumentLike): Host => {
  const unbinders: (() => void)[] = [];

  const on: Host["on"] = (selector, type, handler) => {
    const element = found(root, selector);
    if (element === undefined) return () => undefined;
    // 真实 `event.target` 满足 `TargetLike`（`closest` 与 `value` 本来就是 DOM 成员）；
    // 这里不给 DOM lib 付代价，靠上面声明的结构类型。
    // DOM 语义（向上找最近的 `[data-toc-id]` 再取属性）只留在这个适配器里；
    // widget 拿到的 target 已带 `tocId`，不再自己 `closest`。
    const listener = (event: { target: TargetLike }): void => {
      handler({
        ...event.target,
        tocId: event.target.closest?.("[data-toc-id]")?.getAttribute("data-toc-id") ?? undefined,
      });
    };
    element.addEventListener(type, listener);
    const off = (): void => {
      element.removeEventListener(type, listener);
    };
    unbinders.push(off);
    return off;
  };

  return {
    ...textOps(root),
    ...paintOps(root),
    on,
    destroy: () => {
      for (const off of unbinders.splice(0)) off();
    },
  };
};
