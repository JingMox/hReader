// 这层管：把 HTML 树还原成字符串（属性保序、raw text 不转义、不美化）；不做校验、不碰 IO。

import {
  type HtmlDoctypeNode,
  type HtmlElementNode,
  type HtmlNode,
  type ParsedHtml,
  RAW_TEXT_TAGS,
  VOID_TAGS,
} from "./constants";
import { drainStack } from "./stack";

const escapeText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** 属性值只处理 `&` 和 `"`：其余字符在双引号值里是字面量，多转义会破坏往返。 */
const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const doctypeText = (node: HtmlDoctypeNode): string => {
  const identifiers: string[] = [];
  if (node.publicId.length > 0 || node.systemId.length > 0) {
    identifiers.push(
      node.publicId.length > 0 ? `PUBLIC "${escapeAttribute(node.publicId)}"` : "SYSTEM",
    );
    identifiers.push(`"${escapeAttribute(node.systemId)}"`);
  }
  const suffix = identifiers.length === 0 ? "" : ` ${identifiers.join(" ")}`;
  return `<!DOCTYPE ${node.name}${suffix}>`;
};

const startTagText = (node: HtmlElementNode): string => {
  const attributes = node.attrs
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  return `<${node.tag}${attributes}>`;
};

type Item =
  | { readonly kind: "node"; readonly node: HtmlNode; readonly rawText: boolean }
  | { readonly kind: "literal"; readonly text: string };

const pushChildren = (stack: Item[], children: readonly HtmlNode[], rawText: boolean): void => {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) {
      stack.push({ kind: "node", node: child, rawText });
    }
  }
};

const writeNode = (
  item: Extract<Item, { kind: "node" }>,
  stack: Item[],
  chunks: string[],
): void => {
  const { node, rawText } = item;
  if (node.kind === "text") {
    chunks.push(rawText ? node.value : escapeText(node.value));
    return;
  }
  if (node.kind === "comment") {
    chunks.push(`<!--${node.data}-->`);
    return;
  }
  if (node.kind === "doctype") {
    chunks.push(doctypeText(node));
    return;
  }
  if (node.kind === "document") {
    pushChildren(stack, node.children, rawText);
    return;
  }
  chunks.push(startTagText(node));
  if (VOID_TAGS.has(node.tag)) {
    return;
  }
  stack.push({ kind: "literal", text: `</${node.tag}>` });
  pushChildren(stack, node.children, rawText || RAW_TEXT_TAGS.has(node.tag));
};

export const serializeHtml = (parsed: ParsedHtml): string => {
  const chunks: string[] = [];
  const stack: Item[] = [{ kind: "node", node: parsed.root, rawText: false }];
  for (const item of drainStack(stack)) {
    if (item.kind === "literal") {
      chunks.push(item.text);
      continue;
    }
    writeNode(item, stack, chunks);
  }
  return chunks.join("");
};
