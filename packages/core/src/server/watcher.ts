// 这层管：目录级文件监听（chokidar 归一化 add/change/unlink + 去抖 100ms）；不读文件、不解析内容。
// 自写回声不在这一层判：时间窗分不清"我们的回声"和"别进程的写"（MCP/CLI 落在窗内的
// 改动会被整段吞掉）——字节 sha 去重在下游 `publishChanged`，那才是内容级判定。

import { basename, join } from "node:path";

import { watch } from "chokidar";

export const DEBOUNCE_MS = 100;

/** 盲窗对账心跳：挂载→ready 之间事件源看不见任何写，对被盯文件按固定间隔 reconcile
 *  一次（sha 去重在下游）；真事件到手或 ready 即停。ready 在 CPU 打满时能拖几十秒，
 *  只等 reconcile-at-ready 等于把盲窗拉长到整个挂载期。 */
const RECONCILE_MS = 250;

export interface Watcher {
  /** `file` 为 `undefined` 时监听整个目录（书库目录），否则只关心该文件名。 */
  readonly add: (dir: string, file: string | undefined) => void;
  readonly close: () => void;
}

interface WatcherInput {
  /** `probe` = 盲窗对账心跳（不是真事件）：下游只对活跃文档做内容比对，未活跃路径不得据此发布。 */
  readonly onFileChange: (path: string, probe?: boolean) => void;
}

/** 句柄只要求能关：chokidar 的 `close()` 返回 Promise，注入的 `fs.watch` 替身返回 void，都满足。
 *  `ready` 是可选上报：事件源就绪=挂载盲窗结束（chokidar 'ready' 在首轮扫描后触发）。 */
interface WatchHandle {
  readonly close: () => void;
  readonly ready?: (handler: () => void) => void;
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
  let seenReady = false;
  watcher.on("all", (event, path) => {
    onEvent(event, basename(path));
  });
  watcher.on("ready", () => {
    seenReady = true;
  });
  watcher.on("error", () => undefined);
  return {
    close: () => void watcher.close(),
    // 'ready' 只发一次：监听注册晚于它就绪的话 `once` 永远等不到——记过就直接调。
    ready: (handler) => {
      if (seenReady) handler();
      else watcher.once("ready", handler);
    },
  };
};

interface Scheduler {
  readonly schedule: (path: string) => void;
  readonly clear: () => void;
}

const schedulerOf = (input: WatcherInput): Scheduler => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (path: string): void => {
    const pending = timers.get(path);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        input.onFileChange(path);
      }, DEBOUNCE_MS),
    );
  };
  return {
    schedule,
    clear: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
};

export const createWatcher = (input: WatcherInput, watchFn: WatchFn = chokidarWatch): Watcher => {
  interface Entry {
    readonly handle: WatchHandle;
    readonly stop: () => void;
  }
  const watchers = new Map<string, Entry>();
  const scheduler = schedulerOf(input);
  return {
    add: (dir, file) => {
      const key = `${dir}\0${file ?? "*"}`;
      if (watchers.has(key)) return;
      let poll: ReturnType<typeof setInterval> | undefined;
      const stopPoll = (): void => {
        if (poll !== undefined) {
          clearInterval(poll);
          poll = undefined;
        }
      };
      const handle = watchFn(dir, (event, name) => {
        if (!FILE_EVENTS.has(event)) return;
        if (name === undefined) return;
        if (file !== undefined && name !== file) return;
        // 被盯文件的真事件到手 = 盲窗已结束，对账心跳停掉（去抖照常排队）。
        stopPoll();
        scheduler.schedule(join(dir, name));
      });
      watchers.set(key, { handle, stop: stopPoll });
      // 挂载盲窗：watch() 到事件源就绪之间落下的写，事件源看不见（首轮扫描把它当存量）。
      // 对被盯文件按固定心跳 reconcile（sha 去重下游做，同字节不发事件）：收敛期从
      // "等 ready" 缩短到一个心跳间隔；真事件或 ready 任一先到即停。整目录监听没有
      // 可重读的单文件，盲窗只能靠下一事件收敛。
      const target = file === undefined ? undefined : join(dir, file);
      if (target !== undefined && handle.ready !== undefined) {
        poll = setInterval(() => {
          if (!watchers.has(key)) {
            stopPoll();
            return;
          }
          input.onFileChange(target, true);
        }, RECONCILE_MS);
        poll.unref();
        handle.ready(() => {
          stopPoll();
          if (!watchers.has(key)) return;
          input.onFileChange(target, true);
        });
      }
    },
    close: () => {
      scheduler.clear();
      for (const entry of watchers.values()) {
        entry.stop();
        entry.handle.close();
      }
      watchers.clear();
    },
  };
};
