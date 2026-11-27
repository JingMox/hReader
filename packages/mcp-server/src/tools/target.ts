// This layer: `filePath` → `{workspace, file}` that core can consume, plus the package's only boundary check (reads and creates share the same standard).

import { randomUUID } from "node:crypto";
import { link, mkdir, realpath, rm, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { HrError, cutAtCodePoint, isInside, isInsideOrSelf, nodePatchDeps } from "@hreader/core";

import { foldedOf } from "../errors";

/**
 * One shared sentence in the `filePath` description of seven tools: **what "the workspace" is must be spelled out**.
 * By default it is the cwd at startup (`--workspace` overrides); when the host launches from `cd /`, in-bounds is the whole root —
 * not a bug, but the host must not have to guess.
 */
export const FILE_PATH_HINT =
  "路径相对工作区（可用 --workspace <dir> 指定，缺省为启动时的 cwd）；绝对路径也必须落在工作区之内";

export interface DocumentTarget {
  /** The boundary (core's `workspace`). */
  readonly workspace: string;
  /** Path relative to `workspace`: core's `resolveTarget` does its own realpath + escape rejection. */
  readonly file: string;
  /** The `filePath` the user passed **verbatim**: error wording echoes it, never a path we computed. */
  readonly input: string;
  readonly absolute: string;
}

/**
 * `~` is not expanded: this server does not guess the user's home, nor may it create a directory literally named `~` inside the workspace
 * (`~/doc.html` once silently landed as `<workspace>/~/doc.html` and still answered "created").
 * Only this one spelling is rejected; expansion is a product decision, not the validation layer's job.
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

/** Same shape as core's `io/errors.ts`: take `code` as-is without narrowing; a non-string simply never matches. */
const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/**
 * The boundary check is written once: for a non-existent target we compare the **ancestor** directory, and equality with the workspace is allowed (`isInsideOrSelf`);
 * for an existing one we compare the **target** itself, which must be strictly inside (core's `isInside` means "inside and not equal").
 */

interface ExistingPath {
  readonly path: string;
  /** The target itself exists; `false` means we fell back to the nearest existing ancestor. */
  readonly exists: boolean;
}

/**
 * For a target that does not exist yet, `realpath` throws `ENOENT` (`ENOTDIR` when a parent segment is a file): fall back to the nearest existing ancestor.
 * The root always resolves, so this loop only ends via `return`; other errors rethrow as-is ("cannot resolve" does not mean "inside").
 * `exists` rides along: an existing target is compared on itself (must be strictly inside), a missing one on its ancestor directory (may equal the workspace).
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
 * The boundary check (the only one in this package; reads and creates share the standard): the target itself, or its nearest existing ancestor,
 * must land inside `realpath(workspace)` after `realpath` — an existing target demands "strictly inside", a missing one allows "is the workspace".
 * Two things rest on it: symlink escapes (`ln -s /tmp workspace/link` then `link/x.html`) get rejected;
 * and **ordering** — callers must invoke it before `mkdir`/`writeFile`, or we create directories out of bounds before noticing.
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
    // Wording uses the relative path the user passed in: absolute paths leak host layout to the model.
    throw new HrError("path_outside_workspace", `目标不在工作区内：${target.input}`);
  }
};

const PATH_MESSAGE_CHARS = 64;

const tooLongMessageOf = (file: string): string =>
  `路径过长：${cutAtCodePoint(file, PATH_MESSAGE_CHARS)}…（共 ${String(file.length)} 字符）`;

/**
 * Translate errnos into human wording + our codes: **only the call site knows "which file, which operation"** — the fallback mapping cannot see that context.
 * `internal` is reserved for genuinely unexpected errors (`TypeError` etc.): every fs-layer failure has a semantics to file under.
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

/** Read tools (outline/read_node) do not write, and core exposes no public "read text" entry — so we check then read directly. */
export const readInsideWorkspace = async (target: DocumentTarget): Promise<string> => {
  try {
    await assertInsideWorkspace(target);
    return await readFile(target.absolute, "utf8");
  } catch (error: unknown) {
    // `HrError`s we threw ourselves (out-of-bounds etc.) pass through untouched: only fs failures need translating.
    throw error instanceof HrError ? error : failureOfFsCall(error, target, "无法读取文档");
  }
};

/**
 * core's ops already translate errno (`not_a_file` + `cause: ENOENT`), but **the cause is one and the same**:
 * a missing target should be `not_found` with "document does not exist: <relative path>" wording — core's phrasing cannot be served to the model as-is.
 * Other core errors only get their absolute paths folded (`foldedOf`), code untouched — hence this branch handles ENOENT alone.
 */
export const coreFailureOf = (error: unknown, target: DocumentTarget): unknown =>
  error instanceof HrError && codeOf(error.cause) === "ENOENT"
    ? new HrError("not_found", `文档不存在：${target.input}`, { cause: error })
    : foldedOf(error);

/** The errno table for writes shares the same entries as reads; only the verb differs (`EEXIST` is also `io_failure`). */
export const writeFailureOf = (error: unknown, target: DocumentTarget): HrError =>
  error instanceof HrError
    ? error
    : failureOfFsCall(error, target, "写入失败（目录不可建或文件已存在）");

const encoder = new TextEncoder();

const isEexist = (error: unknown): boolean => codeOf(error) === "EEXIST";

const TMP_PREFIX = ".hr-create-";

/**
 * Atomic "create new": `writeFile(wx)`'s existence gate is atomic, but the write itself is not — a process dying midway leaves half a
 * "new document". tmp + `link(2)` hands "create only if absent" to the kernel (EEXIST never overwrites, never tears the file);
 * tmp content is first landed by `writeFileAtomic` (fsync + inherited permissions), and any failure sweeps tmp away.
 * mkdir's EEXIST (a middle segment is a file) and link's EEXIST (target exists) are different things — folded separately.
 */
export const createNewFileOf = async (target: DocumentTarget, html: string): Promise<void> => {
  const dir = dirname(target.absolute);
  const tmp = join(dir, `${TMP_PREFIX}${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    await nodePatchDeps.fs.writeFileAtomic(tmp, encoder.encode(html));
  } catch (error: unknown) {
    await rm(tmp, { force: true });
    throw writeFailureOf(error, target);
  }
  try {
    await link(tmp, target.absolute);
  } catch (error: unknown) {
    // `file_exists` is the outward meaning of "target already taken" (same code as CLI `--out`); it must not fall into the io_failure fallback.
    // tmp lives in the target's directory: short of EEXIST, anything that could fail link would have failed writeFileAtomic first — defensive fallback.
    /* v8 ignore next */
    if (!isEexist(error)) throw writeFailureOf(error, target);
    throw new HrError("file_exists", `目标已存在：${target.input}`, { cause: error });
  } finally {
    await rm(tmp, { force: true });
  }
};
