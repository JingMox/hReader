// 这层管：目录级文件监听（chokidar 归一化 add/change/unlink + 去抖 100ms）；不读文件、不解析内容。
// 自写回声不在这一层判：时间窗分不清"我们的回声"和"别进程的写"（MCP/CLI 落在窗内的
// 改动会被整段吞掉）——字节 sha 去重在下游 `publishChanged`，那才是内容级判定。

import { basename, join, relative, sep } from "node:path";

import { watch, type MatchFunction } from "chokidar";

import { isTmpFileName } from "../io/atomic";

export const DEBOUNCE_MS = 100;

/** 盲窗对账心跳：挂载→ready 之间事件源看不见任何写，对被盯文件按固定间隔 reconcile
 *  一次（sha 去重在下游）；真事件到手或 ready 即停。ready 在 CPU 打满时能拖几十秒，
 *  只等 reconcile-at-ready 等于把盲窗拉长到整个挂载期。 */
export const RECONCILE_MS = 250;

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

/** `recursive` 只有整目录挂载为 true；被盯文件的挂载保持浅层——它只按名字过滤一个文件。 */
export interface WatchOptions {
  readonly recursive: boolean;
}

export type WatchFn = (
  dir: string,
  onEvent: (event: string, name: string | undefined) => void,
  options: WatchOptions,
) => WatchHandle;

/**
 * 文件事件白名单；目录事件（addDir/unlinkDir）不算"文件变了"。过滤放在 attach，注入源同样被归一化。
 * "rename" 要算进去：注入的 `fs.watch` 替身就用 rename 报"文件被换掉了"。
 */
const FILE_EVENTS: ReadonlySet<string> = new Set(["add", "change", "unlink", "rename"]);

/** 内部目录段名：命中任意一段即不算书库内容。`.hreader` 带 history/locks/trust，
 *  `.git`/`node_modules` 是同仓常见大目录——既防广播噪声，也让 `ignored` 整棵剪掉不进遍历。 */
const INTERNAL_SEGMENTS: ReadonlySet<string> = new Set([".hreader", ".git", "node_modules"]);

/** "书库内容"路径的口径：在监听根内、不穿过内部目录段、叶子名不是原子写/编辑器临时名。
 *  tmp 规则只看叶子——`drafts.202410/`、`backup~/` 目录名形似，里面的文件仍是书库内容。
 *  `root` 本身恒真：chokidar 把 `ignored` 也套在监听根上，根被忽略等于整表静默。 */
export const isLibraryPath = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  if (rel === "") return true;
  const segments = rel.split(sep);
  if (segments[0] === ".." || segments.some((segment) => INTERNAL_SEGMENTS.has(segment))) {
    return false;
  }
  const name = basename(path);
  return !isTmpFileName(name) && !name.endsWith("~");
};

/**
 * 默认事件源。chokidar 把平台差异（编辑器 rename 式原子保存、unlink→add 抖动）归一成
 * add/change/unlink；`ignoreInitial` 跳过存量扫描。整目录挂载放开 `depth` 递归，
 * 单文件挂载仍是 depth 0。`followSymlinks: false`：链接条目本身照常报，但绝不顺着
 * 链接把工作区外的目录挂进监听——逃逸与成环都不可能。`ignored` 与 isLibraryPath 同
 * 口径，唯一区别是目录（和挂载入口尚未 stat 的路径）只按内部段剪：tmp 形目录名下的内容仍是书库，叶子名规则只对 stats 证实是文件的路径生效。
 * `error` 事件没有上抛通道：监听失败只是"不再报变化"，挂个空处理器避免 EventEmitter 未监听 error 直接崩进程。
 */
const chokidarWatch: WatchFn = (dir, onEvent, options) => {
  const ignored: MatchFunction = (path, stats) => {
    if (stats === undefined || stats.isDirectory()) {
      const segments = relative(dir, path).split(sep);
      return segments.some((segment) => INTERNAL_SEGMENTS.has(segment));
    }
    return !isLibraryPath(dir, path);
  };
  const watcher = watch(dir, {
    // exactOptionalPropertyTypes 下 depth 只能"缺省或给数字"，不能显式 undefined。
    ...(options.recursive ? {} : { depth: 0 }),
    ignoreInitial: true,
    followSymlinks: false,
    ignored,
  });
  watcher.on("all", (event, path) => {
    // 事件名一律"相对监听根"：浅层挂载下它就是 basename，递归挂载下保住子目录前缀。
    onEvent(event, relative(dir, path));
  });
  watcher.on("error", () => undefined);
  return {
    close: () => void watcher.close(),
    ready: (handler) => {
      watcher.once("ready", handler);
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
      const handle = watchFn(
        dir,
        (event, name) => {
          if (!FILE_EVENTS.has(event)) return;
          // 空名是"根目录自身"这类无指事件：join(dir,"") 会把根当文件报，吞掉。
          if (name === undefined || name === "") return;
          if (file !== undefined && name !== file) return;
          // 被盯文件的真事件到手 = 盲窗已结束，对账心跳停掉（去抖照常排队）。
          stopPoll();
          scheduler.schedule(join(dir, name));
        },
        { recursive: file === undefined },
      );
      watchers.set(key, { handle, stop: stopPoll });
      // 挂载盲窗：watch() 到事件源就绪之间落下的写，事件源看不见（首轮扫描把它当存量）。
      // 对被盯文件按固定心跳 reconcile（sha 去重下游做，同字节不发事件）：收敛期从
      // "等 ready" 缩短到一个心跳间隔；真事件或 ready 任一先到即停。整目录监听没有
      // 可重读的单文件，盲窗只能靠下一事件收敛。
      const target = file === undefined ? undefined : join(dir, file);
      if (target !== undefined && handle.ready !== undefined) {
        poll = setInterval(() => {
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
