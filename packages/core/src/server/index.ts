// 这层管：server 子模块门面（启动入口 + 被测试直接使用的可单测部件）；不承载实现。

export { startServer } from "./server";
export type { RunningServer, ServerDeps } from "./server";
export type { Reply, ServerOptions, ThumbRender, ThumbRequest } from "./contracts";
export type { DaemonInfo } from "./daemon";
export { decodeParams, matchRoute, paramOf } from "./routes";
export { statusOf } from "./status";
export { READY_FRAME, createEventRing } from "./event-ring";
export { createHub } from "./hub";
export { createWatcher } from "./watcher";
export { daemonFileOf } from "./daemon";
export { createCapabilityBook } from "./capability";
export type { CapabilityBook } from "./capability";
export { createAnnotateTokenBook } from "./annotate";
export type { AnnotateTokenBook } from "./annotate";
export { docAssetReply } from "./doc-assets";
export type { HandlerContext } from "./handlers";
