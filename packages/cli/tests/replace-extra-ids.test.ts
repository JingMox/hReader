// When `replace`'s fragment carries its own `data-hr-id`, that is a "fragment id ignored", reported as
// `replacedIds: [{from: the fragment's id, to: the inherited target id}]`; other addressable nodes **inside**
// the fragment are reassigned by the product and land in `newIds`. Both happen at once, so the human receipt
// must print both hints — printing only "id change" hides two ids appearing from nowhere; printing only "+N ids" hides that the anchor was swapped.
//
// This layer covers the CLI write + human output; `replacedIds` semantics itself lives in `patch-id-inherit.test.ts`.

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

/** The fragment holds **no** addressable node besides its own `data-hr-id` (`newIds` therefore empty). */
const TEXT_ONLY_FRAGMENT = '<div data-hr-id="hr-zz">纯文本</div>';

const idsIn = (html: string): readonly string[] =>
  [...html.matchAll(/data-hr-id="([^"]*)"/gu)].map((match) => String(match[1]));

describe("patch · a fragment with an id that also allocates new ids inside", () => {
  it("should print both the id mapping and the extra new ids in the human receipt", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", DOC);

      const result = checked(
        await runCli(["patch", "a.html", TARGET_ID, "--action", "replace", "--html", FRAGMENT], {
          cwd: dir,
        }),
      );
      expect(result.code).toBe(0);

      // Both hints live in one receipt: first the "fragment id → target id" mapping, then the two new ids allocated inside the fragment.
      const [receipt] = result.stdout.split("\n");
      expect(receipt).toMatch(
        new RegExp(
          `^patched a\\.html \\(\\d+ bytes, id 变更: ${FRAGMENT_ID} → ${TARGET_ID}, \\+2 ids: hr-[0-9a-f]{8}, hr-[0-9a-f]{8}\\)$`,
          "u",
        ),
      );
      // The mapping comes from one "fragment id ignored": the warning carries the fragment's original id so the user can reconcile it.
      expect(result.stdout).toContain(
        `fragment_ids_ignored — 片段里的 data-hr-id="${FRAGMENT_ID}" 已忽略`,
      );

      // The on-disk result is this receipt's ground truth: target id kept, the fragment's own id absent, the two inner segments each get a new id.
      const html = readFileSync(`${dir}/a.html`, "utf8");
      expect(idsIn(html)).toContain(TARGET_ID);
      expect(idsIn(html)).not.toContain(FRAGMENT_ID);
      expect(idsIn(html).filter((id) => id === TARGET_ID)).toHaveLength(1);
      // `<article>` + `<h2>` + target `<div>` + two inner `<p>`s: 5 ids, pairwise distinct.
      expect(idsIn(html)).toHaveLength(5);
      expect(new Set(idsIn(html)).size).toBe(5);
    });
  });
});

describe("patch · a fragment without inner nodes", () => {
  it("should not print an empty '+0 ids' tail when the fragment brings no inner ids", async () => {
    // humanPatch's other half: when `newIds` is entirely consumed by the mapping, that extra hint must vanish whole —
    // a leftover ", +0 ids: " would make the user think something was lost.
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
      // On disk: target id kept, the fragment's own id never enters the doc, and nothing inside carries anyone else's id.
      const html = readFileSync(`${dir}/a.html`, "utf8");
      expect(idsIn(html)).toContain(TARGET_ID);
      expect(idsIn(html)).not.toContain(FRAGMENT_ID);
    });
  });
});
