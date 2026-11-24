// 这层管：仿真实文章的三种 action 落盘后，`hr_read_node` 仍能读到改后的节点（不是只看字节）。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, readNode } from "../../src";
import { nodePatchDeps, patchFile } from "../../src/io";
import type { PatchRequest } from "../../src/ops/patch-node";
import { CORPUS_DOC, DOC_FILE } from "./fixtures";
import { codeOf, readTextAt, withWorkspace, writeTextAt } from "./harness";

const deps = nodePatchDeps;

const readAfter = (html: string, id: string): string =>
  readNode(injectNodeIds(parseHtml(html)).parsed, `#${id}`).html;

const patchIn = async (
  dir: string,
  request: PatchRequest,
): Promise<{ readonly html: string; readonly newIds: readonly string[] }> => {
  const result = await patchFile({ workspace: dir, file: DOC_FILE, request }, deps);
  return { html: await readTextAt(join(dir, DOC_FILE)), newIds: result.newIds };
};

const seeded = async (dir: string): Promise<void> => writeTextAt(join(dir, DOC_FILE), CORPUS_DOC);

describe("真实结构文章 · patch 后仍可读", () => {
  it("should let readNode read the replaced paragraph by the target's own id", async () => {
    await withWorkspace(async (dir) => {
      await seeded(dir);
      const { html, newIds } = await patchIn(dir, {
        targetId: "p1",
        action: "replace",
        html: "<p>改过</p>",
      });
      // docs/05:57：`replace` 的新根继承目标 id ⇒ 老 id 仍可寻址，且不产新 id。
      const output = readAfter(html, "p1");

      expect(newIds).toEqual([]);
      expect(output).toContain("改过");
      expect(output).not.toContain("第一段");
    });
  });
});

describe("真实结构文章 · patch 后仍可读（续）", () => {
  it("should let readNode read an appended paragraph inside the component", async () => {
    await withWorkspace(async (dir) => {
      await seeded(dir);
      const { html, newIds } = await patchIn(dir, {
        targetId: "insight",
        action: "append",
        html: "<p>补</p>",
      });
      const output = readAfter(html, String(newIds[0]));

      expect(output).toContain("补");
      expect(readAfter(html, "i1")).toContain("洞察");
    });
  });

  it("should make readNode report node_not_found after the node is deleted", async () => {
    await withWorkspace(async (dir) => {
      await seeded(dir);
      const { html } = await patchIn(dir, { targetId: "p2", action: "delete" });

      expect(codeOf(() => readAfter(html, "p2"))).toBe("node_not_found");
      expect(readAfter(html, "p1")).toContain("第一段");
    });
  });
});
