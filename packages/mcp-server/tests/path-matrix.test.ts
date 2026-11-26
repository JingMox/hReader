// 这层管：路径边界矩阵（读、写共用一张表）。
//
// 它会因为什么而红：曾经的病根是"路径策略有两份"。表里同一条路径同时用**读**工具（`hr_outline`）
// 与**写**工具（`hr_create_doc`）过一遍，两份口径一旦分叉就有一条红；"拒了但目标已建出来"也会红——
// 那说明判定放在了 `mkdir` 之后。
//
// 每条都断言两件事：①错误码 ②盘上副作用（越界的写必须**什么都没留下**）。

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";
let outside = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-path-");
  outside = await workspaceIn("hreader-mcp-outside-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(outside);
  await leaveWorkspace(workspace);
});

const callOf = async (name: string, arguments_: Record<string, unknown>): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name, arguments: arguments_ });
  await session.close();
  return result;
};

const readOf = (filePath: string): Promise<unknown> => callOf("hr_outline", { filePath });

const createOf = (filePath: string): Promise<unknown> =>
  callOf("hr_create_doc", { filePath, title: "边界" });

const existsOf = async (path: string): Promise<boolean> =>
  readFile(path, "utf8").then(
    () => true,
    () => false,
  );

interface Row {
  readonly name: string;
  readonly path: string;
  /** 读工具该给什么反应：`ok` 这个哨兵 = 真的读到；其余是期望的错误码。 */
  readonly read: string;
  /** 写工具该给什么反应（同上）。 */
  readonly write: string;
  /** 写完之后界外那个路径必须**不存在**（越界写没落地）。 */
  readonly untouched?: "outside";
}

const ROWS: readonly Row[] = [
  {
    name: "一个指向界外的符号链接文件",
    path: "evil.html",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  {
    name: "一条指向界外的符号链接父目录",
    path: "out/x.html",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  {
    name: "名字以两个点开头的目录（界内，必须放过）",
    path: "..foo/x.html",
    read: "ok",
    write: "ok",
  },
  {
    name: "工作区自身",
    path: ".",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  {
    name: "工作区的父目录",
    path: "../",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
  },
  { name: "界内的绝对路径", path: "inside.html", read: "ok", write: "ok" },
  {
    name: "界外的绝对路径",
    path: "absolute-outside.html",
    read: "path_outside_workspace",
    write: "path_outside_workspace",
    untouched: "outside",
  },
];

/** 行的 `path` 是相对 workspace 的写法；绝对路径那两行在准备阶段被换成真绝对路径。 */
const prepareOf = async (row: Row): Promise<string> => {
  if (row.name === "一个指向界外的符号链接文件") {
    await symlink(join(outside, "secret.html"), join(workspace, "evil.html"));
  }
  if (row.name === "一条指向界外的符号链接父目录") {
    await symlink(outside, join(workspace, "out"));
  }
  if (row.name === "界内的绝对路径") return join(workspace, "inside.html");
  if (row.name === "界外的绝对路径") return join(outside, "absolute-outside.html");
  return row.path;
};

const expectReaction = (result: unknown, expected: string): void => {
  if (expected === "ok") {
    expect(isErrorResultOf(result)).toBe(false);
    return;
  }
  expect(isErrorResultOf(result)).toBe(true);
  expect(codeOf(result)).toBe(expected);
};

const absoluteOf = (path: string): string => (isAbsolute(path) ? path : join(workspace, path));

/** 读的那一半要有个真文件；写的那一半要目标不存在，所以读完再把它删掉（顺序反了会 ENOENT）。 */
const seedOf = async (row: Row, path: string): Promise<void> => {
  if (row.read !== "ok") return;
  await writeFile(absoluteOf(path), ANNOTATED_DOC, "utf8");
};

const clearOf = async (row: Row, path: string): Promise<void> => {
  if (row.write !== "ok") return;
  await rm(absoluteOf(path), { force: true });
};

describe("路径边界矩阵 · 读写同一张表", () => {
  it.each(ROWS)(
    "$name：读工具与写工具给出同一个判定",
    async (row) => {
      await writeFile(join(outside, "secret.html"), ANNOTATED_DOC, "utf8");
      await mkdir(join(workspace, "..foo"), { recursive: true });
      const path = await prepareOf(row);
      await seedOf(row, path);

      expectReaction(await callOf("hr_outline", { filePath: path }), row.read);
      await clearOf(row, path);
      // 写工具必须先判定再落盘：越界时界外目标一个字节都不许变。
      expectReaction(await createOf(path), row.write);
      if (row.untouched === "outside") {
        expect(await existsOf(join(outside, "absolute-outside.html"))).toBe(false);
      }
    },
    30_000,
  );
});

describe("路径边界矩阵 · 读不到时的归因", () => {
  // 会把 `[internal] ENOENT: no such file or directory, open '/…/typo.html'` 这种原文透给宿主：
  // 宿主只想知道"这份文档不存在"，而错误归因说错原因比缺功能更贵（本条就是它的红。
  it("should call a missing file not_found instead of leaking the raw errno", async () => {
    const result = await readOf("typo.html");
    const text = textOf(result);

    // 现在的映射是确定的（`ENOENT → not_found`）：这里锁的就是那个码，
    // 而不是"只要不是 internal 就行"——后者是上一轮的分辨力不足版。
    expect(codeOf(result)).toBe("not_found");
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain(workspace);
  });

  it("should refuse a directory target without echoing EISDIR at the host", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    const result = await readOf("sub");
    const text = textOf(result);

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("not_a_file");
    expect(text).not.toContain("EISDIR");
  });

  it("should keep the out-of-workspace verdict for a path that visibly escapes", async () => {
    const result = await readOf("../escape.html");

    expect(codeOf(result)).toBe("path_outside_workspace");
  });
});
