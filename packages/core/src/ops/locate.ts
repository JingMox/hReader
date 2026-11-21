// 这层管：`<nodeId|selector>` 两种解释的唯一实现（先选择器、再 node id）；不改树、不序列化、不判外壳。
// 放在 `ops/` 顶层的理由：`read` 与 `patch` 都是它的调用方，它不是 `readNode` 的内部件；
// 它只借用 `readNode/` 的选择器文法与先序解析（那两件是 `readNode` 的实现细节，不对外）。
// `read` 与 `patch` 共用它：两条命令对同一个串必须解析到同一个节点（同输入同 id），
// 各写一份"重试链"必然漂移。

import type { ParsedHtml } from "../html/constants";
import { HR_ID_PATTERN } from "../html/constants";
import { HrError } from "../hr-error";
import { identifierOf } from "./readNode/attrs";
import { resolveSelector } from "./readNode/resolve";
import { parseSelector } from "./readNode/selector";

/** 一次定位的结果：`selector` 是喂给 `readNode` 的串，`nodeId` 是 `patch` 要的 `data-hr-id`。 */
export interface LocatedTarget {
  /** 命中时实际生效的串：原串（按选择器命中）或 `[data-hr-id="…"]`（按 id 命中）。 */
  readonly selector: string;
  /** 命中元素自己的 `data-hr-id`；元素不可寻址（如 `<em>`）时为 `undefined`。 */
  readonly nodeId: string | undefined;
  /** 命中的元素总数（含不可寻址的）。 */
  readonly matches: number;
  /** 命中且有 `data-hr-id` 的元素数。 */
  readonly addressable: number;
  /** 文档序前 `CANDIDATE_LIMIT` 个 `data-hr-id`（多义报文用）。 */
  readonly candidates: readonly string[];
}

const idSelectorOf = (target: string): string => `[data-hr-id="${target}"]`;
/** 类型谓词：`attemptOrFailure` 只收 `HrError` 进 `Attempt.failure`，其余当场 rethrow。 */
const isRetriable = (error: unknown): error is HrError =>
  error instanceof HrError &&
  (error.code === "invalid_selector" || error.code === "node_not_found");

const locatedFrom = (
  selector: string,
  resolved: ReturnType<typeof resolveSelector>,
): LocatedTarget => ({
  selector,
  nodeId: identifierOf(resolved.node),
  matches: resolved.matches,
  addressable: resolved.addressable,
  candidates: resolved.ids,
});

/**
 * 两跳都没命中。码只在**这里**定，判据是**这一跳为什么失败**（失败码），不是目标串长什么样：
 * `#`、空格、`>` 都不是 id 字符，按字面形态判就会把“文法过了、只是零命中”塞进 syntax 分支
 * （F20：`#S2`/`#nope`/`article > div:nth-of-type(9)` 曾报 `invalid_selector` + `reason:"syntax"`，
 * 报文还自相矛盾地写着“没有匹配到任何节点”，而同一串走 `readNode` 是 `node_not_found`）。
 * 任一跳报 `node_not_found` ⇒ 那一跳的文法已过，整条就是“找不到”；两跳都是 `invalid_selector` 才是写法错。
 * `HR_ID_PATTERN` 只决定第二跳要不要试（在 `idSelectorOf` 之前），判码时不出现。
 * 报文只讲**一句**，主语用用户敲的那个串（不是 `[data-hr-id="…"]`）：另一跳的过程是调试信息，
 * 两跳拼给用户看只会得到自相矛盾的报文（R2-14）。
 */
const bothFailed = (target: string, bySelector: HrError, byId: HrError | undefined): never => {
  const quoted = JSON.stringify(target);
  if (bySelector.code === "node_not_found") {
    // 选择器那一跳的文法过了、只是没命中：报文就讲没命中，不能改口把它说成一个 id。
    throw new HrError("node_not_found", `文档里没有匹配 ${quoted} 的节点。`);
  }
  if (byId?.code === "node_not_found") {
    throw new HrError("node_not_found", `文档里没有 id 为 ${quoted} 的节点。`);
  }
  throw new HrError("invalid_selector", `选择器 ${quoted} 无法解析：${bySelector.message}`, {
    data: { reason: "syntax" },
  });
};

const attempt = (parsed: ParsedHtml, selector: string): LocatedTarget =>
  locatedFrom(selector, resolveSelector(parsed.root, parseSelector(selector), selector));

/** 一跳的结果：要么命中，要么带住可重试的失败原因（报文要用到它）。两个成员互斥以便后续收窄。 */
type Attempt =
  | { readonly located: LocatedTarget; readonly failure: undefined }
  /** 只可能是 `isRetriable` 认下的 `HrError`：其余异常在 `attemptOrFailure` 里当场 rethrow。 */
  | { readonly located: undefined; readonly failure: HrError };

