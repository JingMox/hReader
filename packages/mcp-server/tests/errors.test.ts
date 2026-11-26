// This layer: the two faces of tool results and where logs land — failures keep `HrError.code`; stacks only go to stderr.

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
import { longestLineOf, stderrText } from "./harness";

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
    // Diagnostics (`boom`) go to stderr; the body only gets human words: the host routes on the code, the model reads the text — the two never mix.
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

    // The fallback for a caller that forgot to wrap: the code stays honest, and the body carries neither the raw errno nor an absolute path.
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
    // Some runtimes do not provide `stack` (`exactOptionalPropertyTypes` also forbids assigning `undefined` directly).
    Object.defineProperty(bare, "stack", { value: undefined });

    logFailure("hr_probe", bare);

    expect(stderr.read()).toContain("[hreader-mcp] hr_probe 失败：没有堆栈");
  });

  it("should stringify a non-Error reason", () => {
    expect(messageOf("裸字符串")).toBe("裸字符串");
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  it("should bound a line even when the logged text is megabytes", () => {
    const stderr = stderrText();

    logLine("x".repeat(2 * 1024 * 1024));

    const written = stderr.read();
    // What stalls the runner is megabyte-long single lines: the cap is asserted per "line", and the truncation point marks how much was cut.
    expect(written).toContain("…[truncated ");
    expect(written).toContain(" chars]");
    expect(longestLineOf(written)).toBeLessThan(10_000);
  });

  it("should bound every layer of a cause chain with megabyte-sized stacks", () => {
    const stderr = stderrText();
    const inner = new Error("y".repeat(1024 * 1024));
    const outer = new HrError("not_found", "z".repeat(1024 * 1024), { cause: inner });

    logFailure("hr_probe", outer);

    const written = stderr.read();
    // The tail cause must not be lost: truncation happens inside each layer, so the `caused by` skeleton must survive.
    expect(written).toContain("caused by");
    expect(written).toContain("…[truncated ");
    expect(longestLineOf(written)).toBeLessThan(10_000);
  });

  it("should bound the depth of a cause chain instead of unrolling it without limit", () => {
    const stderr = stderrText();
    let error = new Error("root");
    for (let index = 0; index < 64; index += 1) {
      error = new Error(`wrap ${String(index)}`, { cause: error });
    }

    logFailure("hr_probe", error);

    const written = stderr.read();
    expect(written).toContain("truncated");
    // Each layer's message is only a dozen chars: without a depth cap, 64 layers would print in full.
    expect(written).not.toContain("wrap 0");
  });

  it("should stop at the depth bound even when the cause chain is cyclic", () => {
    const stderr = stderrText();
    const loop = new Error("self-cause");
    // A `cause` pointing back at itself is a legal runtime shape: without a cap, `while (current instanceof Error)` loops forever.
    loop.cause = loop;

    logFailure("hr_probe", loop);

    expect(stderr.read()).toContain("truncated");
  });
});

describe("absolute-path folding", () => {
  it("should leave the message untouched when the root is the filesystem root", () => {
    // With `root === "/"` the root is a prefix of **every** absolute path: folding it only mangles the text.
    expect(elidedOf("找不到风格：/x.yaml", ["/"])).toBe("找不到风格：/x.yaml");
  });

  it("should not touch a sibling directory that merely starts with the root", () => {
    // `root=/ws/hReader` must not eat `/ws/hReader-something/x`: a separator must follow the root.
    expect(elidedOf("读取失败：/ws/hReader-something/x.html", ["/ws/hReader"])).toBe(
      "读取失败：/ws/hReader-something/x.html",
    );
  });

  it("should fold the root and the separator together, leaving a relative path", () => {
    expect(elidedOf("读取失败：/ws/a.html", ["/ws"])).toBe("读取失败：a.html");
    // When what follows the root is a space/punctuation it is not a path prefix — keep it (better miss a fold than break a sentence).
    expect(elidedOf("就是 /ws 本身", ["/ws"])).toBe("就是 /ws 本身");
  });

  it("should fold every root it is given, and treat the regex metacharacters as literal", () => {
    expect(elidedOf("/real/a.html 与 /link/a.html", ["/link", "/real"])).toBe("a.html 与 a.html");
    // `.` inside a root is a literal dot, never a wildcard.
    expect(elidedOf("/ws.v2/a.html 与 XwsYv2/a.html", ["/ws.v2"])).toBe("a.html 与 XwsYv2/a.html");
  });
});

describe("fold order", () => {
  // On macOS cwd=`/var/folders/x`, realpath=`/private/var/folders/x`: folding the short one first hits the middle of the longer string,
  // producing `/privatedoc.html` + a dangling `/private`. Longest-first avoids it.
  it("should fold the longer root first when one root is a suffix of the other", () => {
    const cwd = "/var/folders/x";
    const real = "/private/var/folders/x";
    expect(
      elidedOf(
        `realpath时路径不存在：${real}/doc.html`,
        rootsOf(cwd, () => real),
      ),
    ).toBe("realpath时路径不存在：doc.html");
    // Reversed input order gives the same result: sorting happens inside the fold, independent of the arguments.
    expect(elidedOf(`realpath时路径不存在：${cwd}/doc.html`, [real, cwd])).toBe(
      "realpath时路径不存在：doc.html",
    );
  });
});

describe("where the fold roots come from", () => {
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

describe("JSON-RPC routing", () => {
  it("should map business codes onto the spec codes the host switches on", () => {
    // `-32002` is MCP's "Resource not found"; `-32603` is reserved for genuinely unexpected failures.
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

    // Only an error with `syscall` is fs-layer; an unknown error without it is "we did not expect this".
    expect(textOf(failureOf("hr_probe", ours))).toBe("[internal] 服务器内部错误");
    expect(textOf(failureOf("hr_probe", syscallOne))).toBe(
      "[io_failure] 文件操作失败（细节见服务器日志）",
    );
    // A `code` that is not a string (e.g. a numeric errno), or no `code` at all: neither is fs-layer → `internal`.
    expect(textOf(failureOf("hr_probe", numeric))).toBe("[internal] 服务器内部错误");
    expect(textOf(failureOf("hr_probe", noCode))).toBe("[internal] 服务器内部错误");
  });
});

describe("JSON-RPC exit", () => {
  it("should keep the fine code in data, and fold the path only where we ask it to", () => {
    const error = new HrError("unknown_style", `找不到风格：${process.cwd()}/x.yaml`);

    // The host subdivides on `data.code`; `code` is only the JSON-RPC coarse switch.
    const rpc = rpcErrorOf(error);
    expect(rpc.code).toBe(-32002);
    expect(rpc.data).toEqual({ code: "unknown_style" });

    // Folding is not the exits' default (the caller's `filePath` must echo verbatim): call sites explicitly run `foldedOf` on core text.
    expect(rpc.message).toContain(process.cwd());
    const folded = rpcErrorOf(foldedOf(error));
    expect(folded.message).not.toContain(process.cwd());
    expect(folded.message).toContain("x.yaml");
    expect(folded.data).toEqual({ code: "unknown_style" });
  });
});
