// This layer: scan one template *directory* into a verified shape (manifest + member paths + asset list + capacity).
// Every broken form lands as `invalid_template`; list translates it into a diagnostic, read/create throw it.

import { join } from "node:path";

import { HrError } from "../hr-error";
import { decodeUtf8 } from "../io/bytes";
import { codeOf } from "../io/errors";
import { isInside, isInsideOrSelf } from "../io/paths";
import type { FileStat, FileSystem } from "../io/ports";
import {
  ASSETS_DIR,
  DEFAULT_ENTRY,
  DEFAULT_GUIDE,
  DEFAULT_STYLE,
  MANIFEST_FILE,
  TEMPLATE_ID,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_FILES,
  type TemplateManifest,
} from "./contracts";
import { parseManifestText } from "./manifest";

/** One verified member: `rel` is the forward-slash path relative to the template root; `source` feeds `fs.readFile` (for linked members it is the resolved real path). */
export interface ScannedMember {
  readonly rel: string;
  readonly source: string;
  readonly size: number;
}

export interface ScannedTemplate {
  readonly dir: string;
  readonly realDir: string;
  readonly manifest: TemplateManifest;
  /** Effective members: explicit values use the author's path, absent ones use the default; `style`/`guide` are `undefined` when their default file is missing. */
  readonly entry: ScannedMember;
  readonly style?: ScannedMember;
  readonly guide?: ScannedMember;
  /** All regular files under `assets/`, with `rel` including the `assets/` prefix. */
  readonly assets: readonly ScannedMember[];
}

const invalid = (message: string, cause?: unknown): HrError =>
  cause === undefined
    ? new HrError("invalid_template", message)
    : new HrError("invalid_template", message, { cause });

/** `lstat`/`readdir`/`realpath` failures are uniformly translated into "template broken": an unreadable member means the same thing as a malformed shape. */
const memberFailure = (action: string, path: string, error: unknown): HrError =>
  invalid(`${action}失败：${path}`, error);

interface MemberEntry {
  readonly rel: string;
  readonly isDirectory: boolean;
  readonly size: number;
  /** Path used for reading contents: the resolved real path for linked members, the lexical path for plain ones. */
  readonly source: string;
}

/** The port has no `isDirectory`: anything neither file nor link is descended into as a dir (suspect nodes fail naturally at readdir). */
const isDirStat = (stat: FileStat): boolean => !stat.isFile() && !stat.isSymbolicLink();

/**
 * Walk the whole template dir: regular files count against the capacity gate; dirs are recorded as dir
 * members and descended into; symlinks must resolve back inside the template — resolving outside (or
 * unresolvable) is `invalid_template`. An escaping link is not an asset, it is attack surface.
 *
 * Cycle protection truncates on the **current descent chain** (a realdir already on its own ancestor
 * chain is not entered again), not global dedup: two lexical paths into the same realdir are two
 * different member sets (`a/x` and `alias/x` each count once against capacity) — otherwise aliases
 * would be silently swallowed.
 */
const walkMembers = async (
  fsApi: FileSystem,
  dir: string,
  realDir: string,
): Promise<readonly MemberEntry[]> => {
  const members: MemberEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  const pending: { lexDir: string; realPath: string; prefix: string; chain: readonly string[] }[] =
    [{ lexDir: dir, realPath: realDir, prefix: "", chain: [realDir] }];
  const realpathOf = async (lexPath: string, rel: string): Promise<string> => {
    try {
      return await fsApi.realpath(lexPath);
    } catch (error: unknown) {
      throw invalid(`无法解析的成员路径：${rel}`, error);
    }
  };
  const lstatOf = async (lexPath: string): Promise<FileStat> => {
    try {
      return await fsApi.lstat(lexPath);
    } catch (error: unknown) {
      throw memberFailure("检查成员", lexPath, error);
    }
  };
  const descend = (
    task: { lexDir: string; chain: readonly string[] },
    lexPath: string,
    realPath: string,
    rel: string,
  ): void => {
    if (task.chain.includes(realPath)) return;
    pending.push({
      lexDir: lexPath,
      realPath,
      prefix: rel,
      chain: [...task.chain, realPath],
    });
  };
  for (let task = pending.shift(); task !== undefined; task = pending.shift()) {
    let names: readonly string[];
    try {
      names = await fsApi.readdir(task.realPath);
    } catch (error: unknown) {
      throw memberFailure("读目录", task.lexDir, error);
    }
    for (const name of names) {
      const lexPath = join(task.lexDir, name);
      const rel = task.prefix === "" ? name : `${task.prefix}/${name}`;
      let stat = await lstatOf(lexPath);
      let realPath = lexPath;
      if (stat.isSymbolicLink()) {
        realPath = await realpathOf(lexPath, rel);
        if (!isInsideOrSelf(realDir, realPath)) {
          throw invalid(`成员符号链接指向模板目录之外：${rel}`);
        }
        stat = await lstatOf(realPath);
      } else if (isDirStat(stat)) {
        // Plain dirs are also re-checked against their real path: if an ancestor was swapped for a link, the lexical path lies.
        const childReal = await realpathOf(lexPath, rel);
        if (!isInside(realDir, childReal)) {
          throw invalid(`子目录真实路径跑出模板：${rel}`);
        }
        realPath = childReal;
      }
      if (isDirStat(stat)) {
        members.push({ rel, isDirectory: true, size: 0, source: realPath });
        descend(task, lexPath, realPath, rel);
        continue;
      }
      if (stat.isFile()) {
        members.push({ rel, isDirectory: false, size: stat.size, source: realPath });
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > TEMPLATE_MAX_FILES || totalBytes > TEMPLATE_MAX_BYTES) {
          throw invalid(
            `模板超过容量上限（文件数 ≤ ${String(TEMPLATE_MAX_FILES)}、总大小 ≤ ${String(TEMPLATE_MAX_BYTES)} 字节）`,
          );
        }
      }
    }
  }
  return members;
};

