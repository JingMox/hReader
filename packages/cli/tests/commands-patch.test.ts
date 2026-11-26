// 这层管：`patch` 命令的人读行与失败面（真 fs + 真 core，不跑子进程）；不碰别的命令。

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

describe("patchCommand · 人读行", () => {
  it("should print the new ids on a plain append (no id change to report)", async () => {
    fileOf("p6.html", DOC);
    const text = await patchCommand({
      path: "p6.html",
      // 目标是容器 <article>：段落落在它的内容模型内（往 <p> 里 append 段落会被拒）。
      nodeId: "hr-a",
      action: "append",
      html: "<p>新</p>",
      workspace: dir,
      json: false,
    });

    // append 不换 id：新 id 只能挂在 `ids:` 后面，否则用户拿不到刚插进去那块。
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

    // 删除既不加新 id 也不换 id：行尾必须是干净的 `+0)`，不能拖一个空的 `ids: `。
    expect(text).toMatch(/^patched .*p8\.html \(\d+ bytes, \+0\)\n$/u);
  });
});

describe("patchCommand · replace 的人读行（id 不再变）", () => {
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

    // 新根继承 `hr-c`（不算新分配），片段里更深的三个块才是新 id——它们同样要能被后续 patch 引用。
    expect(text).toMatch(/^patched .*p7\.html \(\d+ bytes, \+3 ids: [\w-]+, [\w-]+, [\w-]+\)\n$/u);
    expect(text).not.toContain("id 变更");
    expect(readFileSync(join(dir, "p7.html"), "utf8")).toContain('<section data-hr-id="hr-c">');
  });
});

describe("patchCommand · 失败面", () => {
  it("should leave the workspace check to core for a path outside the workspace", async () => {
    fileOf("p5.html", DOC);

    // 入口的前置判定不能自己先报 `not_a_file`：路径根本没落在 workspace 里，得报 `path_outside_workspace`。
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
