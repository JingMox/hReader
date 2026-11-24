// 这层管：外来 HTML → 托管文档的纯转换（主干选择 → import 剥离 → 语义投影 → 分节 → 骨架 + 注入 id）；
// 不碰 IO、不读时钟——同一输入必须产出同一串字节（patch/undo 依赖可重复的锚点）。

import {
  type HtmlAttribute,
  type HtmlElementNode,
  type HtmlNode,
  type ParsedHtml,
} from "../html/constants";
import { injectNodeIds } from "../html/inject";
import { parseHtml } from "../html/parse";
import { attributeOf, isDroppedNode, normalizedUrl, sanitizedAttributesOf } from "../html/sanitize";
import { serializeHtml } from "../html/serialize";
import { drainStack } from "../html/stack";
import { normalizeWhitespace, textContentOf } from "../html/text";
import { HrError } from "../hr-error";
import { checkLayout } from "../layout/check";
import { DEFAULT_DOC_KIND, KIND_ATTRIBUTE, type DocKind } from "../layout/kinds";
import { classifyDocument } from "../model/classify";
import { validateDocument } from "../model/validate";

export interface ImportOptions {
  readonly kind?: DocKind;
  readonly title?: string;
}

/** 丢弃内容的聚合条目：`what` 是标签（`script`）或属性类别（`on*`、`data-hr-*`），按首见顺序聚合。 */
export interface ImportDiscard {
  readonly what: string;
  readonly reason: string;
  readonly count: number;
}

export interface ImportReport {
  readonly kind: DocKind;
  readonly title: string;
  /** 标题出处：显式参数 → `<title>` → 首个 `<h1>` → 兜底文案。 */
  readonly titleSource: "option" | "title" | "h1" | "fallback";
  /** 主干判定：`main` 命中 `<main>`；`largest` 命中 body 下文本量占多数的子树；`body` 兜底。 */
  readonly trunk: "main" | "largest" | "body";
  /** `trunk === "largest"` 时选中的 body 子树标签；其余恒为 `undefined`。 */
  readonly trunkTag: string | undefined;
  /** 生成的顶层 `<section>` 数（slides 形态即页数）。 */
  readonly sections: number;
  /** 整棵删除的元素数（脚本/控件/装饰/页面框架等合计）。 */
  readonly removedElements: number;
  /** 剥掉的属性数（事件、内联 style、`data-hr-*`、交互残留等合计）。 */
  readonly strippedAttributes: number;
  readonly discarded: readonly ImportDiscard[];
}

export interface ImportResult {
  readonly html: string;
  readonly report: ImportReport;
}

/* ---------------------------- 主干选择 ---------------------------- */

/** 页面框架：既不是主干候选，也不进产物（`nav` 菜单链不是正文）。 */
const CHROME_TAGS: ReadonlySet<string> = new Set(["nav", "header", "footer", "aside"]);

const childrenOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const firstElementOf = (root: HtmlNode, tag: string): HtmlElementNode | undefined => {
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind === "element" && node.tag === tag) return node;
    for (const child of [...childrenOf(node)].reverse()) stack.push(child);
  }
  return undefined;
};

interface Trunk {
  readonly how: "main" | "largest" | "body";
  readonly node: HtmlElementNode | undefined;
  readonly tag: string | undefined;
}

/**
 * "文本量最大的子树"只在一家独大时成立：候选必须比其他候选的文本量总和还多。
 * 没有支配者时回退 body——多页演示稿的兄弟 `<section class="slide">` 体量相近，
 * 取 argmax 会只留下一页，那种"最大"不是主干、只是碰巧字多。
 */
