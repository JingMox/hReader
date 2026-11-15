// 这层管：包入口（供测试与将来的进程内嵌用）；bin 走 `dist/main.js`，不经过这里。

export { createServer, SERVER_VERSION } from "./server";
export { modeOf, runMain, startHttp, USAGE } from "./cli";
export type { MainIo, Mode, RunningHttp } from "./cli";
export { styleIdsOf, STYLE_URI_PREFIX } from "./resources";
export { USE_STYLE_PROMPT } from "./prompts";
export { UI_MIME_TYPE, UI_URI_PREFIX } from "./ui";