const attemptOrFailure = (parsed: ParsedHtml, selector: string): Attempt => {
  try {
    return { located: attempt(parsed, selector), failure: undefined };
  } catch (error: unknown) {
    if (!isRetriable(error)) throw error;
    return { located: undefined, failure: error };
  }
};

/**
 * 两种解释都成立：选择器命中了一个元素，文档里又真有一个 `data-hr-id` 就是这串。
 * 不选一个“优先”：`patch` 猜错就是改错节点且不报错，静默优先级买不到这种事。
 * 报文必须给两条逃生路——只给 id 那条的话，“用户本来想要那个标签”就没有任何写法了。
 */
const ambiguousTarget = (target: string, bySelector: LocatedTarget): never => {
  const ids = [...new Set([bySelector.nodeId, target])].filter(
    (id): id is string => id !== undefined,
  );
  const quoted = JSON.stringify(target);
  throw new HrError(
    "invalid_selector",
    `目标 ${quoted} 有两种解释，不替你选：按选择器命中 ${String(bySelector.matches)} 个元素，而文档里也另有一个 ` +
      `data-hr-id=${quoted} 的元素。按 id 取：'#${target}' 或 '[data-hr-id=${quoted}]'；` +
      `按标签取：用 '父标签 > ${target}:nth-of-type(n)' 这类带父级的形态。`,
    {
      data: {
        reason: "ambiguous",
        // 双解释时指可选项数（2：id 一个 + 选择器一个），不是命中数。
        count: ids.length,
        matches: bySelector.matches,
        candidates: ids,
      },
    },
  );
};

/** 多义：复用 `invalid_selector`，成因与候选放在 `data` 里（报文只给人看）。 */
const ambiguousPatchTarget = (target: string, located: LocatedTarget): never => {
  const more =
    located.addressable > located.candidates.length ? `…等 ${String(located.addressable)} 个` : "";
  throw new HrError(
    "invalid_selector",
    `选择器「${target}」命中 ${String(located.addressable)} 个可寻址元素，请给 id：${located.candidates.join("、")}${more}`,
    {
      data: {
        reason: "ambiguous",
        count: located.addressable,
        matches: located.matches,
        candidates: located.candidates,
      },
    },
  );
};

/**
 * `patch` 要的是**一个** id：命中多个时猜一个就是改错节点且不报错，命中零个可寻址元素时
 * 也不能把问题推给 core 的“找不到这个 id”（那是一句不对症的报错）。
 */
export const patchTargetIdOf = (parsed: ParsedHtml, target: string): string => {
  const located = locateTarget(parsed, target);
  if (located.addressable > 1) return ambiguousPatchTarget(target, located);
  const id = located.addressable === 0 ? undefined : located.nodeId;
  if (id === undefined) {
    throw new HrError(
      "node_not_found",
      `目标 ${JSON.stringify(target)} 命中的元素没有 data-hr-id（不可寻址），patch 需要 id：改用可寻址的容器或祖先`,
    );
  }
  return id;
};

/**
 * 两条解释的先后**不再**是优先级（先算哪跳只看谁能先解释这个串）：选择器命中时再拿 id 跳交叉校验，
 * 两跳都成立就拒绝；选择器没命中时 id 跳就是回退（裸 id `hr-a1` 靠这条活）。
 */
export const locateTarget = (parsed: ParsedHtml, target: string): LocatedTarget => {
  const bySelector = attemptOrFailure(parsed, target);
  // id 那跳只在目标**够得着**一个 id 时才试（`HR_ID_PATTERN` 只在这里用）：`#`、空格、`>` 进不了 id 字符集，
  // 硬拼成 `[data-hr-id="article > div:nth-of-type(9)"]` 只会多出一次与用户输入无关的“合法零命中”，
  // 而那一次零命中会把 `p[` 这类真文法错改判成 `node_not_found`。
  const byId = HR_ID_PATTERN.test(target)
    ? attemptOrFailure(parsed, idSelectorOf(target))
    : undefined;
  if (bySelector.located !== undefined) {
    // 命中元素就是那个同名 id 自己（如 `[data-hr-id="h2"]`）：两种解释指向同一个节点，不算歧义。
    const collides = byId?.located !== undefined && bySelector.located.nodeId !== target;
    return collides ? ambiguousTarget(target, bySelector.located) : bySelector.located;
  }
  if (byId?.located !== undefined) {
    return byId.located;
  }
  return bothFailed(target, bySelector.failure, byId?.failure);
};
