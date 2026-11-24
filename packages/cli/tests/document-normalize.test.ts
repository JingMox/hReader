// 这层管：读入口共用的两道前置判定——`no_article`（这份文件不是文档）与 `needs_normalize`（缺 id 但能修）。
//
// 两个码要分开：`needs_normalize` 的后手是一条命令（`hr normalize --write`），`no_article` 没有后手。

import { describe, expect, it } from "vitest";

import { HrError, parseHtml } from "@hreader/core";

import {
  assertIsDocument,
  assertNormalized,
  assertUniqueIds,
  withNormalizeAdvice,
} from "../src/document-normalize";

const DOC = parseHtml('<article data-hr-id="hr-a"><p data-hr-id="hr-b">正文</p></article>');
const DRAFT = parseHtml("<article><p>正文</p></article>");

describe("assertIsDocument", () => {
  it("should pass a real document and name the file when <article> is missing", () => {
    expect(() => {
      assertIsDocument(DOC, "/ws/a.html");
    }).not.toThrow();

    // 报错里要带文件名与"这不是一篇 hReader 文档"，否则用户不知道是哪份文件、也不知道该换什么。
    expect(() => {
      assertIsDocument(parseHtml("<p>随手记一段</p>"), "/ws/note.html");
    }).toThrow(/\/ws\/note\.html 里没有 <article>：这不是一篇 hReader 文档/u);
  });
});

describe("assertUniqueIds", () => {
  const duplicated = parseHtml(
    '<article data-hr-id="hr-a"><p data-hr-id="hr-c">甲</p><p data-hr-id="hr-c">乙</p></article>',
  );

  it("should pass a document whose ids are all distinct", () => {
    expect(() => {
      assertUniqueIds(DOC, "/ws/a.html");
    }).not.toThrow();
  });

  it("should reject a document where two elements share one id, naming file/id/count", () => {
    // 重复 id 在**加载侧**就要拒（read/patch 只命中第一个，第二个既改不到也删不掉）。
    let thrown: unknown;
    try {
      assertUniqueIds(duplicated, "/ws/a.html");
    } catch (error: unknown) {
      thrown = error;
    }
    if (!(thrown instanceof HrError)) throw new Error("重复 id 必须抛 HrError");
    expect(thrown.code).toBe("duplicate_id");
    // 三件事缺一不可：哪份文件、哪个 id、一共有几处（用户要知道该改谁）。
    expect(thrown.message).toMatch(/\/ws\/a\.html/u);
    expect(thrown.message).toMatch(/data-hr-id "hr-c"/u);
    expect(thrown.message).toMatch(/共 2 处/u);
    expect(thrown.message).toMatch(/hr normalize \/ws\/a\.html --write/u);
  });

  it("should count every repeat, not just the second one", () => {
    // 三处共用同一个 id 时报的是**总数**：只说“有两个”会让用户改完一轮又撞同一个错。
    const tripled = parseHtml(
      '<article data-hr-id="hr-a"><p data-hr-id="hr-c">甲</p>' +
        '<section data-hr-id="hr-c"><p data-hr-id="hr-c">乙</p></section></article>',
    );

    expect(() => {
      assertUniqueIds(tripled, "/ws/b.html");
    }).toThrow(/共 3 处/u);
  });
});

describe("assertNormalized", () => {
  it("should reject a document that only lacks ids and hand over the command that fixes it", () => {
    expect(() => {
      assertNormalized(DOC, "/ws/a.html");
    }).not.toThrow();
    expect(() => {
      assertNormalized(DRAFT, "/ws/draft.html");
    }).toThrow(/\/ws\/draft\.html 缺少 data-hr-id，先跑 hr normalize \/ws\/draft\.html --write/u);
  });
});

describe("withNormalizeAdvice", () => {
  it("should rewrite core's generic message with the file and the paste-ready command", () => {
    // core 手上只有模型、不知道文件名：`<file>` 占位必须在这一层被替换成真路径。
    const patched = withNormalizeAdvice(
      new HrError("needs_normalize", "<file> 缺少 data-hr-id"),
      "/ws/a.html",
    );

    expect(String(Reflect.get(Object(patched), "message"))).toBe(
      "/ws/a.html 缺少 data-hr-id，先跑 hr normalize /ws/a.html --write",
    );
  });

  it("should pass every other error through untouched", () => {
    const other = new HrError("not_a_file", "没有这个文件");
    const plain = new Error("随便什么");

    expect(withNormalizeAdvice(other, "/ws/a.html")).toBe(other);
    expect(withNormalizeAdvice(plain, "/ws/a.html")).toBe(plain);
  });
});
