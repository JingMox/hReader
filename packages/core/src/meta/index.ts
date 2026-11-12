// 这层管：`hr-meta` 子模块门面（读取 + 类型）；不写回、不校验引用是否存在。

export { readMeta } from "./parse";
export { PENDING_ANNOTATION_STATUS } from "./constants";
export type { MetaAnnotation } from "./constants";
