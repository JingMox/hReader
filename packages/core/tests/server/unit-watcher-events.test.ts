// 这层管：`watcher.ts` 的事件归一化与边界——目录事件过滤、重复 add 去重、不可监听目录、注入源的空事件名。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWatcher, DEBOUNCE_MS, RECONCILE_MS } from "../../src/server/watcher";

type OnEvent = (event: string, name: string | undefined) => void;

/** 注入的事件源：attach 的回调收进 fires，用例手动派发；去抖走 vi 假时钟，与时序无关。 */
const fakeSource = (): {
  readonly fires: OnEvent[];
  readonly watch: Parameters<typeof createWatcher>[1];
} => {
  const fires: OnEvent[] = [];
  return {
    fires,
    watch: (_dir, onEvent) => {
      fires.push(onEvent);
      return { close: () => undefined };
    },
  };
};

const withFakeTimers = (run: () => void): void => {
  vi.useFakeTimers();
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createWatcher · 目录事件与重复订阅", () => {
  it("should ignore directory events and only report file changes", () => {
    withFakeTimers(() => {
      const { fires, watch } = fakeSource();
      const changes: string[] = [];
      const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
      try {
        watcher.add("/tmp/dir", undefined);
        // chokidar 对新建子目录报 addDir：目录事件不算"文件变了"。
        fires[0]?.("addDir", "sub.d");
        vi.advanceTimersByTime(DEBOUNCE_MS * 4);
        expect(changes).toEqual([]);

        fires[0]?.("change", "a.html");
        vi.advanceTimersByTime(DEBOUNCE_MS * 2);
        expect(changes).toEqual([join("/tmp/dir", "a.html")]);
      } finally {
        watcher.close();
      }
    });
  });

  it("should dedupe repeated add() calls for the same dir+file", () => {
    withFakeTimers(() => {
      // "同一 dir+file 只挂一个句柄 + 事件只报一次"，与时序无关、coverage 负载下不抖。
      const changes: string[] = [];
      const { fires, watch } = fakeSource();
      const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
      try {
        watcher.add("/tmp", "a.html");
        watcher.add("/tmp", "a.html");
        expect(fires).toHaveLength(1);
        fires[0]?.("rename", "a.html");
        vi.advanceTimersByTime(DEBOUNCE_MS * 2);

        expect(changes).toEqual([join("/tmp", "a.html")]);
      } finally {
        watcher.close();
      }
    });
  });
});

