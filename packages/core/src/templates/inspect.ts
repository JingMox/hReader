// This layer: scan one template *directory* into a verified shape（manifest + 成员路径 + 资源清单 + 容量）。
// 所有损坏形态都落成 `invalid_template`；list 把它翻译成诊断，read/create 直接抛。

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

/** 一个已核实成员：`rel` 相对模板根的正斜杠路径；`source` 供 `fs.readFile`（链接成员是已解析的真实路径）。 */
export interface ScannedMember {
  readonly rel: string;
  readonly source: string;
  readonly size: number;
}

export interface ScannedTemplate {
  readonly dir: string;
  readonly realDir: string;
  readonly manifest: TemplateManifest;
  /** 生效成员：显式写了的用作者路径，没写的用缺省路径；`style`/`guide` 缺省缺文件时是 `undefined`。 */
  readonly entry: ScannedMember;
  readonly style?: ScannedMember;
  readonly guide?: ScannedMember;
  /** `assets/` 下的全部常规文件，`rel` 含 `assets/` 前缀。 */
  readonly assets: readonly ScannedMember[];
}

const invalid = (message: string, cause?: unknown): HrError =>
  cause === undefined
    ? new HrError("invalid_template", message)
    : new HrError("invalid_template", message, { cause });

/** `lstat`/`readdir`/`realpath` 失败统一翻译成"模板损坏"：读不动的成员与坏掉的形状同义。 */
const memberFailure = (action: string, path: string, error: unknown): HrError =>
  invalid(`${action}失败：${path}`, error);

interface MemberEntry {
  readonly rel: string;
  readonly isDirectory: boolean;
  readonly size: number;
  /** 读内容用的路径：链接成员用已解析的真实路径，普通成员用词法路径。 */
  readonly source: string;
}

/** 端口没有 `isDirectory`：非文件非链接即按目录下钻（存疑节点在 readdir 时自然报错）。 */
const isDirStat = (stat: FileStat): boolean => !stat.isFile() && !stat.isSymbolicLink();

/**
 * 全量走一遍模板目录：常规文件计入容量闸；目录记为 dir 成员并下钻；
 * 符号链接必须解析回模板内——解析到模板外（或解析不了）判 `invalid_template`，
 * 逃逸链接不是"资源"，是攻击面。
 *
 * 环路防护按**当前下钻链**截断（某个 realdir 已是自己祖先时不再进），
 * 不是全局去重：指向同一 realdir 的两个词法路径是两批不同的成员
 * （`a/x` 与 `alias/x` 都要各算一份容量），否则别名会被静默吞掉。
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
        // 普通目录也复核真实路径：祖先若被换链接，词法路径会骗人。
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

/** `entry` 必选：显式写了用它，没写用缺省 `index.html`；不存在或指向目录即 `invalid_template`。 */
const requiredMember = (
  authored: string | undefined,
  index: ReadonlyMap<string, MemberEntry>,
): ScannedMember => memberOf("entry", authored ?? DEFAULT_ENTRY, index);

/** `style`/`guide` 可选：显式写了必须存在；没写时缺省路径在则用、不在则"没有该成员"。 */
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
 * 校验一个候选模板目录。`dirName` 是它在来源根下的目录名（= 它声称的 id）。
 * 任何一步失败都抛 `invalid_template`，报文只描述"这个目录为什么不能当模板"。
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

/** `readdir` 缺根 = 空来源（这一级没有模板）；其余异常上抛成"损坏"。 */
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
 * 目录候选判定：普通目录与符号链接（指向目录与否由 inspect 判定）都算候选；常规文件不是。
 * `lstat` 失败原样上抛——ENOENT 与"坏了"不是一回事，谁捕怎么翻由调用方决定。
 */
export const isTemplateCandidate = async (path: string, fsApi: FileSystem): Promise<boolean> => {
  const stat = await fsApi.lstat(path);
  if (stat.isSymbolicLink()) return true;
  return !stat.isFile();
};
