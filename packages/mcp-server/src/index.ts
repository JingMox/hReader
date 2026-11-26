// This layer: package entry (for tests and future in-process embedding); the bin goes through `dist/main.js`, not here.

export { createServer, SERVER_VERSION } from "./server";
export { modeOf, runMain, startHttp, USAGE } from "./cli";
export type { MainIo, Mode, RunningHttp } from "./cli";
export { styleIdsOf, STYLE_URI_PREFIX } from "./resources";
export { USE_STYLE_PROMPT } from "./prompts";
export { UI_MIME_TYPE, UI_URI_PREFIX } from "./ui";