const largestOf = (body: HtmlElementNode): HtmlElementNode | undefined => {
  const candidates = body.children.flatMap((child) => {
    if (child.kind !== "element" || CHROME_TAGS.has(child.tag)) return [];
    if (isDroppedNode(child, "import")) return [];
    const textLength = normalizeWhitespace(textContentOf(child)).length;
    return textLength > 0 ? [{ node: child, textLength }] : [];
  });
  let best: { readonly node: HtmlElementNode; readonly textLength: number } | undefined;
  let rest = 0;
  for (const candidate of candidates) {
    if (best === undefined || candidate.textLength > best.textLength) {
      rest += best?.textLength ?? 0;
      best = candidate;
    } else {
      rest += candidate.textLength;
    }
  }
  return best !== undefined && best.textLength > rest ? best.node : undefined;
};

const trunkOf = (root: HtmlNode): Trunk => {
  const main = firstElementOf(root, "main");
  if (main !== undefined) return { how: "main", node: main, tag: "main" };
  const body = firstElementOf(root, "body");
  if (body === undefined) return { how: "body", node: undefined, tag: "body" };
  const largest = largestOf(body);
  if (largest !== undefined) return { how: "largest", node: largest, tag: largest.tag };
  return { how: "body", node: body, tag: "body" };
};

const QUIET_HEAD_TAGS: ReadonlySet<string> = new Set(["title", "meta"]);

/** `<head>` 只剩 title/meta 时是解析伴生壳（标题另计、charset 由产物自带）；装了别的才算被丢。 */
const isMeaningfulHead = (node: HtmlElementNode): boolean =>
  node.children.some((child) => child.kind === "element" && !QUIET_HEAD_TAGS.has(child.tag));

/** 主干连同它的全部祖先（路径集合）：不在路径上的元素是"主干之外"，整棵只算一项丢弃。 */
const trunkPathOf = (root: HtmlNode, trunk: HtmlElementNode): ReadonlySet<HtmlNode> => {
  const path = new Set<HtmlNode>([trunk]);
  const walk = (node: HtmlNode): boolean => {
    if (node === trunk) return true;
    if (node.kind !== "element" && node.kind !== "document") return false;
    for (const child of node.children) {
      if (walk(child)) {
        path.add(node);
        return true;
      }
    }
    return false;
  };
  walk(root);
  return path;
};

/**
 * 主干之外的元素整棵丢弃：按最外层计一次（`<main>` 的兄弟 nav、装资源的 `<head>` 等），
 * 让"剥掉了多少"把文档头与页面框架也纳入口径。路径上的节点只负责下钻，不计数。
 */
const recordOutsideTrunk = (
  node: HtmlNode,
  trunk: HtmlElementNode,
  path: ReadonlySet<HtmlNode>,
  counters: Counters,
): void => {
  // 主干本身直接停：它的子树归剥离/投影层管，不是"之外"。
  if (node === trunk || (node.kind !== "element" && node.kind !== "document")) return;
  if (!path.has(node)) {
    if (node.kind === "element" && (node.tag !== "head" || isMeaningfulHead(node))) {
      dropElement(counters, node.tag, "主干之外（文档头与页面框架）");
    }
    return;
  }
  for (const child of node.children) recordOutsideTrunk(child, trunk, path, counters);
};

/* ---------------------------- 剥离 ---------------------------- */

interface Counters {
  removedElements: number;
  strippedAttributes: number;
  readonly discarded: Map<string, ImportDiscard>;
}

const discard = (counters: Counters, what: string, reason: string): void => {
  const key = `${what}${reason}`;
  const entry = counters.discarded.get(key);
  counters.discarded.set(
    key,
    entry === undefined ? { what, reason, count: 1 } : { ...entry, count: entry.count + 1 },
  );
};

/** 整删元素：进聚合 + 计入 `removedElements`（注释/属性走 `discard`，不计元素数）。 */
const dropElement = (counters: Counters, what: string, reason: string): void => {
  counters.removedElements += 1;
  discard(counters, what, reason);
};

const stripAttribute = (counters: Counters, what: string, reason: string): void => {
  counters.strippedAttributes += 1;
  discard(counters, `属性 ${what}`, reason);
};

