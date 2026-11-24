// 这层管：`run()` 的归口逻辑（argv → 退出码 / stdout / stderr），用假 io；真 fs 只为成功路径。
//
// 注意：`--html-stdin` 的 stdin 拒绝用例只是**防御分支/顺带**覆盖 `run.ts` 的 `runPatch` 返回，
// 它的红色只由 stderr 格式决定，别把它记作 patch 路径的症状覆盖。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_STYLE_ID } from "@hreader/core";

import { run, type CliIo } from "../src/run";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

writeFileSync(
  join(dir, "a.html"),
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><p data-hr-id="hr-c">正文</p></article>',
);

writeFileSync(
  join(dir, "img.html"),
  '<article data-hr-id="hr-i"><h2 data-hr-id="hr-j">图</h2><p data-hr-id="hr-k">正文</p><img src="https://cdn.example/a.png" alt="外链"></article>',
);

interface Capture {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

const capture = (overrides: Partial<CliIo> = {}): Capture => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd: dir,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
      // `home` 必须注入：`run(["serve", …])` 不带 `--home` 时落 `homedir()`，即覆盖真实 `~/.hreader/daemon.json`。
      home: dir,
      ...overrides,
    },
  };
};

describe("run · 成功路径", () => {
  it("should print help and exit 0", async () => {
    const { io, out, err } = capture();
    const code = await run(["--help"], io);

    expect(code).toBe(0);
    expect(out.join("")).toContain("hReader CLI");
    expect(err).toEqual([]);
  });

  it("should route outline / read / style / patch through their commands", async () => {
    const cases: readonly { argv: readonly string[]; needle: string }[] = [
      { argv: ["outline", "a.html"], needle: "- hr-b" },
      { argv: ["read", "a.html", "h2"], needle: "<h2" },
      { argv: ["normalize", "a.html"], needle: "data-hr-id" },
      { argv: ["style", "a.html", "--tone", DEFAULT_STYLE_ID], needle: "语言风格" },
      { argv: ["style", "a.html", "--lint"], needle: "" },
      {
        // 目标必须是能装块级子节点的容器：往 `<p>` 里 append 一个 `<p>` 会写出不可重解析的嵌套。
        argv: ["patch", "a.html", "hr-a", "--action", "append", "--html", "<p>新</p>"],
        needle: "patched",
      },
    ];
    for (const item of cases) {
      const { io, out } = capture();
      const code = await run(item.argv, io);
      expect(code).toBe(0);
      expect(out.join("")).toContain(item.needle);
    }
  });
});

describe("run · export 接线", () => {
  it("should print the printable html to stdout", async () => {
    const { io, out } = capture();
    const code = await run(["export", "a.html"], io);
    expect(code).toBe(0);
    expect(out.join("")).toContain("<!DOCTYPE html>");
  });

  it("should write --out under the workspace and report the size line", async () => {
    const { io, out } = capture();
    const code = await run(["export", "a.html", "--out", "print-unit.html"], io);
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^exported .*print-unit\.html \(\d+ bytes\)/u);
  });

  it("should route the dropped-image warning to stderr", async () => {
    const { io, out, err } = capture();
    const code = await run(["export", "img.html"], io);
    expect(code).toBe(0);
    expect(out.join("")).toContain("<!DOCTYPE html>");
    expect(err).toEqual(["已移除 1 个外部图片\n"]);
  });
});

describe("run · 片段来源", () => {
  it("should read the fragment from stdin for --html-stdin", async () => {
    const { io, out } = capture({
      readStdin: () => Promise.resolve(new TextEncoder().encode("<p>来自 stdin</p>")),
    });
    const code = await run(
      ["patch", "a.html", "hr-c", "--action", "replace", "--html-stdin", "--json"],
      io,
    );

    expect(code).toBe(0);
    expect(out.join("")).toContain('"ok":true');
  });
});

describe("run · 用法错误（exit 2）", () => {
  it("should print the message + topic usage to stderr only", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline"], io);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("outline 缺少 <file>\nhReader CLI\n");
  });
});

