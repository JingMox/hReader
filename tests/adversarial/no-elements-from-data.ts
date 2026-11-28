// Shared adversarial checker: rendered data must stay text, never become elements.
//
// Given a rendered container — a happy-dom Element/Document, a real browser node, or any
// structure-compatible DOM — this asserts that
//   1. the subtree holds no dangerous element (the DANGEROUS_TAGS set below), no element
//      carrying an `on*` handler attribute or a `srcdoc` attribute, and no URL-bearing
//      attribute (href, src, action, formaction, xlink:href) whose scheme — after HTML
//      character-reference decoding and ASCII whitespace/control stripping, as browsers
//      do — is javascript:, vbscript: or data:;
//   2. the text nodes equal exactly the given data, in order.
// It answers "did the payload stay text" end to end, not "was some pattern filtered".
//
// Failure taxonomy: a judgment throws an Error whose message names the violation
// ("data rendered as …" or a text mismatch). A checker defect throws
// `CheckerInternalError` — e.g. an element that exposes neither `attributes` nor
// parse5 `attrs` (a getAttribute-only node cannot be enumerated for `on*`
// handlers, so silence would pass `<b onmouseover=x>`), or any unexpected
// exception inside the walk. An internal crash can therefore never be mistaken
// for a detected violation — and a violation can never hide inside a crash.

/** One attribute as the checker needs it — DOM Attr, NamedNodeMap entries and parse5 attrs fit. */
export interface DomAttrLike {
  readonly name: string;
  readonly value: string;
  /** parse5 puts `xlink` here for namespaced attributes in foreign content. */
  readonly prefix?: string;
}

/** The members of a DOM node this checker reads — satisfied by happy-dom and real DOM nodes. */
export interface DomNodeLike {
  readonly nodeType: number;
  readonly nodeValue?: string | null;
  readonly tagName?: string;
  readonly getAttribute?: (name: string) => string | null;
  /** DOM-style enumerable attributes (a NamedNodeMap is Iterable). */
  readonly attributes?: Iterable<DomAttrLike> | undefined;
  /** parse5-style attribute list. */
  readonly attrs?: readonly DomAttrLike[] | undefined;
  readonly childNodes?: Iterable<DomNodeLike> | undefined;
}

/** Anything with children to walk — Element, Document, DocumentFragment, or a fake root. */
export interface DomContainerLike {
  readonly childNodes: Iterable<DomNodeLike>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * The checker itself failed — not a violation. Thrown when a container cannot be
 * inspected (an element without an enumerable attribute list) and wrapping any
 * unexpected exception inside the walk, so a crash is never confused with a
 * caught payload.
 */
export class CheckerInternalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CheckerInternalError";
  }
}

/** A deliberate judgment — kept distinct so the catch can tell violations from crashes. */
class ViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViolationError";
  }
}

/** Tags whose mere presence under rendered data means the payload executed structural control. */
const DANGEROUS_TAGS: ReadonlySet<string> = new Set([
  "img",
  "script",
  "svg",
  "iframe",
  "object",
  "embed",
  "form",
  "style",
  "link",
  "meta",
  "base",
  // MathML can re-enter HTML parsing through <annotation-xml encoding="text/html">.
  "math",
  "annotation-xml",
  // Media elements add attack surface (handlers on sources, tracks, posters).
  "video",
  "audio",
  "source",
  // Interactive or legacy-active elements.
  "details",
  "marquee",
  // With scripting on in a renderer, <noscript> contents are markup — never let data carry them.
  "noscript",
]);

/** Attributes that load or navigate a URL — their scheme is checked on every element. */
const URL_ATTRS: ReadonlySet<string> = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "xlink:href",
]);

/** Schemes that must never appear in a URL-bearing attribute. */
const DANGEROUS_SCHEMES = ["javascript:", "vbscript:", "data:"] as const;

/**
 * The named character references a scheme check must honor — entities are decoded
 * before checking, exactly like the HTML parser does inside attributes. Numeric
 * references below cover everything else.
 */
const NAMED_REFS: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  Tab: "\t",
  NewLine: "\n",
  sol: "/",
  bsol: "\\",
  lpar: "(",
  rpar: ")",
  equals: "=",
};

/** Decodes HTML character references — numeric (with optional `;`) plus the named table. */
const decodeCharRefs = (value: string): string =>
  value.replace(
    /&(#(?:[0-9]+|[xX][0-9a-fA-F]+);?|[A-Za-z][A-Za-z0-9]+;)/gu,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const digits = body.slice(hex ? 2 : 1).replace(/;$/u, "");
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          return "�";
        }
        return String.fromCodePoint(code);
      }
      const name = body.slice(0, -1);
      return NAMED_REFS[name] ?? match;
    },
  );

/** URL-scheme normalization per the URL parser: drop ASCII whitespace/controls, then lowercase. */
const normalizeScheme = (value: string): string => {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code > 0x20 && code !== 0x7f) out += ch;
  }
  return out.toLowerCase();
};

/**
 * Every attribute of the node as lowercase `prefix:name` pairs. Sources, in order:
 * DOM `attributes` (iterable), parse5 `attrs`, then `getAttribute` for the fixed
 * URL/srcdoc names — so a container exposing only `getAttribute` is still covered.
 */
