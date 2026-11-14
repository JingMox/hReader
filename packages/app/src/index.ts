// 这层管：包的公共面。只导出"配对侧（测试 / 未来 CLI 内嵌）会用到"的构造器；内部细节不外泄。
export type { Host, NodeSpec } from "./dom.ts";
export { boot, type BootDeps, type Booted } from "./boot.ts";
export { createStore, type Store } from "./store.ts";
export { createSse, type Sse, type SseEvent, type SseHandlers } from "./sse.ts";
export { createStyleSwitch, type StyleSwitch } from "./style-switch.ts";
export { intentOf, type KeyLike } from "./keys.ts";
export {
  initialState,
  reduce,
  type ConnState,
  type ReaderIntent,
  type ReaderState,
} from "./state.ts";

export { REQUIRED_ANCHORS, missingAnchorsOf } from "./anchors.ts";
