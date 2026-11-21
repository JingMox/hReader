// 这层管：`annotation-basis.ts` 里**没有现成快照可对**的几条边——它们决定用户看到的是
// "整块都是新增"、"块没了"，还是"按槽位重识别"。`degradedReason` 是直接显示给人看的一句话，
// 档位拿错时用户会被告知"历史里找不到该块"（正确是"看不出变化"），靠常规"改一次块再 diff"走不到。
//
// 夹具在 `diff-basis-support.test.ts`（共用，两边只差别在不同历史形状）。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  addAt,
  chunkTextOf,
  diffOf,
  DOC_META_ORPHAN,
  DOC_WITH_META,
  docWithOrphanMeta,
  fieldOf,
  patchOf,
} from "./diff-basis-support";
import { withServer } from "./harness";

describe("diff 基版 · 历史为空", () => {
  it("should give only the current block text when the workspace has no snapshot at all", async () => {
    // 没有基版就没有"变化"可言：`before` 空串、`degraded:false`，除非实现自己造了个假基版。
    await withServer(
      async (ctx) => {
        const body = await diffOf(ctx, "an-selfseeded");

        expect(fieldOf(body, "nodeId")).toBe("hr-c");
        expect(fieldOf(body, "before")).toBe("");
        expect(fieldOf(body, "degraded")).toBe(false);
        expect(fieldOf(body, "reason")).toBeUndefined();
        expect(chunkTextOf(body)).toBe("正文一");
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), DOC_WITH_META("an-selfseeded", "hr-c"), "utf8");
      },
    );
  });
});

describe("diff 基版 · 基版取哪一份", () => {
  it("should take before from the snapshot, not from the current file", async () => {
    // “基版取自历史、不是当前文件”：手改过的正文不得当基版（`before` 必须是快照里的旧文本）。
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "主批注");
      // 只改兄弟：先落一份“正文一”的快照，再绕过 hr 手改 `hr-c`。
      await patchOf(ctx, "replace", "hr-b", "<p>标题改</p>");
      const current = readFileSync(ctx.file, "utf8");
      writeFileSync(ctx.file, current.replace("正文一", "手改的第三版"), "utf8");

      const body = await diffOf(ctx, anId);

      expect(fieldOf(body, "nodeId")).toBe("hr-c");
      expect(fieldOf(body, "before")).toBe("正文一");
      expect(fieldOf(body, "after")).toBe("手改的第三版");
      // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。id 没变 ⇒ 不降级。
      expect(fieldOf(body, "reason")).toBeUndefined();
      expect(fieldOf(body, "degraded")).toBe(false);
    });
  });
});

/** 缩进一层与顶层的两个 `p`：同 tag、同样的"第几个段落"，只差嵌套层。 */
const DOC_NESTED = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><blockquote data-hr-id="hr-quote"><p data-hr-id="hr-deep">深块</p></blockquote>',
  '<p data-hr-id="hr-shallow">浅块</p></article>',
  "</body></html>",
].join("\r\n");

describe("diff 基版 · 批注指向的块在工作区外被删掉", () => {
  it("should report block_missing when the block is gone and no snapshot exists", async () => {
    // 裁定 B：用户在 hreader 之外编辑文件、把带批注的块删了，而工作区还没生成任何快照。
    // 两侧都没有文本可比（`before`/`after` 都是空串），但这**不是**"没有变化"——
    // 块已经不存在了，必须按 `block_missing` 降级告知。
    await withServer(
      async (ctx) => {
        const body = await diffOf(ctx, "an-gone");

        expect(fieldOf(body, "nodeId")).toBe("hr-gone");
        expect(fieldOf(body, "before")).toBe("");
        expect(fieldOf(body, "after")).toBe("");
        // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
        expect(fieldOf(body, "reason")).toBeUndefined();
        expect(fieldOf(body, "degraded")).toBe(true);
        expect(chunkTextOf(body)).toBe("");
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), DOC_META_ORPHAN, "utf8");
      },
    );
  });
});

describe("diff 基版 · 同 tag 但不同层", () => {
  it("should not hand a shallow block the identity of a deleted nested one", async () => {
    // 位置兜底里 `depth` 的那一半：只比 tag 会把"深块"认成"前移上来的浅块"。
    await withServer(
      async (ctx) => {
        const anId = await addAt(ctx, "hr-deep", "深块批注");
        await patchOf(ctx, "replace", "hr-quote", "<p>浅替</p>");

        const body = await diffOf(ctx, anId);

        expect(fieldOf(body, "nodeId")).toBe("hr-deep");
        // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
        expect(fieldOf(body, "reason")).toBeUndefined();
        expect(fieldOf(body, "degraded")).toBe(true);
        expect(fieldOf(body, "before")).toBe("深块");
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), DOC_NESTED, "utf8");
      },
    );
  });
});