describe("run · 用法错误在 --json 下的信封", () => {
  // 已知缺口：契约要求"错误也遵守 --json"，但 args 失败信封里没有 json 字段，
  // usageFailure 拿不到 --json，于是 usage 错误在 --json 下只写 stderr。断言保留，用 it.fails 固定缺口。
  // KD-09
  it.fails("should also emit a usage JSON envelope on stdout under --json", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline", "--json"], io);

    expect(code).toBe(2);
    expect(out.join("")).toBe('{"ok":false,"code":"usage","message":"outline 缺少 <file>"}\n');
    expect(err.join("")).toContain("outline 缺少 <file>");
  });

  // 同上：空 stdin 走 UsageError 分支，--json 下没有 stdout 信封。
  // KD-10
  it("should treat empty --html-stdin as a usage error in plain mode", async () => {
    const plain = capture();
    expect(
      await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], plain.io),
    ).toBe(2);
    expect(plain.out).toEqual([]);
    expect(plain.err.join("")).toContain("--html-stdin 读到的内容为空");
  });

  // KD-10
  it.fails("should treat empty --html-stdin as a usage error under --json too", async () => {
    const json = capture();
    expect(
      await run(
        ["patch", "a.html", "hr-c", "--action", "append", "--html-stdin", "--json"],
        json.io,
      ),
    ).toBe(2);
    expect(json.out.join("")).toContain('"code":"usage"');
  });
});

describe("run · core 错误与内部错误", () => {
  it("should map an HrError to its exit code and print the message to stderr", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline", "missing.html"], io);

    expect(code).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("读取时路径不存在");
  });

  it("should write the error JSON to stdout and nothing to stderr under --json", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline", "missing.html", "--json"], io);

    expect(code).toBe(3);
    expect(out.join("")).toBe(
      '{"ok":false,"code":"not_a_file","message":"读取时路径不存在：' +
        join(dir, "missing.html") +
        '"}\n',
    );
    // 只走一条通道：`2>&1` 的消费者不会再收到第二段。
    expect(err).toEqual([]);
  });

  it("should map a non-HrError to exit 70 without a stack by default", async () => {
    const { io, err } = capture({
      readStdin: () => Promise.reject(new Error("stdin 炸了")),
    });
    const code = await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], io);

    expect(code).toBe(70);
    expect(err.join("")).toBe("stdin 炸了\n");
  });
});

describe("run · HR_DEBUG", () => {
  it("should append the stack to stderr when --debug (HR_DEBUG=1) is on", async () => {
    const { io, err, out } = capture({
      debug: true,
      readStdin: () => Promise.reject(new Error("stdin 炸了")),
    });
    const code = await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], io);

    expect(code).toBe(70);
    expect(err.join("")).toContain("stdin 炸了\nError: stdin 炸了\n");
    expect(err.join("")).toContain("at ");
    expect(out).toEqual([]);
  });
});

describe("run · 没有 stack 的 Error", () => {
  it('should print an empty line instead of the string "undefined" when --debug has no stack', async () => {
    const error = new Error("没有栈");
    // 有的运行时/包装只留 message：`error.stack` 读出来是 undefined，`--debug` 不能因此印 "undefined"。
    Reflect.deleteProperty(error, "stack");
    const { io, err, out } = capture({ debug: true, readStdin: () => Promise.reject(error) });

    expect(await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], io)).toBe(
      70,
    );
    expect(err.join("")).toBe("没有栈\n\n");
    // patch 走 io 失败时 stdout 必须空：这条是 patch 路径的正常失败通道，不是只为了看 debug 栈。
    expect(out.join("")).toBe("");
  });
});

describe("run · 非 Error 的拒绝值", () => {
  it("should not try to print a stack when --debug is on but the rejection is not an Error", async () => {
    const rejection: unknown = "不是 Error 的字符串";
    const { io, err } = capture({
      debug: true,
      readStdin: () =>
        new Promise<never>((_resolve, reject) => {
          Reflect.apply(reject, undefined, [rejection]);
        }),
    });

    // 没有 `stack` 可读：照样只印一句，不能因为开了 --debug 就再印一行 "undefined"。
    expect(await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], io)).toBe(
      70,
    );
    expect(err.join("")).toBe("不是 Error 的字符串\n");
  });

  it("should stringify a non-Error rejection", async () => {
    const rejection: unknown = Symbol("非 Error");
    // run.ts 的 messageOf 必须能 stringify 非 Error 拒绝值：用 Reflect.apply 构造
    // "拒绝值不是 Error"的场景，避免与 prefer-promise-reject-errors 的静态规则冲突。
    const { io, err } = capture({
      readStdin: () =>
        new Promise<never>((_resolve, reject) => {
          Reflect.apply(reject, undefined, [rejection]);
        }),
    });
    expect(await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], io)).toBe(
      70,
    );
    expect(err.join("")).toBe("Symbol(非 Error)\n");
  });
});

describe("run · serve 的 stop 注入", () => {
  it("should hand the injected stop through to the serve command", async () => {
    let release: () => void = () => undefined;
    const stop = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { io, out } = capture({ stop, cwd: dir });

    const running = run(["serve", "a.html", "--port", "0", "--json"], io);
    setTimeout(() => {
      release();
    }, 50);

    expect(await running).toBe(0);
    expect(out.join("")).toContain('"port"');
  }, 20_000);
});
