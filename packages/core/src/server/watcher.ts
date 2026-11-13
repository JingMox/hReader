// 这层管：目录级文件监听（去抖 100ms + 自身写入回声窗口 200ms）；不读文件、不解析内容。

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export const DEBOUNCE_MS = 100;
export const ECHO_MS = 200;

export interface Watcher {
  /** `file` 为 `undefined` 时监听整个目录（书库目录），否则只关心该文件名。 */
  readonly add: (dir: string, file: string | undefined) => void;
  readonly noteSelfWrite: (path: string) => void;
  readonly close: () => void;
}

interface WatcherInput {
  readonly now: () => number;
  readonly onFileChange: (path: string) => void;
}

export type WatchFn = (
  dir: string,
  onEvent: (event: string, name: string | undefined) => void,
) => FSWatcher;

/** 薄封装：把 `fs.watch` 的回调收成 `(event, name)`；Node 在平台不给名字时回调 `null`，`String(null)` 落成 `"null"` 后自然匹配不上任何真实文件名。 */
const nodeWatch: WatchFn = (dir, onEvent) =>
  watch(dir, { persistent: true }, (event, filename) => {
    onEvent(event, String(filename));
  });

interface Scheduler {
  readonly schedule: (path: string) => void;
  readonly note: (path: string) => void;
  readonly clear: () => void;
}

const schedulerOf = (input: WatcherInput): Scheduler => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const selfWrites = new Map<string, number>();
  const emit = (path: string): void => {
    const at = selfWrites.get(path);
    if (at !== undefined && input.now() - at < ECHO_MS) return;
    input.onFileChange(path);
  };
  const schedule = (path: string): void => {
    const pending = timers.get(path);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        emit(path);
      }, DEBOUNCE_MS),
    );
  };
  return {
    schedule,
    note: (path) => {
      selfWrites.set(path, input.now());
    },
    clear: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
};

export const createWatcher = (input: WatcherInput, watchFn: WatchFn = nodeWatch): Watcher => {
  const watchers = new Map<string, FSWatcher>();
  const scheduler = schedulerOf(input);
  const attach = (dir: string, file: string | undefined): FSWatcher =>
    watchFn(dir, (_event, name) => {
      if (name === undefined) return;
      if (file !== undefined && name !== file) return;
      scheduler.schedule(join(dir, name));
    });
  return {
    add: (dir, file) => {
      const key = `${dir}\u0000${file ?? "*"}`;
      if (watchers.has(key)) return;
      watchers.set(key, attach(dir, file));
    },
    noteSelfWrite: scheduler.note,
    close: () => {
      scheduler.clear();
      for (const handle of watchers.values()) handle.close();
      watchers.clear();
    },
  };
};
