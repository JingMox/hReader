// 这层管：把不可信 HTML 裁成安全语义内容的判定（整删的元素、剥掉的属性、伪协议与外链口径），
// 外加"文档有没有可执行面"的探测；`print`（打印稿）与 `import`（外来文档托管化）两个预设共用
// 同一套判定、两张规则表；不改树、不解析、不序列化。

import type { HtmlAttribute, HtmlElementNode, HtmlNode } from "./constants";
import { drainStack } from "./stack";

/**
 * `print`：打印稿裁切，行为是既有契约（逐字节兼容），相对宽松——源文档本身就是托管文档。
 * `import`：`hr import` 的外来文档裁切，面更严——外来 HTML 的编辑态/隐藏面/SMIL 都要清掉。
 */
export type SanitizePreset = "print" | "import";

/**
 * 可执行/外部资源容器的最小公约数：`forbidden_content`（ops/patch-node）的拒绝名单与
 * 下方两个预设的整删名单共用这张底表，避免两份清单各自演进后漂移。
 */
export const FORBIDDEN_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "base",
]);

/**
 * "能执行/能换文档"的 URL 协议前缀：与 `forbidden_content` 共用同一份取值。
 * `vbscript:` 只在 sanitize 侧追加——片段校验加它会改变既有拒绝口径，不许顺手"补齐"。
 */
export const DANGEROUS_URL_PREFIXES: readonly string[] = ["javascript:", "data:text/html"];

/** 浏览器解析协议前会丢掉空白与控制字符：`java\tscript:`、`java&#x0A;script:` 与 `javascript:` 等价。 */
const URL_IGNORABLE = /[\s\p{Cc}]/gu;

/** 严格归一化（import 与 `forbidden_content` 共用）：剥全部空白/控制字符再小写。 */
export const normalizedUrl = (value: string): string =>
  value.replaceAll(URL_IGNORABLE, "").toLowerCase();

/** `on*` 一律算事件属性；大小写不敏感——不依赖"属性名必已被解析器小写化"这个前提。 */
export const isEventAttribute = (name: string): boolean => name.toLowerCase().startsWith("on");

/** 非正文内容、交互控件、外部媒体：整节点删掉。CSS 隐藏的节点照样进打印稿。 */
const PRINT_DROPPED_TAGS: ReadonlySet<string> = new Set([
  ...FORBIDDEN_CONTAINER_TAGS,
  "meta",
  "video",
  "audio",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  // `<noscript>` 的 raw-text 解析歧义（属性值里的 `</noscript>` 会截出活元素）：只能整子树删。
  "noscript",
  // SVG 资源元素整删（`<use href="#sym">` 也不留，否则等于把外部资源面留给主题去赌）
  "image",
  "use",
  "feimage",
]);

/**
 * `import` 在 `print` 名单上补三面：
 * - SMIL 动画元素（`animate`/`set` 等）：能改写父节点属性——`attributeName="onload"` 写事件处理器、
 *   `values="…;javascript:…"` 写危险 URL，属性级过滤挡不住取值列表，只能整元素删；
 * - `foreignObject`：SVG 里的 HTML 二次入口，外来文档没有保留它的正当理由；
 * - 隐藏/惰性内容壳与老式嵌入、raw-text 元素：`template` 的内容不进渲染面；
 *   `xmp`/`noembed`/`noframes`/`plaintext` 的子树是文本不是元素，序列化原样照出——
 *   `<xmp><script>…</script></xmp>` 的脚本字符串会原样穿过过滤，只能整删。
 */
const IMPORT_DROPPED_TAGS: ReadonlySet<string> = new Set([
  ...PRINT_DROPPED_TAGS,
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
  "mpath",
  "foreignobject",
  "template",
  "applet",
  "frame",
  "frameset",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
]);

/** 交互 UI 类名（实测：这些类在 app 侧 0 命中，故清单是防御性的，不是既有契约）。 */
const UI_CLASSES: readonly string[] = ["hr-sidebar", "hr-toc-toggle", "hr-mode-toggle"];

