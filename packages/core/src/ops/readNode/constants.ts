// 这层管：`readNode` 的常量、选择器形状与结果类型；不解析选择器、不遍历树、不算字节。

import type { Diagnostic } from "../../html/constants";
import type { PendingAnnotation } from "../outline";

/** 默认字节上限：单次读取不该把整篇文档塞给调用方。 */
export const DEFAULT_MAX_BYTES = 65536;

/** 硬顶：超过 16MB 的“单节点读取”几乎必然是调用方把单位写错了。 */
export const MAX_BYTES_LIMIT = 16 * 1024 * 1024;

/** 页面外壳：无论选择器怎么写都不对外。 */
export const SHELL_TAGS: ReadonlySet<string> = new Set(["html", "body", "head"]);

/** 内含 raw text 或模板内容的容器：复制出去会带走可执行体，一律不对外。 */
export const BLOCKED_CONTENT_TAGS: ReadonlySet<string> = new Set(["script", "style", "template"]);

/** 外壳锚点：`hr-meta` 脚本与 `hr-theme` 样式（`docs/02` §3.1），读 article 时必须剔除。 */
export const META_ANCHOR_ID = "hr-meta";
export const THEME_ANCHOR_ID = "hr-theme";

/** `#id` 与 `[data-hr-id="id"]` 是同一个形状：两者必须逐字同义。 */
export type Selector =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "tag"; readonly tag: string }
  | {
      readonly kind: "child";
      readonly parent: string;
      readonly tag: string;
      readonly index: number;
    };

export interface ReadNodeResult {
  readonly html: string;
  readonly annotations: readonly PendingAnnotation[];
  readonly truncated: boolean;
  readonly diagnostics: readonly Diagnostic[];
}
