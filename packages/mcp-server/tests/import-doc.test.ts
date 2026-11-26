// 这层管：`hr_import_doc` 端到端（外来 → 落盘 + report 回执）与失败路径（源不存在/已托管/目标占用/越界/撞源）。

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-import-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

const callOf = async (args: Record<string, unknown>): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name: "hr_import_doc", arguments: args });
  await session.close();
  return result;
};

/** 演示稿式外来 HTML：脚本、事件属性、装饰 div、无 `<article>`。 */
const FOREIGN = [
  "<!doctype html><html><head><title>外来演示</title>",
  "<script>window.boot()</script></head>",
  "<body><nav>菜单</nav><main>",
  '<section class="slide"><h1>第一页</h1><p onclick="go()">要点</p></section>',
  '<section class="slide"><h1>第二页</h1><p>收束</p></section>',
  "</main></body></html>",
].join("");

const seedForeign = async (name = "deck.html", html = FOREIGN): Promise<void> => {
  await writeFile(join(workspace, name), html, "utf8");
};

describe("hr_import_doc · 成功", () => {
  it("should write <name>.hr.html next to the source and echo the report", async () => {
    await seedForeign();
    const result = await callOf({ filePath: "deck.html" });
    const payload = payloadOf(result);

    expect(isErrorResultOf(result)).toBe(false);
    expect(payload["path"]).toBe("deck.hr.html");
    const report = payload["report"] as Record<string, unknown>;
    expect(report["kind"]).toBe("note");
    expect(report["trunk"]).toBe("main");
    expect(report["sections"]).toBe(2);
    const written = await readFile(join(workspace, "deck.hr.html"), "utf8");
    expect(written).toContain('data-hr-id="root" data-hr-kind="note"');
    expect(written).not.toContain("<script");
  });

  it("should honor kind, title and an explicit outPath", async () => {
    await seedForeign();
    const result = await callOf({
      filePath: "deck.html",
      kind: "slides",
      title: "季度复盘",
      outPath: "out/deck-managed.html",
    });
    const payload = payloadOf(result);

    expect(payload["path"]).toBe("out/deck-managed.html");
    expect((payload["report"] as Record<string, unknown>)["kind"]).toBe("slides");
    expect((payload["report"] as Record<string, unknown>)["title"]).toBe("季度复盘");
    const written = await readFile(join(workspace, "out", "deck-managed.html"), "utf8");
    expect(written).toContain('data-hr-kind="slides"');
  });
});

describe("hr_import_doc · 失败路径", () => {
  it("should report not_found for a missing source", async () => {
    const result = await callOf({ filePath: "ghost.html" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("not_found");
  });

  it("should refuse an already-managed source", async () => {
    await seedForeign(
      "managed.html",
      '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2></article>',
    );
    const result = await callOf({ filePath: "managed.html" });

    expect(codeOf(result)).toBe("invalid_input");
  });

  it("should report file_exists when the target is taken", async () => {
    await seedForeign();
    await writeFile(join(workspace, "deck.hr.html"), "已占用");
    const result = await callOf({ filePath: "deck.html" });

    expect(codeOf(result)).toBe("file_exists");
    expect(await readFile(join(workspace, "deck.hr.html"), "utf8")).toBe("已占用");
  });

  it("should refuse outPath pointing back at the source", async () => {
    await seedForeign();
    const result = await callOf({ filePath: "deck.html", outPath: "deck.html" });

    expect(codeOf(result)).toBe("invalid_input");
  });

  it("should refuse outPath escaping the workspace", async () => {
    await seedForeign();
    const result = await callOf({ filePath: "deck.html", outPath: "../escape.html" });

    expect(codeOf(result)).toBe("path_outside_workspace");
  });

  it("should refuse a source escaping the workspace", async () => {
    const result = await callOf({ filePath: "../outside.html" });

    expect(codeOf(result)).toBe("path_outside_workspace");
  });

  it("should fold a non-EEXIST write failure into io_failure", async () => {
    await seedForeign();
    // 目标路径的中间段已是一个文件：`mkdir` 撞上 ENOTDIR。
    await writeFile(join(workspace, "blocked"), "file");
    const result = await callOf({ filePath: "deck.html", outPath: "blocked/deck.hr.html" });

    expect(codeOf(result)).toBe("io_failure");
  });

  it("should fold a non-EEXIST writeFile failure via writeFailureOf", async () => {
    await seedForeign();
    // 父目录存在但不可写：`mkdir` 过、`writeFile` 抛 EACCES——不是 EEXIST，走 writeFailureOf。
    const locked = join(workspace, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o500);
    try {
      const result = await callOf({ filePath: "deck.html", outPath: "locked/deck.hr.html" });
      expect(codeOf(result)).toBe("io_failure");
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
