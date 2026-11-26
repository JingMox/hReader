// This layer covers the two shared read-entry pre-checks — `no_article` (this file is not a document) and `needs_normalize` (missing ids but fixable).
//
// The two codes stay separate: `needs_normalize`'s next step is a command (`hr normalize --write`); `no_article` has none.

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

    // The error must carry the filename and "this is not an hReader document", otherwise the user knows neither which file nor what to swap in.
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
    // Duplicate ids are refused at the **load side** (read/patch only ever hit the first; the second can be neither patched nor deleted).
    let thrown: unknown;
    try {
      assertUniqueIds(duplicated, "/ws/a.html");
    } catch (error: unknown) {
      thrown = error;
    }
    if (!(thrown instanceof HrError)) throw new Error("duplicate ids must throw an HrError");
    expect(thrown.code).toBe("duplicate_id");
    // All three facts are mandatory: which file, which id, how many occurrences (the user needs to know what to fix).
    expect(thrown.message).toMatch(/\/ws\/a\.html/u);
    expect(thrown.message).toMatch(/data-hr-id "hr-c"/u);
    expect(thrown.message).toMatch(/共 2 处/u);
    expect(thrown.message).toMatch(/hr normalize \/ws\/a\.html --write/u);
  });

  it("should count every repeat, not just the second one", () => {
    // When three places share one id, the report is the **total**: saying "there are two" makes the user hit the same error again after one round.
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
    // core holds only the model and no filename: the `<file>` placeholder must be substituted with the real path at this layer.
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
    const plain = new Error("whatever");

    expect(withNormalizeAdvice(other, "/ws/a.html")).toBe(other);
    expect(withNormalizeAdvice(plain, "/ws/a.html")).toBe(plain);
  });
});