/** 整删原因按标签归类；`isDroppedNode` 的判定集合是单一事实源，这里只配文案。 */
const dropReasonOf = (node: HtmlElementNode): string => {
  const tag = node.tag.toLowerCase();
  if (tag === "script") return "可执行脚本";
  if (["animate", "animatemotion", "animatetransform", "set", "discard", "mpath"].includes(tag)) {
    return "SMIL 动画";
  }
  if (["iframe", "object", "embed", "applet", "frame", "frameset", "foreignobject"].includes(tag)) {
    return "嵌入内容";
  }
  if (["style", "link", "base", "meta"].includes(tag)) return "样式或资源声明";
  if (["video", "audio"].includes(tag)) return "外部媒体";
  if (["form", "button", "input", "select", "textarea"].includes(tag)) return "交互控件";
  if (["template", "noscript", "noembed", "noframes", "xmp", "plaintext"].includes(tag)) {
    return "隐藏或原始文本壳";
  }
  if (["image", "use", "feimage"].includes(tag)) return "SVG 外部资源引用";
  // 走到这里只剩 data-hr-ui / hr-* 类名命中的节点。
  return "hReader UI 残留";
};

const attrBucketOf = (name: string): { readonly what: string; readonly reason: string } => {
  const key = name.toLowerCase();
  if (key.startsWith("on")) return { what: "on*", reason: "事件处理属性" };
  if (key === "style") return { what: "style", reason: "内联样式（长相归主题）" };
  if (key.startsWith("data-hr-")) return { what: "data-hr-*", reason: "hReader 内部命名空间" };
  return { what: key, reason: "交互、隐藏或伪协议属性" };
};

const stripAttributes = (node: HtmlElementNode, counters: Counters): readonly HtmlAttribute[] => {
  const kept = sanitizedAttributesOf(node, "import");
  if (kept.length === node.attrs.length) return kept;
  for (const attribute of node.attrs) {
    if (kept.includes(attribute)) continue;
    const bucket = attrBucketOf(attribute[0]);
    stripAttribute(counters, bucket.what, bucket.reason);
  }
  return kept;
};

const DATA_IMAGE_PREFIX = "data:image/";

/** 相对路径（协议头与 `//` 外联都没有）或内联 `data:image/`。产物与源同目录落盘，相对路径仍然有效。 */
const isLocalUrl = (value: string): boolean => {
  const normalized = normalizedUrl(value);
  if (normalized.startsWith(DATA_IMAGE_PREFIX)) return true;
  return !normalized.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/u.test(normalized);
};

/**
 * `srcset` 的每个候选都要本地化，任一外联整条剥。候选整串（含 `1x`/`2x` 描述符）直接过
 * `isLocalUrl`：归一化会吃掉空白，描述符只剩粘回 URL 尾部的密度字符，不影响协议判定。
 */
const isLocalSrcset = (value: string): boolean =>
  value.split(",").every((candidate) => candidate.trim() !== "" && isLocalUrl(candidate));

/** `<img>` 的去留看剥离后的 src：缺 src 是坏图；外链图整节点丢（属性剥法挡不住 `src` 整值）。 */
const scrubImg = (
  node: HtmlElementNode,
  attrs: readonly HtmlAttribute[],
  counters: Counters,
): HtmlElementNode | undefined => {
  const src = attrs.find(([name]) => name.toLowerCase() === "src")?.[1];
  if (src === undefined) {
    dropElement(counters, "img", "缺少 src 的坏图");
    return undefined;
  }
  if (!isLocalUrl(src)) {
    dropElement(counters, "img", "外链图片（只保留 data: 或相对路径）");
    return undefined;
  }
  const cleaned = attrs.filter(([name, value]) => {
    if (name.toLowerCase() === "srcset" && !isLocalSrcset(value)) {
      stripAttribute(counters, "srcset", "外链 srcset");
      return false;
    }
    return true;
  });
  return { kind: "element", tag: node.tag, attrs: cleaned, children: [] };
};

