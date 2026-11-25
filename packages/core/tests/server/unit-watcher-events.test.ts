// 这层管：`watcher.ts` 的事件归一化与边界——目录事件过滤、重复 add 去重、不可监听目录、注入源的空事件名。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWatcher, DEBOUNCE_MS } from "../../src/server/watcher";

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
      const watcher = createWatcher(
        { now: Date.now, onFileChange: (path) => changes.push(path) },
        watch,
      );
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
      const watcher = createWatcher(
        { now: Date.now, onFileChange: (path) => changes.push(path) },
        watch,
      );
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

describe("createWatcher · 边界输入", () => {
  it("should survive an unwatchable directory without crashing", () => {
    // 这条留真 chokidar：注入源复刻不了"watch() 当场抛或异步 error"两种失败形态。
    const dir = mkdtempSync(join(tmpdir(), "hr-watch-"));
    const changes: string[] = [];
    const watcher = createWatcher({ now: Date.now, onFileChange: (path) => changes.push(path) });
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
      const watcher = createWatcher(
        { now: Date.now, onFileChange: (path) => changes.push(path) },
        watch,
      );
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
