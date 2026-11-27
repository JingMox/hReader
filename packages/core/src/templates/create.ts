// This layer: createFromTemplate — fetch template → rewrite (title/asset refs/theme inline/node ids) →
// land the assets under `<stem>_files/` first, then the page as the exclusive create that publishes the
// result. Any failure rolls back every file and directory this call created (pre-existing entries are
// never touched), so a failed attempt leaves the filesystem as it was and a retry can succeed.

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
import { codeOf, failureOf, rmdirQuiet, unlinkQuiet } from "../io/errors";
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

/**
 * `<stem>_files/` occupied in ANY form (dir, file or symlink) means `file_exists` before a single write:
 * the batch claims the whole name, and a retry after the cause is removed must still find the name free.
 */
const assertAssetsDirFree = async (dir: string, deps: TemplateDeps): Promise<void> => {
  try {
    await deps.fs.lstat(dir);
  } catch (error: unknown) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw failureOf("检查资源目录", dir, error);
  }
  throw new HrError("file_exists", `目标已存在：${dir}`);
};

/**
 * Which dirs on `dir`'s chain are absent right now — i.e. the ones a recursive mkdir is about to create.
 * Deepest-first, stopping at the first existing ancestor (a file ancestor also stops the walk: the mkdir
 * that follows will surface ENOTDIR on its own).
 */
const missingDirsOf = async (dir: string, deps: TemplateDeps): Promise<string[]> => {
  const missing: string[] = [];
  let cursor: string | undefined = dir;
  while (cursor !== undefined) {
    try {
      await deps.fs.lstat(cursor);
      break;
    } catch (error: unknown) {
      const code = codeOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw failureOf("检查目录", cursor, error);
      }
    }
    missing.push(cursor);
    const parent = dirname(cursor);
    cursor = parent === cursor ? undefined : parent;
  }
  return missing;
};

const depthOf = (path: string): number => path.split(/[\\/]/u).length;

/**
 * The write phase, all-or-nothing: dirs → assets → the exclusive page create that publishes the result.
 * On failure, every file and directory this call created is reclaimed — `createdDirs` is walked in
 * reverse so children go before their parents; a foreign entry inside a created dir just leaves the dir.
 */
const writeAll = async (
  rendered: RenderedTemplate,
  target: ResolvedNewTarget,
  data: Uint8Array,
  assetData: readonly { path: string; data: Uint8Array }[],
  deps: TemplateDeps,
): Promise<void> => {
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  try {
    if (assetData.length > 0) await assertAssetsDirFree(rendered.assetsDir, deps);
    const pending = [
      ...new Set([dirname(target.absolute), ...assetData.map((file) => dirname(file.path))]),
    ].sort((a, b) => depthOf(a) - depthOf(b));
    for (const dir of pending) {
      createdDirs.push(...(await missingDirsOf(dir, deps)));
      await mkdirOrFail(deps, dir);
    }
    if (assetData.length > 0) {
      await createNewFiles(assetData, deps);
      createdFiles.push(...assetData.map((file) => file.path));
    }
    await createNewFile(target.absolute, data, deps);
  } catch (error: unknown) {
    for (const file of createdFiles) await unlinkQuiet(deps.fs, file);
    for (const dir of [...createdDirs].reverse()) await rmdirQuiet(deps.fs, dir);
    throw error;
  }
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
  await writeAll(rendered, target, data, assetData, deps);
  return {
    path: target.relative,
    bytes: data.byteLength,
    assets: assetData.map((file) => relative(target.workspace, file.path).split("\\").join("/")),
  };
};
