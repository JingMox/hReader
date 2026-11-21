// 这层管：`parseArgs` 的纯函数表（argv → Intent / 用法错误）；不跑子进程、不碰 fs。

import { describe, expect, it } from "vitest";

import { COMMAND_LIST_HINT, CWD, expectFailure, parse } from "./args-helpers";

describe("parseArgs · 顶层", () => {
  it("should reject an empty argv with the command list", () => {
    expectFailure([], COMMAND_LIST_HINT, undefined);
  });

  it("should not echo --json back in an args failure (run.ts owns that)", () => {
    expectFailure(["--json"], COMMAND_LIST_HINT, undefined);
  });

  it("should reject an unknown command", () => {
    expectFailure(["nope"], "未知命令：nope", undefined);
    expectFailure(["--json", "nope"], "未知命令：nope", undefined);
  });

  it("should reject an unknown flag before any command runs", () => {
    expectFailure(["--bad"], "未知参数：--bad", undefined);
    expectFailure(["--json", "--bad"], "未知参数：--bad", undefined);
  });

  it("should reject a value flag that has no value", () => {
    expectFailure(["--workspace"], "参数 --workspace 缺少取值", undefined);
    expectFailure(
      ["outline", "a.html", "--json", "--workspace"],
      "参数 --workspace 缺少取值",
      undefined,
    );
  });

  it("should pair flags and positionals in any order (value flags eat the next token)", () => {
    const parsed = parse(["--json", "outline", "a.html", "--workspace", "w"]);

    expect(parsed).toEqual({
      ok: true,
      intent: { kind: "outline", path: "/repo/a.html", json: true, workspace: "/repo/w" },
    });
  });
});

describe("parseArgs · --help", () => {
  it("should produce a root help intent with no topic", () => {
    expect(parse(["--help"])).toEqual({ ok: true, intent: { kind: "help", topic: undefined } });
  });

  it.each(["outline", "read", "patch", "style"])(
    "should pick the %s section for `<cmd> --help`",
    (name) => {
      expect(parse([name, "--help"])).toEqual({ ok: true, intent: { kind: "help", topic: name } });
    },
  );

  it("should ignore a non-command positional when choosing the topic", () => {
    expect(parse(["--help", "nope"])).toEqual({
      ok: true,
      intent: { kind: "help", topic: undefined },
    });
    expect(parse(["nope", "--help"])).toEqual({
      ok: true,
      intent: { kind: "help", topic: undefined },
    });
  });

  it("should let a value flag eat a following --help (documented quirk)", () => {
    // `--html` 会把 `--help` 当成自己的取值：开关先被吃掉，帮助就不会触发。
    expect(parse(["patch", "--html", "--help"])).toEqual({
      ok: false,
      message: "patch 缺少 <file>",
      topic: "patch",
    });
  });
});

describe("parseArgs · outline", () => {
  it("should resolve the path and workspace against cwd", () => {
    expect(parse(["outline", "sub/a.html", "--workspace", "../w"])).toEqual({
      ok: true,
      intent: { kind: "outline", path: "/repo/sub/a.html", json: false, workspace: "/w" },
    });
  });

  it("should default the workspace to cwd", () => {
    expect(parse(["outline", "/abs/a.html"])).toMatchObject({
      ok: true,
      intent: { workspace: CWD },
    });
  });

  it("should reject a missing <file>", () => {
    expectFailure(["outline"], "outline 缺少 <file>", "outline");
  });

  it("should reject extra positionals with their count", () => {
    expectFailure(["outline", "a", "b", "c"], "outline 只接受 1 个位置参数，多出 2 个", "outline");
    expectFailure(
      ["outline", "a", "--json", "b"],
      "outline 只接受 1 个位置参数，多出 1 个",
      "outline",
    );
  });

  it("should reject a flag that outline does not own (raw name is the message)", () => {
    expectFailure(["outline", "a", "--lint"], "--lint", "outline");
  });
});

describe("parseArgs · read", () => {
  it("should accept a target and an optional --max-bytes", () => {
    expect(parse(["read", "a.html", "hr-1"])).toEqual({
      ok: true,
      intent: {
        kind: "read",
        path: "/repo/a.html",
        target: "hr-1",
        maxBytes: undefined,
        json: false,
        workspace: CWD,
      },
    });
    expect(parse(["read", "a.html", "section", "--max-bytes", "42", "--json"])).toEqual({
      ok: true,
      intent: {
        kind: "read",
        path: "/repo/a.html",
        target: "section",
        maxBytes: 42,
        json: true,
        workspace: CWD,
      },
    });
  });
});

describe("parseArgs · read 的用法错误", () => {
  it.each([
    [["read"], "read 缺少 <file>"],
    [["read", "a.html"], "read 缺少 <nodeId|selector>"],
    [["read", "a", "b", "c"], "read 只接受 2 个位置参数，多出 1 个"],
    [["read", "a", "b", "--visual", "x"], "--visual"],
  ])("should reject %j", (argv, message) => {
    expectFailure(argv, message, "read");
  });
});