/** import 预设的整删 + 属性剥离；注释不进托管正文（外来注释是源文档的编辑痕迹，不是内容）。 */
const scrubbedOf = (node: HtmlNode, counters: Counters): HtmlNode | undefined => {
  if (node.kind !== "element") {
    if (node.kind === "text") return node;
    discard(counters, "注释", "注释不进托管正文");
    return undefined;
  }
  if (isDroppedNode(node, "import")) {
    dropElement(counters, node.tag, dropReasonOf(node));
    return undefined;
  }
  const attrs = stripAttributes(node, counters);
  if (node.tag === "img") return scrubImg(node, attrs, counters);
  const children = node.children.flatMap((child) => {
    const scrubbed = scrubbedOf(child, counters);
    return scrubbed === undefined ? [] : [scrubbed];
  });
  return { kind: "element", tag: node.tag, attrs, children };
};

/* ---------------------------- 语义投影 ---------------------------- */

/** 起新 section 的标题层。 */
const SECTION_HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2"]);

/** 顶层块保留集：h3+ 留在节内当小节标题。 */
const KEPT_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "dl",
  "table",
  "figure",
  "blockquote",
  "pre",
  "hr",
  "details",
]);

/** 行内保留集：顶层出现时攒进 `<p>` 运行段。 */
const KEPT_INLINE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "ins",
  "kbd",
  "mark",
  "q",
  "rp",
  "rt",
  "s",
  "samp",
  "small",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
]);

/** 结构标签：只在被保留的块里当骨架（ul>li、table>tr）；顶层裸奔时按普通容器拆开。 */
const KEPT_STRUCT_TAGS: ReadonlySet<string> = new Set([
  "li",
  "dt",
  "dd",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "figcaption",
  "summary",
]);

const KEPT_TAGS: ReadonlySet<string> = new Set([
  ...KEPT_BLOCK_TAGS,
  ...KEPT_INLINE_TAGS,
  ...KEPT_STRUCT_TAGS,
  "h1",
  "h2",
]);

/** 绘图语义：子树整体丢，连文本都不当正文（装饰性 div 里的字要留，但 SVG 的坐标不是字）。 */
const DROP_SUBTREE_TAGS: ReadonlySet<string> = new Set(["svg", "math", "canvas", "map"]);

const elementOf = (
  tag: string,
  attrs: readonly HtmlAttribute[],
  children: readonly HtmlNode[],
): HtmlElementNode => ({ kind: "element", tag, attrs, children });

/** 行内容器（含 `pre`）里的空白是内容；块容器里只有空白文本的节点是源文档的缩进噪声。 */
const whitespaceContextOf = (tag: string): boolean => KEPT_INLINE_TAGS.has(tag) || tag === "pre";

const projectInner = (
  parentTag: string,
  children: readonly HtmlNode[],
  counters: Counters,
): HtmlNode[] => {
  const keepWhitespace = whitespaceContextOf(parentTag);
  const out: HtmlNode[] = [];
  for (const child of children) {
    if (child.kind === "text") {
      if (keepWhitespace || normalizeWhitespace(child.value) !== "") out.push(child);
      continue;
    }
    // 剥离层只留 element/text：注释与声明节点到不了这里，`child` 必为元素。
    /* v8 ignore next */
    if (child.kind !== "element") continue;
    const tag = child.tag;
    if (DROP_SUBTREE_TAGS.has(tag)) {
      dropElement(counters, tag, "绘图语义");
      continue;
    }
    if (KEPT_TAGS.has(tag)) {
      out.push(elementOf(tag, child.attrs, projectInner(tag, child.children, counters)));
      continue;
    }
    // 不在保留集的容器（span/div/font/center…）：只留子树，壳本身没有语义。
    out.push(...projectInner(tag, child.children, counters));
  }
  return out;
};

/** 运行段攒成 `<p>`：splice 换新数组——run 还要继续攒，`<p>` 的 children 不能被同一个数组的清空带走。 */
const flushRun = (run: HtmlNode[], out: HtmlNode[]): void => {
  if (run.length > 0) out.push(elementOf("p", [], run.splice(0)));
};

