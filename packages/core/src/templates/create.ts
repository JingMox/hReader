// This layer: createFromTemplate — fetch template → rewrite (title/asset refs/theme inline/node ids) →
// atomically land the target + `<stem>_files/`. Every pre-write check runs before any write; the write itself goes to io primitives.

import { basename, dirname, extname, join, relative } from "node:path";

import { HrError } from "../hr-error";
import type { HtmlElementNode, HtmlNode, ParsedHtml, SourceSpan } from "../html/constants";
import { injectNodeIds } from "../html/inject";
import { parseHtml } from "../html/parse";
import { serializeHtml } from "../html/serialize";
import { ZERO_SPAN } from "../html/span";
import { drainStack } from "../html/stack";
import { mkdirOrFail } from "../io/atomic";
import { encodeUtf8, readBytes } from "../io/bytes";
import { createNewFile, createNewFiles } from "../io/create";
import { resolveNewTarget, type ResolvedNewTarget } from "../io/paths";
import { classifyDocument } from "../model/classify";
import { replaceTheme } from "../style/apply";
import {
  ASSETS_DIR,
  type CreateFromTemplateInput,
  type CreateFromTemplateResult,
  type LoadedTemplate,
  type TemplateDeps,
  type TemplateRoots,
} from "./contracts";
import type { ScannedMember } from "./inspect";
import { loadTemplate } from "./service";

/** The escaping surface for text nodes: `&`/`<`/`>`; `<title>` is RCDATA, `<h1>` is normal flow content — one set covers both. */
const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const hasBytes = (span: SourceSpan): boolean => span.end > span.start;

const spanOrZero = (node: HtmlElementNode): SourceSpan => ({ ...ZERO_SPAN, ...node.span });

interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Find, in document order, the first element with the given tag that really has bytes in the source; parse5-synthesized nodes have zero-width spans. */
const firstElement = (root: HtmlNode, tag: string): HtmlElementNode | undefined => {
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind !== "element" && node.kind !== "document") continue;
    if (node.kind === "element" && node.tag === tag && hasBytes(spanOrZero(node))) return node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return undefined;
};

/** Rewrite the `<title>` and first `<h1>` text at their source spans; absent elements are skipped (free-form HTML does not guarantee them). */
const retitleHtml = (html: string, title: string | undefined): string => {
  if (title === undefined) return html;
  const parsed = parseHtml(html, { locations: true });
  const splices: Splice[] = [];
  for (const tag of ["title", "h1"]) {
    const node = firstElement(parsed.root, tag);
    if (node === undefined) continue;
    const span = spanOrZero(node);
    splices.push({ start: span.innerStart, end: span.innerEnd, text: escapeText(title) });
  }
  return splices
    .sort((left, right) => right.start - left.start)
    .reduce((acc, one) => `${acc.slice(0, one.start)}${one.text}${acc.slice(one.end)}`, html);
};

/** Attributes that move with the document: `src`/`href`/`poster` take the URL directly; `srcset` is a comma-separated candidate list. */
const DIRECT_URL_ATTRS = new Set(["src", "href", "poster"]);
const SRCSET_ATTR = "srcset";

/** Rewrite candidates one by one: each keeps its own leading whitespace (the `, ` spacing is the author's); only the URL segment is replaced. */
const rewriteSrcset = (value: string, from: string, to: string): string =>
  value
    .split(",")
    .map((candidate) => {
      const body = candidate.trimStart();
      const parts = body.trimEnd().split(/\s+/u);
      const url = parts[0];
      return url?.startsWith(from) === true
        ? candidate.slice(0, candidate.length - body.length) +
            to +
            url.slice(from.length) +
            (parts.length > 1 ? ` ${parts.slice(1).join(" ")}` : "")
        : candidate;
    })
    .join(",");

/** Only relative references starting with `assets/` are rewritten: absolute URLs and other relative paths are left alone. */
const rewriteAttrs = (node: HtmlElementNode, from: string, to: string): HtmlElementNode => ({
  ...node,
  attrs: node.attrs.map(([name, value]) =>
    DIRECT_URL_ATTRS.has(name) && value.startsWith(from)
      ? [name, to + value.slice(from.length)]
      : name === SRCSET_ATTR
        ? [name, rewriteSrcset(value, from, to)]
        : [name, value],
  ),
});

const mapElements = (node: HtmlNode, from: string, to: string): HtmlNode => {
  if (node.kind === "element") {
    const mapped = rewriteAttrs(node, from, to);
    return { ...mapped, children: mapped.children.map((child) => mapElements(child, from, to)) };
  }
  if (node.kind === "document") {
    return { ...node, children: node.children.map((child) => mapElements(child, from, to)) };
  }
  return node;
};