describe("parseArgs · read 的 --max-bytes", () => {
  it.each(["abc", "0", "-1", "1.5", "10000001"])("should reject --max-bytes %s", (value) => {
    expectFailure(
      ["read", "a.html", "b", "--max-bytes", value],
      "--max-bytes 必须是 1..10000000 的整数",
      "read",
    );
  });

  it("should carry --json into a --max-bytes failure", () => {
    expectFailure(
      ["read", "a", "b", "--json", "--max-bytes", "0"],
      "--max-bytes 必须是 1..10000000 的整数",
      "read",
    );
  });

  it("should accept the ceiling and the floor", () => {
    expect(parse(["read", "a", "b", "--max-bytes", "10000000"])).toMatchObject({
      ok: true,
      intent: { maxBytes: 10_000_000 },
    });
    expect(parse(["read", "a", "b", "--max-bytes", "1"])).toMatchObject({
      ok: true,
      intent: { maxBytes: 1 },
    });
  });
});

describe("parseArgs · patch", () => {
  it("should build an inline source and a workspace-relative target", () => {
    expect(parse(["patch", "a.html", "hr-1", "--action", "replace", "--html", "<p>x</p>"])).toEqual(
      {
        ok: true,
        intent: {
          kind: "patch",
          path: "/repo/a.html",
          nodeId: "hr-1",
          action: "replace",
          html: { kind: "inline", text: "<p>x</p>" },
          json: false,
          workspace: CWD,
        },
      },
    );
  });

  it("should keep ../ outside strings for core to reject (no early normalisation)", () => {
    // `../x.html` 先按 cwd 绝对化（/x.html），边界判定交给 core —— CLI 不做提前拒绝。
    expect(parse(["patch", "../x.html", "hr-1", "--action", "delete"])).toMatchObject({
      ok: true,
      intent: { path: "/x.html", workspace: "/repo" },
    });
    expect(
      parse(["patch", "a.html", "hr-1", "--action", "delete", "--workspace", "/w"]),
    ).toMatchObject({ ok: true, intent: { path: "/repo/a.html", workspace: "/w" } });
  });
});

describe("parseArgs · patch 的用法错误", () => {
  it.each([
    [["patch"], "patch 缺少 <file>"],
    [["patch", "a.html"], "patch 缺少 <nodeId|selector>"],
    [["patch", "a", "b", "c", "--action", "delete"], "patch 只接受 2 个位置参数，多出 1 个"],
    [["patch", "a", "b", "--action"], "参数 --action 缺少取值"],
    [["patch", "a", "b", "--max-bytes", "5", "--action", "delete"], "--max-bytes"],
    [["patch", "a", "b", "--patch-note", "x", "--action", "delete"], "未知参数：--patch-note"],
  ])("should reject %j", (argv, message) => {
    if (message.startsWith("参数 --action") || message.startsWith("未知参数")) {
      // tokenize 阶段失败：还没有 topic，也没有 json。
      expect(parse(argv)).toEqual({ ok: false, message });
      return;
    }
    expectFailure(argv, message, "patch");
  });

  it("should reject a missing or unknown --action", () => {
    expectFailure(["patch", "a", "b", "--html", "x"], "patch 缺少 --action", "patch");
    expectFailure(
      ["patch", "a", "b", "--action", "explode", "--html", "x"],
      "未知的 --action：explode",
      "patch",
    );
  });
});

describe("parseArgs · patch 的 html 来源", () => {
  it("should require exactly one html source outside delete", () => {
    expectFailure(
      ["patch", "a", "b", "--action", "append"],
      "--html / --html-file / --html-stdin 必须且只能给一个",
      "patch",
    );
    expectFailure(
      ["patch", "a", "b", "--action", "append", "--html", "<p>a</p>", "--html-stdin"],
      "--html / --html-file / --html-stdin 必须且只能给一个",
      "patch",
    );
  });

  it("should reject delete with any html source (declared in the CLI layer)", () => {
    expectFailure(
      ["patch", "a", "b", "--action", "delete", "--html", "<p>x</p>"],
      "delete 不接受 --html / --html-file / --html-stdin",
      "patch",
    );
    expectFailure(
      ["patch", "a", "b", "--action", "delete", "--html-file", "f"],
      "delete 不接受 --html / --html-file / --html-stdin",
      "patch",
    );
    expectFailure(
      ["patch", "a", "b", "--action", "delete", "--html-stdin"],
      "delete 不接受 --html / --html-file / --html-stdin",
      "patch",
    );
  });
});

describe("parseArgs · patch 的来源解析", () => {
  it("should accept file and stdin sources", () => {
    expect(
      parse(["patch", "a", "b", "--action", "append", "--html-file", "frag.html"]),
    ).toMatchObject({ ok: true, intent: { html: { kind: "file", path: "/repo/frag.html" } } });
    expect(parse(["patch", "a", "b", "--action", "delete"])).toEqual({
      ok: true,
      intent: {
        kind: "patch",
        path: "/repo/a",
        nodeId: "b",
        action: "delete",
        json: false,
        workspace: "/repo",
      },
    });
    expect(parse(["patch", "a", "b", "--action", "insert_after", "--html-stdin"])).toMatchObject({
      ok: true,
      intent: { html: { kind: "stdin" } },
    });
  });

  it("should carry --json into patch failures", () => {
    expectFailure(["patch", "a", "b", "--json"], "patch 缺少 --action", "patch");
  });
});
