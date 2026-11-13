// 这层管：默认依赖装配（HOME/项目根/内置主题根）与错误文本兜底；不碰真盘。

import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import { nodeStyleDeps } from "../../src/style/node";
import { messageOf } from "../../src/style/text";
import { styleEnv } from "./harness";
import { existsOf } from "../../src/style/resource";
import { loadThemeCss } from "../../src/style/theme";
import { codeOfAsync, systemError } from "../io/harness";

describe("nodeStyleDeps", () => {
  it("should point stylesRoot at the repo styles directory and use the real HOME", () => {
    const deps = nodeStyleDeps("/project");

    expect(deps.home).toBe(homedir());
    expect(deps.projectRoot).toBe("/project");
    expect(deps.stylesRoot.endsWith("/styles/")).toBe(true);
    expect(typeof deps.fs.readFile).toBe("function");
    expect(typeof deps.sleep).toBe("function");
  });
});

describe("messageOf", () => {
  it("should use the message of an Error and stringify non-errors", () => {
    expect(messageOf(new Error("坏掉了"))).toBe("坏掉了");
    expect(messageOf(42)).toBe("42");
    expect(messageOf(undefined)).toBe("undefined");
  });
});

describe("loadThemeCss · 探路与读取之间的竞态", () => {
  it("should map a vanished theme file to style_io_failure", async () => {
    const env = styleEnv({ "/work/styles/t/theme.css": "body{}" });
    // 探路成功后文件消失：`existsOf` 看到有，随后 readFile 报 ENOENT（不是 style_io_failure 的常规路径）。
    env.fake.once(
      "lstat",
      (path) => path === "/work/styles/t/theme.css",
      (path) => {
        env.fake.fail("readFile", systemError("ENOENT"), (p) => p === path);
      },
    );

    expect(await codeOfAsync(() => loadThemeCss("t", env.deps))).toBe("style_io_failure");
  });
});

describe("existsOf · 非缺文件异常冒泡（R1 新增）", () => {
  it("should map an EACCES lstat to style_io_failure instead of 'missing'", async () => {
    const env = styleEnv({ "/work/styles/t/theme.css": "body{}" });
    env.fake.fail("lstat", systemError("EACCES"), (path) => path === "/work/styles/t/theme.css");

    expect(await codeOfAsync(() => existsOf("/work/styles/t/theme.css", env.deps))).toBe(
      "style_io_failure",
    );
  });

  it("should still report 'missing' for ENOENT and true when the file exists", async () => {
    const env = styleEnv({ "/work/styles/t/theme.css": "body{}" });

    expect(await existsOf("/work/styles/t/theme.css", env.deps)).toBe(true);
    expect(await existsOf("/work/styles/t/none.css", env.deps)).toBe(false);
  });
});
