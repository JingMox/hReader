// 这层管：已知限制的"锁现状"用例。每条注释都写清：**这条锁的是当前已知限制，不是期望行为**。
// 它们的作用是让"限制被悄悄改掉"这件事显形，而不是宣布这就是契约。
//
// 它会因为什么而红：限制真的被修好了（那时应当把用例改成断言新行为，并删掉对应的 `L-` 登记）——
// 这是唯一一种"红得让人高兴"的红。

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeOf, leaveWorkspace, sessionOf, textOf, workspaceIn } from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-limits-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

describe("已知限制 · 特殊文件", () => {
  it("should answer a FIFO target with an error instead of blocking the server", async () => {
    // 限制内容：`writeFile(..., "wx")` 对**已存在**的 FIFO 直接 `EEXIST`，所以这里不会卡；
    // 但"目标是非普通文件、且尚不存在"的情形仍未被特殊处理（未登记的已知限制）。
    // 这条锁的是"至少不会把 server 挂住"——实现若改成先 open 再判类型，这里就会超时变红。
    execFileSync("mkfifo", [join(workspace, "pipe.html")]);
    const session = await sessionOf();
    const result: unknown = await session.client.callTool({
      name: "hr_create_doc",
      arguments: { filePath: "pipe.html", title: "管道" },
    });
    await session.close();

    expect(codeOf(result)).toBe("file_exists");
    expect(textOf(result)).not.toContain("EEXIST");
  }, 10_000);
});

describe("ui:// 不存在的 docId · 假成功已封", () => {
  it("should answer a missing document with a not_found JSON-RPC error", async () => {
    // 以前回一页壳（`<!doctype html>` + 空正文）：宿主看到"文档空着"而不是"这份文档不存在"，
    // 与 `unknown_style` 撒谎同类。现在走 `-32002` + `data.code`。
    const session = await sessionOf();
    const error: unknown = await session.client
      .readResource({ uri: "ui://hreader/view/ghost" })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    await session.close();

    expect(Reflect.get(Object(error), "code")).toBe(-32002);
    expect(Reflect.get(Object(Reflect.get(Object(error), "data")), "code")).toBe("not_found");
  }, 10_000);
});
