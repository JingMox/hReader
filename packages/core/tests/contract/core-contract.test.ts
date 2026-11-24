import { describe, expect, it } from "vitest";

// 跨包只走包名。解析链 = tsconfig.base paths + vitest resolve.alias（同一份源码）。
import { HrError } from "@hreader/core";

function caughtFromThrow(): unknown {
  try {
    throw new HrError("invalid_html", "boom");
  } catch (error) {
    return error;
  }
}

describe("cross-package HrError via package name", () => {
  it("should construct HrError and narrow it from unknown", () => {
    const error: unknown = new HrError("node_not_found", "from protocol");

    if (!(error instanceof HrError)) {
      throw new Error("unreachable: @hreader/core must resolve to one class");
    }

    expect(error.code).toBe("node_not_found");
    expect(error.name).toBe("HrError");
    expect(error.message).toBe("from protocol");
  });

  it("should keep instanceof true for a value caught from a throw", () => {
    expect(caughtFromThrow()).toBeInstanceOf(HrError);
  });

  it("should resolve to the same class as the source entry (no duplicate module instance)", async () => {
    const again = await import("@hreader/core");

    expect(again.HrError).toBe(HrError);
  });
});