const attributesOf = (node: DomNodeLike): { name: string; value: string }[] => {
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: string, prefix?: string): void => {
    const lowerName = name.toLowerCase();
    const lowerPrefix = (prefix ?? "").toLowerCase();
    // An Attr whose name already carries the prefix (name="xlink:href",
    // prefix="xlink") must not double it into "xlink:xlink:href".
    const qualified =
      lowerPrefix === "" || lowerName.startsWith(`${lowerPrefix}:`)
        ? lowerName
        : `${lowerPrefix}:${lowerName}`;
    if (seen.has(qualified)) return;
    seen.add(qualified);
    out.push({ name: qualified, value });
  };
  if (node.attributes !== undefined) {
    for (const attr of node.attributes) add(attr.name, attr.value, attr.prefix);
  }
  if (node.attrs !== undefined) {
    for (const attr of node.attrs) add(attr.name, attr.value, attr.prefix);
  }
  if (node.getAttribute !== undefined) {
    for (const name of [...URL_ATTRS, "srcdoc"]) {
      const value = node.getAttribute(name);
      if (value !== null) add(name, value);
    }
  }
  return out;
};

/**
 * Defensive bounds — a synthetic or hostile container may hand back cyclic,
 * self-referencing, or infinite `childNodes`; the walk must fail loud instead
 * of hanging or eating memory.
 */
const MAX_VISITED_NODES = 5_000_000;
const MAX_CHILDREN_READ = 5_000_000;

/**
 * Reads an iterable of children into an array with a hard bound. `for..of`
 * terminates a generator cleanly on throw; a spread (`[...iterable]`) would
 * iterate forever on an infinite source.
 */
const readChildren = (iterable: Iterable<DomNodeLike>, owner: string): DomNodeLike[] => {
  const kids: DomNodeLike[] = [];
  for (const kid of iterable) {
    kids.push(kid);
    if (kids.length > MAX_CHILDREN_READ) {
      throw new CheckerInternalError(
        `${owner} lists more than ${String(MAX_CHILDREN_READ)} children — refusing to continue`,
      );
    }
  }
  return kids;
};

/**
 * Asserts a rendered container holds no dangerous element and that its text nodes equal
 * `expectedTexts` (document order, exact match — whitespace nodes count too).
 * Throws an Error naming the violation on a judgment, `CheckerInternalError` when
 * the container cannot be inspected, the tree is cyclic or oversized, or the walk
 * itself crashes.
 */
const walkContainer = (container: DomContainerLike, expectedTexts: readonly string[]): void => {
  const texts: string[] = [];
  const visited = new Set<DomNodeLike>();
  // An explicit stack, not recursion — corpus payloads nest thousands deep.
  const stack = readChildren(container.childNodes, "the container").reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (visited.has(node)) {
      throw new CheckerInternalError(
        "container revisited a node — childNodes is cyclic or aliased",
      );
    }
    visited.add(node);
    if (visited.size > MAX_VISITED_NODES) {
      throw new CheckerInternalError(
        `container exceeds ${String(MAX_VISITED_NODES)} visited nodes — refusing to continue`,
      );
    }
    if (node.nodeType === ELEMENT_NODE) {
      const tag = (node.tagName ?? "").toLowerCase();
      if (DANGEROUS_TAGS.has(tag)) {
        throw new ViolationError(`data rendered as a dangerous <${tag}> element`);
      }
      if (node.attributes === undefined && node.attrs === undefined) {
        // Only getAttribute remains — fine for the fixed URL/srcdoc names, but
        // on* handlers are open-ended and cannot be enumerated. Failing closed
        // is the only honest answer.
        throw new CheckerInternalError(
          `cannot inspect <${tag}>: the container exposes neither 'attributes' nor parse5 'attrs', so on* handlers would go unchecked`,
        );
      }
      for (const attr of attributesOf(node)) {
        if (attr.name.startsWith("on")) {
          throw new ViolationError(
            `data rendered as <${tag}> with a handler attribute ${JSON.stringify(attr.name)}`,
          );
        }
        if (attr.name === "srcdoc") {
          throw new ViolationError(`data rendered as <${tag}> with a srcdoc attribute`);
        }
        if (URL_ATTRS.has(attr.name)) {
          const scheme = normalizeScheme(decodeCharRefs(attr.value));
          for (const bad of DANGEROUS_SCHEMES) {
            if (scheme.startsWith(bad)) {
              throw new ViolationError(
                `data rendered as <${tag}> with a dangerous-scheme ${attr.name}: ${JSON.stringify(attr.value)}`,
              );
            }
          }
        }
      }
    } else if (node.nodeType === TEXT_NODE) {
      texts.push(node.nodeValue ?? "");
    }
    if (node.childNodes !== undefined) {
      // Loop-push, never a spread into push(): hundreds of thousands of
      // children would exceed the engine's argument-count limit (RangeError).
      const kids = readChildren(
        node.childNodes,
        `a <${node.tagName?.toLowerCase() ?? "unknown"}> node`,
      );
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        const kid = kids[i];
        if (kid !== undefined) stack.push(kid);
      }
    }
  }
  if (texts.length !== expectedTexts.length) {
    throw new ViolationError(
      `rendered text node count ${String(texts.length)} != expected ${String(expectedTexts.length)} (got ${JSON.stringify(texts)})`,
    );
  }
  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i] !== expectedTexts[i]) {
      throw new ViolationError(
        `text node ${String(i)} mismatch: rendered ${JSON.stringify(texts[i])}, expected ${JSON.stringify(expectedTexts[i])}`,
      );
    }
  }
};

export const assertNoElementsFromData = (
  container: DomContainerLike,
  expectedTexts: readonly string[],
): void => {
  try {
    walkContainer(container, expectedTexts);
  } catch (error) {
    if (error instanceof ViolationError || error instanceof CheckerInternalError) throw error;
    throw new CheckerInternalError("assertNoElementsFromData crashed internally", {
      cause: error,
    });
  }
};
