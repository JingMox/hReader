// This layer: saveTemplate — extract the theme CSS + `<stem>_files/` assets from an existing page into
// a staged template dir (sibling of the tier root), self-check it, then publish with one rename.
// A failure mid-way removes the whole staging dir; a taken target is `file_exists` (no --force).

import { basename, dirname, extname, join } from "node:path";

import { HrError } from "../hr-error";
import type { HtmlNode } from "../html/constants";
import { parseHtml } from "../html/parse";
import { serializeHtml } from "../html/serialize";
import { drainStack } from "../html/stack";
import { normalizeWhitespace, textContentOf } from "../html/text";
import { mkdirOrFail } from "../io/atomic";
import { decodeUtf8, encodeUtf8 } from "../io/bytes";
import { nonce } from "../io/digest";
import { codeOf, failureOf, rmdirQuiet, unlinkQuiet } from "../io/errors";
import { isInside, isInsideOrSelf, resolveTarget } from "../io/paths";
import type { FileStat, FileSystem } from "../io/ports";
import { classifyDocument } from "../model/classify";
import { HEADING_LEVELS } from "../model/constants";
import { embeddedThemeCssOf, replaceTheme } from "../style/apply";
import { assertThemeSafe } from "../style/css";
import {
  ASSETS_DIR,
  DEFAULT_ENTRY,
  DEFAULT_GUIDE,
  DEFAULT_STYLE,
  MANIFEST_FILE,
  TEMPLATE_ID,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_FILES,
  TEMPLATES_DIRNAME,
  type SaveTemplateInput,
  type SavedTemplate,
  type TemplateDeps,
  type TemplateFormat,
  type TemplateManifest,
  type TemplateRoots,
} from "./contracts";
import { mapElements } from "./create";
import { inspectTemplateDir } from "./inspect";

/** `.hreader` matches io/paths.ts's STORE_DIR: the staging dir sits next to `templates/` inside it. */
const HREADER_DIR = ".hreader";

/** Staging dirs are siblings of `templates/` under `.hreader/`; a leftover is invisible to `listTemplateDirs`. */
const STAGING_PREFIX = ".hr-template-save-";

/** A crash-leftover older than this is reaped on the next save; a fresher one may still be in flight. */
const STAGING_MAX_AGE_MS = 3_600_000;

/** Tags whose subtree never yields visible text — heading collection skips them (same set outline uses). */
const NON_TEXT_TAGS = new Set(["script", "style", "template", "head"]);

/** Heading text in the generated guide: long titles would drown the outline, so they are capped. */
const HEADING_TEXT_LIMIT = 120;

interface StagedAsset {
  /** Forward-slash path relative to the template root (the `assets/…` member name). */
  readonly rel: string;
  /** Absolute path under the staging root the bytes land at. */
  readonly dest: string;
  readonly data: Uint8Array;
}

const invalidInput = (message: string, cause?: unknown): HrError =>
  cause === undefined
    ? new HrError("invalid_input", message)
    : new HrError("invalid_input", message, { cause });

const optionalText = (value: string | undefined, flag: string): string | undefined => {
  if (value === undefined) return undefined;
  if (value.trim() === "") throw invalidInput(`${flag} 不能为空`);
  return value;
};

/** The port has no `isDirectory`: same convention as inspect — anything neither file nor link descends as a dir. */
const isDirStat = (stat: FileStat): boolean => !stat.isFile() && !stat.isSymbolicLink();

/**
 * Remove the staging dir unconditionally (rollback): files and links are unlinked, real dirs are
 * descended into and removed bottom-up. Nothing inside the staging root is user data — whatever
 * partial shape exists must go.
 */
const removeTree = async (fsApi: FileSystem, dir: string): Promise<void> => {
  let names: readonly string[];
  try {
    names = await fsApi.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = await fsApi.lstat(path);
      if (isDirStat(stat)) await removeTree(fsApi, path);
      else await unlinkQuiet(fsApi, path);
    } catch {
      continue;
    }
  }
  await rmdirQuiet(fsApi, dir);
};

/**
 * Best-effort sweep of crash-leftover staging dirs under `<scopeBase>/.hreader/`. Reaping never
 * fails a save: a failed list/stat/remove just leaves the dir for the next run. Only
 * `.hr-template-save-*` directories old enough by dir mtime are touched — nothing else.
 */
