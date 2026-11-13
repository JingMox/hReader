// 这层管：进程内按文档的串行队列；跨进程互斥仍归文件锁，这里既不替代它也不改它的语义。

import { resolve } from "node:path";

/** `Map` 里存的是“该 key 上最后一个任务跑完的信号”，不是任务本身。 */
const tails = new Map<string, Promise<void>>();

/**
 * `\0` 不会出现在路径或 docId 里，两段拼不成歧义键；`repo` 由调用方给启动期已 realpath 的根
 * （CLI 会做），这里只做纯字符串归一，不在热路径上碰磁盘。
 */
export const docQueueKey = (repo: string, docId: string): string => `${resolve(repo)}\0${docId}`;

/** 成功与失败都要放行下一单：链尾只看“跑完了”，所以两条臂用同一个回调。 */
const settled = (): undefined => undefined;

/**
 * 先排队再拿文件锁：同文档并发时后来者停在内存里，不再每 `LOCK_RETRY_MS` 去 open/read 一次锁文件。
 * 前一个任务失败也要放行下一个（`then` 的两支同一个回调），否则一次失败会把队列焊死。
 */
export const withDocQueue = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const previous = tails.get(key);
  const result = (previous ?? Promise.resolve()).then(() => work());
  const tail = result.then(settled, settled);
  tails.set(key, tail);
  return result.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
};