/**
 * The serialize path (mandatory for managed, or when assets must move): one pass rewrites every
 * `assets/` reference, and managed additionally gets `injectNodeIds` (idempotent on existing ids).
 * A plain html format with no assets is never serialized — the original bytes survive verbatim.
 */
const renderHtml = (html: string, assetsTarget: string, managed: boolean): string => {
  const parsed = parseHtml(html);
  const mapped: ParsedHtml = {
    root: mapElements(parsed.root, `${ASSETS_DIR}/`, `${assetsTarget}/`),
    diagnostics: parsed.diagnostics,
  };
  return managed ? serializeHtml(injectNodeIds(mapped).parsed) : serializeHtml(mapped);
};

const templateFailure = (message: string, cause?: unknown): HrError =>
  cause === undefined
    ? new HrError("invalid_template", message)
    : new HrError("invalid_template", message, { cause });

/** `<stem>_files` is the same name as the F1c file-tree fold rule: `note.html`'s assets land in `note_files/`. */
const assetsDirNameOf = (targetName: string): string =>
  `${basename(targetName, extname(targetName))}_files`;

/** Theme inlining: when the entry has no `<head>` or the CSS fails the safety line, underlying codes are uniformly translated into "template broken". */
const inlineTheme = (html: string, css: string): string => {
  try {
    return replaceTheme(html, css).html;
  } catch (error: unknown) {
    throw templateFailure(
      `模板无法内联样式（entry 缺 <head> 或 style 未过安全检查）：${String(error)}`,
      error,
    );
  }
};

/** A managed product must carry a single article + legal ids — injectNodeIds cannot rescue a skeleton with no article. */
const assertManaged = (html: string): void => {
  if (classifyDocument(parseHtml(html)).cls !== "managed") {
    throw templateFailure("managed 模板的 entry 产出不是受管文档（缺单个合法 <article>）");
  }
};

interface RenderedTemplate {
  readonly html: string;
  readonly assetsDir: string;
  /** `dest` is `<target dir>/<stem>_files/<subpath after the assets prefix>`. */
  readonly files: readonly { rel: string; source: string; dest: string }[];
}

const renderTemplate = (
  template: LoadedTemplate,
  members: readonly ScannedMember[],
  title: string | undefined,
  assetsDirName: string,
  targetDir: string,
): RenderedTemplate => {
  const retitled = retitleHtml(template.entry, title);
  const managed = template.manifest.format === "managed";
  const rendered =
    managed || members.length > 0 ? renderHtml(retitled, assetsDirName, managed) : retitled;
  const themed = template.style === undefined ? rendered : inlineTheme(rendered, template.style);
  if (managed) assertManaged(themed);
  const assetsDir = join(targetDir, assetsDirName);
  return {
    html: themed,
    assetsDir,
    files: members.map((member) => ({
      rel: member.rel,
      source: member.source,
      // rel starts with `assets/`; the subpath after the prefix is assembled from readdir names, so it cannot contain `..` or absolute segments.
      dest: join(assetsDir, ...member.rel.slice(ASSETS_DIR.length + 1).split("/")),
    })),
  };
};

export const createFromTemplate = async (
  input: CreateFromTemplateInput,
  roots: TemplateRoots,
  deps: TemplateDeps,
): Promise<CreateFromTemplateResult> => {
  const { template, members } = await loadTemplate(input.id, roots, deps);
  const target: ResolvedNewTarget = await resolveNewTarget(
    { workspace: roots.workspace, file: input.target },
    deps.fs,
  );
  const rendered = renderTemplate(
    template,
    members,
    input.title,
    assetsDirNameOf(basename(target.absolute)),
    dirname(target.absolute),
  );
  // Inspect before committing: no write happens until every asset has been read into memory — a failed entry leaves no half-copied asset dir.
  const data = encodeUtf8(rendered.html);
  const assetData: { path: string; data: Uint8Array }[] = [];
  for (const file of rendered.files) {
    try {
      assetData.push({ path: file.dest, data: await readBytes(deps.fs, file.source) });
    } catch (error: unknown) {
      throw templateFailure(`无法读取模板资源：${file.rel}`, error);
    }
  }
  await mkdirOrFail(deps, dirname(target.absolute));
  await createNewFile(target.absolute, data, deps);
  if (assetData.length > 0) {
    const dirs = new Set(assetData.map((file) => dirname(file.path)));
    for (const dir of dirs) await mkdirOrFail(deps, dir);
    await createNewFiles(assetData, deps);
  }
  return {
    path: target.relative,
    bytes: data.byteLength,
    assets: assetData.map((file) => relative(target.workspace, file.path).split("\\").join("/")),
  };
};
