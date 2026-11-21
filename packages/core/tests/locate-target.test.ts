// 这层管：`locateTarget` 的一条契约——**内部错误不伪装成用户错**。
// 两跳里只有 `invalid_selector`/`node_not_found` 算“这一跳没解释通”，可以重试；其余 `HrError`
// 说明定位之外出了事，必须原样上抛，不能改写成 `node_not_found`/`invalid_selector` 让用户
// 以为是自己选择器写错了。第一跳、第二跳各钉一条（两跳是两段独立的 try/catch）。
//
// 为什么这两条仍要 mock：现实输入造不出不可重试的内部错误。真链路上 `parseSelector` 只抛
// `invalid_selector`、`resolveSelector` 只抛 `invalid_selector`/`node_not_found`，全是可重试的，
// 于是上面这条承诺在真链路上永远走不到——只有把 resolveSelector 换成会抛内部错的桩才走得到。
// 真链路（用户真正会走到的每条成功与拒绝路径）归 `locate-real-chain.test.ts`，本文件不重复。
//
// 断言钉的是用户可见物：抛出的 `code` 与 `message` 原文（报文经 reportFailure 直出给用户），
// 以及实际跑了几跳（原样上抛 = 当场停下，不再试下一跳）。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseHtml } from "../src/html/parse";
import { HrError } from "../src/hr-error";
import { locateTarget } from "../src/ops/locate";

interface MockState {
  /** 每跳实际喂给 `resolveSelector` 的串，按调用顺序。 */
  sources: string[];
  /** 每跳要抛的东西，按调用顺序对齐 `sources`。 */
  throws: unknown[];
}

const state = vi.hoisted((): MockState => ({ sources: [], throws: [] }));

// 文法层一律放行，把失败全部推到 `resolveSelector` 那一跳：两跳才会各自碰到桩，
// `state.sources` 也才数得清到底是第几跳把异常抛上来的。
vi.mock("../src/ops/readNode/selector", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, parseSelector: () => ({ kind: "tag", tag: "p" }) };
});

vi.mock("../src/ops/readNode/resolve", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveSelector: (_root: unknown, _selector: unknown, source: string): never => {
      state.sources.push(source);
      throw state.throws[state.sources.length - 1];
    },
  };
});

const parsed = parseHtml(
  '<!doctype html><html><body><article data-hr-id="hr-a"><p data-hr-id="hr-b">正文</p></article></body></html>',
);

const failureOf = (target: string): HrError => {
  try {
    locateTarget(parsed, target);
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("期望定位失败，但成功了");
};

beforeEach(() => {
  state.sources = [];
  state.throws = [];
});

describe("locateTarget · 第一跳抛出不可重试的 HrError", () => {
  it("should rethrow the first hop's HrError verbatim instead of retrying", () => {
    state.throws = [new HrError("invalid_html", "解析器内部状态坏了")];

    const failed = failureOf("hr-x");

    expect(failed.code).toBe("invalid_html");
    expect(failed.message).toBe("解析器内部状态坏了");
    // 当场停下：没有第二跳。
    expect(state.sources).toEqual(["hr-x"]);
  });
});

describe("locateTarget · 第二跳抛出不可重试的 HrError", () => {
  it("should rethrow the second hop's HrError verbatim instead of reporting a user error", () => {
    state.throws = [
      new HrError("invalid_selector", "不是合法选择器"),
      new HrError("duplicate_id", "文档里两个元素共用一个 id"),
    ];

    const failed = failureOf("hr-x");

    // 第一跳是可重试的（选择器解释失败）→ 走到第二跳；第二跳的内部错原样上抛，
    // 不会被改写成“没有 id 为 hr-x 的节点”。
    expect(failed.code).toBe("duplicate_id");
    expect(failed.message).toBe("文档里两个元素共用一个 id");
    expect(state.sources).toEqual(["hr-x", '[data-hr-id="hr-x"]']);
  });
});
