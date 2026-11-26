// `replace` 的片段自带 `data-hr-id` 时，那是"片段带来的 id 被忽略"，报成
// `replacedIds: [{from: 片段的 id, to: 继承到的目标 id}]`；片段**内部**其它可寻址节点由产品重新分配，
// 落在 `newIds` 里。两件事同时发生，人读回执就必须把两段提示都印出来——
// 只印 "id 变更" 会让用户不知道文档里凭空多了两个 id，只印 "+N ids" 又看不出锚点被换了。
//
// 这层管 CLI 落盘 + 人读输出；`replacedIds` 的语义本身在 `patch-id-inherit.test.ts`。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked, seed } from "./cli-support";
import { runCli, withTempDir } from "./harness";

const FRAGMENT_ID = "hr-zz";
const TARGET_ID = "hr-d";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  `<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><div data-hr-id="${TARGET_ID}"><p data-hr-id="hr-c">正文</p></div></article>`,
  "</body></html>",
].join("\n");

const FRAGMENT = `<div data-hr-id="${FRAGMENT_ID}"><p>内一</p><p>内二</p></div>`;

/** 片段里除了它自己的 `data-hr-id` 之外**没有**可寻址节点（`newIds` 因此为空）。 */
const TEXT_ONLY_FRAGMENT = '<div data-hr-id="hr-zz">纯文本</div>';

const idsIn = (html: string): readonly string[] =>
  [...html.matchAll(/data-hr-id="([^"]*)"/gu)].map((match) => String(match[1]));

describe("patch · 片段带 id 且片段内还要分新 id", () => {
  it("should print both the id mapping and the extra new ids in the human receipt", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", DOC);

      const result = checked(
        await runCli(["patch", "a.html", TARGET_ID, "--action", "replace", "--html", FRAGMENT], {
          cwd: dir,
        }),
      );
      expect(result.code).toBe(0);

      // 两段提示都在同一条回执里：先给"片段 id → 目标 id"的映射，再补片段内部新分配的两个 id。
      const [receipt] = result.stdout.split("\n");
      expect(receipt).toMatch(
        new RegExp(
          `^patched a\\.html \\(\\d+ bytes, id 变更: ${FRAGMENT_ID} → ${TARGET_ID}, \\+2 ids: hr-[0-9a-f]{8}, hr-[0-9a-f]{8}\\)$`,
          "u",
        ),
      );
      // 映射来自一次“片段 id 被忽略”：warning 带着片段原来的 id，用户能对上号。
      expect(result.stdout).toContain(
        `fragment_ids_ignored — 片段里的 data-hr-id="${FRAGMENT_ID}" 已忽略`,
      );

      // 落盘结果是这条回执的真相：目标 id 保留、片段自带的 id 没上盘、内部两段各自拿到新 id。
      const html = readFileSync(`${dir}/a.html`, "utf8");
      expect(idsIn(html)).toContain(TARGET_ID);
      expect(idsIn(html)).not.toContain(FRAGMENT_ID);
      expect(idsIn(html).filter((id) => id === TARGET_ID)).toHaveLength(1);
      // `<article>` + `<h2>` + 目标 `<div>` + 内部两个 `<p>`：5 个 id，互不相同。
      expect(idsIn(html)).toHaveLength(5);
      expect(new Set(idsIn(html)).size).toBe(5);
    });
  });
});

describe("patch · 片段不带内部节点", () => {
  it("should not print an empty '+0 ids' tail when the fragment brings no inner ids", async () => {
    // `humanPatch` 的另一半：`newIds` 全被映射吃掉时那截补充提示必须整段消失——
    // 留下 ", +0 ids: " 会让用户以为丢了东西。
    await withTempDir(async (dir) => {
      seed(dir, "a.html", DOC);

      const result = checked(
        await runCli(
          ["patch", "a.html", TARGET_ID, "--action", "replace", "--html", TEXT_ONLY_FRAGMENT],
          { cwd: dir },
        ),
      );
      expect(result.code).toBe(0);
      const [receipt] = result.stdout.split("\n");
      expect(receipt).toMatch(
        new RegExp(
          `^patched a\\.html \\(\\d+ bytes, id 变更: ${FRAGMENT_ID} → ${TARGET_ID}\\)$`,
          "u",
        ),
      );
      expect(receipt).not.toContain("ids:");
      // 落盘：目标 id 保留、片段自带的 id 不进文档、内部没有别人的 id。
      const html = readFileSync(`${dir}/a.html`, "utf8");
      expect(idsIn(html)).toContain(TARGET_ID);
      expect(idsIn(html)).not.toContain(FRAGMENT_ID);
    });
  });
});