const reapStaleStagingDirs = async (
  parent: string,
  fsApi: FileSystem,
  nowMs: number,
): Promise<void> => {
  let names: readonly string[];
  try {
    names = await fsApi.readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const dir = join(parent, name);
    try {
      const stat = await fsApi.lstat(dir);
      if (isDirStat(stat) && stat.mtimeMs + STAGING_MAX_AGE_MS <= nowMs) {
        await removeTree(fsApi, dir);
      }
    } catch {
      continue;
    }
  }
};

interface CollectedAsset {
  readonly rel: string;
  readonly source: string;
  readonly data: Uint8Array;
}

/**
 * Copy-out list of `<stem>_files/`: links must resolve back inside the assets dir's real path,
 * dirs likewise (an escaping member is refused, not silently dropped — same stance as inspect).
 * Everything is read eagerly so a mid-walk failure happens before a single staged byte exists.
 */
const collectAssets = async (
  dir: string,
  workspace: string,
  fsApi: FileSystem,
): Promise<readonly CollectedAsset[]> => {
  let stat: FileStat;
  try {
    stat = await fsApi.lstat(dir);
  } catch (error: unknown) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw failureOf("检查资源目录", dir, error);
  }
  // A linked assets dir resolves below (its target must still live inside the workspace); a plain file is refused.
  if (!isDirStat(stat) && !stat.isSymbolicLink()) {
    throw invalidInput(`资源路径存在但不是目录：${dir}`);
  }
  let assetsReal: string;
  try {
    assetsReal = await fsApi.realpath(dir);
  } catch (error: unknown) {
    throw failureOf("解析资源目录", dir, error);
  }
  if (!isInside(workspace, assetsReal)) {
    throw new HrError("path_outside_workspace", `资源目录真实路径跑出 workspace：${assetsReal}`);
  }
  // Same store-area stance as `resolveTarget`: `.hreader/**` is hreader's own data, not page assets.
  if (isInsideOrSelf(join(workspace, HREADER_DIR), assetsReal)) {
    throw new HrError(
      "path_outside_workspace",
      `资源目录真实路径落在 .hreader 存储区内：${assetsReal}`,
    );
  }
  const assets: CollectedAsset[] = [];
  let totalBytes = 0;
  const capacity = (): void => {
    if (assets.length > TEMPLATE_MAX_FILES || totalBytes > TEMPLATE_MAX_BYTES) {
      throw invalidInput(
        `页面资源超过模板容量上限（文件数 ≤ ${String(TEMPLATE_MAX_FILES)}、总大小 ≤ ${String(TEMPLATE_MAX_BYTES)} 字节）`,
      );
    }
  };
  const pending: { lexDir: string; realPath: string; prefix: string; chain: readonly string[] }[] =
    [{ lexDir: dir, realPath: assetsReal, prefix: "", chain: [assetsReal] }];
  for (let task = pending.shift(); task !== undefined; task = pending.shift()) {
    let names: readonly string[];
    try {
      names = await fsApi.readdir(task.realPath);
    } catch (error: unknown) {
      throw failureOf("读资源目录", task.lexDir, error);
    }
    for (const name of [...names].sort()) {
      const lexPath = join(task.lexDir, name);
      const rel = task.prefix === "" ? name : `${task.prefix}/${name}`;
      let memberStat: FileStat;
      let realPath = lexPath;
      try {
        memberStat = await fsApi.lstat(lexPath);
      } catch (error: unknown) {
        throw failureOf("检查资源成员", lexPath, error);
      }
      if (memberStat.isSymbolicLink() || isDirStat(memberStat)) {
        try {
          realPath = await fsApi.realpath(lexPath);
        } catch (error: unknown) {
          throw invalidInput(`无法解析的资源成员路径：${rel}`, error);
        }
        if (!isInsideOrSelf(assetsReal, realPath)) {
          throw invalidInput(`资源成员指向目录之外：${rel}`);
        }
        if (memberStat.isSymbolicLink()) {
          try {
            memberStat = await fsApi.lstat(realPath);
          } catch (error: unknown) {
            throw failureOf("检查资源成员", realPath, error);
          }
        }
      }
      if (isDirStat(memberStat)) {
        if (task.chain.includes(realPath)) continue;
        pending.push({
          lexDir: lexPath,
          realPath,
          prefix: rel,
          chain: [...task.chain, realPath],
        });
        continue;
      }
      if (!memberStat.isFile()) {
        throw invalidInput(`资源里有非常规文件：${rel}`);
      }
      let data: Uint8Array;
      try {
        data = await fsApi.readFile(realPath);
      } catch (error: unknown) {
        throw failureOf("读取资源文件", realPath, error);
      }
      totalBytes += data.byteLength;
      assets.push({ rel, source: realPath, data });
      capacity();
    }
  }
  return assets;
};

