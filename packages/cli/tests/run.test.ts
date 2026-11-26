// This layer covers `run()`'s routing logic (argv → exit code / stdout / stderr) with a fake io; real fs only for success paths.
//
// Note: the `--html-stdin` stdin-refusal case only exercises a **defensive/incidental** branch — `run.ts`'s `runPatch`
// return; its redness is decided by the stderr shape — do not count it as patch-path symptom coverage.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Module-level fixture: every importing case eats from this source — relying on "whatever file a previous case happened to write" breaks under reordering.
writeFileSync(
  join(dir, "foreign.html"),
  "<body><main><h1>外来</h1><script>boot()</script><p>正文</p></main></body>",
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
      // `home` must be injected: `run(["serve", …])` without `--home` lands on `homedir()` — that is the real `~/.hreader/daemon.json`.
      home: dir,
      ...overrides,
    },
  };
};

describe("run · success paths", () => {
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
        // The target must be a container that holds block-level children: appending a `<p>` into a `<p>` writes an unreparsable nest.
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

describe("run · export wiring", () => {
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

describe("run · import wiring", () => {
  it("should convert a foreign html and write <name>.hr.html by default", async () => {
    const { io, out } = capture();
    const code = await run(["import", "foreign.html"], io);

    expect(code).toBe(0);
    expect(out.join("")).toContain("imported foreign.hr.html (note");
    // The artifact is a real managed document: data-hr-id and data-hr-kind all present.
    const written = readFileSync(join(dir, "foreign.hr.html"), "utf8");
    expect(written).toContain('data-hr-id="root" data-hr-kind="note"');
    expect(written).not.toContain("<script");

    // Rerun without --force: target exists → file_exists (exit 1).
    const second = capture();
    expect(await run(["import", "foreign.html"], second.io)).toBe(1);
    expect(second.err.join("")).toContain("目标已存在");
  });

  it("should emit the report envelope under --json", async () => {
    const { io, out } = capture();
    const code = await run(["import", "foreign.html", "--out", "f2.html", "--json"], io);

    expect(code).toBe(0);
    const line = out.join("");
    expect(line.endsWith("\n") && !line.slice(0, -1).includes("\n")).toBe(true);
    expect(line).toContain('"trunk":"main"');
    expect(line).toContain('"path":');
    expect(existsSync(join(dir, "f2.html"))).toBe(true);
  });

  it("should exit 2 when --out points back at the source", async () => {
    const { io, out, err } = capture();
    const code = await run(["import", "foreign.html", "--out", "foreign.html"], io);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("--out 不能指向源文件自身");
  });
});

describe("run · fragment sources", () => {
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

describe("run · usage errors (exit 2)", () => {
  it("should print the message + topic usage to stderr only", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline"], io);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("outline 缺少 <file>\nhReader CLI\n");
  });
});

describe("run · usage-error envelopes under --json", () => {
  // Known gap: the contract wants "errors honor --json too", but the args failure envelope has no json field,
  // so usageFailure never sees --json and usage errors under --json only write stderr. The assertion stays, pinned with it.fails.
  // KD-09
  it.fails("should also emit a usage JSON envelope on stdout under --json", async () => {
    const { io, out, err } = capture();
    const code = await run(["outline", "--json"], io);

    expect(code).toBe(2);
    expect(out.join("")).toBe('{"ok":false,"code":"usage","message":"outline 缺少 <file>"}\n');
    expect(err.join("")).toContain("outline 缺少 <file>");
  });

  // Same as above: empty stdin takes the UsageError branch, and under --json there is no stdout envelope.
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

describe("run · core errors and internal errors", () => {
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
    // One channel only: `2>&1` consumers must not receive a second segment.
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

  it("should bound the stderr line even when the error echoes a megabyte-sized argument", async () => {
    const { io, out, err } = capture();
    // `文档里没有匹配 "<选择器>" 的节点。` echoes the input verbatim: an MB-scale single line can stall terminals and log pipelines.
    const code = await run(["read", "a.html", `#${"x".repeat(2 * 1024 * 1024)}`], io);

    expect(code).toBe(1);
    expect(out).toEqual([]);
    const written = err.join("");
    expect(written).toContain("文档里没有匹配");
    expect(written).toContain("…[truncated ");
    expect(written.length).toBeLessThan(10_000);
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

describe("run · an Error with no stack", () => {
  it('should print an empty line instead of the string "undefined" when --debug has no stack', async () => {
    const error = new Error("没有栈");
    // Some runtimes/wrappers keep only message: `error.stack` reads as undefined, and `--debug` must not print "undefined" for it.
    Reflect.deleteProperty(error, "stack");
    const { io, err, out } = capture({ debug: true, readStdin: () => Promise.reject(error) });

    expect(await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], io)).toBe(
      70,
    );
    expect(err.join("")).toBe("没有栈\n\n");
    // On an io failure in patch, stdout must be empty: this is the patch path's normal failure channel, not a debug-stack check.
    expect(out.join("")).toBe("");
  });
});

describe("run · non-Error rejection values", () => {
  it("should not try to print a stack when --debug is on but the rejection is not an Error", async () => {
    const rejection: unknown = "不是 Error 的字符串";
    const { io, err } = capture({
      debug: true,
      readStdin: () =>
        new Promise<never>((_resolve, reject) => {
          Reflect.apply(reject, undefined, [rejection]);
        }),
    });

    // No `stack` to read: still just one line — enabling --debug must not add an "undefined" line.
    expect(await run(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], io)).toBe(
      70,
    );
    expect(err.join("")).toBe("不是 Error 的字符串\n");
  });

  it("should stringify a non-Error rejection", async () => {
    const rejection: unknown = Symbol("非 Error");
    // run.ts's messageOf must stringify non-Error rejection values: Reflect.apply constructs the
    // "rejection is not an Error" scenario without tripping the prefer-promise-reject-errors static rule.
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

describe("run · serve stop injection", () => {
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