describe("createWatcher · 挂载盲窗 reconcile", () => {
  /** 带 `ready` 上报的事件源句柄：chokidar 'ready' 的抽象，注入源按同样契约给。 */
  interface ReadyHandle {
    readonly close: () => void;
    readonly ready: (handler: () => void) => void;
  }

  /** 复刻 chokidar "就绪前的事件看不见"的挂载盲窗：事件在 ready 之前一律不派发。 */
  const readySource = (): {
    readonly readies: (() => void)[];
    readonly fires: OnEvent[];
    readonly watch: Parameters<typeof createWatcher>[1];
  } => {
    const readies: (() => void)[] = [];
    const fires: OnEvent[] = [];
    return {
      readies,
      fires,
      watch: (_dir, onEvent): ReadyHandle => {
        fires.push(onEvent);
        return {
          close: () => undefined,
          ready: (handler) => {
            readies.push(handler);
          },
        };
      },
    };
  };

  it("should probe the watched file on a heartbeat until a real event arrives", () => {
    withFakeTimers(() => {
      const seen: { readonly path: string; readonly probe: boolean | undefined }[] = [];
      const { fires, watch } = readySource();
      const watcher = createWatcher(
        {
          onFileChange: (path, probe) => {
            seen.push({ path, probe });
          },
        },
        watch,
      );
      try {
        watcher.add("/tmp/dir", "a.html");
        // 盲窗里事件源看不见写：心跳按节拍把被盯文件送下去做内容比对（带探针标记）。
        vi.advanceTimersByTime(RECONCILE_MS * 2 + 50);
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(
          seen.every((entry) => entry.probe === true && entry.path === join("/tmp/dir", "a.html")),
        ).toBe(true);
        // 真事件到手 = 盲窗已结束：心跳停，之后只剩去抖出来的真投递。
        fires[0]?.("change", "a.html");
        vi.advanceTimersByTime(DEBOUNCE_MS * 2);
        expect(seen.at(-1)).toEqual({ path: join("/tmp/dir", "a.html"), probe: undefined });
        const count = seen.length;
        vi.advanceTimersByTime(RECONCILE_MS * 4);
        expect(seen).toHaveLength(count);
      } finally {
        watcher.close();
      }
    });
  });

  it("should stop the heartbeat at ready after one final reconcile", () => {
    withFakeTimers(() => {
      const changes: string[] = [];
      const { readies, watch } = readySource();
      const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
      try {
        watcher.add("/tmp/dir", "a.html");
        vi.advanceTimersByTime(RECONCILE_MS + 50);
        const beforeReady = changes.length;
        expect(beforeReady).toBeGreaterThanOrEqual(1);
        for (const ready of readies) ready();
        // ready 落定补最后一跳，然后心跳永久停：再走多少拍都不再投递。
        expect(changes).toHaveLength(beforeReady + 1);
        vi.advanceTimersByTime(RECONCILE_MS * 4);
        expect(changes).toHaveLength(beforeReady + 1);
      } finally {
        watcher.close();
      }
    });
  });

  it("should re-read the watched file on source ready, catching writes the attach gap hid", () => {
    const changes: string[] = [];
    const { readies, watch } = readySource();
    const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
    try {
      watcher.add("/tmp/dir", "a.html");
      // 盲窗里落下的外部写 chokidar 看不见：事件根本不来，只能靠就绪时的重读兜底。
      // patch→add 相邻的场景：同一路径的写紧跟着挂监听——ready 时的 reconcile
      // 必须照样送达 onFileChange，"算不算改"由下游字节 sha 判定。
      for (const ready of readies) ready();
      expect(changes).toEqual([join("/tmp/dir", "a.html")]);
    } finally {
      watcher.close();
    }
  });

  it("should not reconcile a whole-directory watch (no single file to re-read)", () => {
    const changes: string[] = [];
    const { readies, watch } = readySource();
    const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
    try {
      watcher.add("/tmp/dir", undefined);
      for (const ready of readies) ready();
      expect(changes).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it("should not reconcile after close, even if ready lands late", () => {
    const changes: string[] = [];
    const { readies, watch } = readySource();
    const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
    watcher.add("/tmp/dir", "a.html");
    watcher.close();
    for (const ready of readies) ready();
    expect(changes).toEqual([]);
  });
});

describe("createWatcher · 边界输入", () => {
  it("should survive an unwatchable directory without crashing", () => {
    // 这条留真 chokidar：注入源复刻不了"watch() 当场抛或异步 error"两种失败形态。
    const dir = mkdtempSync(join(tmpdir(), "hr-watch-"));
    const changes: string[] = [];
    const watcher = createWatcher({ onFileChange: (path) => changes.push(path) });
    try {
      watcher.add(join(dir, "gone"), undefined);
      watcher.close();

      expect(changes).toEqual([]);
    } finally {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should tolerate an injected source reporting an undefined name", () => {
    withFakeTimers(() => {
      const changes: string[] = [];
      const { fires, watch } = fakeSource();
      const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
      try {
        watcher.add("/tmp", undefined);
        fires[0]?.("rename", undefined);
        fires[0]?.("rename", "a.html");
        vi.advanceTimersByTime(DEBOUNCE_MS * 2);

        expect(changes).toEqual([join("/tmp", "a.html")]);
      } finally {
        watcher.close();
      }
    });
  });
});