const memberIndexOf = (members: readonly MemberEntry[]): ReadonlyMap<string, MemberEntry> =>
  new Map(members.map((member) => [member.rel, member]));

const memberOf = (
  field: "entry" | "style" | "guide",
  rel: string,
  index: ReadonlyMap<string, MemberEntry>,
): ScannedMember => {
  const hit = index.get(rel);
  if (hit === undefined) throw invalid(`${field} 指向的成员不存在：${rel}`);
  if (hit.isDirectory) throw invalid(`${field} 指向的是目录不是文件：${rel}`);
  return { rel, source: hit.source, size: hit.size };
};

/** `entry` is required: an explicit value is used as-is, an absent one falls back to the default `index.html`; missing or pointing at a dir is `invalid_template`. */
const requiredMember = (
  authored: string | undefined,
  index: ReadonlyMap<string, MemberEntry>,
): ScannedMember => memberOf("entry", authored ?? DEFAULT_ENTRY, index);

/** `style`/`guide` are optional: an explicit value must exist; when absent, the default path is used if present and "no such member" if not. */
const optionalMember = (
  field: "style" | "guide",
  authored: string | undefined,
  fallback: string,
  index: ReadonlyMap<string, MemberEntry>,
): ScannedMember | undefined => {
  if (authored === undefined && !index.has(fallback)) return undefined;
  return memberOf(field, authored ?? fallback, index);
};

/**
 * Validate one candidate template dir. `dirName` is its directory name under the source root (= the id it claims).
 * Any failure throws `invalid_template`; the message only describes why this dir cannot serve as a template.
 */
export const inspectTemplateDir = async (
  dir: string,
  dirName: string,
  fsApi: FileSystem,
): Promise<ScannedTemplate> => {
  if (!TEMPLATE_ID.test(dirName)) {
    throw invalid(`目录名不是合法模板 id：${dirName}（须匹配 ${TEMPLATE_ID.source}）`);
  }
  let realDir: string;
  try {
    realDir = await fsApi.realpath(dir);
  } catch (error: unknown) {
    throw memberFailure("解析模板目录", dir, error);
  }
  const manifestPath = join(dir, MANIFEST_FILE);
  let text: string;
  try {
    text = decodeUtf8(await fsApi.readFile(manifestPath), manifestPath);
  } catch (error: unknown) {
    throw invalid(
      codeOf(error) === "ENOENT"
        ? `缺少 ${MANIFEST_FILE}：${dir}`
        : `无法读取 ${MANIFEST_FILE}：${manifestPath}`,
      error,
    );
  }
  const manifest = parseManifestText(text, `${dirName}/${MANIFEST_FILE}`);
  if (manifest.id !== dirName) {
    throw invalid(`manifest 的 id（${manifest.id}）与目录名（${dirName}）不一致`);
  }
  const memberList = await walkMembers(fsApi, dir, realDir);
  const members = memberIndexOf(memberList);
  const entry = requiredMember(manifest.entry, members);
  const style = optionalMember("style", manifest.style, DEFAULT_STYLE, members);
  const guide = optionalMember("guide", manifest.guide, DEFAULT_GUIDE, members);
  const assets = memberList
    .filter((member) => !member.isDirectory && member.rel.startsWith(`${ASSETS_DIR}/`))
    .map((member) => ({ rel: member.rel, source: member.source, size: member.size }));
  return {
    dir,
    realDir,
    manifest,
    entry,
    ...(style === undefined ? {} : { style }),
    ...(guide === undefined ? {} : { guide }),
    assets,
  };
};

/** `readdir` on a missing root = empty tier (this level has no templates); other failures propagate as "broken". */
export const listTemplateDirs = async (
  root: string,
  fsApi: FileSystem,
): Promise<readonly string[]> => {
  try {
    return await fsApi.readdir(root);
  } catch (error: unknown) {
    if (codeOf(error) === "ENOENT") return [];
    throw invalid(`无法读取模板根目录：${root}`, error);
  }
};

/**
 * Dir candidate check: plain dirs and symlinks (whether the link target is a dir is for inspect to judge)
 * both count as candidates; regular files do not.
 * `lstat` failures rethrow as-is — ENOENT and "broken" are not the same thing; who catches and how it is translated is the caller's decision.
 */
export const isTemplateCandidate = async (path: string, fsApi: FileSystem): Promise<boolean> => {
  const stat = await fsApi.lstat(path);
  if (stat.isSymbolicLink()) return true;
  return !stat.isFile();
};
