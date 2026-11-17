// 这层管：`run()` 的归口逻辑（argv → 退出码 / stdout / stderr），用假 io；真 fs 只为成功路径。

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
      { argv: ["style", "a.html", "--tone", DEFAULT_STYLE_ID], needle: "语言风格" },
      { argv: ["style", "a.html", "--lint"], needle: "" },
      {
        argv: ["patch", "a.html", "hr-c", "--action", "append", "--html", "<p>新</p>"],
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

describe("run · 用法错误在 --json 下的信封（F1 缺口）", () => {
  // 待裁定 F1：卡片 §3 要求"错误也遵守 --json"，但 args 失败信封里没有 json 字段，
  // usageFailure 拿不到 --json，于是 usage 错误在 --json 下只写 stderr。断言保留，用 it.fails 固定缺口。
  // KD-09
  it.fails("should also emit a usage JSON envelope on stdout under --json", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline", "--json"], io);

    expect(code).toBe(2);
    expect(out.join("")).toBe('{"ok":false,"code":"usage","message":"outline 缺少 <file>"}\n');
    expect(err.join("")).toContain("outline 缺少 <file>");
  });

  // 同上 F1：空 stdin 走 UsageError 分支，--json 下没有 stdout 信封。
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

  it("should write the error JSON to stdout and the message to stderr under --json", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline", "missing.html", "--json"], io);

    expect(code).toBe(3);
    expect(out.join("")).toBe(
      '{"ok":false,"code":"not_a_file","message":"读取时路径不存在：' +
        join(dir, "missing.html") +
        '"}\n',
    );
    expect(err.join("")).toContain("读取时路径不存在");
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

describe("run · 非 Error 的拒绝值", () => {
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

describe("run · pdf/png 的 Chrome 接线", () => {
  // 只走到"选 Chrome 二进制"这一步就失败：命令层到会话层的整条接线被执行到，但不真的起进程。
  const noChrome = { env: { HREADER_CHROME: join(dir, "no-chrome") } };

  // 用 `img.html`：`printProductOf` 在渲染之前就发警告，顺带把 stderr 的 warn 接线也走一遍。
  it.each([
    ["pdf", ["img.html", "--out", join(dir, "a.pdf")], join(dir, "a.pdf")],
    ["png", ["img.html", "--out", join(dir, "a.png"), "--width", "800"], join(dir, "a.png")],
  ])("%s 找不到 Chrome 时 exit 3、警告已出、不落盘", async (kind, argv, out) => {
    // `stop` 给上：pdf/png 也必须把它接进渲染层（不传就等满 --timeout，Ctrl-C 会白等）。
    const stop = new Promise<void>(() => undefined);
    const { io, out: stdout, err } = capture({ ...noChrome, stop });
    expect(await run([kind, ...argv], io)).toBe(3);
    expect(err.join("")).toContain("已移除 1 个外部图片");
    expect(err.join("")).toContain("找不到 Chrome");
    expect(err.join("")).toContain("候选路径：");
    expect(stdout.join("")).toBe("");
    expect(existsSync(out)).toBe(false);
  });
});
