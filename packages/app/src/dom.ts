// 这层管：`Host` 接口 + 唯一真实 DOM 适配器 `createDomHost(document)`。
// **不引用 DOM lib**（本仓库 tsconfig 的 `lib` 只有 ES2023）：这里只声明"用到的那几个成员"的结构类型，
// `main.ts` 传入真实 `document`；widgets 因此只依赖 `Host`/`NodeSpec`，不碰实现。

import { escapeAttr } from "./escape-attr.ts";

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
  /** `event.key` for keydown/keyup (an event property, not a target one — the adapter pre-resolves it here). */
  readonly key?: string;
  /** 由 `Host.on` 预解析的 `[data-toc-id]`：widget 只读这一个字段，不碰选择器/属性名。 */
  readonly tocId?: string | undefined;
  /** 由 `Host.on` 预解析的 `[data-hr-id]:not(article)`：正文块点击只读这一个字段。 */
  readonly blockId?: string | undefined;
}

export interface Host {
  readonly text: (selector: string, value: string) => void;
  readonly attr: (selector: string, name: string, value: string | undefined) => void;
  readonly html: (selector: string, markup: string) => void;
  readonly cls: (selector: string, name: string, on: boolean) => void;
  readonly children: (selector: string, specs: readonly NodeSpec[]) => void;
  /** 把整篇 HTML 按 `data-hr-id` 拆成"块 id → 块 innerHTML"（正文增量更新的输入）。 */
  readonly blocks: (markup: string) => ReadonlyMap<string, string>;
  /** 只替换某一块的 innerHTML（不整篇重载，滚动位置因此不丢）。 */
  readonly blockHtml: (id: string, markup: string) => void;
  /** 块在新文档里不存在了：从 DOM 真正删掉（**必选**，缺实现就是漏删块）。 */
  readonly removeBlock: (id: string) => void;
  /** 同步整篇 HTML 中新增、改标签或重排的块，保留未改动块与选区。 */
  readonly syncBlocks?: (markup: string) => void;
  readonly on: (
    selector: string,
    type: string,
    handler: (target: TargetLike) => void,
  ) => () => void;
  readonly scrollTo: (selector: string) => void;
  /** 文档序取全部命中元素（演示模式的步进元素枚举）；**必选**，缺实现就是步进永远不出现。 */
  readonly all: (selector: string) => readonly ElementLike[];
  /** 锚点是否存在：模板缺锚点必须**可见地失败**，不能静默跳过。可选：假 host 可省。 */
  readonly has?: (selector: string) => boolean;
  readonly destroy: () => void;
}

