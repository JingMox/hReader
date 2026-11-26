// 这层管：`parseArgs` 的 normalize 子表（argv → normalize Intent / 用法错误）；不跑子进程、不碰 fs。

import { describe, expect, it } from "vitest";

import { expectFailure, parse } from "./args-helpers";

describe("parseArgs · normalize（只补 id）", () => {
  it("should parse the file plus --write into a normalize intent", () => {
    expect(parse(["normalize", "a.html", "--write", "--workspace", "w"])).toEqual({
      ok: true,
      intent: {
        kind: "normalize",
        path: "/repo/a.html",
        write: true,
        json: false,
        workspace: "/repo/w",
      },
    });
  });

  it("should default --write to false (不给就只打 stdout，一个字节都不落盘)", () => {
    expect(parse(["normalize", "a.html"])).toMatchObject({ ok: true, intent: { write: false } });
  });

  it("should reject a second positional and name the count", () => {
    expectFailure(
      ["normalize", "a.html", "b.html"],
      "normalize 只接受 1 个位置参数，多出 1 个",
      "normalize",
    );
  });

  it("should reject a missing <file>", () => {
    expectFailure(["normalize"], "normalize 缺少 <file>", "normalize");
  });

  it("should reject a flag normalize cannot honour (--out belongs to export)", () => {
    const parsed = parse(["normalize", "a.html", "--out", "x.html"]);

    expect(parsed).toMatchObject({ ok: false, topic: "normalize" });
    // 报文必须点名那个多余的旗标：只说“参数不对”会让用户挨个试。
    expect(String(Reflect.get(Object(parsed), "message"))).toContain("--out");
  });
});