/** 主干 → 块流：不在保留集的容器（div/section/article…）就地拆开，子节点上提到本层。 */
const projectBlocks = (
  children: readonly HtmlNode[],
  out: HtmlNode[],
  counters: Counters,
): void => {
  const run: HtmlNode[] = [];
  for (const child of children) {
    if (child.kind === "text") {
      if (normalizeWhitespace(child.value) !== "") run.push(child);
      continue;
    }
    // 同上：剥离层只留 element/text。
    /* v8 ignore next */
    if (child.kind !== "element") continue;
    const tag = child.tag;
    if (DROP_SUBTREE_TAGS.has(tag) || CHROME_TAGS.has(tag)) {
      dropElement(
        counters,
        tag,
        DROP_SUBTREE_TAGS.has(tag) ? "绘图语义" : "页面框架（导航/页眉/页脚/侧栏）",
      );
      continue;
    }
    if (SECTION_HEADING_TAGS.has(tag) || KEPT_BLOCK_TAGS.has(tag)) {
      flushRun(run, out);
      out.push(elementOf(tag, child.attrs, projectInner(tag, child.children, counters)));
      continue;
    }
    if (KEPT_INLINE_TAGS.has(tag)) {
      run.push(elementOf(tag, child.attrs, projectInner(tag, child.children, counters)));
      continue;
    }
    flushRun(run, out);
    projectBlocks(child.children, out, counters);
  }
  flushRun(run, out);
};

/* ---------------------------- 分节与标题 ---------------------------- */

interface Draft {
  readonly heading: HtmlElementNode | undefined;
  readonly blocks: readonly HtmlNode[];
}

/** 节标题统一降级成 `<h2>`（文档级 `<h1>` 只有一个，就是标题）；文本归一后重建，嵌套标记不进标题。 */
const sectionHeadingOf = (node: HtmlElementNode): HtmlElementNode =>
  elementOf("h2", [], [{ kind: "text", value: normalizeWhitespace(textContentOf(node)) }]);

const sectionsOf = (blocks: readonly HtmlNode[]): readonly Draft[] => {
  const drafts: Draft[] = [];
  let heading: HtmlElementNode | undefined;
  let current: HtmlNode[] = [];
  const close = (): void => {
    if (heading === undefined && current.length === 0) return;
    drafts.push({ heading, blocks: current });
    heading = undefined;
    current = [];
  };
  for (const block of blocks) {
    if (block.kind === "element" && SECTION_HEADING_TAGS.has(block.tag)) {
      close();
      heading = sectionHeadingOf(block);
      continue;
    }
    current.push(block);
  }
  close();
  return drafts;
};

const titleFromTag = (root: HtmlNode): string | undefined => {
  const title = firstElementOf(root, "title");
  if (title === undefined) return undefined;
  const text = normalizeWhitespace(textContentOf(title));
  return text === "" ? undefined : text;
};

/* ---------------------------- 装配 ---------------------------- */

const documentOf = (
  kind: DocKind,
  lang: string,
  title: string,
  article: HtmlElementNode,
): ParsedHtml => {
  const head = elementOf(
    "head",
    [],
    [
      elementOf("meta", [["charset", "utf-8"]], []),
      elementOf(
        "meta",
        [
          ["name", "viewport"],
          ["content", "width=device-width, initial-scale=1"],
        ],
        [],
      ),
      elementOf("title", [], [{ kind: "text", value: title }]),
    ],
  );
  const body =
    kind === "slides"
      ? elementOf("body", [], [article])
      : elementOf("body", [], [elementOf("main", [["class", "hr-layout"]], [article])]);
  const root: HtmlNode = {
    kind: "document",
    children: [
      { kind: "doctype", name: "html", publicId: "", systemId: "" },
      elementOf("html", [["lang", lang]], [head, body]),
    ],
  };
  return { root, diagnostics: [] };
};

const langOf = (root: HtmlNode): string => {
  const html = firstElementOf(root, "html");
  const lang = html === undefined ? "" : normalizeWhitespace(attributeOf(html, "lang") ?? "");
  return lang === "" ? "zh" : lang;
};

