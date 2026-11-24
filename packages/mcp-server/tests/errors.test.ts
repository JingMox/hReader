// 这层管：工具结果的两副面孔与日志落点——失败保留 `HrError.code`，堆栈只进 stderr。

import { HrError } from "@hreader/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  elidedOf,
  failureOf,
  foldedOf,
  okResult,
  rootsOf,
  rpcCodeOf,
  rpcErrorOf,
} from "../src/errors";
import { logFailure, logLine, messageOf } from "../src/log";

const stderrText = (): { read(): string } => {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { read: () => written.join("") };
};

const textOf = (result: { content: readonly unknown[] }): string =>
  result.content
    .flatMap((one) =>
      typeof one === "object" && one !== null && "text" in one && typeof one.text === "string"
        ? [one.text]
        : [],
    )
    .join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("okResult", () => {
  it("should pretty-print the payload and keep ui meta optional", () => {
    expect(textOf(okResult({ a: 1 }))).toBe('{\n  "a": 1\n}');
    expect(okResult({ a: 1 })._meta).toBeUndefined();
    expect(okResult({ a: 1 }, { ui: { resourceUri: "ui://x" } })._meta).toEqual({
      ui: { resourceUri: "ui://x" },
    });
  });
});

describe("failureOf", () => {
  it("should keep the HrError code in the body and the stack out of it", () => {
    const stderr = stderrText();
    const result = failureOf("hr_probe", new HrError("io_failure", "写不进去"));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("[io_failure] 写不进去");
    expect(stderr.read()).toContain("hr_probe 失败");
    expect(stderr.read()).toContain("at ");
  });

  it("should keep the raw text out of the body and use a generic message instead", () => {
    const stderr = stderrText();
    // 诊断（`boom`）进 stderr，正文只给人话：宿主按码分流，模型看文案，两件事不混。
    expect(textOf(failureOf("hr_probe", new Error("boom")))).toBe("[internal] 服务器内部错误");
    expect(textOf(failureOf("hr_probe", "裸字符串"))).toBe("[internal] 服务器内部错误");
    expect(stderr.read()).toContain("boom");
  });

  it("should map a bare fs errno that nobody wrapped, without leaking the path", () => {
    stderrText();
    const bare = Object.assign(new Error("ENOENT: no such file or directory, open '/x/y.html'"), {
      code: "ENOENT",
      syscall: "open",
    });
    const text = textOf(failureOf("hr_probe", bare));

    // 调用点漏包时的兜底：码仍然诚实，但正文里既无 errno 原文也无绝对路径。
    expect(text).toBe("[not_found] 目标不存在");
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain("/x/y.html");
  });
});

