// This layer: createFromTemplate —— 取模板 → 改写（标题/资源引用/主题内联/节点 id）→
// 原子落成 target + `<stem>_files/`。任何写盘前的检查都先做掉，落盘本身交给 io 原语。

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

/** 文本节点的转义面：`&`/`<`/`>`；`<title>` 是 RCDATA、`<h1>` 是普通流内容，同一套够用。 */
const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const hasBytes = (span: SourceSpan): boolean => span.end > span.start;

const spanOrZero = (node: HtmlElementNode): SourceSpan => ({ ...ZERO_SPAN, ...node.span });

interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** 文档序找"首个出现且源码里真的有字节"的指定标签元素；parse5 合成的节点是零宽区间。 */
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

/** 源码区间改写 `<title>` 与首个 `<h1>` 的文本；元素不存在就跳过（自由 HTML 不保证有它们）。 */
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

/** 会跟着文档搬家的属性：`src`/`href`/`poster` 直取 URL，`srcset` 是逗号分隔的候选串。 */
const DIRECT_URL_ATTRS = new Set(["src", "href", "poster"]);
const SRCSET_ATTR = "srcset";

/** 候选串逐个改写：保留各自的前导空白（`, ` 的间隔是作者写的），只换 URL 段。 */
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

/** 只认 `assets/` 打头的相对引用：绝对 URL 与其他相对路径不动。 */
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
 * 序列化路径（managed 必走，或要搬资源时）：一次遍历改完所有 `assets/` 引用，
 * managed 再补 `injectNodeIds`（对已有 id 幂等）。html 且无资源时完全不序列化——原字节保留。
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

/** `<stem>_files` 与 F1c 文件树折叠规则同名：`note.html` 的资源进 `note_files/`。 */
const assetsDirNameOf = (targetName: string): string =>
  `${basename(targetName, extname(targetName))}_files`;

/** 主题内联：entry 没有 `<head>` 或 CSS 过不了安全线时，把底层码统一翻成"模板损坏"。 */
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

/** managed 的产物必须带单 article + 合法 id——injectNodeIds 救不了"没有 article"的骨架。 */
const assertManaged = (html: string): void => {
  if (classifyDocument(parseHtml(html)).cls !== "managed") {
    throw templateFailure("managed 模板的 entry 产出不是受管文档（缺单个合法 <article>）");
  }
};

interface RenderedTemplate {
  readonly html: string;
  readonly assetsDir: string;
  /** `dest` 是 `<target 目录>/<stem>_files/<assets 前缀后的子路径>`。 */
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
      // rel 以 `assets/` 开头；剥前缀后的子路径由 readdir 名单拼成，天然不含 `..`/绝对段。
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
  // 先验货后落盘：资源全部读到内存之前不动笔，entry 写不进也不留半套资源目录。
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
