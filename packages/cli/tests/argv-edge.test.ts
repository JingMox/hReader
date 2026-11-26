// 这层管：argv 词法的对抗面——重复旗标、`=值` 与空格取值、`--` 终止、
// 短选项、布尔带值、以 `-` 开头的文件名、unicode 路径。全部钉纯函数契约，不起子进程。

import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

describe("argv · 重复旗标（后值赢）", () => {
  it("should let the last occurrence win for string flags", () => {
    expect(parse(["import", "a.html", "--kind", "report", "--kind", "brief"])).toMatchObject({
      ok: true,
      intent: { docKind: "brief" },
    });
    expect(parse(["export", "a.html", "--out", "one.html", "--out", "two.html"])).toMatchObject({
      ok: true,
      intent: { out: `${CWD}/two.html` },
    });
  });

  it("should let the last --visual win too", () => {
    expect(
      parse(["export", "a.html", "--visual", "deck-noir", "--visual", "atelier-editorial"]),
    ).toMatchObject({ ok: true, intent: { visual: "atelier-editorial" } });
  });
});

describe("argv · `--flag=value` 与 `--flag value` 同义", () => {
  it("should treat the inline form identically", () => {
    expect(parse(["import", "a.html", "--kind=slides"])).toMatchObject({
      ok: true,
      intent: { docKind: "slides" },
    });
    expect(parse(["read", "a.html", "x", "--max-bytes=42"])).toMatchObject({
      ok: true,
      intent: { maxBytes: 42 },
    });
  });
});

describe("argv · 布尔旗标带值即用法错误", () => {
  it.each([
    ["--force=true", "参数 --force 不接受取值"],
    ["--json=1", "参数 --json 不接受取值"],
    ["--outline=false", "参数 --outline 不接受取值"],
    ["--no-outline=x", "参数 --no-outline 不接受取值"],
  ])("should reject %s", (flag, message) => {
    expectFailure(["export", "a.html", flag], message, undefined);
  });

  it("should accept --strict=<tier> as the only boolean-with-value flag", () => {
    expect(parse(["check", "a.html", "--strict=error"])).toMatchObject({
      ok: true,
      intent: { strict: "error" },
    });
    expect(parse(["check", "a.html", "--strict=warning"])).toMatchObject({
      ok: true,
      intent: { strict: "warning" },
    });
    expect(parse(["check", "a.html", "--strict"])).toMatchObject({
      ok: true,
      intent: { strict: "error" },
    });
  });

  it("should reject other --strict values by name", () => {
    expectFailure(
      ["check", "a.html", "--strict=false"],
      "未知的 --strict：false（可选：error | warning）",
      "check",
    );
    expectFailure(
      ["check", "a.html", "--strict=bogus"],
      "未知的 --strict：bogus（可选：error | warning）",
      "check",
    );
  });

  it("should treat `--strict warning` as an extra positional (boolean flags take no separated value)", () => {
    expectFailure(
      ["check", "a.html", "--strict", "warning"],
      "check 只接受 1 个位置参数，多出 1 个",
      "check",
    );
  });
});

describe("argv · `--` 终止与短选项", () => {
  it("should let a dash-leading filename through after --", () => {
    expect(parse(["outline", "--", "-weird.html"])).toEqual({
      ok: true,
      intent: {
        kind: "outline",
        path: `${CWD}/-weird.html`,
        json: false,
        workspace: CWD,
      },
    });
  });

  it("should reject a dash-leading filename without -- as an unknown option", () => {
    expectFailure(["outline", "-weird.html"], "未知参数：-w", undefined);
  });

  it("should reject merged short options", () => {
    expectFailure(["outline", "-abc"], "未知参数：-a", undefined);
  });

  it("should eat a flag-looking token as a string flag's value (documented quirk)", () => {
    // strict:false 的词法行为：string 旗标把下一个 token 当值吃掉——`--kind --force`
    // 不是"缺取值"，而是"--kind 的值是 --force"，再被枚举校验打回。
    expectFailure(
      ["import", "a.html", "--kind", "--force"],
      "未知的 --kind：--force（可选：note | report | minutes | brief | slides）",
      "import",
    );
  });
});

describe("argv · 边界取值", () => {
  it("should resolve an empty --workspace to cwd (quirk, pinned)", () => {
    expect(parse(["outline", "a.html", "--workspace="])).toMatchObject({
      ok: true,
      intent: { workspace: CWD },
    });
    expect(parse(["outline", "a.html", "--workspace", ""])).toMatchObject({
      ok: true,
      intent: { workspace: CWD },
    });
  });

  it("should treat `--html=` as an empty inline fragment (command layer rejects it)", () => {
    expect(parse(["patch", "a.html", "x", "--action", "replace", "--html="])).toMatchObject({
      ok: true,
      intent: { html: { kind: "inline", text: "" } },
    });
  });

  it("should carry unicode filenames through unchanged", () => {
    expect(parse(["outline", "目录/文档 🚀.html"])).toMatchObject({
      ok: true,
      intent: { path: `${CWD}/目录/文档 🚀.html` },
    });
  });
});
