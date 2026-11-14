// 这层管：最小的可订阅状态容器。只有 `get`/`dispatch`/`subscribe` 三个方法；
// `subscribe` 立刻返回退订函数，且**同引用不通知**（reducer 已保证"没变就返回原 state"）。

import type { ReaderIntent, ReaderState } from "./state.ts";
import { reduce } from "./state.ts";

export interface Store {
  readonly get: () => ReaderState;
  readonly dispatch: (intent: ReaderIntent) => void;
  readonly subscribe: (listener: (state: ReaderState) => void) => () => void;
}

export const createStore = (initial: ReaderState): Store => {
  let state = initial;
  const listeners = new Set<(state: ReaderState) => void>();

  const dispatch = (intent: ReaderIntent): void => {
    const next = reduce(state, intent);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  const subscribe = (listener: (state: ReaderState) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { get: () => state, dispatch, subscribe };
};