interface DraftHeading {
  readonly level: number;
  readonly text: string;
}

/** Whole-document h1..h6 in document order (an "html"-format page keeps its headings outside any article). */
const collectHeadings = (root: HtmlNode): readonly DraftHeading[] => {
  const headings: DraftHeading[] = [];
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind !== "element" && node.kind !== "document") continue;
    if (node.kind === "element") {
      if (NON_TEXT_TAGS.has(node.tag)) continue;
      const level = HEADING_LEVELS[node.tag];
      if (level !== undefined) {
        const text = normalizeWhitespace(textContentOf(node));
        if (text !== "") {
          headings.push({
            level,
            text:
              Array.from(text).length > HEADING_TEXT_LIMIT
                ? `${Array.from(text).slice(0, HEADING_TEXT_LIMIT).join("")}…`
                : text,
          });
        }
      }
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return headings;
};

/** The generated `guide.md` draft: name, heading outline, and a to-be-filled writing-rules section. */
const guideDraft = (
  name: string,
  sourceName: string,
  format: TemplateFormat,
  headings: readonly DraftHeading[],
): string => {
  const outline =
    headings.length === 0
      ? "（原页面没有标题层级）"
      : headings.map((heading) => `${"  ".repeat(heading.level - 1)}- ${heading.text}`).join("\n");
  return `# ${name}

从 \`${sourceName}\` 提取的模板（format: ${format}）。

## 结构大纲

${outline}

## 写作规范（待补充）

（填写：这篇文档的语气、用词与结构约定——哪些 section 必备、哪些组件可复用、每节写多少。）
`;
};

const manifestOf = (
  input: SaveTemplateInput,
  name: string,
  description: string | undefined,
  format: TemplateFormat,
  hasStyle: boolean,
  sourceName: string,
): TemplateManifest => ({
  id: input.id,
  name,
  description: description ?? `从 ${sourceName} 提取的页面模板`,
  version: 1,
  format,
  entry: DEFAULT_ENTRY,
  ...(hasStyle ? { style: DEFAULT_STYLE } : {}),
  guide: DEFAULT_GUIDE,
  tags: [],
});

/** Whatever already sits at the target name — dir, file or link — is a taken slot: `file_exists`, no overwrite. */
const assertTargetFree = async (dir: string, fsApi: FileSystem): Promise<void> => {
  try {
    await fsApi.lstat(dir);
  } catch (error: unknown) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw failureOf("检查目标目录", dir, error);
  }
  throw new HrError("file_exists", `模板已存在：${dir}`);
};

