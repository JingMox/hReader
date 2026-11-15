// 这层管：daemon.json 的解析、docId 的推导规则、阅读器 URL 的拼法。
// docId 规则（AC-2 要求写进报告并回填卡内）：docId = 目标相对 `daemon.workspace` 的路径，`/` 分隔；
// 相对路径的基是 workspace（不是 Pi 的 cwd）；workspace 自身与越界路径都不算文档。

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  daemonFileOf,
  docIdOf,
  parseDaemon,
  readDaemonOf,
  readerUrlOf,
  type DaemonInfo,
} from "../pi-hreader.ts";
import { fakeDepsOf } from "./fakes.ts";

const INFO: DaemonInfo = { port: 7331, token: "tok-1", pid: 4242, workspace: "/work" };
const VALID = JSON.stringify(INFO);
const depsOf = (files: Readonly<Record<string, string>> = {}) =>
  fakeDepsOf({ home: "/home/u", files }).deps;

describe("parseDaemon", () => {
  it("合法 daemon.json 解析出四个字段", () => {
    expect(parseDaemon(VALID)).toEqual(INFO);
  });

  it("不是 JSON、或 JSON 不是对象，都当没有 daemon", () => {
    expect(parseDaemon("{ not json")).toBeUndefined();
    expect(parseDaemon("[1,2]")).toBeUndefined();
    expect(parseDaemon("null")).toBeUndefined();
  });

  it("port 不是正整数就当没有 daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, port: 0 }))).toBeUndefined();
  });

  it("pid 不是正整数就当没有 daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, pid: -1 }))).toBeUndefined();
  });

  it("token 为空串就当没有 daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, token: "" }))).toBeUndefined();
  });

  it("workspace 为空串就当没有 daemon", () => {
    expect(parseDaemon(JSON.stringify({ ...INFO, workspace: "" }))).toBeUndefined();
  });
});

describe("daemonFileOf / readDaemonOf", () => {
  it("daemon.json 在 `<home>/.hreader/` 下", () => {
    expect(daemonFileOf("/home/u")).toBe("/home/u/.hreader/daemon.json");
  });

  it("读得到就解析出记录", async () => {
    await expect(readDaemonOf(depsOf({ "/home/u/.hreader/daemon.json": VALID }))).resolves.toEqual(
      INFO,
    );
  });

  it("文件不存在或读失败一律当没有 daemon，不抛", async () => {
    await expect(readDaemonOf(depsOf({}))).resolves.toBeUndefined();
  });
});

describe("docIdOf", () => {
  it("相对路径以 daemon 的 workspace 为基", () => {
    expect(docIdOf("/work", "docs/x.html")).toEqual({ ok: true, docId: "docs/x.html" });
  });

  it("绝对路径落在 workspace 内也接受", () => {
    expect(docIdOf("/work", "/work/a/b.md")).toEqual({ ok: true, docId: "a/b.md" });
  });

  it("绝对路径里的 `.` 与 `..` 先归一化再判断", () => {
    expect(docIdOf("/work", "/work/a/./b/../c.md")).toEqual({ ok: true, docId: "a/c.md" });
  });
});

describe("docIdOf 的越界判定", () => {
  it("指向 workspace 自身不算文档", () => {
    expect(docIdOf("/work", ".")).toEqual({ ok: false, reason: "outside_workspace" });
  });

  it("父目录越界不算文档", () => {
    expect(docIdOf("/work", "..")).toEqual({ ok: false, reason: "outside_workspace" });
  });

  it("workspace 之外的兄弟目录不算文档", () => {
    expect(docIdOf("/work", "/etc/passwd")).toEqual({ ok: false, reason: "outside_workspace" });
  });

  it("workspace 尾部带 `/` 时结论不变（真 daemon.json 里很可能是这种形状）", () => {
    expect(docIdOf("/work/", "a.md")).toEqual({ ok: true, docId: "a.md" });
    expect(docIdOf("/work/", "/work/a.md")).toEqual({ ok: true, docId: "a.md" });
  });

  it("前缀相似不是子目录：`/tmp/wsfoo` 不在 `/tmp/ws` 下", () => {
    expect(docIdOf("/tmp/ws", "/tmp/wsfoo/a.md")).toEqual({
      ok: false,
      reason: "outside_workspace",
    });
    expect(docIdOf("/tmp/ws", "/tmp/wsx")).toEqual({ ok: false, reason: "outside_workspace" });
  });
});

describe("docIdOf 的前缀相似洞（真目录）", () => {
  it("`<base>/ws` 与 `<base>/wsfoo` 不是父子", async () => {
    const base = await mkdtemp(join(tmpdir(), "hr-docid-"));
    const workspace = join(base, "ws");
    const sibling = join(base, "wsfoo");
    await mkdir(workspace);
    await mkdir(sibling);
    await writeFile(join(sibling, "a.md"), "# a\n");
    expect(docIdOf(workspace, join(sibling, "a.md"))).toEqual({
      ok: false,
      reason: "outside_workspace",
    });
    await writeFile(join(workspace, "a.md"), "# a\n");
    expect(docIdOf(workspace, join(workspace, "a.md"))).toEqual({ ok: true, docId: "a.md" });
  });
});

describe("readerUrlOf", () => {
  it("URL 里的 t 就是 daemon.json 的 token（`GET /s/:docId` 是 token 认证）", () => {
    expect(readerUrlOf(INFO, "docs/x.html")).toBe("http://127.0.0.1:7331/s/docs%2Fx.html?t=tok-1");
  });

  it("docId 里的空格与 token 里的保留字符都被转义", () => {
    expect(readerUrlOf({ ...INFO, token: "a b&c" }, "带 空格.md")).toBe(
      "http://127.0.0.1:7331/s/%E5%B8%A6%20%E7%A9%BA%E6%A0%BC.md?t=a%20b%26c",
    );
  });
});
