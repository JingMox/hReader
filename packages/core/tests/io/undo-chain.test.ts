// 这层管：parse → normalize → patch → undo 链的字节级还原与故障隔离——
// 随机补丁序列 + 等量 undo 必须回到原文；失败补丁不许动盘；style 写路径同链。

import { createHash } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HISTORY_LIMIT } from "../../src/io/history";
import { nodePatchDeps, patchFile, undoPatch } from "../../src/io";
import type { PatchRequest } from "../../src/index";
import type { StyleDeps } from "../../src/style/contracts";
import { normalizeFile } from "../../src/ops/normalize-file";
import { applyStyle } from "../../src/style/apply-file";
import { revertLast } from "../../src/ops/revert-op";
import {
  codeOfAsync,
  historyNamesOf,
  mkdirAt,
  readBytesAt,
  writeBytesAt,
  writeTextAt,
  withWorkspace,
} from "./harness";
import { ARTICLE_DOC, DOC_FILE } from "./fixtures";

const deps = nodePatchDeps;

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
// 统一成 Uint8Array 再比对：Buffer 与 Uint8Array 同字节也不同型，toEqual 会判不等。
const bytesOf = async (dir: string) => new Uint8Array(await readBytesAt(join(dir, DOC_FILE)));

/** 确定性 PRNG（mulberry32）：失败可复现，不靠真实随机。 */
const rngOf = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(rng: () => number, list: readonly T[]): T => {
  const item = list[Math.floor(rng() * list.length)];
  if (item === undefined) throw new Error("empty list");
  return item;
};

const hrIdsOf = (bytes: Uint8Array): string[] =>
  [...new TextDecoder().decode(bytes).matchAll(/data-hr-id="([^"]+)"/gu)].map(
    (match) => match[1] ?? "",
  );

/** 只产大概率合法的补丁；容器不合的组合在本套件里不是覆盖目标（content-model 另有套件）。 */
const requestOf = (rng: () => number, ids: readonly string[], step: number): PatchRequest => {
  const targetId = pick(rng, ids);
  const roll = rng();
  const block = `<p>补丁 ${String(step)}-${String(Math.floor(rng() * 1e6))}</p>`;
  if (targetId === "root") {
    return roll < 0.5
      ? { targetId, action: "append", html: block }
      : { targetId, action: "replace", html: `<p>根区 ${String(step)}</p>` };
  }
  if (roll < 0.3) return { targetId, action: "delete" };
  if (roll < 0.55) return { targetId, action: "replace", html: block };
  if (roll < 0.8)
    return { targetId, action: rng() < 0.5 ? "insert_before" : "insert_after", html: block };
  // append 只对装得下块级内容的容器发；其余降级成 insert_before（父容器吃同样的片段）。
  return ids.includes(targetId)
    ? { targetId, action: "insert_before", html: block }
    : { targetId, action: "append", html: block };
};

describe("undo 链 · 任意补丁序列 + 等量 undo = 原文（种子化 fuzz）", () => {
  it.each([7, 2026, 424242])(
    "should rewind every successful patch byte for byte (seed %i)",
    async (seed) => {
      const rng = rngOf(seed);
      await withWorkspace(async (dir) => {
        await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(`${ARTICLE_DOC}\n`));
        const states: Uint8Array[] = [await bytesOf(dir)];
        const STEPS = 40;
        let changes = 0;

        for (let step = 0; step < STEPS && changes < HISTORY_LIMIT + 4; step += 1) {
          const before = await bytesOf(dir);
          const ids = hrIdsOf(before);
          const request = requestOf(rng, ids, step);
          try {
            const result = await patchFile({ workspace: dir, file: DOC_FILE, request }, deps);
            const after = await bytesOf(dir);
            if (result.changed) {
              changes += 1;
              // changed 必须真的有字节差；新状态入栈。
              expect(sha(after)).not.toBe(sha(before));
              states.push(after);
            } else {
              expect(sha(after)).toBe(sha(before));
            }
          } catch {
            // 目标被删/内容模型冲突：失败补丁不许动一个字节，也不许留快照。
            expect(await bytesOf(dir)).toEqual(before);
          }
        }
        expect(changes).toBeGreaterThan(5);

        // 快照只保留最近 HISTORY_LIMIT 份：能逐份退到 states[changes - kept]。
        const kept = Math.min(changes, HISTORY_LIMIT);
        const historyCount = (await historyNamesOf(dir, DOC_FILE)).length;
        expect(historyCount).toBe(kept);
        for (let index = 0; index < kept; index += 1) {
          const expected = states[states.length - 2 - index];
          await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
          expect(await bytesOf(dir)).toEqual(expected);
        }
        const code = await codeOfAsync(() => undoPatch({ workspace: dir, file: DOC_FILE }, deps));
        expect(code).toBe("undo_unavailable");
      });
    },
  );

  it("should restore the original bytes after a short patch/undo round trip", async () => {
    await withWorkspace(async (dir) => {
      await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(ARTICLE_DOC));
      const before = await bytesOf(dir);

      await patchFile(
        {
          workspace: dir,
          file: DOC_FILE,
          request: { targetId: "p1", action: "replace", html: "<p>改</p>" },
        },
        deps,
      );
      await patchFile(
        {
          workspace: dir,
          file: DOC_FILE,
          request: { targetId: "box", action: "append", html: "<p>新段</p>" },
        },
        deps,
      );
      await patchFile(
        { workspace: dir, file: DOC_FILE, request: { targetId: "h1", action: "delete" } },
        deps,
      );
      for (let index = 0; index < 3; index += 1) {
        await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      }

      expect(await bytesOf(dir)).toEqual(before);
    });
  });
});

