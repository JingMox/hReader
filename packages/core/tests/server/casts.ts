// 这层管：测试替身的类型出口——用"真类 + Object.assign"构造成真 `ServerResponse`/`IncomingMessage`，
// 全程不写 `as`（仓库同时禁断言与禁 disable），替身的方法仍由传入的结构化对象提供。

import { mkdtempSync, watch, type FSWatcher } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const watched: { readonly dir: string; readonly watcher: FSWatcher }[] = [];

/** 真 `ServerResponse` 外壳（`instanceof` 成立），`write/writeHead/end` 由 `stub` 覆盖。 */
export const responseLike = (stub: object): ServerResponse =>
  Object.assign(new ServerResponse(new IncomingMessage(new Socket())), stub);

/** 真 `IncomingMessage` 外壳，事件/数据由 `stub`（或调用方 push）提供。 */
export const requestLike = (stub: object): IncomingMessage =>
  Object.assign(new IncomingMessage(new Socket()), stub);

/** `WatchFn` 的返回类型是 `FSWatcher` 且不可 new：开一个空临时目录真监听，用完统一关。 */
export const watcherLike = (): FSWatcher => {
  const dir = mkdtempSync(join(tmpdir(), "hr-watch-"));
  const watcher = watch(dir, { persistent: false });
  watched.push({ dir, watcher });
  return watcher;
};

export const disposeWatchers = (): void => {
  for (const entry of watched.splice(0)) {
    entry.watcher.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
};
