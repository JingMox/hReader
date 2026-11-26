// Escapes HTML text and attribute values and assembles attribute strings; no tree traversal, no node semantics.

/** These three characters must be escaped in text nodes, or a `<` turns body text back into markup — the first door to XSS. */
export const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Attribute values escape one more character: every attribute is double-quoted, so an early `"` would break out of the attribute context. */
export const escapeAttribute = (value: string): string =>
  escapeText(value).replaceAll('"', "&quot;");

export const utf8LengthOf = (text: string): number => new TextEncoder().encode(text).length;

/** Attribute string including the leading space of each attribute; an empty list returns "", so callers need no null check. */
export const attributeStringOf = (attrs: readonly (readonly [string, string])[]): string =>
  attrs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
