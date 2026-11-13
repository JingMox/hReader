// 这层管：patch 的词表与裸数据类型；不含逻辑、不碰 IO、不分配 ID。

export type PatchAction = "replace" | "insert_before" | "insert_after" | "append" | "delete";

export interface PatchRequest {
  /** 目标的 `data-hr-id`；`"root"` 指最外层 `<article>` 自身（保留其属性）。 */
  readonly targetId: string;
  readonly action: PatchAction;
  /** replace / insert_before / insert_after / append 必填；delete 必须不传。 */
  readonly html?: string;
}

export interface PatchOutcome {
  readonly html: string;
  /** 本次新分配的 ID，文档序；已有 ID 一律不动。 */
  readonly newIds: readonly string[];
  readonly changed: boolean;
}

export const ROOT_TARGET_ID = "root";

export const PATCH_ACTIONS: readonly PatchAction[] = [
  "replace",
  "insert_before",
  "insert_after",
  "append",
  "delete",
];

/** 可执行容器与外部资源容器：一条都不放过，报文里点名标签即可。 */
export const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "base",
]);

/** 这类值不是 URL 而是"能执行/能换文档"的协议，比较前要剥空白与控制字符再小写。 */
export const FORBIDDEN_VALUE_PREFIXES: readonly string[] = ["javascript:", "data:text/html"];

/** 动画元素只在 `<svg>` 里能生效，判定要看 svg 上下文（`attributeName` 被 parse5 小写化）。 */
export const SVG_CONTAINER = "svg";

export const SVG_EVENT_TAGS: ReadonlySet<string> = new Set(["animate", "set"]);
