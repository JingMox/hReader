// 这层管：目录级文件监听（chokidar 归一化 add/change/unlink + 去抖 100ms + 自身写入回声窗口 200ms）；不读文件、不解析内容。

import { basename, join } from "node:path";

import { watch } from "chokidar";

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

/** 句柄只要求能关：chokidar 的 `close()` 返回 Promise，注入的 `fs.watch` 替身返回 void，都满足。 */
interface WatchHandle {
  readonly close: () => void;
}

export type WatchFn = (
  dir: string,
  onEvent: (event: string, name: string | undefined) => void,
) => WatchHandle;

/**
 * 文件事件白名单；目录事件（addDir/unlinkDir）不算"文件变了"。过滤放在 attach，注入源同样被归一化。
 * "rename" 要算进去：注入的 `fs.watch` 替身就用 rename 报"文件被换掉了"。
 */
const FILE_EVENTS: ReadonlySet<string> = new Set(["add", "change", "unlink", "rename"]);

/**
 * 默认事件源。chokidar 把平台差异（编辑器 rename 式原子保存、unlink→add 抖动）归一成
 * add/change/unlink；`depth: 0` 只看目录本身一层，`ignoreInitial` 跳过存量扫描。
 * `error` 事件没有上抛通道：监听失败只是"不再报变化"，挂个空处理器避免 EventEmitter 未监听 error 直接崩进程。
 */
const chokidarWatch: WatchFn = (dir, onEvent) => {
  const watcher = watch(dir, { depth: 0, ignoreInitial: true });
  watcher.on("all", (event, path) => {
    onEvent(event, basename(path));
  });
  watcher.on("error", () => undefined);
  return { close: () => void watcher.close() };
};

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

export const createWatcher = (input: WatcherInput, watchFn: WatchFn = chokidarWatch): Watcher => {
  const watchers = new Map<string, WatchHandle>();
  const scheduler = schedulerOf(input);
  const attach = (dir: string, file: string | undefined): WatchHandle =>
    watchFn(dir, (event, name) => {
      if (!FILE_EVENTS.has(event)) return;
      if (name === undefined) return;
      if (file !== undefined && name !== file) return;
      scheduler.schedule(join(dir, name));
    });
  return {
    add: (dir, file) => {
      const key = `${dir}\0${file ?? "*"}`;
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
