// 这层管：错误折叠的两个"形状不变量"——折叠后的 **cause 链**（下游靠它摸回 errno）与
// `elidedOf` 对根的**顺序无关**（`[cwd, real]` 与 `[real, cwd]` 必须折出同一句）。
//
// 它会因为什么而红：
// - 折叠只留 message 不留 cause（`foldedOf` 里丢掉 `cause: error`）→ `cause` 不再是原 HrError；
// - 折叠时把 cause 拍平成字符串 → 原 cause 的 `code` / 更深一层 cause 摸不到；
// - `elidedOf` 的"长的根先折"排序被删 → 两个顺序折出不同结果（macOS `/var` ↔ `/private/var`）。

import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { elidedOf, foldedOf, rootsOf } from "../src/errors";

const errnoOf = (root: string): Error & { code: string } =>
  Object.assign(new Error(`ENOENT: no such file or directory, open '${root}/doc.html'`), {
    code: "ENOENT",
  });

/** 断言 `unknown` 真是 HrError 并收窄：比 `as` 一遍更严（错类型会当场抛，而不是骗过类型检查）。 */
const hrErrorOf = (value: unknown): HrError => {
  if (!(value instanceof HrError)) throw new Error(`不是 HrError：${typeof value}`);
  return value;
};

/**
 * 沿 `cause` 链收集所有节点（带环保护）。**只回答"还摸不摸得到"**，不锁层数：
 * `foldedOf` 将来若把底层 cause 直接挂上来（可观察行为更好、层数更少），这里照样绿。
 */
const causesOf = (root: unknown): readonly unknown[] => {
  const chain: unknown[] = [];
  let node: unknown = root instanceof Error ? root.cause : undefined;
  while (node !== undefined && !chain.includes(node)) {
    chain.push(node);
    node = node instanceof Error ? node.cause : undefined;
  }
  return chain;
};

const codeOfCause = (node: unknown): unknown =>
  node instanceof Error && "code" in node ? node.code : undefined;

describe("折叠后的 cause 链", () => {
  it("should keep both the original HrError and its errno reachable along the cause chain", () => {
    const errno = errnoOf("/ws/project");
    const original = new HrError("not_found", "/ws/project/doc.html 不存在", { cause: errno });

    const folded = foldedOf(original);
    expect(folded).toBeInstanceOf(HrError);
    expect(folded).not.toBe(original);
    expect(hrErrorOf(folded).code).toBe("not_found");

    // 下游拿 `cause.code` 比 errno 是常见写法：折完这条链上必须两样都还摸得到。
    // 不断言"恰好两层"——那是内部结构，不是契约。
    const chain = causesOf(folded);
    expect(chain).toContain(original);
    expect(chain.map(codeOfCause)).toContain("ENOENT");
  });

  it("should leave a non-HrError untouched so its own errno stays reachable", () => {
    const errno = errnoOf("/ws/project");

    expect(foldedOf(errno)).toBe(errno);
    expect(errno.code).toBe("ENOENT");
  });
});

describe("elidedOf 与根的顺序无关", () => {
  it("should fold the same text whichever order the two roots are given in", () => {
    const cwd = "/var/folders/x/hreader-ws";
    const real = "/private/var/folders/x/hreader-ws";
    const message = `ENOENT: open '${real}/doc.html' while cwd was '${cwd}'`;

    const cwdFirst = elidedOf(
      message,
      rootsOf(cwd, () => real),
    );
    const realFirst = elidedOf(message, [real, cwd]);

    expect(cwdFirst).toBe(realFirst);
    // 折的是"窄"的那个：短根 `cwd` 折进去会剩下 `/privatedoc.html` 这种畸形。
    // （`elidedOf` 是单趟替换，只折最长的那处命中；第二处留着不算缺陷。）
    expect(cwdFirst).not.toContain("/private");
  });

  it("should fold the same way when the two roots are passed in reverse creation order", () => {
    const cwd = "/var/folders/x/hreader-ws";
    const real = "/private/var/folders/x/hreader-ws";
    const message = `ENOENT: open '${cwd}/doc.html', realpath '${real}/doc.html'`;

    expect(elidedOf(message, [cwd, real])).toBe(elidedOf(message, [real, cwd]));
  });
});
