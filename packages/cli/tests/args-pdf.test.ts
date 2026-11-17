// 这层管：`hr pdf` 的 argv → intent（纸张/超时/绝对路径/开关）；不碰文件系统。
import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

const okOf = (argv: readonly string[]) => {
  const result = parse(argv);
  if (!result.ok) throw new Error(`预期解析成功：${result.message}`);
  if (result.intent.kind !== "pdf") throw new Error(`预期 pdf intent：${result.intent.kind}`);
  return result.intent;
};

describe("parseArgs · hr pdf 默认值", () => {
  it("纸张默认 a4，超时默认 60s，路径换算成绝对路径", () => {
    const intent = okOf(["pdf", "a.html", "--out", "out/a.pdf"]);
    expect(intent.pageSize).toBe("a4");
    expect(intent.timeoutMs).toBe(60_000);
    expect(intent.path).toBe(`${CWD}/a.html`);
    expect(intent.out).toBe(`${CWD}/out/a.pdf`);
    expect(intent.force).toBe(false);
    expect(intent.json).toBe(false);
    expect(intent.workspace).toBe(CWD);
  });

  it("三个开关与 --workspace 都透传", () => {
    const intent = okOf([
      "pdf",
      "a.html",
      "--out",
      "a.pdf",
      "--page-size",
      "letter",
      "--timeout",
      "30",
      "--force",
      "--json",
      "--workspace",
      "/repo/docs",
    ]);
    expect(intent.pageSize).toBe("letter");
    expect(intent.timeoutMs).toBe(30_000);
    expect(intent.force).toBe(true);
    expect(intent.json).toBe(true);
    expect(intent.workspace).toBe("/repo/docs");
  });

  it("绝对路径原样保留", () => {
    const intent = okOf(["pdf", "/tmp/a.html", "--out", "/tmp/a.pdf"]);
    expect(intent.path).toBe("/tmp/a.html");
    expect(intent.out).toBe("/tmp/a.pdf");
  });
});

describe("parseArgs · hr pdf 用法错误", () => {
  it("缺 file", () => {
    expectFailure(["pdf", "--out", "a.pdf"], "pdf 缺少 <file>", "pdf");
  });

  it("缺 --out", () => {
    expectFailure(["pdf", "a.html"], "pdf 缺少 --out <path>", "pdf");
  });

  it("--out 传空串也算缺", () => {
    expectFailure(["pdf", "a.html", "--out", ""], "pdf 缺少 --out <path>", "pdf");
  });

  it("多出位置参数", () => {
    expectFailure(
      ["pdf", "a.html", "b.html", "--out", "a.pdf"],
      "pdf 只接受 1 个位置参数，多出 1 个",
      "pdf",
    );
  });

  it("不认识的开关", () => {
    expectFailure(["pdf", "a.html", "--out", "a.pdf", "--visual", "x"], "--visual", "pdf");
  });

  it.each(["0", "601", "1.5", "abc", "-3"])("--timeout %s 越界", (value) => {
    expectFailure(
      ["pdf", "a.html", "--out", "a.pdf", "--timeout", value],
      "--timeout 必须是 1..600 的整数秒",
      "pdf",
    );
  });
});
