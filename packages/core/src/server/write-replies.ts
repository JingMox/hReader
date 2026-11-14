// 这层管：写路由的"按 kind 选处理器 + 同文档串行"（AC3.5 复用既有队列）；不解析 body 语义。

import type { IncomingMessage } from "node:http";

import {
  annotationAddReply,
  annotationResolveReply,
  undoReply,
  type DocAnId,
} from "./annotation-replies";
import { requiredStringOf } from "./body";
import { HrError } from "../hr-error";
import {
  annotationReply,
  LOCK_WAIT_MS,
  patchReply,
  styleReply,
  type HandlerContext,
  type Written,
} from "./handlers";
import { bodyRecordOf } from "./http-io";
import { docQueueKey, withDocQueue } from "./queue";
import { paramOf, type Route } from "./routes";

const writeReplyOf = (
  context: HandlerContext,
  route: Route,
  body: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, string>>,
): Promise<Written> => {
  const docId = requiredStringOf(body, "docId");
  // 路径 `<docId>` 是唯一真相（裁定 #6）：body 里给了不一致的 docId 就是**用户错误**，不是静默忽略。
  const pathDocId = paramOf(params, "docId", docId);
  if (pathDocId !== docId) {
    throw new HrError("invalid_payload", `body.docId（${docId}）与路径（${pathDocId}）不一致`);
  }
  if (route.kind === "patch") return patchReply(context, body, LOCK_WAIT_MS);
  if (route.kind === "style") return styleReply(context, body, LOCK_WAIT_MS);
  if (route.kind === "annotationAdd") return annotationAddReply(context, docId, body, LOCK_WAIT_MS);
  if (route.kind === "annotationResolve") {
    const ids: DocAnId = { docId, anId: paramOf(params, "anId", "") };
    return annotationResolveReply(context, ids, body, LOCK_WAIT_MS);
  }
  if (route.kind === "undo") return undoReply(context, docId, LOCK_WAIT_MS);
  return annotationReply(context, body, LOCK_WAIT_MS);
};

/** `dispatchWrite` 是写路由的唯一入口：同文档串行 + body 解析都在这里，handler 只看 record。 */
interface WriteRequest {
  readonly req: IncomingMessage;
  readonly bodyMs: number;
}

export const dispatchWrite = async (
  context: HandlerContext,
  route: Route,
  params: Readonly<Record<string, string>>,
  request: WriteRequest,
): Promise<Written> => {
  const body = await bodyRecordOf(request.req, request.bodyMs);
  const key = docQueueKey(context.workspace, requiredStringOf(body, "docId"));
  return withDocQueue(key, () => writeReplyOf(context, route, body, params));
};
