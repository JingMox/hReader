// 这层管：写路由的"按 kind 选处理器 + 同文档串行"（AC3.5 复用既有队列）；不解析 body 语义。

import type { IncomingMessage } from "node:http";

import {
  annotationAddReply,
  annotationResolveReply,
  undoReply,
  type DocAnId,
} from "./annotation-replies";
import { requiredStringOf, stringFieldOf } from "./body";
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

const docIdOf = (
  body: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, string>>,
): string => {
  const pathDocId = params["docId"];
  if (pathDocId === undefined) return requiredStringOf(body, "docId");
  // 路径 `<docId>` 是唯一真相（裁定 #6）：browser 端可省略 body.docId，但给了不一致的值必须拒收。
  const bodyDocId = stringFieldOf(body, "docId");
  if (bodyDocId !== undefined && bodyDocId !== pathDocId) {
    throw new HrError("invalid_payload", `body.docId（${bodyDocId}）与路径（${pathDocId}）不一致`);
  }
  return pathDocId;
};

const writeReplyOf = (
  context: HandlerContext,
  route: Route,
  body: Readonly<Record<string, unknown>>,
  ids: DocAnId,
): Promise<Written> => {
  if (route.kind === "patch") return patchReply(context, body, LOCK_WAIT_MS);
  if (route.kind === "style") return styleReply(context, body, LOCK_WAIT_MS);
  if (route.kind === "annotationAdd") {
    return annotationAddReply(context, ids.docId, body, LOCK_WAIT_MS);
  }
  if (route.kind === "annotationResolve") {
    return annotationResolveReply(context, ids, body, LOCK_WAIT_MS);
  }
  if (route.kind === "undo") return undoReply(context, ids.docId, LOCK_WAIT_MS);
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
  const docId = docIdOf(body, params);
  const ids: DocAnId = { docId, anId: paramOf(params, "anId", "") };
  const key = docQueueKey(context.workspace, docId);
  return withDocQueue(key, () => writeReplyOf(context, route, body, ids));
};