/** 带协议即等于脚本执行的属性。 */
const SCRIPT_URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "xlink:href"]);

/** `scriptUrlPrefixes` 之外还要在链接属性上单独拦的前缀（`data:` 只拦链接，不拦资源属性）。 */
const LINK_URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "xlink:href"]);

const SCRIPT_SCHEMES: readonly string[] = [...DANGEROUS_URL_PREFIXES, "vbscript:"];

/** 资源属性只放行内联的 `data:image/…`；相对路径也删（单文件产物里它必然是坏图）。 */
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

/**
 * 按 CSS Syntax 解转义后再判：`url(\68 ttp://…)` 与 `url(http://…)` 对浏览器是同一个请求，
 * `u\72 l(` 也是 `url(`。`\` + 1-6 位十六进制（可吞一个空白）→ 码点；`\` + 换行是行接续（删掉）；
 * `\` + 其他单字符 → 字符本身。码点为 0、超界或代理项时按规范回落 U+FFFD。
 */
const CSS_ESCAPE = /\\(?:[0-9a-f]{1,6}\s?|\r\n|[\n\r\f]|.)/giu;

const decodeCssEscapes = (value: string): string =>
  value.replace(CSS_ESCAPE, (escape) => {
    const body = escape.slice(1);
    const digits = /^[0-9a-f]{1,6}$/iu.test(body)
      ? body
      : /^[0-9a-f]{1,6}\s$/iu.test(body)
        ? body.slice(0, -1)
        : undefined;
    if (digits === undefined) return /^[\n\r\f]/u.test(body) ? "" : body;
    const point = Number.parseInt(digits, 16);
    return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
      ? "�"
      : String.fromCodePoint(point);
  });

/** 引号内空白与大小写变体也归一拦：解码后的 `url( ' //…' )` 仍是同一个外链请求。 */
const STYLE_EXTERNAL_URL = /url\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//iu;

/** print 的历史口径：只剥 ≤0x20 的字符。比严格口径窄（NEL/C1 等不剥），但 print 行为是冻结契约。 */
const normalizedPrintUrl = (value: string): string => {
  let normalized = "";
  for (const char of value) {
    if (char.charCodeAt(0) > 0x20) {
      normalized += char;
    }
  }
  return normalized.toLowerCase();
};

interface SanitizeRules {
  readonly droppedTags: ReadonlySet<string>;
  /** 命中即整节点删除的属性名（UI/编辑态标记，不是按值判）。 */
  readonly droppedIfAttributes: readonly string[];
  readonly droppedIfClasses: readonly string[];
  /**
   * 属性名比较前先小写：parse5 会把属性名小写化（foreign adjustment 只还原已知驼峰清单），
   * 但 import 不假设输入树一定出自 parse5——`ONLOAD` 在手造树上仍是事件属性。
   * print 关闭它是为了逐字节兼容。
   */
  readonly lowercaseAttributeNames: boolean;
  /** 命中即剥的属性名（元素保留）。 */
  readonly strippedAttributes: ReadonlySet<string>;
  /** 命中即剥的属性名前缀：namespace 级占用，逐个点名会漏掉将来新增的值。 */
  readonly strippedAttributePrefixes: readonly string[];
  readonly scriptUrlPrefixes: readonly string[];
  /** 只在链接属性上追加拦截的前缀（import 连 `data:` 一起拦）。 */
  readonly blockedLinkPrefixes: readonly string[];
  readonly normalizeUrl: (value: string) => string;
  /** 只放行内联 `data:image/` 的资源属性面；两个预设目前同口径，但口径归规则表不归函数。 */
  readonly resourceAttributes: readonly string[];
  /** `style` 处理：print 只丢带外链 `url()` 的（逐字节契约）；import 全丢。 */
  readonly style: "keep-unless-external-url" | "drop";
}

const PRINT_RULES: SanitizeRules = {
  droppedTags: PRINT_DROPPED_TAGS,
  droppedIfAttributes: ["contenteditable", "data-hr-ui"],
  droppedIfClasses: UI_CLASSES,
  lowercaseAttributeNames: false,
  strippedAttributes: new Set<string>(),
  strippedAttributePrefixes: [],
  scriptUrlPrefixes: SCRIPT_SCHEMES,
  blockedLinkPrefixes: [],
  normalizeUrl: normalizedPrintUrl,
  resourceAttributes: ["src", "srcset", "poster"],
  style: "keep-unless-external-url",
};

