// 这层管：`filePath` → core 能吃的 `{workspace, file}`，以及本包唯一那道边界判定（读与建共用同一个口径）。

import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { HrError } from "@hreader/core";

import { foldedOf } from "../errors";

/**
 * 六个工具的 `filePath` 描述共用这一句：**"工作区"是什么必须写出来**。
 * 本卡不提供 `--workspace`（`cli.ts` 用 `process.cwd()`），所以"工作区"就是启动时的 cwd；
 * 宿主 `cd /` 拉起时界内就是整个根，这不是 bug，但不能靠宿主自己猜（G3 P1-3）。
 */
export const FILE_PATH_HINT =
  "路径相对工作区（工作区 = 服务器启动时的当前工作目录 cwd）；绝对路径也必须落在工作区之内";

export interface DocumentTarget {
  /** 边界（core 的 `workspace`）。 */
  readonly workspace: string;
  /** 相对 `workspace` 的路径：core 的 `resolveTarget` 自己会 realpath + 拒逃逸。 */
  readonly file: string;
  /** 用户**原样**传进来的 `filePath`：错误文案回显它，绝不回显我们算出来的路径（F8-2）。 */
  readonly input: string;
  readonly absolute: string;
}

/**
 * `~` 不展开：本服务器不猜用户主目录，也不许把 `~` 当普通目录名在工作区里造出来
 * （`~/doc.html` 曾经静默落盘成 `<workspace>/~/doc.html`，还回"已创建"）。
 * 只拒这一种写法；展开是产品决定，不是校验层的事。
 */
const tildeFreeOf = (filePath: string): string => {
  if (filePath === "~" || filePath.startsWith("~/")) {
    throw new HrError(
      "invalid_input",
      `不接受 \`~\` 展开：${filePath}。请传工作区内的相对路径或绝对路径`,
    );
  }
  return filePath;
};

export const documentTargetOf = (filePath: string, cwd: string): DocumentTarget => {
  const input = tildeFreeOf(filePath);
  const absolute = isAbsolute(input) ? input : resolve(cwd, input);
  return { workspace: cwd, file: relative(cwd, absolute), input, absolute };
};

/** 与 core 的 `io/errors.ts` 同形：只把 `code` 原样取出、不做类型收窄，非字符串自然比不相等。 */
const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/**
 * 与 core `packages/core/src/io/paths.ts:29-32` 的 `isInside` **逐字等价**——适配层不许写第二套路径策略。
 * 三处细节缺一不可：`startsWith("..")` 会把工作区里合法存在的 `..foo/` 判成逃逸
 * （`relative("/ws", "/ws/..foo/x") === "..foo/x"`），所以要比 `..${sep}`；
 * `rel === ".."` 是父目录本身、`rel === ""` 是 base 自身，两者都不算界内。
 * core 未导出 `isInside`/`isInsideOrSelf`：M3.2 若导出即改为引用，见 `L-13`。
 */
