// 这层管：模型子模块门面（派生 + 校验 + 模型类型）；不做 HTML 解析、不碰 IO。

export { classifyDocument } from "./classify";
export { toDocumentModel } from "./derive";
export { loadDocument } from "./load";
export { validateDocument } from "./validate";
export type { Classification, DocClass } from "./classify";
export type { DocumentModel } from "./constants";
export type { DocumentLoad } from "./load";
