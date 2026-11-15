// 这层管：把 (workspace, file) 解析成工作区内的真实路径（词法 + realpath 双重校验）；不读写内容。

import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { HrError } from "../hr-error";
import { sha1Hex } from "./digest";
import { failureOf } from "./errors";
import type { FileStat, FileSystem } from "./ports";

/** hreader 自己的存储根：history / locks 都在里面，且本身不可被 patch。 */
const STORE_DIR = ".hreader";

export interface ResolvedTarget {
  /** 已解引用符号链接的路径；后续读写都用它。 */
  readonly realPath: string;
  /** 相对 workspace 的正斜杠路径：history 目录名与锁文件名都由它派生。 */
  readonly relative: string;
  /** workspace 的真实路径：原子写每次落盘前都要拿它复核父目录（P0-1）。 */
  readonly workspace: string;
  readonly storeDir: string;
  /** 该文件的锁文件路径：编排层用它加锁，锁的粒度是"一个文件"。 */
  readonly lockPath: string;
}

const outside = (reason: string, file: string): HrError =>
  new HrError("path_outside_workspace", `${reason}：${file}`);

/** 边界判定是纯字符串运算：只认"严格在 base 之下"，base 自身不算。 */
export const isInside = (base: string, candidate: string): boolean => {
  const rel = relative(base, candidate);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** 目录复核要放行"就是 workspace 本身"（直接放在根下的文件，其父目录等于 workspace）。 */
export const isInsideOrSelf = (base: string, candidate: string): boolean =>
  candidate === base || isInside(base, candidate);

/** 任一 fs 调用失败都要落成冻结错误码：同一个 catch 只留一份，测试盖住它就是盖住全部调用点。 */
const callOf = async <T>(action: string, path: string, op: () => Promise<T>): Promise<T> => {
  try {
    return await op();
  } catch (error: unknown) {
    throw failureOf(action, path, error);
  }
};

const realpathOf = (fsApi: FileSystem, path: string): Promise<string> =>
  callOf("realpath", path, () => fsApi.realpath(path));

const statOf = (fsApi: FileSystem, path: string): Promise<FileStat> =>
  callOf("lstat", path, () => fsApi.lstat(path));

const storeErrorOf = (relativePath: string, file: string): HrError | undefined => {
  if (relativePath === STORE_DIR || relativePath.startsWith(`${STORE_DIR}/`)) {
    return outside("`.hreader/**` 是 hreader 自己的存储目录，不可 patch", file);
  }
  return undefined;
};

/**
 * 两道校验各管一类逃逸：词法拦 `..`/绝对路径（文件不存在也要拦得住），
 * realpath 拦"父目录是指向 workspace 外的符号链接"（词法看不出来）。
 * 这里只是第一道；写盘前的两道复核在 `atomic.ts`（P0-1）。
 */
export const resolveTarget = async (
  input: { readonly workspace: string; readonly file: string },
  fsApi: FileSystem,
): Promise<ResolvedTarget> => {
  if (!isAbsolute(input.workspace)) {
    throw new HrError("invalid_input", `workspace 必须是绝对路径：${input.workspace}`);
  }
  if (input.file.length === 0) throw new HrError("not_a_file", "file 不能为空");
  if (isAbsolute(input.file)) throw outside("不接受绝对路径", input.file);
  const workspaceAbs = resolve(input.workspace);
  const lexical = resolve(workspaceAbs, input.file);
  if (!isInside(workspaceAbs, lexical)) throw outside("`file` 逃出了 workspace", input.file);
  const workspaceReal = await realpathOf(fsApi, workspaceAbs);
  const realPath = await realpathOf(fsApi, lexical);
  if (!isInside(workspaceReal, realPath)) throw outside("真实路径落在 workspace 外", input.file);
  const relativePath = relative(workspaceReal, realPath).split(sep).join("/");
  const storeError = storeErrorOf(relativePath, input.file);
  if (storeError !== undefined) throw storeError;
  const stat = await statOf(fsApi, realPath);
  if (!stat.isFile()) throw new HrError("not_a_file", `不是普通文件：${input.file}`);
  const storeDir = join(workspaceReal, STORE_DIR);
  const key = sha1Hex(relativePath);
  return {
    realPath,
    relative: relativePath,
    workspace: workspaceReal,
    storeDir,
    lockPath: join(storeDir, "locks", `${key}.lock`),
  };
};

export const historyDirOf = (target: ResolvedTarget): string =>
  join(target.storeDir, "history", sha1Hex(target.relative));
