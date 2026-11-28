// Shared adversarial checker: rendered data must stay text, never become elements.
//
// Given a rendered container — a happy-dom Element/Document, a real browser node, or any
// structure-compatible DOM — this asserts that
//   1. the subtree holds no dangerous element (img, script, svg, iframe, object, embed,
//      form, style, link, meta, base) and no <a> whose href resolves to a script scheme;
//   2. the text nodes equal exactly the given data, in order.
// It answers "did the payload stay text" end to end, not "was some pattern filtered".

/** The members of a DOM node this checker reads — satisfied by happy-dom and real DOM nodes. */
export interface DomNodeLike {
  readonly nodeType: number;
  readonly nodeValue?: string | null;
  readonly tagName?: string;
  readonly getAttribute?: (name: string) => string | null;
  readonly childNodes?: Iterable<DomNodeLike> | undefined;
}

/** Anything with children to walk — Element, Document, DocumentFragment, or a fake root. */
export interface DomContainerLike {
  readonly childNodes: Iterable<DomNodeLike>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

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
]);

/** <a> is allowed as an element — but never with a script scheme in href. */
const DANGEROUS_SCHEMES = ["javascript:", "vbscript:"] as const;

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
 * Asserts a rendered container holds no dangerous element and that its text nodes equal
 * `expectedTexts` (document order, exact match — whitespace nodes count too).
 * Throws `Error` with the offending tag or the first text mismatch.
 */
export const assertNoElementsFromData = (
  container: DomContainerLike,
  expectedTexts: readonly string[],
): void => {
  const texts: string[] = [];
  const walk = (node: DomNodeLike): void => {
    if (node.nodeType === ELEMENT_NODE) {
      const tag = (node.tagName ?? "").toLowerCase();
      if (DANGEROUS_TAGS.has(tag)) {
        throw new Error(`data rendered as a dangerous <${tag}> element`);
      }
      if (tag === "a" && node.getAttribute !== undefined) {
        const href = node.getAttribute("href");
        if (
          href !== null &&
          DANGEROUS_SCHEMES.some((scheme) => normalizeScheme(href).startsWith(scheme))
        ) {
          throw new Error(
            `data rendered as <a> with a script-scheme href: ${JSON.stringify(href)}`,
          );
        }
      }
    } else if (node.nodeType === TEXT_NODE) {
      texts.push(node.nodeValue ?? "");
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  for (const child of container.childNodes) walk(child);
  if (texts.length !== expectedTexts.length) {
    throw new Error(
      `rendered text node count ${String(texts.length)} != expected ${String(expectedTexts.length)} (got ${JSON.stringify(texts)})`,
    );
  }
  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i] !== expectedTexts[i]) {
      throw new Error(
        `text node ${String(i)} mismatch: rendered ${JSON.stringify(texts[i])}, expected ${JSON.stringify(expectedTexts[i])}`,
      );
    }
  }
};
