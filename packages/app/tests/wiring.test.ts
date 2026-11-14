// 这层管：`syncView` 的 class 写入契约——"右栏是否张开"由**两个字段共同决定**
// （`panel === "sidenote" || diff.open`，`wiring.ts:84`），而不是由 widget 自己判。
// 这条表达式曾经只覆盖 `panel`（`sidenotes--open` 的写者在 widget 里），迁到 `wiring.ts` 后
// 单看 panel 会漏掉"diff 开着、panel 关着"这一半，所以三条状态都要钉住。

import { describe, expect, it } from "vitest";

import { closedDiff } from "../src/notes.ts";
import { syncView } from "../src/wiring.ts";
import { createFakeHost, stateOf } from "./support/fake-host.ts";

const ROOT = "#hr-root";

/** 只取 `#hr-notes` 上的 `sidenotes--open` 写入（`1` = 加类，`0` = 摘类）。 */
const openWrites = (fake: ReturnType<typeof createFakeHost>): string[] =>
  fake.calls
    .filter(
      (call) =>
        call.op === "cls" &&
        call.args[0] === `${ROOT} #hr-notes` &&
        call.args[1] === "sidenotes--open",
    )
    .map((call) => call.args[2] ?? "");

describe("syncView · 面板开合类", () => {
  it("should open the right pane when the sidenote panel is showing", () => {
    const fake = createFakeHost();
    const sync = syncView({ host: fake.host, widgets: [] });

    sync(stateOf({ panel: "sidenote", sidenoteId: "hr-a", diff: { ...closedDiff, open: false } }));

    expect(openWrites(fake)).toEqual(["1"]);
  });

  it("should keep the right pane open while the diff panel is open with the sidenote panel closed", () => {
    const fake = createFakeHost();
    const sync = syncView({ host: fake.host, widgets: [] });

    // 这一半就是"只写 panel"会漏掉的：`diff.open` 为真时右栏必须仍然张开。
    sync(stateOf({ panel: "closed", sidenoteId: undefined, diff: { ...closedDiff, open: true } }));

    expect(openWrites(fake)).toEqual(["1"]);
  });

  it("should close the right pane only when both the panel and the diff are closed", () => {
    const fake = createFakeHost();
    const sync = syncView({ host: fake.host, widgets: [] });

    sync(stateOf({ panel: "sidenote", sidenoteId: "hr-a", diff: { ...closedDiff, open: true } }));
    sync(stateOf({ panel: "closed", sidenoteId: undefined, diff: { ...closedDiff, open: true } }));
    sync(stateOf({ panel: "closed", sidenoteId: undefined, diff: { ...closedDiff, open: false } }));

    expect(openWrites(fake)).toEqual(["1", "1", "0"]);
  });
});