export const saveTemplate = async (
  input: SaveTemplateInput,
  roots: TemplateRoots,
  deps: TemplateDeps,
): Promise<SavedTemplate> => {
  if (!TEMPLATE_ID.test(input.id)) {
    throw invalidInput(`模板 id 不合法（须匹配 ${TEMPLATE_ID.source}）：${input.id}`);
  }
  const name = optionalText(input.name, "--name") ?? input.id;
  const description = optionalText(input.description, "--description");
  // Provided CSS goes through the same safety gate `createFromTemplate` will apply at inline time:
  // refuse it now rather than saving a template that breaks on first use.
  if (input.style !== undefined) assertThemeSafe(input.style);
  const source = await resolveTarget({ workspace: roots.workspace, file: input.file }, deps.fs);
  const ext = extname(source.realPath);
  if (ext.toLowerCase() !== ".html" && ext.toLowerCase() !== ".htm") {
    throw invalidInput(`模板源必须是 HTML 文件：${input.file}`);
  }
  let html: string;
  try {
    html = decodeUtf8(await deps.fs.readFile(source.realPath), source.realPath);
  } catch (error: unknown) {
    throw error instanceof HrError ? error : failureOf("读取页面", source.realPath, error);
  }
  const parsed = parseHtml(html);
  const format: TemplateFormat = classifyDocument(parsed).cls === "managed" ? "managed" : "html";
  // Provided `style` replaces the extracted theme; the extracted one is left exactly as authored.
  const style = input.style ?? embeddedThemeCssOf(html);
  // An extracted theme faces the same gate a provided `style` passed above: it lands in style.css
  // verbatim, and would otherwise save a template every `createFromTemplate` refuses.
  if (input.style === undefined && style !== undefined) assertThemeSafe(style);
  const stem = basename(source.realPath, ext);
  const assetsDir = join(dirname(source.realPath), `${stem}_files`);
  const assets = await collectAssets(assetsDir, source.workspace, deps.fs);
  // The theme slot stays in the entry but empty — `createFromTemplate` inlines `style.css` back into it.
  let entry = replaceTheme(html, "").html;
  if (assets.length > 0) {
    const reParsed = parseHtml(entry);
    entry = serializeHtml({
      root: mapElements(reParsed.root, `${stem}_files/`, `${ASSETS_DIR}/`),
      diagnostics: reParsed.diagnostics,
    });
  }
  const guide =
    input.guide ??
    guideDraft(name, basename(source.realPath), format, collectHeadings(parsed.root));
  const manifest = manifestOf(
    input,
    name,
    description,
    format,
    style !== undefined,
    basename(source.realPath),
  );
  const staged: readonly { rel: string; data: Uint8Array }[] = [
    { rel: MANIFEST_FILE, data: encodeUtf8(`${JSON.stringify(manifest, null, 2)}\n`) },
    { rel: DEFAULT_ENTRY, data: encodeUtf8(entry) },
    ...(style === undefined ? [] : [{ rel: DEFAULT_STYLE, data: encodeUtf8(style) }]),
    { rel: DEFAULT_GUIDE, data: encodeUtf8(guide) },
  ];
  const totalBytes =
    staged.reduce((acc, member) => acc + member.data.byteLength, 0) +
    assets.reduce((acc, asset) => acc + asset.data.byteLength, 0);
  if (staged.length + assets.length > TEMPLATE_MAX_FILES || totalBytes > TEMPLATE_MAX_BYTES) {
    throw invalidInput(
      `页面与资源超过模板容量上限（文件数 ≤ ${String(TEMPLATE_MAX_FILES)}、总大小 ≤ ${String(TEMPLATE_MAX_BYTES)} 字节）`,
    );
  }

  const scopeBase = input.global === true ? deps.home : source.workspace;
  const tierRoot = join(scopeBase, HREADER_DIR, TEMPLATES_DIRNAME);
  const finalDir = join(tierRoot, input.id);
  await assertTargetFree(finalDir, deps.fs);
  await mkdirOrFail(deps, tierRoot);
  await reapStaleStagingDirs(join(scopeBase, HREADER_DIR), deps.fs, deps.clock.now().getTime());
  // The staging dir is a sibling of `templates/` inside `.hreader/`: same filesystem → rename is atomic,
  // and a crash-leftover is invisible to `listTemplateDirs` (it only scans the tier root itself).
  const staging = join(scopeBase, HREADER_DIR, `${STAGING_PREFIX}${nonce()}`);
  const stagedAssets: StagedAsset[] = assets.map((asset) => ({
    rel: `${ASSETS_DIR}/${asset.rel}`,
    dest: join(staging, ASSETS_DIR, ...asset.rel.split("/")),
    data: asset.data,
  }));
  await mkdirOrFail(deps, staging);
  const writeMember = async (absPath: string, data: Uint8Array): Promise<void> => {
    try {
      await deps.fs.writeFile(absPath, data);
    } catch (error: unknown) {
      throw failureOf("写模板文件", absPath, error);
    }
  };
  try {
    for (const member of staged) {
      await writeMember(join(staging, ...member.rel.split("/")), member.data);
    }
    if (stagedAssets.length > 0) await mkdirOrFail(deps, join(staging, ASSETS_DIR));
    for (const asset of stagedAssets) {
      await mkdirOrFail(deps, dirname(asset.dest));
      await writeMember(asset.dest, asset.data);
    }
    // Self-check the staged dir through the same gate readers use: a template that cannot pass
    // inspect must never reach the tier root.
    await inspectTemplateDir(staging, input.id, deps.fs);
    try {
      await deps.fs.rename(staging, finalDir);
    } catch (error: unknown) {
      const code = codeOf(error);
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        throw new HrError("file_exists", `模板已存在：${finalDir}`);
      }
      throw failureOf("发布模板", finalDir, error);
    }
  } catch (error: unknown) {
    await removeTree(deps.fs, staging);
    throw error;
  }
  return {
    id: input.id,
    dir: finalDir,
    format,
    scope: input.global === true ? "user" : "workspace",
    assets: stagedAssets.map((asset) => asset.rel),
  };
};