const IMPORT_RULES: SanitizeRules = {
  droppedTags: IMPORT_DROPPED_TAGS,
  // 外来文档常把 contenteditable 挂在 body/大容器上（编辑器导出物）：整删会把正文一起带走，降级为剥属性。
  droppedIfAttributes: ["data-hr-ui"],
  droppedIfClasses: UI_CLASSES,
  lowercaseAttributeNames: true,
  strippedAttributes: new Set<string>([
    // 编辑/交互 affordance：托管文档不是编辑器，这些属性带进来全是残留。
    "contenteditable",
    "autofocus",
    "tabindex",
    "accesskey",
    "draggable",
    "spellcheck",
    // `hidden` 的内容不可见，不算语义内容；`ping` 是跟踪信标；`background` 是老式外链面。
    "hidden",
    "ping",
    "background",
  ]),
  // `data-hr-*` 是 hReader 自己的命名空间：外来文档里的 `data-hr-id` 会与注入器分配的 ID 撞车。
  strippedAttributePrefixes: ["data-hr-"],
  scriptUrlPrefixes: SCRIPT_SCHEMES,
  // 链接上的 `data:` 是整个文档的载荷（`data:image` 只在资源属性上放行，见 hasExternalResource）。
  blockedLinkPrefixes: ["data:"],
  normalizeUrl: normalizedUrl,
  resourceAttributes: ["src", "srcset", "poster"],
  // 托管文档里内联 style 本来就是 `inline_style` 警告面（长相归主题）；外来 style 还常带
  // 定位/隐藏/外链 url()，逐条解析 CSS 声明来过滤不划算，全剥。
  style: "drop",
};

const RULES: Readonly<Record<SanitizePreset, SanitizeRules>> = {
  print: PRINT_RULES,
  import: IMPORT_RULES,
};

/** 被删时计入 `droppedImages` 的标签：`<img>` 与 SVG `<image>`；`<svg>` 内的 `<image>` 随 `<svg>` 整删，自然不计。 */
export const isCountedImage = (node: HtmlElementNode): boolean =>
  node.tag.toLowerCase() === "img" || node.tag.toLowerCase() === "image";

export const attributeOf = (node: HtmlElementNode, name: string): string | undefined =>
  node.attrs.find(([key]) => key === name)?.[1];

const classTokensOf = (node: HtmlElementNode): readonly string[] =>
  (attributeOf(node, "class") ?? "").split(/\s+/u).filter((token) => token !== "");

export const isDroppedNode = (node: HtmlElementNode, preset: SanitizePreset): boolean => {
  const rules = RULES[preset];
  // parse5 会把 SVG 标签名改成 camelCase（`feImage`），故先归一化再查表。
  return (
    rules.droppedTags.has(node.tag.toLowerCase()) ||
    rules.droppedIfAttributes.some((name) => attributeOf(node, name) !== undefined) ||
    classTokensOf(node).some((token) => rules.droppedIfClasses.includes(token))
  );
};

/** 命中即删**整个元素**（不是只删属性）：留着无 `src` 的 `<img>` 在纸面上是个坏图标。 */
export const hasExternalResource = (node: HtmlElementNode, preset: SanitizePreset): boolean =>
  RULES[preset].resourceAttributes.some((name) => {
    const value = attributeOf(node, name);
    if (value === undefined) {
      return false;
    }
    return name === "srcset" ? hasExternalSrcset(value) : !DATA_IMAGE_URL.test(value.trim());
  });

const hasAnyPrefix = (normalized: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => normalized.startsWith(prefix));

/**
 * 只丢属性、不丢节点：`on*` 一律丢（含 `svg onload`），伪协议只丢那个属性
 * （正文里的 `<a href="https://…">` 是内容，必须留）。
 */
