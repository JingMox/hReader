// This layer covers the `patch` command's human lines and failure surface (real fs + real core, no subprocess); no other commands.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { patchCommand } from "../src/commands/patch";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-cmd-patch-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DOC = [
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p><p data-hr-id="hr-d">正文二</p></article>',
].join("\n");

const fileOf = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

describe("patchCommand · human lines", () => {
  it("should print the new ids on a plain append (no id change to report)", async () => {
    fileOf("p6.html", DOC);
    const text = await patchCommand({
      path: "p6.html",
      // The target is the container <article>: a paragraph falls inside its content model (appending one to <p> is refused).
      nodeId: "hr-a",
      action: "append",
      html: "<p>新</p>",
      workspace: dir,
      json: false,
    });

    // append does not re-id: new ids may only hang after `ids:`, otherwise the user cannot reach the block just inserted.
    expect(text).toMatch(/^patched .*p6\.html \(\d+ bytes, \+1 ids: [\w-]+\)\n$/u);
  });

  it("should print the patched line with no id list at all when nothing new is introduced", async () => {
    fileOf("p8.html", DOC);
    const text = await patchCommand({
      path: "p8.html",
      nodeId: "hr-c",
      action: "delete",
      html: undefined,
      workspace: dir,
      json: false,
    });

    // delete neither adds nor reassigns ids: the line tail must be a clean `+0)`, not a trailing empty `ids: `.
    expect(text).toMatch(/^patched .*p8\.html \(\d+ bytes, \+0\)\n$/u);
  });
});

describe("patchCommand · human lines for replace (ids no longer change)", () => {
  it("should keep the target id and print only the deeper new ids when replace adds nested blocks", async () => {
    fileOf("p7.html", DOC);
    const text = await patchCommand({
      path: "p7.html",
      nodeId: "hr-c",
      action: "replace",
      html: "<section><p>外层</p><p>一个</p><p>两个</p></section>",
      workspace: dir,
      json: false,
    });

    // The new root inherits `hr-c` (not a new allocation); the three deeper blocks in the fragment are the new ids — they too must be addressable by later patches.
    expect(text).toMatch(/^patched .*p7\.html \(\d+ bytes, \+3 ids: [\w-]+, [\w-]+, [\w-]+\)\n$/u);
    expect(text).not.toContain("id 变更");
    expect(readFileSync(join(dir, "p7.html"), "utf8")).toContain('<section data-hr-id="hr-c">');
  });
});

describe("patchCommand · failure surface", () => {
  it("should leave the workspace check to core for a path outside the workspace", async () => {
    fileOf("p5.html", DOC);

    // The entry's pre-check must not jump to `not_a_file` itself: the path never lands inside the workspace, so it must be `path_outside_workspace`.
    await expect(
      patchCommand({
        path: "../escape.html",
        nodeId: "hr-d",
        action: "append",
        html: "<p>新</p>",
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "path_outside_workspace" });
  });

  it("should reject an unknown node id (node_not_found)", async () => {
    fileOf("p3.html", DOC);
    await expect(
      patchCommand({
        path: "p3.html",
        nodeId: "hr-nope",
        action: "delete",
        html: undefined,
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "node_not_found" });
  });
});
