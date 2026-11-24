// 批注 UI 接线的共用夹具：真 `boot()` + 假 Host + 记录型 IO。
// 断言只读 `fake.calls` / `store.get()` / `posted`，不在中间层调私有函数。

import { vi } from "vitest";

import { boot } from "../../src/boot.ts";
import type { AppIo } from "../../src/io.ts";
import type { AnnotationCard } from "../../src/notes.ts";
import type { RawSelection } from "../../src/widgets/selection.ts";
import { harnessOf } from "./boot-harness.ts";
import { guardedOf } from "./guarded.ts";

export const ROOT = "#hr-root";
export const TEXT = "第一段正文，供 c 键与划词使用。";

export interface Posted {
  readonly body: Readonly<Record<string, unknown>>;
  readonly path: string;
}

/** 一个挂着的 POST：测试自己决定何时成功/失败，用来断言"未 resolve 期间"的行为。 */
export interface PendingPost {
  readonly settle: () => void;
  readonly fail: () => void;
}

const ioOf = (
  posted: Posted[],
  mode: "ok" | "fail" | "pending",
  pending: PendingPost[],
): AppIo => ({
  text: () => Promise.resolve("<p>一</p>"),
  json: (path) => Promise.reject(new Error(`${path} 不该被读`)),
  post: (path: string, body: Readonly<Record<string, unknown>>, guard) => {
    posted.push({ path, body });
    const settled = () => guardedOf({ revision: path.endsWith("/undo") ? "r9" : "r2" }, guard);
    if (mode === "fail") return Promise.reject(new Error("boom"));
    if (mode === "ok") return Promise.resolve(settled());
    return new Promise((resolve, reject) => {
      pending.push({
        settle: () => {
          resolve(settled());
        },
        fail: () => {
          reject(new Error("boom"));
        },
      });
    });
  },
});

/** 与服务端契约同形（`guard.isDiffResponse`）：假件不得比真实响应更宽松。 */
const DIFF_WIRE = {
  nodeId: "hr-a",
  before: "服务端已有",
  after: "服务端已有新段落",
  chunks: [{ kind: "ins" as const, text: "新段落" }],
  degraded: false,
};

const loadedCards = (): readonly AnnotationCard[] => [
  { id: "an-1111aaaa", nodeId: "hr-a", note: "服务端已有", status: "pending" },
];

export const notesOf = (
  overrides: {
    readonly failPost?: boolean;
    readonly lost?: readonly string[];
    readonly diagnostics?: readonly string[];
    readonly pendingPost?: boolean;
    /** diff 回包带上降级声明（三档里的"按位置重识别"）：面板要把它原样显示给用户。 */
    readonly diffReason?: string;
  } = {},
) => {
  const posted: Posted[] = [];
  const pending: PendingPost[] = [];
  const lost = overrides.lost ?? [];
  const diagnostics = overrides.diagnostics ?? [];
  const mode =
    overrides.pendingPost === true ? "pending" : overrides.failPost === true ? "fail" : "ok";
  const io = ioOf(posted, mode, pending);
  const fetchAnnotations = vi.fn(() =>
    Promise.resolve({ annotations: loadedCards(), lost, diagnostics }),
  );
  const diffWire =
    overrides.diffReason === undefined
      ? DIFF_WIRE
      : { ...DIFF_WIRE, degraded: true, degradedReason: overrides.diffReason };
  const fetchDiff = vi.fn(() => Promise.resolve(diffWire));
  return {
    posted,
    pending,
    fetchAnnotations,
    fetchDiff,
    notes: {
      io,
      fetchAnnotations,
      fetchDiff,
      textOf: (id: string) => (id === "hr-a" ? TEXT : undefined),
    },
  };
};

export const bootedWith = (overrides: Parameters<typeof notesOf>[0] = {}) => {
  const h = harnessOf(true);
  const spy = notesOf(overrides);
  const booted = boot({ ...h.deps, notes: spy.notes });
  return { ...h, ...spy, booted };
};

export type Booted = ReturnType<typeof bootedWith>;

export const draftOf = (h: Booted, text: string): void => {
  h.store.dispatch({ kind: "noteChanged", text });
};

export const shiftD = { key: "D", shiftKey: true };

export const selectOf = (h: Booted, raw: RawSelection): void => {
  const select = h.booted.selection;
  if (select === undefined) throw new Error("boot().selection 未接线");
  select(raw);
};

export const pendingWrites = (h: Booted): readonly string[] =>
  h.fake.calls
    .filter((call) => call.op === "children" && call.args[0] === `${ROOT} #hr-notes-pending`)
    .map((call) => call.args[1] ?? "");

/** 一段真实选区（`boot().selection` 的入参形态）。 */
export const SELECTION = {
  nodeId: "hr-a",
  blockText: TEXT,
  start: 2,
  end: 6,
  crossBlock: false,
} as const;

/** 右栏卡片点击事件的 DOM 子集（`event.target.closest` 链）。 */
export const CARD_EVENT = {
  closest: () => ({ getAttribute: () => "an-1111aaaa" }),
};

export const flashCalls = (h: Booted): readonly (readonly string[])[] =>
  h.fake.calls
    .filter((call) => call.op === "cls" && call.args[1] === "hr-flash")
    .map((call) => call.args);

/** 点提交/取消：入口是模板里的真按钮选择器（不直接调 `wireSubmit` 的私有函数）。 */
export const submitOf = (h: Booted): void => {
  h.fake.fire(`${ROOT} #hr-note-submit`, "click", {});
};

export const cancelOf = (h: Booted): void => {
  h.fake.fire(`${ROOT} #hr-note-cancel`, "click", {});
};

/** 某类元素上最后一次写文本的值（没有写点就是 `undefined`）。 */
export const lastTextOf = (h: Booted, selectorPart: string): string | undefined =>
  h.fake.calls
    .filter((call) => call.op === "text" && call.args[0]?.includes(selectorPart) === true)
    .at(-1)?.args[1];

/** 用户可见的提示：错误元素 / 提示元素 / 状态栏三处，任一非空即算"提示到了"。 */
export const hintsOf = (h: Booted): readonly string[] =>
  h.fake.calls
    .filter(
      (call) =>
        call.op === "text" &&
        ["#hr-note-error", "#hr-note-hint", "#hr-statusbar"].some(
          (part) => call.args[0]?.includes(part) === true,
        ) &&
        (call.args[1] ?? "") !== "",
    )
    .map((call) => call.args[1] ?? "");

/** 任何写点（text/children）里包含这段文案的次数：诊断信息落在右栏还是状态栏都算"说给用户了"。 */
export const writesContaining = (h: Booted, needle: string): number =>
  h.fake.calls.filter(
    (call) =>
      (call.op === "text" || call.op === "children") &&
      call.args.some((arg) => arg.includes(needle)),
  ).length;