describe("undo 链 · 故障隔离", () => {
  it("should leave bytes and history untouched when the patch evaluation throws", async () => {
    await withWorkspace(async (dir) => {
      await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(ARTICLE_DOC));
      const before = await bytesOf(dir);

      const code = await codeOfAsync(() =>
        patchFile(
          {
            workspace: dir,
            file: DOC_FILE,
            request: { targetId: "nope", action: "replace", html: "<p>x</p>" },
          },
          deps,
        ),
      );

      expect(code).toBe("node_not_found");
      expect(await bytesOf(dir)).toEqual(before);
      expect(await historyNamesOf(dir, DOC_FILE)).toEqual([]);
    });
  });

  it("should leave a failed patch without consuming the undo chain", async () => {
    await withWorkspace(async (dir) => {
      await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(ARTICLE_DOC));
      await patchFile(
        { workspace: dir, file: DOC_FILE, request: { targetId: "p2", action: "delete" } },
        deps,
      );
      // 已删目标的二次 delete：必抛，且不许留快照。
      await codeOfAsync(() =>
        patchFile(
          { workspace: dir, file: DOC_FILE, request: { targetId: "p2", action: "delete" } },
          deps,
        ),
      );
      expect(await historyNamesOf(dir, DOC_FILE)).toHaveLength(1);
      await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      expect(await bytesOf(dir)).toEqual(new TextEncoder().encode(ARTICLE_DOC));
    });
  });
});

describe("undo 链 · normalize 与 style 共用同一条快照链", () => {
  it("should restore pre-normalize bytes when normalize ran with history", async () => {
    const UNNORMALIZED =
      "<!doctype html><html><body><article><p>第一段</p></article></body></html>";
    await withWorkspace(async (dir) => {
      await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(UNNORMALIZED));
      const result = await normalizeFile(
        { workspace: dir, file: DOC_FILE, write: true, history: true },
        deps,
      );

      expect(result.injected).toBeGreaterThan(0);
      await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      expect(await bytesOf(dir)).toEqual(new TextEncoder().encode(UNNORMALIZED));
    });
  });

  /** 真实 fs 的最小 StyleDeps：主题文件落在工作区自己的 styles/ 下。 */
  const styleDepsOf = async (dir: string): Promise<StyleDeps> => {
    const themeDir = join(dir, "styles", "atelier-editorial");
    await mkdirAt(themeDir);
    await writeTextAt(join(themeDir, "theme.css"), ".a{color:#000}\n");
    return { ...deps, home: dir, projectRoot: dir, stylesRoot: join(dir, "styles") };
  };

  it("should make a style apply undoable like every other write path", async () => {
    await withWorkspace(async (dir) => {
      const styleDeps = await styleDepsOf(dir);
      await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(ARTICLE_DOC));
      const before = await bytesOf(dir);

      const applied = await applyStyle(
        { workspace: dir, file: DOC_FILE, visualId: "atelier-editorial" },
        styleDeps,
      );
      expect(applied.changed).toBe(true);
      expect(sha(await bytesOf(dir))).not.toBe(sha(before));

      // 样式写与 patch 是同一条链：undo 必须退到样式写入之前，而不是报 undo_unavailable。
      await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      expect(await bytesOf(dir)).toEqual(before);
    });
  });

  it("should rewind one step not two when a style apply follows a patch", async () => {
    await withWorkspace(async (dir) => {
      const styleDeps = await styleDepsOf(dir);
      await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(ARTICLE_DOC));
      await patchFile(
        {
          workspace: dir,
          file: DOC_FILE,
          request: { targetId: "p1", action: "replace", html: "<p>改</p>" },
        },
        deps,
      );
      const afterPatch = await bytesOf(dir);
      await applyStyle(
        { workspace: dir, file: DOC_FILE, visualId: "atelier-editorial" },
        styleDeps,
      );

      // 两步写 ⇒ 一次 undo 退一步：落点必须是 patch 之后、样式之前的那份字节。
      await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      expect(await bytesOf(dir)).toEqual(afterPatch);
    });
  });
});

describe("undo 链 · revertLast 的错误码映射", () => {
  it("should map an empty chain to nothing_to_undo and leave the file alone", async () => {
    await withWorkspace(async (dir) => {
      await writeBytesAt(join(dir, DOC_FILE), new TextEncoder().encode(ARTICLE_DOC));
      const before = await bytesOf(dir);

      const code = await codeOfAsync(() => revertLast({ workspace: dir, file: DOC_FILE }, deps));

      expect(code).toBe("nothing_to_undo");
      expect(await bytesOf(dir)).toEqual(before);
    });
  });
});
