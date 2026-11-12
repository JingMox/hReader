// 这层管：模型子模块门面（派生 + 校验 + 模型类型）；不做 HTML 解析、不碰 IO。

export { toDocumentModel } from "./derive";
export { validateDocument } from "./validate";
export type { DocumentModel } from "./constants";