describe("log", () => {
  it("should prefix every line and never touch stdout", () => {
    const stderr = stderrText();
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    logLine("就绪");
    logFailure("hr_probe", "裸字符串");

    expect(stderr.read()).toContain("[hreader-mcp] 就绪");
    expect(stderr.read()).toContain("[hreader-mcp] hr_probe 失败：裸字符串");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("should fall back to the message when an Error carries no stack", () => {
    const stderr = stderrText();
    const bare = new Error("没有堆栈");
    // 有的运行环境不给 `stack`（`exactOptionalPropertyTypes` 也不允许直接赋 `undefined`）。
    Object.defineProperty(bare, "stack", { value: undefined });

    logFailure("hr_probe", bare);

    expect(stderr.read()).toContain("[hreader-mcp] hr_probe 失败：没有堆栈");
  });

  it("should stringify a non-Error reason", () => {
    expect(messageOf("裸字符串")).toBe("裸字符串");
    expect(messageOf(new Error("boom"))).toBe("boom");
  });
});

describe("绝对路径折叠", () => {
  it("should leave the message untouched when the root is the filesystem root", () => {
    // `root === "/"` 时根是**每个**绝对路径的前缀：折它只会把文案拆坏。
    expect(elidedOf("找不到风格：/x.yaml", ["/"])).toBe("找不到风格：/x.yaml");
  });

  it("should not touch a sibling directory that merely starts with the root", () => {
    // `root=/ws/hReader` 不许吃掉 `/ws/hReader-something/x`：根后面必须跟分隔符。
    expect(elidedOf("读取失败：/ws/hReader-something/x.html", ["/ws/hReader"])).toBe(
      "读取失败：/ws/hReader-something/x.html",
    );
  });

  it("should fold the root and the separator together, leaving a relative path", () => {
    expect(elidedOf("读取失败：/ws/a.html", ["/ws"])).toBe("读取失败：a.html");
    // 根后面跟的是空格/标点时不算路径前缀，原样保留（宁可漏折，也不许把句子拆坏）。
    expect(elidedOf("就是 /ws 本身", ["/ws"])).toBe("就是 /ws 本身");
  });

  it("should fold every root it is given, and treat the regex metacharacters as literal", () => {
    expect(elidedOf("/real/a.html 与 /link/a.html", ["/link", "/real"])).toBe("a.html 与 a.html");
    // `.` 在根里是字面点，不许当通配符。
    expect(elidedOf("/ws.v2/a.html 与 XwsYv2/a.html", ["/ws.v2"])).toBe("a.html 与 XwsYv2/a.html");
  });
});

describe("折叠顺序", () => {
  // macOS 上 cwd=`/var/folders/x`、realpath=`/private/var/folders/x`：先折短的会命中长串中段，
  // 折出 `/privatedoc.html` + 半截 `/private`。长根先折就没这问题。
  it("should fold the longer root first when one root is a suffix of the other", () => {
    const cwd = "/var/folders/x";
    const real = "/private/var/folders/x";
    expect(
      elidedOf(
        `realpath时路径不存在：${real}/doc.html`,
        rootsOf(cwd, () => real),
      ),
    ).toBe("realpath时路径不存在：doc.html");
    // 调用方给的顺序反着来也一样：排序在折叠里做，不依赖入参。
    expect(elidedOf(`realpath时路径不存在：${cwd}/doc.html`, [real, cwd])).toBe(
      "realpath时路径不存在：doc.html",
    );
  });
});

describe("折叠根的来源", () => {
  it("should keep one root when the real path equals cwd", () => {
    expect(rootsOf("/ws", (path) => path)).toEqual(["/ws"]);
  });

  it("should keep both when cwd is a symlink into the real path", () => {
    expect(rootsOf("/link", () => "/real")).toEqual(["/link", "/real"]);
  });

  it("should fall back to cwd alone when realpath fails", () => {
    expect(
      rootsOf("/ws", () => {
        throw new Error("EACCES");
      }),
    ).toEqual(["/ws"]);
  });
});

describe("JSON-RPC 分流", () => {
  it("should map business codes onto the spec codes the host switches on", () => {
    // `-32002` 是 MCP 的 "Resource not found"；`-32603` 只留给真正没料到的失败。
    expect(rpcCodeOf("not_found")).toBe(-32002);
    expect(rpcCodeOf("unknown_style")).toBe(-32002);
    expect(rpcCodeOf("invalid_input")).toBe(-32602);
    expect(rpcCodeOf("path_outside_workspace")).toBe(-32602);
    expect(rpcCodeOf("internal")).toBe(-32603);
    expect(rpcCodeOf("io_failure")).toBe(-32603);
  });

  it("should treat a non-fs error as internal and an unknown errno with syscall as io_failure", () => {
    const ours = Object.assign(new Error("boom"), { code: "EWEIRD" });
    const numeric = Object.assign(new Error("boom"), { code: 42 });
    const noCode: object = {};
    const syscallOne = Object.assign(new Error("boom"), { code: "EWEIRD", syscall: "open" });

    // 有 `syscall` 才是 fs 层错误：没有它的未知错误就是"我们没料到"。
    expect(textOf(failureOf("hr_probe", ours))).toBe("[internal] 服务器内部错误");
    expect(textOf(failureOf("hr_probe", syscallOne))).toBe(
      "[io_failure] 文件操作失败（细节见服务器日志）",
    );
    // 有 `code` 但不是字符串（如数字 errno）、或根本没有 `code`：都不是 fs 层，走 `internal`。
    expect(textOf(failureOf("hr_probe", numeric))).toBe("[internal] 服务器内部错误");
    expect(textOf(failureOf("hr_probe", noCode))).toBe("[internal] 服务器内部错误");
  });
});

describe("JSON-RPC 出口", () => {
  it("should keep the fine code in data, and fold the path only where we ask it to", () => {
    const error = new HrError("unknown_style", `找不到风格：${process.cwd()}/x.yaml`);

    // 宿主按 `data.code` 细分，`code` 只是 JSON-RPC 的粗粒度开关。
    const rpc = rpcErrorOf(error);
    expect(rpc.code).toBe(-32002);
    expect(rpc.data).toEqual({ code: "unknown_style" });

    // 折叠不是出口的默认动作（用户传的 `filePath` 必须原样回显）：由调用点显式对 core 文案调用 `foldedOf`。
    expect(rpc.message).toContain(process.cwd());
    const folded = rpcErrorOf(foldedOf(error));
    expect(folded.message).not.toContain(process.cwd());
    expect(folded.message).toContain("x.yaml");
    expect(folded.data).toEqual({ code: "unknown_style" });
  });
});
