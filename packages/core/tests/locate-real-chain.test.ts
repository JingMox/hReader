// 这层管：`locateTarget` / `patchTargetIdOf` 的**真链路**（parseSelector → resolveSelector → 双跳交叉校验）。
// 与 `locate-target.test.ts` 分工：那份把两个底层件都 mock 成"只会抛"，专钉白盒走不到的**防御臂**；
// 本文件**不 mock 任何东西**，钉的是用户真正会走到的每一条成功与拒绝路径。
//
// 为什么必须单独有真链路：CLI 的 e2e 走 `spawn` 子进程，子进程里 `@hreader/core` 解析到 dist，
// 本仓的 src 覆盖率账面上就永远是 0——命中路径"跑过但不算数"。这里在**进程内**直调，跑的就是 src。
//
// 断言钉用户可见物：返回的 `selector`/`nodeId`/`matches`/`addressable`/`candidates`，以及拒绝时
// 抛出的 `code`/`message`/`data`（这些会经 reportFailure 直出给用户）。

import { describe, expect, it } from "vitest";

import { parseHtml } from "../src/html/parse";
import { HrError } from "../src/hr-error";
import type { HrErrorData } from "../src/hr-error";
import { locateTarget, patchTargetIdOf } from "../src/ops/locate";

const docWith = (body: string): ReturnType<typeof parseHtml> =>
  parseHtml(
    [
      "<!doctype html>",
      '<html><head><title>t</title></head><body><article data-hr-id="hr-root">',
      body,
      "</article></body></html>",
    ].join(""),
  );

/** 一份普通文档：`<h2>` 有 id、`<p>` 有 id、`<em>` 没有 id（不可寻址）。 */
const PLAIN = docWith(
  ['<h2 data-hr-id="hr-h2">标题</h2>', '<p data-hr-id="hr-x">正文</p>', "<em>强调</em>"].join(""),
);

const liOf = (count: number): string =>
  `<ul data-hr-id="hr-ul">${Array.from(
    { length: count },
    (_unused, index) => `<li data-hr-id="hr-l${String(index + 1)}">第 ${String(index + 1)} 项</li>`,
  ).join("")}</ul>`;

/** `h2` 既能当标签、又能当某个**不是** `<h2>` 的元素的 id：双解释语料。 */
const DUAL = docWith('<h2 data-hr-id="hr-h2">标题</h2><div data-hr-id="h2">div 也叫 h2</div>');

const errorOf = (run: () => unknown): HrError => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("期望定位失败，但成功了");
};

const dataOf = (error: HrError): HrErrorData => {
  if (error.data === undefined) throw new Error("期望定位失败时带 data，但没有");
  return error.data;
};

describe("locateTarget · 选择器命中（真文法 + 真解析）", () => {
  it("should return the hit element's own id and match count for a tag selector", () => {
    const located = locateTarget(PLAIN, "h2");

    expect(located.selector).toBe("h2");
    expect(located.nodeId).toBe("hr-h2");
    expect(located.matches).toBe(1);
    expect(located.addressable).toBe(1);
    expect([...located.candidates]).toEqual(["hr-h2"]);
  });

  it("should report a hit element without data-hr-id as matched but not addressable", () => {
    // `<em>` 没有 id：命中是真的，可寻址是假的——`read` 能读，`patch` 不能改（node_not_found 臂）。
    const located = locateTarget(PLAIN, "em");

    expect(located.selector).toBe("em");
    expect(located.nodeId).toBeUndefined();
    expect(located.matches).toBe(1);
    expect(located.addressable).toBe(0);
    expect([...located.candidates]).toEqual([]);
  });
});

describe("locateTarget · 裸 id 靠 id 跳回退（文法那一跳对它就是错的）", () => {
  it("should locate a bare id through the [data-hr-id=…] hop and report that hop's selector", () => {
    // `hr-x` 在 parseSelector 里是文法错（标签名不许带 `-`）：这条能成立，全靠回退链无条件跑完。
    const located = locateTarget(PLAIN, "hr-x");

    expect(located.selector).toBe('[data-hr-id="hr-x"]');
    expect(located.nodeId).toBe("hr-x");
    expect(located.matches).toBe(1);
    expect(located.addressable).toBe(1);
  });
});

