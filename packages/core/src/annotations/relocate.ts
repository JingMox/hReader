// This layer: structural selector paths (`body > div:nth-of-type(2) > p:nth-of-type(3)`)
// and anchor relocation across all three document classes. Pure: no IO, no clock.
// Failure is a value (`orphaned` / `anchor_lost` / `ambiguous`), never a throw and never a delete.

import type { HtmlElementNode, HtmlNode } from "../html/constants";
import { HR_ID_ATTRIBUTE } from "../html/constants";
import { parseHtml } from "../html/parse";
import { drainStack } from "../html/stack";
import { textContentOf } from "../html/text";
import { attributeOf } from "../model/attrs";
import { classifyDocument } from "../model/classify";
import type { DocumentModel } from "../model/constants";
import { toDocumentModel } from "../model/derive";
import { matchAnchorInText, type AnchorFailure, type AnchorResult } from "./anchor";
import { bodyTextOf } from "./body-text";
import type { TextAnchor } from "./model";
import { elementsOf } from "./meta-insert";
import type { SidecarAnnotation } from "./sidecar-model";

// ---- selector path: narrow grammar, char scanner, no regex over the input ----

/** One `>`-separated step: a tag, optionally with `:nth-of-type(n)` (1-based, same-tag siblings). */
export interface SelectorStep {
  readonly tag: string;
  readonly nth: number;
}

/** Structural bounds: a malicious selector string fails fast and flat, never deep. */
export const SELECTOR_LIMITS = { chars: 1024, steps: 64, nth: 9999 } as const;

const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9-]/;
const DIGIT = /[0-9]/;
const SPACE = /[ \t\n\r]/;
const PSEUDO = ":nth-of-type(";

interface Scan {
  readonly text: string;
  position: number;
}

const skipSpaces = (scan: Scan): void => {
  for (;;) {
    const character = scan.text[scan.position];
    if (character === undefined || !SPACE.test(character)) return;
    scan.position += 1;
  }
};

const takeRun = (scan: Scan, accepted: RegExp): string => {
  const start = scan.position;
  for (;;) {
    const character = scan.text[scan.position];
    if (character === undefined || !accepted.test(character)) {
      return scan.text.slice(start, scan.position);
    }
    scan.position += 1;
  }
};

const takeName = (scan: Scan): string | undefined => {
  const head = scan.text[scan.position] ?? "";
  if (!NAME_START.test(head)) return undefined;
  scan.position += 1;
  return `${head}${takeRun(scan, NAME_CHAR)}`;
};

const takeNth = (scan: Scan): number | undefined => {
  if (!scan.text.slice(scan.position).toLowerCase().startsWith(PSEUDO)) return 1;
  scan.position += PSEUDO.length;
  const digits = takeRun(scan, DIGIT);
  if (digits.length === 0) return undefined;
  if (scan.text[scan.position] !== ")") return undefined;
  scan.position += 1;
  const nth = Number.parseInt(digits, 10);
  return nth >= 1 && nth <= SELECTOR_LIMITS.nth ? nth : undefined;
};

/**
 * Grammar: `name (":" "nth-of-type(n)")?` steps joined by `>` (spaces tolerated).
 * Anything else — empty, truncated, unknown pseudo — is `undefined`: an unparseable
 * selector is a selector that cannot match, which falls back to the body text domain.
 */
export const parseSelectorPath = (selector: string): readonly SelectorStep[] | undefined => {
  const scan: Scan = { text: selector.trim(), position: 0 };
  if (scan.text.length === 0 || scan.text.length > SELECTOR_LIMITS.chars) return undefined;
  const steps: SelectorStep[] = [];
  for (;;) {
    skipSpaces(scan);
    const name = takeName(scan);
    if (name === undefined) return undefined;
    const nth = takeNth(scan);
    if (nth === undefined) return undefined;
    steps.push({ tag: name.toLowerCase(), nth });
    if (steps.length > SELECTOR_LIMITS.steps) return undefined;
    skipSpaces(scan);
    if (scan.position === scan.text.length) return steps;
    if (scan.text[scan.position] !== ">") return undefined;
    scan.position += 1;
  }
};

// ---- element lookup ----

const childrenOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

interface Entry {
  readonly node: HtmlElementNode;
  /** 0-based index among same-tag element siblings; `nth-of-type(n)` compares `n - 1` to it. */
  readonly tagIndex: number;
}

/** Push element children in reverse so the LIFO stack yields document order. */
const pushEntries = (children: readonly HtmlNode[], stack: Entry[]): void => {
  const counts = new Map<string, number>();
  const entries: Entry[] = [];
  for (const child of children) {
    if (child.kind !== "element") continue;
    const tagIndex = counts.get(child.tag) ?? 0;
    counts.set(child.tag, tagIndex + 1);
    entries.push({ node: child, tagIndex });
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined) stack.push(entry);
  }
};

const matchesStep = (entry: Entry, step: SelectorStep): boolean =>
  entry.node.tag === step.tag && entry.tagIndex === step.nth - 1;