/**
 * 输入已是托管文档（`classifyDocument` 判 managed）时拒绝转换：再导一遍会重写全部 id、
 * 让既有批注锚点全部失效。`normalizable`（有 `<article>` 但缺合法 id）不在此列——
 * 外来网页恰好含一个 `<article>` 是常态，那种文档该走的就是 import。
 */
export const importForeign = (html: string, options: ImportOptions = {}): ImportResult => {
  const parsed = parseHtml(html);
  if (classifyDocument(parsed).cls === "managed") {
    throw new HrError(
      "invalid_input",
      "文档已是托管文档（<article> 已带合法 data-hr-id），hr import 只用于外来 HTML",
    );
  }
  const counters: Counters = { removedElements: 0, strippedAttributes: 0, discarded: new Map() };
  const trunk = trunkOf(parsed.root);
  if (trunk.node !== undefined) {
    recordOutsideTrunk(parsed.root, trunk.node, trunkPathOf(parsed.root, trunk.node), counters);
  }
  const children = trunk.node === undefined ? [] : trunk.node.children;
  const scrubbed = children.flatMap((child) => {
    const kept = scrubbedOf(child, counters);
    return kept === undefined ? [] : [kept];
  });
  const blocks: HtmlNode[] = [];
  projectBlocks(scrubbed, blocks, counters);

  let title = options.title;
  let titleSource: ImportReport["titleSource"] = "option";
  if (title === undefined) {
    title = titleFromTag(parsed.root);
    titleSource = "title";
  }
  let firstH1: HtmlElementNode | undefined;
  if (title === undefined) {
    titleSource = "h1";
    firstH1 = blocks.find(
      (block): block is HtmlElementNode => block.kind === "element" && block.tag === "h1",
    );
    title = firstH1 === undefined ? undefined : normalizeWhitespace(textContentOf(firstH1));
  }
  if (title === undefined || title === "") {
    title = "未命名";
    titleSource = "fallback";
  }
  // 标题取自首个 h1 时把它从块流里吃掉：文档标题与"第一节标题"是同一段文字，不重复出现。
  const flow = firstH1 === undefined ? blocks : blocks.filter((block) => block !== firstH1);
  const drafts = sectionsOf(flow);
  const kind = options.kind ?? DEFAULT_DOC_KIND;

  const article = elementOf(
    "article",
    [
      ["data-hr-id", "root"],
      [KIND_ATTRIBUTE, kind],
    ],
    [
      elementOf("h1", [], [{ kind: "text", value: title }]),
      ...drafts.map((draft) =>
        elementOf(
          "section",
          [],
          draft.heading === undefined ? draft.blocks : [draft.heading, ...draft.blocks],
        ),
      ),
    ],
  );
  const injected = injectNodeIds(documentOf(kind, langOf(parsed.root), title, article));

  // 产物自证：必须是 managed、且零 error 级诊断。过不了是 import 自己的 bug，不落盘也不回半成品。
  // 结构由本文件手工装配（单个带合法 id 的 article、无重复 id），失败分支只能靠代码缺陷到达——
  // 但它宁可误杀也不该把带病产物交出去，故保留。
  const classification = classifyDocument(injected.parsed);
  const errors = [
    ...validateDocument(injected.parsed),
    ...checkLayout(injected.parsed.root),
  ].filter((diagnostic) => diagnostic.severity === "error");
  /* v8 ignore start */
  if (classification.cls !== "managed" || errors.length > 0) {
    const detail = errors
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("；");
    throw new HrError(
      "invalid_document",
      `导入产物未通过托管校验（${classification.cls}${detail === "" ? "" : `；${detail}`}）`,
    );
  }
  /* v8 ignore stop */

  return {
    html: serializeHtml(injected.parsed),
    report: {
      kind,
      title,
      titleSource,
      trunk: trunk.how,
      trunkTag: trunk.how === "largest" ? trunk.tag : undefined,
      sections: drafts.length,
      removedElements: counters.removedElements,
      strippedAttributes: counters.strippedAttributes,
      discarded: [...counters.discarded.values()],
    },
  };
};
