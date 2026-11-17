// 这层管：`hr png` 的 argv → intent（宽/倍率/高度上限/超时/绝对路径/开关）；不碰文件系统。
import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

const okOf = (argv: readonly string[]) => {
  const result = parse(argv);
  if (!result.ok) throw new Error(`预期解析成功：${result.message}`);
  if (result.intent.kind !== "png") throw new Error(`预期 png intent：${result.intent.kind}`);
  return result.intent;
};

describe("parseArgs · hr png 默认值", () => {
  it("宽 1200 / 倍率 2 / 高上限 20000 / 超时 60s", () => {
    const intent = okOf(["png", "a.html", "--out", "out/a.png"]);
    expect([intent.width, intent.scale, intent.maxHeight, intent.timeoutMs]).toEqual([
      "1200",
      "2",
      "20000",
      60_000,
    ]);
    // 没给 --max-height：默认值只是兜底，不能当成用户请求做面积预检。
    expect(intent.maxHeightExplicit).toBe(false);
    expect(intent.path).toBe(`${CWD}/a.html`);
    expect(intent.out).toBe(`${CWD}/out/a.png`);
    expect(intent.force).toBe(false);
    expect(intent.json).toBe(false);
    expect(intent.workspace).toBe(CWD);
  });
});

describe("parseArgs · hr png 大纲旗标", () => {
  it("两个大纲旗标都是已知旗标：放行到意图里，不在这里报未用", () => {
    // png 没有大纲：真正的拒绝是命令层的 `invalid_input` exit 1（不是用法错误 exit 2）。
    expect(okOf(["png", "a.html", "--out", "a.png", "--no-outline"]).outlineFlag).toBe(
      "--no-outline",
    );
    expect(okOf(["png", "a.html", "--out", "a.png", "--outline"]).outlineFlag).toBe("--outline");
    expect(okOf(["png", "a.html", "--out", "a.png"]).outlineFlag).toBeUndefined();
  });
});

describe("parseArgs · hr png 透传", () => {
  it("四个取值与两个开关都透传", () => {
    const intent = okOf([
      "png",
      "a.html",
      "--out",
      "a.png",
      "--width",
      "256",
      "--scale",
      "3",
      "--max-height",
      "50000",
      "--timeout",
      "30",
      "--force",
      "--json",
      "--workspace",
      "/repo/docs",
    ]);
    expect([intent.width, intent.scale, intent.maxHeight, intent.timeoutMs]).toEqual([
      "256",
      "3",
      "50000",
      30_000,
    ]);
    expect(intent.maxHeightExplicit).toBe(true);
    expect(intent.force).toBe(true);
    expect(intent.json).toBe(true);
    expect(intent.workspace).toBe("/repo/docs");
  });
});

describe("parseArgs · hr png 用法错误", () => {
  it("缺 file", () => {
    expectFailure(["png", "--out", "a.png"], "png 缺少 <file>", "png");
  });

  it("缺 --out", () => {
    expectFailure(["png", "a.html"], "png 缺少 --out <path>", "png");
  });

  it("多余位置参数", () => {
    expectFailure(
      ["png", "a.html", "b.html", "--out", "a.png"],
      "png 只接受 1 个位置参数，多出 1 个",
      "png",
    );
  });

  it("不认识的 flag", () => {
    const result = parse(["png", "a.html", "--out", "a.png", "--page-size", "a4"]);
    expect(result.ok).toBe(false);
  });

  it.each([["0"], ["601"], ["1.5"], ["abc"]])("--timeout %s 越界 → 用法错误", (value) => {
    expectFailure(
      ["png", "a.html", "--out", "a.png", "--timeout", value],
      "--timeout 必须是 1..600 的整数",
      "png",
    );
  });

  it("三个尺寸越界不在这里判（留给命令层的 invalid_input）", () => {
    expect(okOf(["png", "a.html", "--out", "a.png", "--width", "99999"]).width).toBe("99999");
  });
});
