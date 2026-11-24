// 这层管：`watcher.ts` 的事件归一化与边界——目录事件过滤、重复 add 去重、不可监听目录、注入源的空事件名。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWatcher } from "../../src/server/watcher";

const DEBOUNCE_MS = 120;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitFor = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(10);
  }
  return pred();
};

const withWatcher = async (
  run: (ctx: {
    dir: string;
    watcher: ReturnType<typeof createWatcher>;
    changes: string[];
  }) => Promise<void>,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "hr-watch-"));
  const changes: string[] = [];
  const watcher = createWatcher({ now: Date.now, onFileChange: (path) => changes.push(path) });
  try {
    await run({ dir, watcher, changes });
  } finally {
    watcher.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("createWatcher · 目录事件与重复订阅", () => {
  it("should ignore directory events and only report file changes", async () => {
    await withWatcher(async ({ dir, watcher, changes }) => {
      watcher.add(dir, undefined);
      await wait(50);
      // chokidar 对新建子目录报 addDir：目录事件不算"文件变了"。
      const sub = join(dir, "sub.d");
      mkdirSync(sub);
      await wait(DEBOUNCE_MS * 4);

      expect(changes.every((path) => path !== sub)).toBe(true);
      writeFileSync(join(dir, "a.html"), "x");
      expect(await waitFor(() => changes.includes(join(dir, "a.html")), 2000)).toBe(true);
      expect(changes.every((path) => path !== sub)).toBe(true);
    });
  });

  it("should dedupe repeated add() calls for the same dir+file", async () => {
    await withWatcher(async ({ dir, watcher, changes }) => {
      watcher.add(dir, "a.html");
      watcher.add(dir, "a.html");
      writeFileSync(join(dir, "a.html"), "x");
      expect(await waitFor(() => changes.length > 0, 2000)).toBe(true);
      await wait(DEBOUNCE_MS * 3);

      expect(changes).toEqual([join(dir, "a.html")]);
    });
  });
});

describe("createWatcher · 边界输入", () => {
  it("should survive an unwatchable directory without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-watch-"));
    const changes: string[] = [];
    const watcher = createWatcher({ now: Date.now, onFileChange: (path) => changes.push(path) });
    try {
      watcher.add(join(dir, "gone"), undefined);
      await wait(DEBOUNCE_MS * 2);
      watcher.close();

      expect(changes).toEqual([]);
    } finally {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should tolerate an injected source reporting an undefined name", async () => {
    const changes: string[] = [];
    let fire: ((event: string, name: string | undefined) => void) | undefined;
    const watcher = createWatcher(
      { now: Date.now, onFileChange: (path) => changes.push(path) },
      (_dir, onEvent) => {
        fire = onEvent;
        return { close: () => undefined };
      },
    );
    try {
      watcher.add("/tmp", undefined);
      fire?.("rename", undefined);
      fire?.("rename", "a.html");
      await wait(DEBOUNCE_MS * 2);

      expect(changes).toEqual([join("/tmp", "a.html")]);
    } finally {
      watcher.close();
    }
  });
});
