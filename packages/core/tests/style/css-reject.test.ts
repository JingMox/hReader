// 这层管：`assertThemeSafe` 的拒绝面——外链/逃逸 <style> 的一律 invalid_theme，且错误信息点名证据。

import { describe, expect, it } from "vitest";

import { assertThemeSafe } from "../../src/style/css";
import { HrError } from "../../src/hr-error";

const errorFor = (css: string): HrError => {
  try {
    assertThemeSafe(css);
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("期望 invalid_theme 但没有抛");
};

describe("assertThemeSafe · @import 与逃逸", () => {
  it.each([
    ["@import（原样）", '@import "x.css";'],
    ["@IMPORT（大写）", '@IMPORT url("x.css");'],
    ["注释粘连的 @import", "/*x*/@import 'y.css';"],
    ["无空格的 @import", "@import'z.css';"],
    ["</style 逃逸", "body{color:red}</style><script>alert(1)</script>"],
    ["< 在字符串里", '.a::after{content:"<"}'],
  ])("should reject %s with invalid_theme", (_label, css) => {
    const error = errorFor(css);

    expect(error.code).toBe("invalid_theme");
    expect(error.message.length).toBeGreaterThan(0);
    expect(error).not.toBeInstanceOf(SyntaxError);
  });
});

describe("assertThemeSafe · 远程与危险 url()", () => {
  it.each([
    ["javascript:（小写）", ".a{background:url(javascript:alert(1))}"],
    ["JaVaScRiPt:（混合大小写）", ".a{background:url('JaVaScRiPt:alert(1)')}"],
    ["javascript: 无 url()", ".a{background:javascript:alert(1)}"],
    ["url(http://)", ".a{background:url(http://evil.example/x.png)}"],
    ["uRl(HTTP://) 大小写", ".a{background:uRl(HTTP://evil.example/x.png)}"],
    ["url('https://')", ".a{background:url('https://evil.example/x.png')}"],
    ["协议相对 url(//evil)", ".a{background:url(//evil.example/x.png)}"],
    ["协议相对带引号", '.a{background:url("//evil.example/x.png")}'],
    ["@font-face 外链", "@font-face{font-family:x;src:url(https://cdn.example/x.woff2)}"],
    ["data:text/html", ".a{background:url(data:text/html,<svg onload=alert(1)>)}"],
    ["mailto:", ".a{background:url(mailto:a@b.c)}"],
    ["blob:", ".a{background:url(blob:https://x/y)}"],
    ["file:", ".a{background:url(file:///etc/passwd)}"],
    ["未闭合的 url(", ".a{background:url(https://evil.example/x"],
    ["未闭合的 http url(", ".a{background:url(http://evil.example/x"],
    ["未闭合的协议相对 url(", ".a{background:url(//evil.example/x"],
    ["未闭合带引号与空白的 url(", ".a{background:url( 'http://evil.example/x"],
    ["url 与 ( 之间带空格的非 http scheme", ".a{background:url (ftp://evil.example/x)}"],
    ["带引号的非 http scheme", '.a{background:url("ftp://evil.example/x")}'],
    ["外链 scheme 尾巴带锚点", ".a{background:url(ftp://evil.example/x#)}"],
    ["未闭合带单引号的 http url(", ".a{background:url('http://evil.example/x"],
    ["引号内含空白的 http url(", '.a{background:url(" http://evil.example/x")}'],
    ["url 与 ( 之间带空格的伪协议", ".a{background:url (javascript:alert(1))}"],
    ["大写伪协议 scheme", ".a{background:url(JAVASCRIPT:alert(1))}"],
    ["url( 与参数间多个空白的伪协议", ".a{background:url(  javascript:alert(1)  )}"],
  ])("should reject %s with invalid_theme", (_label, css) => {
    expect(errorFor(css).code).toBe("invalid_theme");
  });

  it("should keep the message actionable (mentions url())", () => {
    expect(errorFor(".a{background:url(ftp://files.example/x)}").message).toContain("url()");
  });

  it("should name the offense for a protocol-relative url", () => {
    expect(errorFor(".a{background:url(http://evil.example/x)}").message).toContain("外部资源");
  });

  it("should echo the offending argument trimmed in the message", () => {
    expect(errorFor('.a{background:url("ftp://files.example/x")}').message).toContain(
      "ftp://files.example/x",
    );
  });
});

describe("assertThemeSafe · 转义先反转义再判", () => {
  it.each([
    ["十六进制转义的 http", ".a{background:url(\\68 ttp://evil.example/x.png)}"],
    ["十六进制转义的 @import", "@im\\70 ort 'x.css';"],
    ["十六进制转义的 javascript:", ".a{background:url(java\\73 cript:alert(1))}"],
    ["十六进制转义的 url(", ".a{background:u\\72l(http://evil.example/x.png)}"],
    ["转义后的协议相对地址", ".a{background:\\75 rl(//evil.example/x.png)}"],
    ["转义后的 @import（无空格）", "\\40 import 'y.css';"],
    ["大小写混合 + 转义", ".a{background:URL(\\68 ttp://evil.example/x.png)}"],
    ["单字符转义的 javascript:", ".a{background:url(javascript\\:alert(1))}"],
    ["单字符转义的 @import", "@im\\port 'x.css';"],
    ["单字符转义的 url(", ".a{background:u\\rl(http://evil.example/x.png)}"],
  ])("should reject %s with invalid_theme", (_label, css) => {
    expect(errorFor(css).code).toBe("invalid_theme");
  });

  it("should allow an @import that only exists inside a comment", () => {
    expect(() => {
      assertThemeSafe("/* @import url(x.css); */\nbody{color:#111}");
    }).not.toThrow();
    expect(() => {
      assertThemeSafe("/*! 版权注释里的 @import url(x.css) 也不算威胁 */\nbody{margin:0}");
    }).not.toThrow();
  });
});

describe("assertThemeSafe · 注释断词与续行逃逸", () => {
  it.each([
    ["未闭合的 url( + 协议相对", ".a{background:url('//evil.example/x"],
    ["未闭合的 url( + 空格", ".a{background:url(  http://evil.example/x"],
  ])("should reject %s with invalid_theme", (_label, css) => {
    expect(errorFor(css).code).toBe("invalid_theme");
  });

  it("should allow a comment that breaks a scheme token mid-word", () => {
    expect(() => {
      assertThemeSafe(".a{background:url(java/**/script:x)}");
    }).not.toThrow();
  });

  it("should echo the offending url argument in the error message", () => {
    expect(errorFor(".a{background:url(ftp://files.example/x.png)}").message).toContain(
      "ftp://files.example/x.png",
    );
  });

  it("should name @import in the reason when rejecting it", () => {
    expect(errorFor('@import url("x.css");').message).toContain("@import");
  });
});

describe("assertThemeSafe · 报错文案", () => {
  it("should name the pseudo-scheme in the reason when rejecting javascript:", () => {
    expect(errorFor(".a{background:url(javascript:alert(1))}").message).toContain("javascript:");
  });

  it("should echo the trimmed argument verbatim in the url() reason", () => {
    expect(errorFor(".a{background:url( ftp://files.example/x.png )}").message).toContain(
      "收到：ftp://files.example/x.png",
    );
  });
});
