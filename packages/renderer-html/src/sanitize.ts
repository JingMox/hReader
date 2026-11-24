// 这层管：交互 UI 与外部资源裁切（从树里删掉，不是 CSS 隐藏）；不编号、不拼文档。

import type { HtmlElementNode } from "@hreader/core";

export type Attribute = HtmlElementNode["attrs"][number];

/** 非正文内容、交互控件、外部媒体：整节点删掉。CSS 隐藏的节点照样进打印稿。 */
const DROPPED_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "link",
  "base",
  "meta",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  // SVG 资源元素整删（`<use href="#sym">` 也不留，否则等于把外部资源面留给主题去赌）
  "image",
  "use",
  "feimage",
]);

/** 交互 UI 类名（实测：这些类在 app 侧 0 命中，故清单是防御性的，不是既有契约）。 */
const UI_CLASSES: readonly string[] = ["hr-sidebar", "hr-toc-toggle", "hr-mode-toggle"];

const UI_ATTRIBUTES: readonly string[] = ["contenteditable", "data-hr-ui"];

/** 带协议即等于脚本执行的属性。 */
const SCRIPT_SCHEME_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "xlink:href"]);

const SCRIPT_SCHEMES: readonly string[] = ["javascript:", "vbscript:", "data:text/html"];

/** 资源属性只放行内联的 `data:image/…`；相对路径也删（单文件产物里它必然是坏图）。 */
const RESOURCE_ATTRIBUTES: readonly string[] = ["src", "srcset", "poster"];

const DATA_IMAGE_URL = /^data:image\//iu;

/**
 * `srcset` 按候选逐个判，不能只看串首：`data:image/png;base64,AAA 1x, https://cdn/b.png 2x` 串首是内联图，
 * 第二个候选却会真的外联。描述符只抵密度/宽度两种；非 base64 的内联载荷（`;charset=…,<svg…>`）
 * 会被当成外链整张删掉——fail-closed，那个形状本来就是载荷面。
 */
const INLINE_SRCSET_ITEM =
  /^\s*data:image\/[a-z0-9.+-]+(?:;base64)?,[A-Za-z0-9+/=%]*\s*(?:\d+(?:\.\d+)?(?:w|x))?\s*(?:,|$)/iu;

const hasExternalSrcset = (value: string): boolean => {
  let rest = value;
  while (rest.trim() !== "") {
    const match = INLINE_SRCSET_ITEM.exec(rest);
    if (match === null) {
      return true;
    }
    rest = rest.slice(match[0].length);
  }
  return false;
};

const STYLE_EXTERNAL_URL = /url\(\s*['"]?(?:[a-z][a-z0-9+.-]*:)?\/\//iu;

/** 被删时计入 `droppedImages` 的标签：`<img>` 与 SVG `<image>`；`<svg>` 内的 `<image>` 随 `<svg>` 整删，自然不计。 */
export const isCountedImage = (node: HtmlElementNode): boolean =>
  node.tag.toLowerCase() === "img" || node.tag.toLowerCase() === "image";

export const attributeOf = (node: HtmlElementNode, name: string): string | undefined =>
  node.attrs.find(([key]) => key === name)?.[1];

const classTokensOf = (node: HtmlElementNode): readonly string[] =>
  (attributeOf(node, "class") ?? "").split(/\s+/u).filter((token) => token !== "");

export const isDroppedNode = (node: HtmlElementNode): boolean =>
  // parse5 会把 SVG 标签名改成 camelCase（`feImage`），故先归一化再查表。
  DROPPED_TAGS.has(node.tag.toLowerCase()) ||
  UI_ATTRIBUTES.some((name) => attributeOf(node, name) !== undefined) ||
  classTokensOf(node).some((token) => UI_CLASSES.includes(token));

/** 命中即删**整个元素**（不是只删属性）：留着无 `src` 的 `<img>` 在纸面上是个坏图标。 */
export const hasExternalResource = (node: HtmlElementNode): boolean =>
  RESOURCE_ATTRIBUTES.some((name) => {
    const value = attributeOf(node, name);
    if (value === undefined) {
      return false;
    }
    return name === "srcset" ? hasExternalSrcset(value) : !DATA_IMAGE_URL.test(value.trim());
  });

/** 浏览器解析协议前会丢掉 C0 控制字符与空白：`java\tscript:` 与 `javascript:` 等价，故先归一化。 */
const isScriptUrl = (value: string): boolean => {
  let normalized = "";
  for (const char of value) {
    if (char.charCodeAt(0) > 0x20) {
      normalized += char;
    }
  }
  return SCRIPT_SCHEMES.some((scheme) => normalized.toLowerCase().startsWith(scheme));
};

/**
 * 只丢属性、不丢节点：`on*` 一律丢（含 `svg onload`），伪协议只丢那个属性
 * （正文里的 `<a href="https://…">` 是内容，必须留）。
 */
const isDroppedAttribute = ([name, value]: Attribute): boolean => {
  if (name.startsWith("on")) {
    return true;
  }
  if (SCRIPT_SCHEME_ATTRIBUTES.has(name)) {
    return isScriptUrl(value);
  }
  return name === "style" && STYLE_EXTERNAL_URL.test(value);
};

export const sanitizedAttributesOf = (node: HtmlElementNode): readonly Attribute[] =>
  node.attrs.filter((attribute) => !isDroppedAttribute(attribute));
