// R3-D3（.workflow/cards/R3.md D3「定位在锁内」）：`patch` 的 target 必须在**本次要写的那份字节**上定位。
// ① 一次 patch 对目标文件只 `readFile` **一次**——读两次就有"定位用 A、写回用 B"的窗口；
// ② 取锁前文件被别人 `mv` 换掉时，定位看到的是**锁内那份新字节**：要么改到新树里的节点，
//    要么 `node_not_found`；**永远不会**"改了旧树那个"。时序用 `open` 端口钩子制造（锁的 `open`
//    必先于锁内的 `readFile`），不用 sleep，所以是确定性的。
//
// 断言钉外部可观察物：端口上的 `readFile` 调用次数、请求函数收到的字节、落盘字节。

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile, type FileSystem, type PatchDeps } from "../../src/io";
import { readTextAt, withWorkspace, writeTextAt } from "./harness";

const FILE = "a.html";

const docWith = (body: string): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    `<article data-hr-id="hr-root">${body}</article>`,
    "</body></html>",
  ].join("\n");

/** 旧树只有 `p1`；新树的段落 id 是 `p9`——定位若发生在锁外，就必然落空或改错。 */
const OLD_TREE = docWith('<p data-hr-id="p1">旧树</p>');
const NEW_TREE = docWith('<p data-hr-id="p9">新树</p>');

const depsWith = (fs: FileSystem): PatchDeps => ({ ...nodePatchDeps, fs });

/** 记下每次 `readFile` 的路径：`patch` 对目标文件的读次数就是"定位用哪份字节"的判据。 */
const countingDeps = (reads: string[]): PatchDeps => {
  const base = nodePatchDeps;
  return depsWith({
    ...base.fs,
    readFile: (path) => {
      reads.push(path);
      return base.fs.readFile(path);
    },
  });
};

/** 在 `open(lock)` 那一刻把文档整个换掉：这正是"取锁前被 mv 换掉"的时序。 */
const swappingDeps = (staging: string, file: string, swapped: () => void): PatchDeps => {
  const base = nodePatchDeps;
  return depsWith({
    ...base.fs,
    open: (path, mode) => {
      if (path.endsWith(".lock")) {
        swapped();
        renameSync(staging, file);
      }
      return base.fs.open(path, mode);
    },
  });
};

describe("D3 · 一次 patch 只读一次盘", () => {
  it("should read the target file exactly once", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, FILE), OLD_TREE);
      const reads: string[] = [];

      const result = await patchFile(
        {
          workspace: dir,
          file: FILE,
          request: { targetId: "p1", action: "replace", html: '<p data-hr-id="p1">改了</p>' },
        },
        countingDeps(reads),
      );

      expect(result.changed).toBe(true);
      expect(reads.filter((path) => path.endsWith(FILE))).toHaveLength(1);
    });
  });
});

describe("D3 · 取锁前被 mv 换掉：定位必须看到锁内那份字节", () => {
  it("should locate inside the lock, so the edit lands in the new tree (never the old one)", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, OLD_TREE);
      const staging = join(dir, "staging.html");
      writeFileSync(staging, NEW_TREE);
      const seen: string[] = [];
      let swaps = 0;

      await patchFile(
        {
          workspace: dir,
          file: FILE,
          request: (html) => {
            seen.push(html);
            const targetId = html.includes('data-hr-id="p9"') ? "p9" : "p1";
            return { targetId, action: "replace", html: '<p data-hr-id="p9">新内容</p>' };
          },
        },
        swappingDeps(staging, file, () => {
          swaps += 1;
        }),
      );

      // 钩子确实开过火，否则这条用例是空转的。
      expect(swaps).toBeGreaterThan(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("新树");
      const after = await readTextAt(file);
      expect(after).toContain("新内容");
      expect(after).not.toContain("旧树");
    });
  });
});