const isInside = (base: string, candidate: string): boolean => {
  const rel = relative(base, candidate);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** 目录要比的可能是 workspace 本身（目标不存在时退到的祖先，恰好就是它）：这一支才放行相等。 */
const isInsideOrSelf = (base: string, candidate: string): boolean =>
  candidate === base || isInside(base, candidate);

interface ExistingPath {
  readonly path: string;
  /** 目标本身存在；`false` 表示退到了最近的既存祖先。 */
  readonly exists: boolean;
}

/**
 * 要新建的目标还不存在，`realpath` 会 `ENOENT`（父级是文件时是 `ENOTDIR`）：退到最近的既存祖先。
 * 根目录必然解析得出来，所以这个循环只从 `return` 收尾；其余错误原样抛出（"解析不了"不等于"就在界内"）。
 * `exists` 也随同带出：目标存在时比的是它自己（必须严格在界内），不存在时比的是祖先目录（允许就是 workspace 本身）。
 */
const realpathOfExisting = async (candidate: string): Promise<ExistingPath> => {
  let exists = true;
  for (;;) {
    try {
      return { path: await realpath(candidate), exists };
    } catch (error: unknown) {
      const code = codeOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      exists = false;
      candidate = dirname(candidate);
    }
  }
};

/**
 * 边界判定（本包只此一处，读、建同一个口径）：目标本身、或它最近的既存祖先，`realpath`
 * 之后必须落在 `realpath(workspace)` 之内——存在的是目标就卡"严格在内"，不存在的是祖先就允行"就是 workspace"。
 * 两件事靠它成立：一是符号链接逃逸（`ln -s /tmp workspace/link` 之后传 `link/x.html`）被拒；
 * 二是**顺序**——调用方必须在 `mkdir`/`writeFile` 之前调用它，反了就是先把目录建出去再发现越界。
 */
export const assertInsideWorkspace = async (target: DocumentTarget): Promise<void> => {
  const [workspace, resolved] = await Promise.all([
    realpath(target.workspace),
    realpathOfExisting(target.absolute),
  ]);
  const accepted = resolved.exists
    ? isInside(workspace, resolved.path)
    : isInsideOrSelf(workspace, resolved.path);
  if (!accepted) {
    // 文案用用户传进来的相对路径：绝对路径会把宿主布局泄给模型（F6-②）。
    throw new HrError("path_outside_workspace", `目标不在工作区内：${target.input}`);
  }
};

const PATH_MESSAGE_CHARS = 64;

const tooLongMessageOf = (file: string): string =>
  `路径过长：${file.slice(0, PATH_MESSAGE_CHARS)}…（共 ${String(file.length)} 字符）`;

/**
 * 把 errno 翻成人话 + 我们的码：**只有调用点知道"这是哪个文件的哪次操作"**，兜底映射拿不到这层上下文。
 * `internal` 只留给真正没料到的错误（`TypeError` 等）：fs 层的失败全部有语义可归。
 */
const failureOfFsCall = (error: unknown, target: DocumentTarget, verb: string): HrError => {
  const errno = codeOf(error);
  if (errno === "ENOENT")
    return new HrError("not_found", `文档不存在：${target.input}`, { cause: error });
  if (errno === "EISDIR")
    return new HrError("not_a_file", `不是普通文件：${target.input}`, { cause: error });
  if (errno === "ENAMETOOLONG") {
    return new HrError("invalid_input", tooLongMessageOf(target.input), { cause: error });
  }
  return new HrError("io_failure", `${verb}：${target.input}`, { cause: error });
};

/** 只读工具（outline/read_node）不落盘、core 也没有公开的"读文本"入口，所以判定完直接读。 */
export const readInsideWorkspace = async (target: DocumentTarget): Promise<string> => {
  try {
    await assertInsideWorkspace(target);
    return await readFile(target.absolute, "utf8");
  } catch (error: unknown) {
    // 自己抛的 `HrError`（越界等）原样走：只有 fs 的失败需要翻译。
    throw error instanceof HrError ? error : failureOfFsCall(error, target, "无法读取文档");
  }
};

/**
 * core 的 ops 自己已经翻译过 errno（`not_a_file` + `cause: ENOENT`），但**因果是同一个**：
 * 目标不存在就该是 `not_found`、文案就该是"文档不存在：<相对路径>"，不能把 core 的口径直接端给模型。
 * 其它 core 错误只折绝对路径（`foldedOf`），码原样——所以这里只分 ENOENT 一支。
 */
export const coreFailureOf = (error: unknown, target: DocumentTarget): unknown =>
  error instanceof HrError && codeOf(error.cause) === "ENOENT"
    ? new HrError("not_found", `文档不存在：${target.input}`, { cause: error })
    : foldedOf(error);

/** 写新文件的 errno 翻译与读共用同一套上表，只是动词不同（`EEXIST` 也是 `io_failure`）。 */
export const writeFailureOf = (error: unknown, target: DocumentTarget): HrError =>
  error instanceof HrError
    ? error
    : failureOfFsCall(error, target, "写入失败（目录不可建或文件已存在）");
