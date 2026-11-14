// 这层管：`store` 的三条契约——同引用不通知、退订后不再通知、多订阅按注册顺序。

import { describe, expect, it, vi } from "vitest";

import { createStore } from "../src/store.ts";
import { stateOf } from "./support/fake-host.ts";

const storeAt = (activeId: string) => createStore(stateOf({ activeId, blocks: ["hr-a", "hr-b"] }));

describe("store · 不通知", () => {
  it("should return the initial state and not notify for a no-op intent", () => {
    const store = storeAt("hr-b");
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ kind: "move", delta: 1 }); // 已在最后一块

    expect(store.get().activeId).toBe("hr-b");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("store · 通知顺序", () => {
  it("should notify subscribers in registration order", () => {
    const store = storeAt("hr-a");
    const seen: string[] = [];
    store.subscribe(() => seen.push("first"));
    store.subscribe(() => seen.push("second"));

    store.dispatch({ kind: "move", delta: 1 });

    expect(seen).toEqual(["first", "second"]);
  });
});

describe("store · 退订", () => {
  it("should stop notifying after unsubscribe", () => {
    const store = storeAt("hr-a");
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();

    store.dispatch({ kind: "move", delta: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("should survive a subscriber unsubscribing during notification", () => {
    const store = storeAt("hr-a");
    const second = vi.fn();
    const offFirst = store.subscribe(() => {
      offFirst();
    });
    store.subscribe(second);

    store.dispatch({ kind: "move", delta: 1 });

    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("store · 传出去的状态", () => {
  it("should hand the new state to listeners", () => {
    const store = storeAt("hr-a");
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ kind: "conn", conn: "live" });

    const seen: unknown = listener.mock.calls[0]?.[0];
    expect(seen).toMatchObject({ conn: "live" });
  });
});