/** `document` 的最小结构：查询、建元素、拿到 `<style>`/`<select>` 的那几个成员。 */
export interface DocumentLike {
  readonly body: { readonly getAttribute: (name: string) => string | null };
  readonly querySelector: (selector: string) => ElementLike | null;
  /** `Host.all` 的唯一来源；缺省表示环境不支持枚举（`all` 返回空）。 */
  readonly querySelectorAll?: (selector: string) => readonly ElementLike[];
  readonly createElement: (tag: string) => ElementLike;
  /** Fullscreen API 三段（进入 / 退出 / 当前态）：任一缺席即整体退化，演示模式落回"铺满视口"。 */
  readonly documentElement?: { readonly requestFullscreen?: () => Promise<void> };
  readonly exitFullscreen?: () => Promise<void>;
  readonly fullscreenElement?: unknown;
  readonly addEventListener?: (type: string, handler: () => void) => void;
  readonly removeEventListener?: (type: string, handler: () => void) => void;
  /** `Range` 的最小声明（块内字符偏移的度量）；缺省表示不量偏移。 */
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
  value?: string;
  readonly tagName: string;
  readonly parentElement?: ElementLike | null;
  readonly nextElementSibling?: ElementLike | null;
  readonly classList: { readonly toggle: (name: string, on?: boolean) => void };
  readonly replaceChildren: (...nodes: ElementLike[]) => void;
  readonly appendChild: (node: ElementLike) => void;
  readonly insertBefore: (node: ElementLike, ref: ElementLike | null) => void;
  readonly replaceWith: (node: ElementLike) => void;
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
  readonly focus?: () => void;
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

/** 主题 CSS 的注释里会出现字面 `<article …>`（如 slides 分页注释）：先把这些非正文区段
 *  抹成等长空白（保住索引）再定位文章起点，否则截出来的"正文"会从 CSS 注释中间开始，
 *  注释尾巴和后面的规则文本会被解析成游离元素、直接渲染在正文顶部。 */
const stripHeadOf = (markup: string): string => {
  const masked = markup.replace(
    /<style\b[\s\S]*?<\/style>|<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/giu,
    (region) => " ".repeat(region.length),
  );
  const start = masked.indexOf("<article");
  if (start === -1) return markup;
  const end = markup.lastIndexOf("</article>");
  return start <= end ? markup.slice(start, end + "</article>".length) : markup;
};

const syncHeadTheme = (root: DocumentLike, markup: string): void => {
  const css = /<style\b[^>]*\bid=["']hr-theme["'][^>]*>([\s\S]*?)<\/style>/iu.exec(markup)?.[1];
  const themeEl = css === undefined ? undefined : found(root, "#hr-theme");
  if (themeEl !== undefined && css !== undefined && themeEl.textContent !== css) {
    themeEl.textContent = css;
  }
};

const indexBlocks = (nodes: readonly ElementLike[]): Map<string, ElementLike> => {
  const index = new Map<string, ElementLike>();
  for (const node of nodes) {
    const id = node.getAttribute("data-hr-id");
    if (id !== null) index.set(id, node);
  }
  return index;
};

const parsedBlocksOf = (
  root: DocumentLike,
  markup: string,
  topOnly = false,
): Map<string, ElementLike> => {
  const box = root.createElement("div");
  // 游离 `<div>` 解析：不进活动文档（`innerHTML` 的受控使用点之一）。
  box.innerHTML = stripHeadOf(markup);
  const direct = topOnly ? box.querySelectorAll("article[data-hr-id] > [data-hr-id]") : [];
  // 跳过根 `<article>` 自身，索引文档内所有可寻址块（整块同步时优先取 `<article>` 直接子块以保住包装容器）。
  const nodes = direct.length > 0 ? direct : box.querySelectorAll("[data-hr-id]:not(article)");
  return indexBlocks(nodes);
};

const sameShape = (live: ElementLike, fresh: ElementLike): boolean =>
  live.tagName === fresh.tagName &&
  live.getAttribute("data-hr-component") === fresh.getAttribute("data-hr-component");

const placeBlock = (
  container: ElementLike,
  live: ElementLike | undefined,
  fresh: ElementLike,
  anchor: ElementLike | null,
): ElementLike => {
  if (live === undefined) {
    container.insertBefore(fresh, anchor);
    return fresh;
  }
  if (!sameShape(live, fresh)) {
    live.replaceWith(fresh);
    return fresh;
  }
  if (live.parentElement === container && live.nextElementSibling !== anchor) {
    container.insertBefore(live, anchor);
  }
  return live;
};

const syncAllBlocks = (root: DocumentLike, markup: string): void => {
  syncHeadTheme(root, markup);
  const container = found(root, "#hr-doc article[data-hr-id]") ?? found(root, "#hr-doc");
  if (container === undefined) return;
  const freshEntries = [...parsedBlocksOf(root, markup, true).entries()].reverse();
  let anchor: ElementLike | null = null;
  for (const [id, fresh] of freshEntries) {
    anchor = placeBlock(container, found(root, `[data-hr-id="${escapeAttr(id)}"]`), fresh, anchor);
  }
};

/** 结构/事件无关的那一半（纯读改写）。 */
const paintOps = (
  root: DocumentLike,
): Pick<Host, "children" | "blocks" | "blockHtml" | "removeBlock" | "syncBlocks"> => ({
  children: (selector, specs) => {
    const element = found(root, selector);
    if (element !== undefined) element.replaceChildren(...specs.map((spec) => paint(root, spec)));
  },
  blocks: (markup) => {
    const index = new Map<string, string>();
    for (const [id, node] of parsedBlocksOf(root, markup)) index.set(id, node.innerHTML);
    return index;
  },
  blockHtml: (id, markup) => {
    const element = found(root, `[data-hr-id="${escapeAttr(id)}"]`);
    // 第二处：块级替换（内容来自服务器，已过白名单；不整篇重载所以滚动位置不丢）。
    if (element !== undefined && element.innerHTML !== markup) element.innerHTML = markup;
  },
  removeBlock: (id) => {
    found(root, `[data-hr-id="${escapeAttr(id)}"]`)?.remove?.();
  },
  syncBlocks: (markup) => {
    syncAllBlocks(root, markup);
  },
});

/** 只碰文本/属性/类名的那些。 */
const textOps = (
  root: DocumentLike,
): Pick<Host, "text" | "attr" | "html" | "cls" | "scrollTo" | "all" | "has"> => ({
  text: (selector, value) => {
    const element = found(root, selector);
    if (element === undefined) return;
    if (element.textContent !== value) element.textContent = value;
    if (typeof element.value === "string" && element.value !== value) element.value = value;
  },
  attr: (selector, name, value) => {
    const element = found(root, selector);
    if (element === undefined) return;
    if (value === undefined) element.removeAttribute(name);
    else element.setAttribute(name, value);
  },
  html: (selector, markup) => {
    syncHeadTheme(root, markup);
    const clean = stripHeadOf(markup);
    const element = found(root, selector);
    if (element !== undefined && element.innerHTML !== clean) element.innerHTML = clean;
  },
  cls: (selector, name, on) => {
    found(root, selector)?.classList.toggle(name, on);
  },
  scrollTo: (selector) => {
    found(root, selector)?.scrollIntoView?.({ block: "start" });
  },
  all: (selector) => root.querySelectorAll?.(selector) ?? [],
  has: (selector) => found(root, selector) !== undefined,
});

export const createDomHost = (root: DocumentLike): Host => {
  const unbinders: (() => void)[] = [];

  const on: Host["on"] = (selector, type, handler) => {
    const element = found(root, selector);
    if (element === undefined) return () => undefined;
    // 真实 DOM 的 `value` 与 `closest` 在原型链上，直接对象展开会丢掉：必须显式转接并保留 `this`。
    const listener = (event: { target: TargetLike; key?: unknown }): void => {
      const target = event.target;
      const findClosest = target.closest;
      const closest =
        findClosest === undefined ? undefined : (sel: string) => findClosest.call(target, sel);
      handler({
        ...(target.value === undefined ? {} : { value: target.value }),
        ...(typeof event.key === "string" ? { key: event.key } : {}),
        ...(closest === undefined ? {} : { closest }),
        tocId: closest?.("[data-toc-id]")?.getAttribute("data-toc-id") ?? undefined,
        blockId: closest?.("[data-hr-id]:not(article)")?.getAttribute("data-hr-id") ?? undefined,
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
