// 这层管：`packages/desktop/accels.json`（全局快捷键的唯一真源）与 `src/keys.ts`（应用内按键映射）
// 之间的交叉断言。两个包各自都有单测，但"同一份键同时被两边处理"这件事只有在跨文件处才看得见：
// `keys.ts:24` 的 `modified()` = `metaKey||ctrlKey||altKey`（**不含 Shift**）是第一道闸，
// 而 `shortcut.rs::parse_accel` 只保证全局键带 Cmd/Ctrl/Alt。任一侧单独改都自洽，合起来才会抢键。
//
// 断言口径（对应 M4.2 AC-7）：
// A1 每个 accelerator 必须带 `modified()` 认的修饰键（Cmd/Ctrl/Alt）：没有它们的全局键活在
//    `modified()` 为 false 的世界里，与应用内保留键（Escape / Shift+D / w / j / k / h / c）同域，
//    这正是 `Shift+K` 那种"看着无害、其实吃掉了 Shift 层"的键。
// A2 用 `keys.ts` 自己的 `intentOf` 走一遍：带 Cmd/Ctrl/Alt 的键必须被 `modified()` 短路（拿不到 intent）。
// A3 全局键不许占 `Escape`（`shortcut.rs` 的 `ReservedKey`），否则应用里再也见不到 Escape。
//
// 已知局限：加速键用 tauri 的 Code 名（`"K"`），应用内键用小写 `event.key`（`"k"`），
// 所以 A2 不能靠"字符串相等"证明碰撞，只能证明"短路确实发生"。真正的跨文件契约是 A1/A3。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { intentOf, type KeyLike } from "../src/keys.ts";
import { stateOf } from "./support/fake-host.ts";

const ACCELS_JSON = join(import.meta.dirname, "..", "..", "desktop", "accels.json");

/** `keys.ts:24` 认的修饰键：它们的任一为真，`intentOf` 就在第一行返回 `undefined`。 */
const MODIFIED_FLAGS: readonly string[] = [
  "CmdOrCtrl",
  "CommandOrControl",
  "Ctrl",
  "Control",
  "Alt",
  "Option",
];

const ESCAPE_CODE = "escape";

interface ParsedAccel {
  readonly alias: string;
  readonly text: string;
  readonly modifiers: readonly string[];
  readonly code: string;
}

const parseAccel = (alias: string, text: string): ParsedAccel => {
  const parts = text.split("+");
  const code = parts.at(-1) ?? "";
  return { alias, text, modifiers: parts.slice(0, -1), code };
};

/** 与 `shortcut.rs::parse_accel` 同一口径：`code` 是 `+` 后的最后一段，其余都是修饰键。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const loadAccels = (): readonly ParsedAccel[] => {
  const raw: unknown = JSON.parse(readFileSync(ACCELS_JSON, "utf8"));
  if (raw === null) return [];
  if (!isRecord(raw)) throw new Error("accels.json 顶层必须是对象");
  return Object.entries(raw).map(([alias, value]) => {
    if (typeof value !== "string") throw new Error(`${alias} 必须是字符串`);
    return parseAccel(alias, value);
  });
};

const ACCELS = loadAccels();

/** 没有任何 `modified()` 认的修饰键 = 只有 Shift（或裸键）：这就是被禁止的那类全局键。 */
const lacksModified = (accel: ParsedAccel): boolean =>
  accel.modifiers.filter((modifier) => MODIFIED_FLAGS.includes(modifier)).length === 0;

/** 把 accelerator 翻成 `keys.ts` 会看到的事件：CmdOrCtrl 在 macOS 记成 meta、别处记成 ctrl。 */
const eventOf = (accel: ParsedAccel): KeyLike => {
  const has = (names: readonly string[]): boolean =>
    accel.modifiers.some((modifier) => names.includes(modifier));
  return {
    key: accel.code,
    metaKey: has(["CmdOrCtrl", "CommandOrControl"]) && process.platform === "darwin",
    ctrlKey:
      has(["Ctrl", "Control"]) ||
      (has(["CmdOrCtrl", "CommandOrControl"]) && process.platform !== "darwin"),
    altKey: has(["Alt", "Option"]),
    shiftKey: has(["Shift"]),
  };
};

describe("accels.json × keys.ts · 交叉断言", () => {
  it("should find the accelerator file and parse it", () => {
    expect(ACCELS.length).toBeGreaterThan(0);
  });

  it.each(ACCELS.map((accel) => [accel.alias, accel] as const))(
    "%s 必须带 keys.ts 的 modified() 认的修饰键",
    (_alias, accel) => {
      // 只剩 Shift（或什么都没有）→ `modified()` 不短路 → 与应用内保留键同域。
      expect(lacksModified(accel), `${accel.text} 去掉 Cmd/Ctrl/Alt 后只剩 Shift`).toBe(false);
    },
  );

  it.each(ACCELS.map((accel) => [accel.alias, accel] as const))(
    "%s 必须被 modified() 短路（应用内拿不到 intent）",
    (_alias, accel) => {
      expect(intentOf(eventOf(accel), stateOf({ activeId: "hr-b" }))).toBeUndefined();
    },
  );

  it.each(ACCELS.map((accel) => [accel.alias, accel] as const))(
    "%s 不许占用 Escape（shortcut.rs 的 ReservedKey）",
    (_alias, accel) => {
      expect(accel.code.toLowerCase()).not.toBe(ESCAPE_CODE);
    },
  );

  it("should keep Escape meaningful to the app (the reason it is reserved)", () => {
    expect(intentOf({ key: "Escape" }, stateOf())).toEqual({ kind: "panelClosed" });
  });

  it("should flag a bare Shift global key so adding Shift+K to accels.json goes red", () => {
    // 用同一个判据验证上面那条：`Shift+K` 看上去无害，但在 webview 里 `modified()` 不短路，
    // 于是 Shift 层就被全局注册吃掉了。它的 `lacksModified` 必须为 true。
    expect(lacksModified(parseAccel("stealFocus", "Shift+K"))).toBe(true);
    expect(lacksModified(parseAccel("showWindow", "CmdOrCtrl+Shift+H"))).toBe(false);
  });
});
