// 这层管：`syntaxErrorOf` 的两种输入形状（有 pos / 无 pos）。
//
// 为什么从内部路径引入：`yaml` 的 `YAMLParseError` 恒带 `pos`，公开 API 永远走不到"无 pos"
// 那一臂；该兜底是对第三方边界的防御（v3#16），只能直接喂一个无 `pos` 的错误对象来钉住，
// 而 `syntaxErrorOf` 是 `@internal`（未进 `src/index.ts` 公共面）。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { syntaxErrorOf } from "../../src/style/spec";

describe("syntaxErrorOf · 报文的两种形状（v3#16 第三方边界）", () => {
  it("should omit the line marker when the third-party error carries no pos", () => {
    const error = syntaxErrorOf({ message: "bad" }, "style.yaml", "a: 1");

    expect(error).toBeInstanceOf(HrError);
    expect(error.code).toBe("invalid_style");
    expect(error.message).toBe("style.yaml：YAML 语法错：bad");
    expect(error.message).not.toContain("第");
    expect(error.message).not.toContain("行）");
  });

  it("should name 第 2 行 for a pos on the second line", () => {
    const error = syntaxErrorOf({ message: "bad", pos: [8, 1] }, "style.yaml", "a: 1\nb: 2");

    expect(error.code).toBe("invalid_style");
    expect(error.message).toContain("第 2 行");
    expect(error.message).toBe("style.yaml：YAML 语法错（第 2 行）：bad");
  });

  it("should name 第 1 行 for pos[0] = 0 and keep the cause", () => {
    const cause = { message: "bad", pos: [0, 1] };
    const error = syntaxErrorOf(cause, "style.yaml", "a: 1");

    expect(error.message).toContain("第 1 行");
    expect(error.cause).toBe(cause);
  });
});
