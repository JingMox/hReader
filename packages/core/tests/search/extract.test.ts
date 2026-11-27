// `extractDocFields` field selection: `<title>` wins, the first non-empty `<h1>` is the
// fallback, and a doc with neither indexes an empty title.

import { describe, expect, it } from "vitest";

import { extractDocFields } from "../../src/search/extract";

describe("extractDocFields", () => {
  it("prefers <title> over <h1>", () => {
    const fields = extractDocFields(
      `<!doctype html><html><head><title>标题文档</title></head><body><h1>页内标题</h1></body></html>`,
    );
    expect(fields.title).toBe("标题文档");
  });

  it("falls back to the first non-empty <h1>", () => {
    const fields = extractDocFields(
      `<!doctype html><html><body><h1>   </h1><h1>回退标题</h1><h1>第二个</h1></body></html>`,
    );
    expect(fields.title).toBe("回退标题");
    expect(fields.headings).toBe("回退标题 第二个");
  });

  it("indexes an empty title when neither exists", () => {
    const fields = extractDocFields(`<!doctype html><html><body><p>只有正文</p></body></html>`);
    expect(fields.title).toBe("");
    expect(fields.headings).toBe("");
  });
});