const isDroppedAttribute = ([name, value]: HtmlAttribute, rules: SanitizeRules): boolean => {
  const key = rules.lowercaseAttributeNames ? name.toLowerCase() : name;
  if (key.startsWith("on")) {
    return true;
  }
  if (rules.strippedAttributes.has(key)) {
    return true;
  }
  if (rules.strippedAttributePrefixes.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  if (key === "style") {
    return rules.style === "drop" || STYLE_EXTERNAL_URL.test(decodeCssEscapes(value));
  }
  if (SCRIPT_URL_ATTRIBUTES.has(key) || LINK_URL_ATTRIBUTES.has(key)) {
    const normalized = rules.normalizeUrl(value);
    return (
      (SCRIPT_URL_ATTRIBUTES.has(key) && hasAnyPrefix(normalized, rules.scriptUrlPrefixes)) ||
      (LINK_URL_ATTRIBUTES.has(key) && hasAnyPrefix(normalized, rules.blockedLinkPrefixes))
    );
  }
  return false;
};

export const sanitizedAttributesOf = (
  node: HtmlElementNode,
  preset: SanitizePreset,
): readonly HtmlAttribute[] =>
  node.attrs.filter((attribute) => !isDroppedAttribute(attribute, RULES[preset]));

/**
 * 可执行面的元素清单：`IMPORT_DROPPED_TAGS` 里"能跑代码/能再开一份文档"的子集
 * （`style`/`link`/`template` 这类非执行容器不算）。与整删名单同源演进：
 * 将来 import 预设新删的可执行容器要同步加进这里。
 */
const EXECUTABLE_TAGS: ReadonlySet<string> = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "applet",
  "frame",
  "frameset",
  // SMIL 能改写父节点属性（`attributeName="onload"`、`values="javascript:…"`），属性级探测挡不住。
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
  "mpath",
  "foreignobject",
]);

/** 探测面比剥离面宽：`action`/`formaction` 只在探测侧算"能执行"——整删它们的宿主元素在
 *  两个预设里都整删，剥离名单不必跟进；漏报只是探测漏报。 */
const EXECUTABLE_URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  ...SCRIPT_URL_ATTRIBUTES,
  "action",
  "formaction",
]);

const hasExecutableAttribute = (node: HtmlElementNode): boolean => {
  // `srcdoc` 把整份 HTML 载荷收进属性值：元素级探测摸不到里面，只能按属性本身算。
  if (attributeOf(node, "srcdoc") !== undefined) return true;
  const refreshMeta =
    node.tag.toLowerCase() === "meta" &&
    normalizedUrl(attributeOf(node, "http-equiv") ?? "") === "refresh";
  return node.attrs.some(([name, value]) => {
    const key = name.toLowerCase();
    if (isEventAttribute(key)) return true;
    if (EXECUTABLE_URL_ATTRIBUTES.has(key)) {
      const normalized = normalizedUrl(value);
      if (hasAnyPrefix(normalized, SCRIPT_SCHEMES)) return true;
    }
    // `<meta http-equiv="refresh" content="0; url=javascript:…">`：协议藏在 content 里，
    // 归一化后按子串判（前面还有 `0;url=` 前缀，不能用 startsWith）。
    return (
      refreshMeta &&
      key === "content" &&
      SCRIPT_SCHEMES.some((scheme) => normalizedUrl(value).includes(scheme))
    );
  });
};

/**
 * 文档级"有没有可执行内容"的探测（`GET /api/doc/:id/info` 的 `scripts` 字段）。
 * 它只回答"阅读器该不该给用户'允许脚本'的入口"——真正的防线是 `/s/` 下发的 CSP `sandbox`，
 * 漏报最坏是入口不显，不构成放行。
 */
export const hasExecutableContent = (root: HtmlNode): boolean => {
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (
      node.kind === "element" &&
      (EXECUTABLE_TAGS.has(node.tag.toLowerCase()) || hasExecutableAttribute(node))
    ) {
      return true;
    }
    if (node.kind === "element" || node.kind === "document") {
      for (const child of node.children) stack.push(child);
    }
  }
  return false;
};
