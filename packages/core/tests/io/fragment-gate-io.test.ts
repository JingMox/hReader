// 这层管：片段被拒时"文件一个字节都没动"的证明（真实 fs），错误码与报文都断。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile } from "../../src/io";
import { ARTICLE_DOC, DOC_FILE } from "./fixtures";
import { ACCEPTED_FRAGMENTS, REJECTED_FRAGMENTS } from "./fragments";
import {
  codeOfAsync,
  namesInOrEmpty,
  readBytesAt,
  realDirOf,
  sha1Of,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "./harness";
import { childTags, elementById, found } from "./tree-probe";

const deps = nodePatchDeps;

describe("片段校验失败 · 不落盘", () => {
  it.each(REJECTED_FRAGMENTS)(
    "should keep the file byte-identical after rejecting $code",
    async ({ fragment, code }) => {
      await withWorkspace(async (dir) => {
        const file = join(dir, DOC_FILE);
        await writeTextAt(file, ARTICLE_DOC);
        const before = sha256Of(await readBytesAt(file));
        const actual = await codeOfAsync(() =>
          patchFile(
            {
              workspace: dir,
              file: DOC_FILE,
              request: { targetId: "p1", action: "replace", html: fragment },
            },
            deps,
          ),
        );
        const storeDir = join(await realDirOf(dir), ".hreader");

        expect(actual).toBe(code);
        expect(sha256Of(await readBytesAt(file))).toBe(before);
        expect(await namesInOrEmpty(join(storeDir, "history", sha1Of(DOC_FILE)))).toEqual([]);
        expect(await namesInOrEmpty(join(storeDir, "locks"))).toEqual([]);
      });
    },
  );
});

describe("片段校验失败 · 不落盘（续）", () => {
  it("should reject a forbidden fragment on every action, not just replace", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, ARTICLE_DOC);
      const before = sha256Of(await readBytesAt(file));
      for (const action of ["append", "insert_after", "replace"] as const) {
        const code = await codeOfAsync(() =>
          patchFile(
            {
              workspace: dir,
              file: DOC_FILE,
              request: { targetId: "p1", action, html: "<script>x</script>" },
            },
            deps,
          ),
        );
        expect(code).toBe("forbidden_content");
      }
      expect(sha256Of(await readBytesAt(file))).toBe(before);
    });
  });
});

/** 带完整表格祖先链的夹具：`<tr>`/`<td>` 片段只有落在这条链上才成立。 */
const TABLE_DOC = [
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>t</title></head><body>',
  '<article data-hr-id="root"><table data-hr-id="tbl"><tbody data-hr-id="tb">',
  '<tr data-hr-id="row"><td data-hr-id="c0">a</td></tr>',
  "</tbody></table></article>",
  "</body></html>",
].join("\n");

const assertAcceptedFragmentsLand = async (): Promise<void> => {
  // 单独解析会丢标签、套上祖先链解析才合法：放行之后必须真的落在 `<tbody>`/`<tr>` 里面，
  // 不能因为“解析时是合法的”就写出一个平行结构。
  await withWorkspace(async (dir) => {
    const file = join(dir, DOC_FILE);
    await writeTextAt(file, TABLE_DOC);

    const cases = [
      { targetId: "tb", fragment: "<tr><td>b</td></tr>", parent: "tb", chain: ["table", "tbody"] },
      { targetId: "row", fragment: "<td>b</td>", parent: "row", chain: ["table", "tbody", "tr"] },
    ] as const;

    for (const item of cases) {
      const result = await patchFile(
        {
          workspace: dir,
          file: DOC_FILE,
          request: { targetId: item.targetId, action: "append", html: item.fragment },
        },
        deps,
      );
      const written = new TextDecoder().decode(await readBytesAt(file));
      const newId = result.newIds[0];
      if (newId === undefined) throw new Error(`片段 ${item.fragment} 没有拿到新 id`);
      const located = found(elementById(written, newId), `#${newId}（${item.fragment}）`);

      // 盘上的字节重新解析后，新元素的祖先链必须是那条表格链，而不是被 foster-parent 挪到前面。
      expect(located.chain.map((node) => node.tag)).toEqual([
        "html",
        "body",
        "article",
        ...item.chain,
      ]);
      expect(childTags(written, item.parent)).toHaveLength(2);
    }
  });
};

describe("放行的表格结构片段 · 落盘位置", () => {
  it("should land an accepted bare <tr> inside <tbody> and a bare <td> inside <tr>", async () => {
    await assertAcceptedFragmentsLand();
  });

  it("should keep exactly the two table-structure fragment entries accepted", () => {
    // 这条守着 AC 口径本身：`<tr>`/`<td>` 在 ACCEPTED 里、且没有同时留在 REJECTED 里。
    const accepted = ACCEPTED_FRAGMENTS.map((entry) => entry.fragment);
    const rejected = REJECTED_FRAGMENTS.map((entry) => entry.fragment);

    expect(accepted).toContain("<tr><td>b</td></tr>");
    expect(accepted).toContain("<td>b</td>");
    expect(rejected).not.toContain("<tr><td>b</td></tr>");
    expect(rejected).not.toContain("<td>b</td>");
  });
});
