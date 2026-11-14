// 这层管：`parseArgs` 对 serve 的四个边界（默认值、--allow-host 列表、坏端口、缺失位置参数）。

import { describe, it, expect } from "vitest";

import { expectFailure, parse } from "./args-helpers";

describe("parseArgs · serve 的默认值与 --allow-host", () => {
  it("should default port 0, cwd workspace and no allowHosts", () => {
    expect(parse(["serve", "doc.html"])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        path: "/repo/doc.html",
        port: 0,
        json: false,
        workspace: "/repo",
        appDir: undefined,
        appDirGiven: false,
      },
    });
  });
});

describe("parseArgs · serve 的 --app-dir", () => {
  it("should resolve an explicit --app-dir against cwd and mark appDirGiven", () => {
    expect(parse(["serve", "doc.html", "--app-dir", "ui/dist"])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        path: "/repo/doc.html",
        port: 0,
        json: false,
        workspace: "/repo",
        appDir: "/repo/ui/dist",
        appDirGiven: true,
      },
    });
  });
});

describe("parseArgs · serve 的 --allow-host 列表", () => {
  it("should split, trim and drop blank --allow-host entries", () => {
    expect(parse(["serve", "doc.html", "--allow-host", " a.example , ,b.example "])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        path: "/repo/doc.html",
        port: 0,
        json: false,
        workspace: "/repo",
        appDir: undefined,
        appDirGiven: false,
        allowHosts: ["a.example", "b.example"],
      },
    });
    expect(parse(["serve", "doc.html", "--allow-host", " , "])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        path: "/repo/doc.html",
        port: 0,
        json: false,
        workspace: "/repo",
        appDir: undefined,
        appDirGiven: false,
      },
    });
  });
});

describe("parseArgs · serve 的坏参数", () => {
  it("should reject a bad --port and any extra positional", () => {
    expectFailure(
      ["serve", "doc.html", "--port", "70000"],
      "--port 必须是 0..65535 的整数",
      "serve",
    );
    expectFailure(["serve", "doc.html", "x.html"], "serve 只接受 1 个位置参数，多出 1 个", "serve");
  });

  it("should require the file and name the first flag serve does not own", () => {
    expect(parse(["serve"])).toEqual({ ok: false, message: "serve 缺少 <file>", topic: "serve" });
    expect(parse(["serve", "doc.html", "--lint"])).toEqual({
      ok: false,
      message: "--lint",
      topic: "serve",
    });
  });
});
