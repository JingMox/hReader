// This layer covers `applyBlockPatch` (the pure byte splice: byte-precision, sanitizer
// refusals, warnings, returned address) plus `patchBlock`'s IO contract (locked write,
// snapshot, undo, resolveTarget refusals).

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, undoPatch } from "../src/io";
import { applyBlockPatch, listBlocks } from "../src/ops/block-address";
import { patchBlock } from "../src/ops/patch-block";
import {
  codeOf,
  codeOfAsync,
  mkdirAt,
  readTextAt,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "./io/harness";
import { readBytesAt, historyNamesOf } from "./io/harness";

const DOC = "<article><h1>T</h1><p>one</p><div><p>two</p></div><p>three</p></article>";

const addressAt = (html: string, index: number): string => {
  const block = listBlocks(html)[index];
  if (block === undefined) throw new Error("test fixture: no such block");
  return block.address;
};

/** Assert that only `[from, to)` changed between `before` and `after`. */
const expectOutsideUnchanged = (before: string, after: string, from: number, to: number): void => {
  expect(after.slice(0, from)).toBe(before.slice(0, from));
  const tailBefore = before.slice(to);
  expect(after.endsWith(tailBefore)).toBe(true);
};

describe("applyBlockPatch · byte precision", () => {
  it("should replace only the block's outerHTML range", () => {
    const html = `A${DOC}Z`;
    const [block] = listBlocks(html);
    const outcome = applyBlockPatch(html, {
      address: addressAt(html, 1),
      action: "replace",
      html: "<p>ONE</p>",
    });
    const target = listBlocks(html)[1];
    expect(target).toBeDefined();
    if (target === undefined) return;
    expectOutsideUnchanged(html, outcome.html, target.start, target.end);
    expect(outcome.html.slice(target.start)).toBe(
      `<p>ONE</p><div><p>two</p></div><p>three</p></article>Z`,
    );
    expect(block).toBeDefined();
  });

  it("should patch a <p> inside <noscript> byte-precisely (scripting-off tree)", () => {
    // Scripting off keeps <noscript> children as markup with real source offsets; the
    // scripting-on annotation tree (D54) would read them as raw text and lose the range.
    const html = "<article><noscript><p>x</p></noscript>tail</article>";
    const [block] = listBlocks(html);
    const outcome = applyBlockPatch(html, {
      address: block?.address ?? "",
      action: "replace",
      html: "<p>y</p>",
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.html).toBe("<article><noscript><p>y</p></noscript>tail</article>");
  });

  it("should mark an equivalent replacement as changed:false with the same address", () => {
    const outcome = applyBlockPatch(DOC, {
      address: addressAt(DOC, 1),
      action: "replace",
      html: "<p>one</p>",
    });
    expect(outcome.changed).toBe(false);
    expect(outcome.html).toBe(DOC);
    expect(outcome.address).toBe(addressAt(DOC, 1));
    expect(outcome.newIds).toEqual([]);
    expect(outcome.replacedIds).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  it("should splice insertBefore at the block's start offset", () => {
    const target = listBlocks(DOC)[1];
    if (target === undefined) throw new Error("fixture");
    const outcome = applyBlockPatch(DOC, {
      address: target.address,
      action: "insertBefore",
      html: "<blockquote>q</blockquote>",
    });
    expect(outcome.html).toBe(
      DOC.slice(0, target.start) + "<blockquote>q</blockquote>" + DOC.slice(target.start),
    );
    expect(outcome.changed).toBe(true);
    // The returned address is the inserted block's — it must resolve on the written bytes.
    expect(outcome.address).toContain("css:body > article > blockquote@");
    expect(outcome.newIds).toEqual([]);
    expect(outcome.replacedIds).toEqual([]);
    expect(
      outcome.html.slice(target.start, target.start + "<blockquote>q</blockquote>".length),
    ).toBe("<blockquote>q</blockquote>");
  });

  it("should splice insertAfter at the block's end offset", () => {
    const target = listBlocks(DOC)[1];
    if (target === undefined) throw new Error("fixture");
    const outcome = applyBlockPatch(DOC, {
      address: target.address,
      action: "insertAfter",
      html: "<p>after</p>",
    });
    expect(outcome.html).toBe(DOC.slice(0, target.end) + "<p>after</p>" + DOC.slice(target.end));
    expect(outcome.address).toContain("css:body > article > p:nth-of-type(2)@");
  });

  it("should delete exactly the block's outerHTML range", () => {
    const target = listBlocks(DOC)[1];
    if (target === undefined) throw new Error("fixture");
    const outcome = applyBlockPatch(DOC, { address: target.address, action: "delete" });
    expect(outcome.html).toBe(DOC.slice(0, target.start) + DOC.slice(target.end));
    expect(outcome.changed).toBe(true);
    expect(outcome.address).toBeUndefined();
    expect(outcome.newIds).toEqual([]);
    expect(outcome.replacedIds).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  it("should return the inner block's address when the replacement wraps a leaf", () => {
    const outcome = applyBlockPatch(DOC, {
      address: addressAt(DOC, 1),
      action: "replace",
      html: "<div><p>nested</p></div>",
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.address).toContain("css:body > article > div > p@");
  });

  it("should return no address when the written fragment holds no block", () => {
    const outcome = applyBlockPatch(DOC, {
      address: addressAt(DOC, 1),
      action: "insertAfter",
      html: "<span>inline</span>",
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.address).toBeUndefined();
  });
});

describe("applyBlockPatch · request validation", () => {
  const address = addressAt(DOC, 1);

  it("should reject an unknown action even when html is present", () => {
    // With html supplied, a smuggled action would pass the missing-html check and splice
    // bytes — the action gate itself must be the wall.
    expect(
      codeOf(() => applyBlockPatch(DOC, { address, action: "append" as never, html: "<p>x</p>" })),
    ).toBe("invalid_input");
  });

  it("should reject delete carrying html", () => {
    expect(
      codeOf(() => applyBlockPatch(DOC, { address, action: "delete", html: "<p>x</p>" })),
    ).toBe("invalid_input");
  });

  it("should reject a content action missing html", () => {
    expect(codeOf(() => applyBlockPatch(DOC, { address, action: "replace" }))).toBe(
      "invalid_input",
    );
  });

  it("should report a malformed address as invalid_selector", () => {
    const code = (() => {
      try {
        applyBlockPatch(DOC, { address: "css:body > p", action: "delete" });
        return "no_throw";
      } catch (error) {
        return Reflect.get(Object(error), "code") as string;
      }
    })();
    expect(code).toBe("invalid_selector");
  });

  it("should mark a malformed address with data.reason syntax", () => {
    // `data.reason` is the machine-readable half of the refusal — `patch-node`'s
    // syntax/semantic split rides on it.
    const data = (() => {
      try {
        applyBlockPatch(DOC, { address: "css:body > p", action: "delete" });
        return {};
      } catch (error) {
        return Reflect.get(Object(error), "data") as unknown;
      }
    })();
    expect(data).toEqual({ reason: "syntax" });
  });

  it("should report a stale address as target_moved", () => {
    const code = (() => {
      try {
        applyBlockPatch("<p>edited</p>", { address, action: "delete" });
        return "no_throw";
      } catch (error) {
        return Reflect.get(Object(error), "code") as string;
      }
    })();
    expect(code).toBe("target_moved");
  });
});

describe("applyBlockPatch · fragment sanitizer (same rules as managed patches)", () => {
  const address = addressAt(DOC, 1);
  const patch = (html: string): string => {
    try {
      applyBlockPatch(DOC, { address, action: "replace", html });
      return "no_throw";
    } catch (error) {
      return String(Reflect.get(Object(error), "code") ?? "no_code");
    }
  };

  it("should refuse <script> in the fragment", () => {
    expect(patch("<div><script>alert(1)</script></div>")).toBe("forbidden_content");
  });

  it("should refuse inline event handlers", () => {
    expect(patch('<p onerror="x()">hi</p>')).toBe("forbidden_content");
    expect(patch('<p onclick="x()">hi</p>')).toBe("forbidden_content");
  });

  it("should refuse javascript: URLs", () => {
    expect(patch('<p><a href="javascript:x()">l</a></p>')).toBe("forbidden_content");
  });

  it("should refuse iframe srcdoc", () => {
    expect(patch('<div><iframe srcdoc="<p>x</p>"></iframe></div>')).toBe("forbidden_content");
  });

  it("should surface fragment diagnostics as warnings", () => {
    const outcome = applyBlockPatch(DOC, {
      address,
      action: "replace",
      html: '<p class="a" class="b">x</p>',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.warnings.some((w) => w.code === "duplicate_attribute")).toBe(true);
  });

  it("should warn on fragment data-hr-id and never let ids into the output", () => {
    // The fragment pipeline strips `data-hr-id` (ids are hReader's, not the user's file's)
    // and reports `fragment_ids_ignored`; no new ids are ever injected for foreign docs.
    const outcome = applyBlockPatch(DOC, {
      address,
      action: "replace",
      html: '<p data-hr-id="foreign">x</p>',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.warnings.some((w) => w.code === "fragment_ids_ignored")).toBe(true);
    expect(outcome.newIds).toEqual([]);
    expect(outcome.html).not.toContain("data-hr-id");
  });

  it("should reject a fragment that cannot live under the block's parent", () => {
    // <td> can only live inside table structure; inserting it under <article> reparses wrong.
    const code = (() => {
      try {
        applyBlockPatch(DOC, { address, action: "insertAfter", html: "<td>x</td>" });
        return "no_throw";
      } catch (error) {
        return String(Reflect.get(Object(error), "code") ?? "no_code");
      }
    })();
    expect(code).toBe("content_model_conflict");
  });

  it("should refuse a path that lands on a non-block element", () => {
    const doc = "<div><em>x</em><p>y</p></div>";
    const code = (() => {
      try {
        applyBlockPatch(doc, { address: "css:body > div > em@deadbeef", action: "delete" });
        return "no_throw";
      } catch (error) {
        return String(Reflect.get(Object(error), "code") ?? "no_code");
      }
    })();
    expect(code).toBe("target_moved");
  });
});

describe("patchBlock · IO contract", () => {
  const FILE = "post.html";
  const deps = nodePatchDeps;

  it("should write only the block's bytes, snapshot history and report the new address", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, DOC);
      const before = await readTextAt(file);
      const address = addressAt(before, 1);

      const result = await patchBlock(
        { workspace: dir, file: FILE, address, action: "replace", html: "<p>ONE</p>" },
        deps,
      );

      expect(result.changed).toBe(true);
      expect(result.undoable).toBe(true);
      expect(result.historyPath).not.toBeNull();
      expect(result.address).toMatch(/^css:body > article > p@[0-9a-f]{8}$/u);
      expect(result.newIds).toEqual([]);
      const after = await readTextAt(file);
      expect(after).toContain("<p>ONE</p>");
      expect(after.indexOf("<p>ONE</p>")).toBe(before.indexOf("<p>one</p>"));
      expect(await historyNamesOf(dir, FILE)).toHaveLength(1);
    });
  });

  it("should restore the exact bytes on undo", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, `\uFEFF${DOC}\r\n`);
      const before = await readBytesAt(file);
      await patchBlock(
        { workspace: dir, file: FILE, address: addressAt(DOC, 1), action: "delete" },
        deps,
      );
      const undone = await undoPatch({ workspace: dir, file: FILE }, deps);
      expect(undone.sha256).toBe(sha256Of(before));
      expect(Array.from(await readBytesAt(file))).toEqual(Array.from(before));
    });
  });

  it("should not write or snapshot when nothing changed", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, DOC);
      const result = await patchBlock(
        {
          workspace: dir,
          file: FILE,
          address: addressAt(DOC, 1),
          action: "replace",
          html: "<p>one</p>",
        },
        deps,
      );
      expect(result.changed).toBe(false);
      expect(result.historyPath).toBeNull();
      expect(result.undoable).toBe(false);
      expect(await historyNamesOf(dir, FILE)).toHaveLength(0);
    });
  });

  it("should refuse a target outside the workspace", async () => {
    await withWorkspace(async (dir) => {
      const code = await codeOfAsync(() =>
        patchBlock(
          {
            workspace: dir,
            file: "../outside.html",
            address: addressAt(DOC, 1),
            action: "delete",
          },
          deps,
        ),
      );
      expect(code).toBe("path_outside_workspace");
    });
  });

  it("should refuse a target inside .hreader/", async () => {
    await withWorkspace(async (dir) => {
      await mkdirAt(join(dir, ".hreader"));
      await writeTextAt(join(dir, ".hreader", "state.html"), DOC);
      const code = await codeOfAsync(() =>
        patchBlock(
          {
            workspace: dir,
            file: ".hreader/state.html",
            address: addressAt(DOC, 1),
            action: "delete",
          },
          deps,
        ),
      );
      expect(code).toBe("path_outside_workspace");
    });
  });

  it("should refuse a stale address without touching the file", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, DOC);
      const before = await readBytesAt(file);
      const code = await codeOfAsync(() =>
        patchBlock(
          {
            workspace: dir,
            file: FILE,
            address: "css:body > article > p@00000000",
            action: "delete",
          },
          deps,
        ),
      );
      expect(code).toBe("target_moved");
      expect(await readBytesAt(file)).toEqual(before);
      expect(await historyNamesOf(dir, FILE)).toHaveLength(0);
    });
  });

  it("should still work on a managed document without touching data-hr-id", async () => {
    const managed = '<article data-hr-id="root"><p data-hr-id="p1">one</p><p>two</p></article>';
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, managed);
      const address = addressAt(managed, 1);
      const result = await patchBlock(
        { workspace: dir, file: FILE, address, action: "replace", html: "<p>TWO</p>" },
        deps,
      );
      expect(result.changed).toBe(true);
      const after = await readTextAt(file);
      expect(after).toContain('data-hr-id="p1"');
      expect(after).toContain("data-hr-id");
      expect(after).toContain("<p>TWO</p>");
    });
  });
});
