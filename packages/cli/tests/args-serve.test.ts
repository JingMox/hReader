// This layer covers the four `parseArgs` boundaries for serve (defaults, --allow-host list, bad port, missing positional).

import { describe, it, expect } from "vitest";

import { expectFailure, parse } from "./args-helpers";

describe("parseArgs · serve defaults and --allow-host", () => {
  it("should default port 0, cwd workspace and no allowHosts", () => {
    expect(parse(["serve", "doc.html"])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        exitWithParent: false,
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

describe("parseArgs · serve --app-dir", () => {
  it("should resolve an explicit --app-dir against cwd and mark appDirGiven", () => {
    expect(parse(["serve", "doc.html", "--app-dir", "ui/dist"])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        exitWithParent: false,
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

describe("parseArgs · serve --allow-host list", () => {
  it("should split, trim and drop blank --allow-host entries", () => {
    expect(parse(["serve", "doc.html", "--allow-host", " a.example , ,b.example "])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        exitWithParent: false,
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
        exitWithParent: false,
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

describe("parseArgs · serve --home", () => {
  it("should resolve an explicit --home against cwd and reject nothing else", () => {
    expect(parse(["serve", "doc.html", "--home", "state"])).toEqual({
      ok: true,
      intent: {
        kind: "serve",
        exitWithParent: false,
        path: "/repo/doc.html",
        port: 0,
        json: false,
        workspace: "/repo",
        appDir: undefined,
        appDirGiven: false,
        home: "/repo/state",
      },
    });
  });
});

describe("parseArgs · serve bad arguments", () => {
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