describe("locateTarget · 选择器命中多个可寻址元素", () => {
  it("should count every match while capping candidates at CANDIDATE_LIMIT", () => {
    const located = locateTarget(docWith(liOf(7)), "li");

    expect(located.matches).toBe(7);
    expect(located.addressable).toBe(7);
    expect(located.candidates).toHaveLength(5);
    expect([...located.candidates]).toEqual(["hr-l1", "hr-l2", "hr-l3", "hr-l4", "hr-l5"]);
  });
});

describe("locateTarget · 两种解释都成立时拒绝且不选", () => {
  it("should refuse a literal that is both a tag and another element's id", () => {
    const error = errorOf(() => locateTarget(DUAL, "h2"));
    const data = dataOf(error);

    expect(error.code).toBe("invalid_selector");
    expect(data.reason).toBe("ambiguous");
    // 双解释时 `count` 是可选项数（id 一个 + 选择器一个），`matches` 才是选择器跳中的元素数。
    expect(data.count).toBe(2);
    expect(data.matches).toBe(1);
    expect(data.candidates).toEqual(["hr-h2", "h2"]);
    expect(error.message).toContain("'#h2'");
  });

  it("should not treat the element's own id as a second interpretation", () => {
    // `<h2 data-hr-id="h2">`：两跳指向同一个节点，`collides` 必须为假，否则每个自指 id 都成了歧义。
    const located = locateTarget(docWith('<h2 data-hr-id="h2">标题</h2>'), "h2");

    expect(located.nodeId).toBe("h2");
    expect(located.selector).toBe("h2");
  });

  it("should resolve an explicit [data-hr-id=…] selector without a collision", () => {
    // 显式属性选择器：第二跳的串本身不是合法 id，`collides` 为假，直接返回选择器那一跳。
    const located = locateTarget(DUAL, '[data-hr-id="h2"]');

    expect(located.nodeId).toBe("h2");
    expect(located.selector).toBe('[data-hr-id="h2"]');
  });
});

describe("locateTarget · 两跳都失败时的码由目标形态定", () => {
  it("should report a syntax error as invalid_selector with reason syntax", () => {
    const error = errorOf(() => locateTarget(PLAIN, "p["));

    expect(error.code).toBe("invalid_selector");
    expect(dataOf(error).reason).toBe("syntax");
    expect(error.message).toContain("无法解析");
  });

  it("should report an absent but id-shaped literal as node_not_found", () => {
    const error = errorOf(() => locateTarget(PLAIN, "hr-zz"));

    expect(error.code).toBe("node_not_found");
    expect(error.message).toContain('"hr-zz"');
  });

  it("should report a valid selector with no match as node_not_found", () => {
    const error = errorOf(() => locateTarget(PLAIN, "table"));

    expect(error.code).toBe("node_not_found");
    expect(error.message).toContain('"table"');
  });
});

describe("patchTargetIdOf · patch 只接受一个 id", () => {
  it("should return the single hit's id", () => {
    expect(patchTargetIdOf(PLAIN, "h2")).toBe("hr-h2");
  });

  it("should refuse a hit without data-hr-id instead of blaming a missing id", () => {
    const error = errorOf(() => patchTargetIdOf(PLAIN, "em"));

    expect(error.code).toBe("node_not_found");
    expect(error.message).toContain("不可寻址");
  });

  it("should leave the ellipsis out when every candidate is already listed", () => {
    // 只有“被上限截掉一部分”时才补“…等 N 个”；两个候选全列出来时说“等 2 个”就是自相矛盾。
    const error = errorOf(() => patchTargetIdOf(docWith(liOf(2)), "li"));
    const data = dataOf(error);

    expect(data.count).toBe(2);
    expect(data.candidates).toEqual(["hr-l1", "hr-l2"]);
    expect(error.message).not.toContain("…等");
  });

  it("should refuse multiple addressable hits with count 7 and 5 candidates", () => {
    const error = errorOf(() => patchTargetIdOf(docWith(liOf(7)), "li"));
    const data = dataOf(error);

    expect(error.code).toBe("invalid_selector");
    expect(data.reason).toBe("ambiguous");
    expect(data.count).toBe(7);
    expect(data.matches).toBe(7);
    expect(data.candidates).toHaveLength(5);
    expect(error.message).toContain("…等 7 个");
  });
});
