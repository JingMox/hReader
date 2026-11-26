// 写批注的插入点不能被"隐式 body 的零宽 span"或正文里的字面 `</body>` 带偏。
// `appendAnnotation` 是纯函数（不落盘、不加锁），片段输入在这里可直接构造；
// HTTP 层会先拒绝"文档里没有 <article>"，所以片段路径只有在纯函数这一层才可达。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readAnnotations } from "../../src/annotations";
import { appendAnnotation } from "../../src/server/annotation";
import { httpCall, withServer, type TestServer } from "./harness";
import { withPost } from "./wire";

/** 写入时间戳由调用方从注入时钟取；纯函数层只透传，测试里用固定值保证字节级可比。 */
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const META_OPEN = '<script id="hr-meta"';

const inputOf = (body: string): Parameters<typeof appendAnnotation>[1] => ({
  start: 0,
  end: body.length,
  text: body,
  note: "批注",
  status: "pending_ai",
});

describe("片段文档 · 插入点", () => {
  it("should append the meta script after the fragment instead of before it", () => {
    const html = '<p data-hr-id="hr-c">片段正文</p>';

    const outcome = appendAnnotation(html, inputOf("片段正文"), "an_00000001", CREATED_AT);

    expect(outcome.html.indexOf(META_OPEN)).toBeGreaterThan(outcome.html.indexOf("</p>"));
    expect(outcome.html.startsWith(html)).toBe(true);
  });

  it("should keep the annotation readable through the metadata round trip", () => {
    const html = '<p data-hr-id="hr-c">片段正文</p>';

    const outcome = appendAnnotation(html, inputOf("片段正文"), "an_00000001", CREATED_AT);

    // 写进去读不回来 = 批注当场丢了；`diagnostics` 里有原因也不等于用户能看到。
    const parsed = readAnnotations(outcome.html);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.annotations.map((card) => card.id)).toEqual(["an_00000001"]);
  });
});

const literalSeed = (workspace: string): void => {
  writeFileSync(
    join(workspace, "doc.html"),
    [
      "<html><body>",
      '<article data-hr-id="hr-a"><p data-hr-id="hr-c">之前 &lt;/body&gt; 之后</p></article>',
      "</body></html>",
    ].join(""),
    "utf8",
  );
};

/** 正文块的字节快照（`shasum` 级）：写批注不许改动正文一个字节，包括实体转义形式。 */
const blockDigestOf = (html: string): string => {
  const block = /<p data-hr-id="hr-c">[^<]*<\/p>/.exec(html)?.[0];
  if (block === undefined) throw new Error("正文块不见了");
  return createHash("sha256").update(block, "utf8").digest("hex");
};

const postNote = async (ctx: TestServer): Promise<void> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${ctx.docId}/annotations`,
    headers: withPost(ctx.token),
    body: JSON.stringify({
      docId: ctx.docId,
      nodeId: "hr-c",
      anchor: { exact: "之前 </body> 之后", prefix: "", suffix: "", start: 0 },
      note: "批注",
    }),
  });
  expect(response.status).toBe(201);
};

describe("正文里的字面 </body> · 插入点", () => {
  it("should keep the block bytes and put the meta before the real body end", async () => {
    await withServer(async (ctx) => {
      const before = blockDigestOf(readFileSync(ctx.file, "utf8"));
      await postNote(ctx);
      const html = readFileSync(ctx.file, "utf8");

      // `shasum` 级比对：正文块一个字节都不许动（字符串包含会把“改了一个实体”放过）。
      expect(blockDigestOf(html)).toBe(before);
      expect(html.indexOf(META_OPEN)).toBeGreaterThan(html.indexOf("</p>"));
      expect(html.indexOf(META_OPEN)).toBeLessThan(html.lastIndexOf("</body>"));
      expect(readAnnotations(html).annotations).toHaveLength(1);
    }, literalSeed);
  });
});