/** Direct descent: among `current`'s element children, the unique `nth`-of-`tag` one. */
const descend = (current: HtmlElementNode, step: SelectorStep): HtmlElementNode | undefined => {
  const counts = new Map<string, number>();
  for (const child of current.children) {
    if (child.kind !== "element") continue;
    const tagIndex = counts.get(child.tag) ?? 0;
    counts.set(child.tag, tagIndex + 1);
    if (child.tag === step.tag && tagIndex === step.nth - 1) return child;
  }
  return undefined;
};

/**
 * Step 0 matches the first element in document order satisfying `tag` + `nth-of-type` —
 * that is what makes `body > ...` and `html > body > ...` paths both work; later steps
 * descend direct children only. Any step missing means the selector no longer matches.
 */
export const elementByPath = (
  root: HtmlNode,
  steps: readonly SelectorStep[],
): HtmlElementNode | undefined => {
  const first = steps[0];
  if (first === undefined) return undefined;
  const stack: Entry[] = [];
  pushEntries(childrenOf(root), stack);
  let current: HtmlElementNode | undefined;
  for (const entry of drainStack(stack)) {
    if (matchesStep(entry, first)) {
      current = entry.node;
      break;
    }
    pushEntries(entry.node.children, stack);
  }
  if (current === undefined) return undefined;
  for (const step of steps.slice(1)) {
    const next = descend(current, step);
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
};

// ---- relocation ----

/** Which text domain the anchor was matched in; `none` = the record has no locating info at all. */
export type RelocateVia = "node" | "selector" | "body" | "none";

export type RelocateResult =
  | { readonly ok: true; readonly start: number; readonly end: number; readonly via: RelocateVia }
  | { readonly ok: false; readonly reason: AnchorFailure; readonly via: RelocateVia };

const failed = (reason: AnchorFailure, via: RelocateVia): RelocateResult => ({
  ok: false,
  reason,
  via,
});

const matched = (result: AnchorResult, via: RelocateVia): RelocateResult =>
  result.ok
    ? { ok: true, start: result.start, end: result.end, via }
    : { ok: false, reason: result.reason, via };

/** Preorder flatten of the model: same traversal `flattenOf` gives `blockBasisOf`. */
const flattenModel = (model: DocumentModel): readonly DocumentModel[] => {
  const out: DocumentModel[] = [];
  const stack: DocumentModel[] = [model];
  for (const node of drainStack(stack)) {
    out.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return out;
};

interface DocView {
  readonly root: HtmlNode;
  readonly elements: readonly HtmlElementNode[];
  readonly model: DocumentModel | undefined;
  readonly bodyText: string;
}

/**
 * `nodeId` resolution by document class: managed documents keep the model-based logic
 * (ids + per-block normalized text, identical to the meta flow); other classes fall back
 * to a raw `data-hr-id` scan of the element tree — their ids are just attributes there.
 */
const byNodeId = (view: DocView, nodeId: string, anchor: TextAnchor): RelocateResult => {
  if (view.model !== undefined) {
    const nodes = flattenModel(view.model);
    if (!nodes.some((node) => node.id === nodeId)) return failed("orphaned", "node");
    const text = nodes
      .filter((node) => node.id === nodeId)
      .map((node) => node.text)
      .join("");
    return matched(matchAnchorInText(text, anchor), "node");
  }
  const hits = view.elements.filter((element) => attributeOf(element, HR_ID_ATTRIBUTE) === nodeId);
  if (hits.length === 0) return failed("orphaned", "node");
  const text = hits.map(textContentOf).join("");
  return matched(matchAnchorInText(text, anchor), "node");
};

const bySelector = (view: DocView, selector: string, anchor: TextAnchor): RelocateResult => {
  const steps = parseSelectorPath(selector);
  const element = steps === undefined ? undefined : elementByPath(view.root, steps);
  if (element !== undefined) {
    return matched(matchAnchorInText(textContentOf(element), anchor), "selector");
  }
  // Selector miss: the anchor gets one more chance against the whole body text.
  return matched(matchAnchorInText(view.bodyText, anchor), "body");
};

const relocate = (view: DocView, annotation: SidecarAnnotation): RelocateResult => {
  if (annotation.nodeId !== undefined) return byNodeId(view, annotation.nodeId, annotation.anchor);
  if (annotation.selector !== undefined) {
    return bySelector(view, annotation.selector, annotation.anchor);
  }
  return failed("orphaned", "none");
};

/**
 * Parse once, relocate many: the returned closure resolves each sidecar annotation against
 * this document's bytes — model blocks for managed docs, `data-hr-id` scan for the rest,
 * selector path with a body fallback otherwise. `body` is always implied by the parser;
 * an empty document's fallback text is the empty string.
 */
export const docRelocatorOf = (
  html: string,
): ((annotation: SidecarAnnotation) => RelocateResult) => {
  const parsed = parseHtml(html);
  const managed = classifyDocument(parsed).cls === "managed";
  const model = managed ? toDocumentModel(parsed) : undefined;
  const elements = elementsOf(parsed.root);
  const view: DocView = {
    root: parsed.root,
    elements,
    model,
    bodyText: bodyTextOf(parsed),
  };
  return (annotation) => relocate(view, annotation);
};