describe("diff 基版 · 槽位在更新的快照里已就地改过", () => {
  it("should take before from the latest snapshot text at that slot", async () => {
    // `beforeOfSlot` 的一侧：同槽位还能在新快照里找到时，基版取那份快照的文本（此处 `hr-d`）。
    let body: unknown = null;
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "主批注");
      await patchOf(ctx, "delete", "hr-c");
      await patchOf(ctx, "replace", "hr-d", "<p>后来的段落</p>");
      body = await diffOf(ctx, anId);
    });
    // 重识别成功：`nodeId` 给那一槽位真实的 id；`before` 是新快照里的文本，不是锚定的旧文本。
    expect(fieldOf(body, "nodeId")).toBe("hr-d");
    expect(fieldOf(body, "before")).toBe("正文二");
    expect(fieldOf(body, "after")).toBe("后来的段落");
    expect(fieldOf(body, "degraded")).toBe(true);
  });
});

describe("diff 基版 · 块在正文里但历史里没有", () => {
  it("should report block_missing when the block only exists in the current file", async () => {
    // “正文里有、历史里没有”：必须报缺基版，且 `before` 是空串而不是正文本身。
    await withServer(
      async (ctx) => {
        // 先造出历史：一次 patch 就会落快照，而这份快照里根本没有 `hr-hand`（它只在手改后的文件里）。
        await patchOf(ctx, "replace", "hr-b", "<p>标题改</p>");
        const current = readFileSync(ctx.file, "utf8");
        expect(current).not.toContain('data-hr-id="hr-hand"');
        writeFileSync(
          ctx.file,
          current.replace(
            '<p data-hr-id="hr-c">正文一</p>',
            '<p data-hr-id="hr-c">正文一</p><p data-hr-id="hr-hand">手改回来的块</p>',
          ),
          "utf8",
        );

        const body = await diffOf(ctx, "an-hand");

        expect(fieldOf(body, "nodeId")).toBe("hr-hand");
        expect(fieldOf(body, "before")).toBe("");
        expect(fieldOf(body, "degraded")).toBe(true);
        expect(fieldOf(body, "degradedReason")).toBe("历史里找不到该块");
        expect(chunkTextOf(body)).toBe("手改回来的块");
      },
      (workspace) => {
        writeFileSync(
          join(workspace, "doc.html"),
          docWithOrphanMeta("an-hand", "hr-hand", "只在手改后的文件里"),
          "utf8",
        );
      },
    );
  });
});

describe("diff 基版 · 历史被裁空", () => {
  it("should report block_missing once every snapshot containing the block has been pruned", async () => {
    // 块删掉之后又写了十几次，`HISTORY_LIMIT` 把带块的那份挤掉了：不能崩，也不能假装重识别成功。
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "主批注");
      await patchOf(ctx, "delete", "hr-c");
      for (let index = 0; index < 10; index += 1) {
        await addAt(ctx, "hr-d", `填充批注 ${String(index)}`);
      }

      const body = await diffOf(ctx, anId);

      expect(fieldOf(body, "nodeId")).toBe("hr-c");
      // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
      expect(fieldOf(body, "originNodeId")).toBeUndefined();
      expect(fieldOf(body, "before")).toBe("");
      expect(fieldOf(body, "after")).toBe("");
      expect(fieldOf(body, "reason")).toBeUndefined();
      expect(fieldOf(body, "degraded")).toBe(true);
      expect(fieldOf(body, "degradedReason")).toBe("历史里找不到该块");
    });
  });
});

describe("diff 基版 · 槽位在更新的快照里已被别的块顶掉", () => {
  it("should fall back to the anchored old text when the latest slot no longer holds it", async () => {
    // `beforeOfSlot` 的另一侧：块在**最新**快照的那个先序槽位上已经不是同一个 tag 了
    // （前面的 `<p>` 全换成 `<h2>`），基版只能回到还留着它自己那份快照里的旧文本。
    let body: unknown = null;
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "主批注");
      await patchOf(ctx, "delete", "hr-c");
      await patchOf(ctx, "replace", "hr-d", "<h2>后来的段落</h2>");
      // 快照是"改之前"的副本：再改一次兄弟，最新快照里那个槽位才真的变成 `<h2>`。
      await patchOf(ctx, "replace", "hr-b", "<h2>标题改</h2>");
      body = await diffOf(ctx, anId);
    });
    // 槽位对不上 ⇒ block_missing：`before` 是锚定块自己的旧文本，不是占了那个槽位的 `<h2>`。
    expect(fieldOf(body, "nodeId")).toBe("hr-c");
    expect(fieldOf(body, "before")).toBe("正文一");
    expect(fieldOf(body, "after")).toBe("");
    expect(fieldOf(body, "degraded")).toBe(true);
    expect(fieldOf(body, "degradedReason")).toBe("当前文档里找不到该块");
  });
});
