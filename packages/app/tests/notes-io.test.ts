// 批注的写请求与乐观卡：纯接线（注入 IO），不碰 DOM。
// 降级 diff 由服务端算，浏览器只渲染 chunk —— 见 `notes-widgets.test.ts`。

import { describe, expect, it } from "vitest";

import type { AppIo } from "../src/io.ts";
import { optimisticCardOf } from "../src/notes.ts";
import { revertOf, submitAnnotationOf } from "../src/wiring.ts";
import { guardedOf } from "./support/guarded.ts";

interface Call {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly guard: unknown;
}

const ioOf = (post?: AppIo["post"]): AppIo => ({
  text: () => Promise.resolve(""),
  // 这两条用例只走写请求：读接口被调到就是接线错了。
  json: (path) => Promise.reject(new Error(`${path} 不该被读`)),
  ...(post === undefined ? {} : { post }),
});

const capturingPost = (): { post: AppIo["post"]; calls: Call[] } => {
  const calls: Call[] = [];
  const post: AppIo["post"] = <T>(
    path: string,
    body: Readonly<Record<string, unknown>>,
    guard: (value: unknown) => value is T,
  ) => {
    calls.push({ path, body, guard });
    return Promise.resolve(guardedOf({ revision: "r1" }, guard));
  };
  return { post, calls };
};

describe("写请求接线 · undo", () => {
  it("should POST one undo with an encoded docId and the revision guard", async () => {
    const { post, calls } = capturingPost();
    const io = ioOf(post);

    await expect(revertOf(io, "a b.html")).resolves.toEqual({ revision: "r1" });

    expect(calls.map((call) => call.path)).toEqual(["/api/doc/a%20b.html/undo"]);
    expect(calls[0]?.body).toEqual({});
    expect(typeof calls[0]?.guard).toBe("function");
  });

  it("should throw a clear error when IO has no post", async () => {
    await expect(revertOf(ioOf(), "d")).rejects.toThrow("未实现写请求");
  });
});

describe("写请求接线 · 批注", () => {
  it("should POST the note body to the annotations route", async () => {
    const { post, calls } = capturingPost();
    const io = ioOf(post);

    await submitAnnotationOf(io, "a b.html", { note: "x" });

    expect(calls.map((call) => call.path)).toEqual(["/api/doc/a%20b.html/annotations"]);
    expect(calls[0]?.body).toEqual({ note: "x" });
    expect(typeof calls[0]?.guard).toBe("function");
  });

  it("should throw a clear error when IO has no post", async () => {
    await expect(submitAnnotationOf(ioOf(), "d", {})).rejects.toThrow("未实现写请求");
  });
});

describe("optimisticCardOf", () => {
  it("should namespace the optimistic id by seq", () => {
    const card = optimisticCardOf(
      { nodeId: "hr-a", anchor: { exact: "x", prefix: "", suffix: "", start: 0 } },
      "n",
      7,
    );

    expect(card).toEqual({
      id: "tmp-7",
      nodeId: "hr-a",
      note: "n",
      status: "pending",
      optimistic: true,
    });
  });
});
