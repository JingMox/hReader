// This layer covers `hr export` argv→intent, the `print-skip` tri-state, and fs error routing; no disk, no Chrome.

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { ioFailureOf } from "../src/commands/export-print";
import { skipLineOf, skipReasonOf } from "../src/commands/print-skip";
import { exitCodeOf } from "../src/exit-codes";
import { CWD, expectFailure, parse } from "./args-helpers";

const DEFAULT_INTENT = {
  ok: true,
  intent: {
    kind: "export",
    path: `${CWD}/a.html`,
    visual: "atelier-editorial",
    workspace: CWD,
    json: false,
    force: false,
  },
};

const FLAGGED_INTENT = {
  ok: true,
  intent: {
    kind: "export",
    path: `${CWD}/d/a.html`,
    visual: "lyric",
    out: `${CWD}/out/x.html`,
    workspace: CWD,
    json: false,
    force: true,
  },
};

describe("exportIntent", () => {
  it("should default the visual theme to atelier-editorial", () => {
    expect(parse(["export", "a.html"])).toEqual(DEFAULT_INTENT);
  });

  it("should take --visual/--out/--force as absolute paths under cwd", () => {
    expect(
      parse(["export", "d/a.html", "--visual", "lyric", "--out", "out/x.html", "--force"]),
    ).toEqual(FLAGGED_INTENT);
  });

  it("should reject an empty --visual but treat an empty --out as absent", () => {
    expectFailure(["export", "a.html", "--visual", ""], "--visual 不能为空", "export");
    expect(parse(["export", "a.html", "--out", ""])).toEqual(DEFAULT_INTENT);
  });

  it("should reject extra positionals and unknown flags", () => {
    expectFailure(["export"], "export 缺少 <file>", "export");
    expectFailure(
      ["export", "a.html", "b.html"],
      "export 只接受 1 个位置参数，多出 1 个",
      "export",
    );
    // Unknown args pass their bare name through to `run.ts` where the hint is assembled (`未知参数：--tone`); here we only pin the intent layer's verbatim.
    expectFailure(["export", "a.html", "--tone", "x"], "--tone", "export");
  });
});

describe("ioFailureOf", () => {
  it("should fold fs errnos into io_failure instead of leaking the raw code", () => {
    for (const code of ["ENOENT", "EACCES", "ENOSPC"]) {
      const error = ioFailureOf(Object.assign(new Error(code), { code }), "写入", "/tmp/x");
      expect(error.code).toBe("io_failure");
      expect(error.message).not.toContain(code);
      expect(exitCodeOf(error.code)).toBe(3);
    }
  });

  it("should pass an existing HrError through unchanged", () => {
    // A real code like `path_outside_workspace` must not be folded into io_failure.
    const passthrough = ioFailureOf(
      new HrError("path_outside_workspace", "逃逸"),
      "写入",
      "/tmp/x",
    );
    expect(passthrough.code).toBe("path_outside_workspace");
  });
});

describe("print-skip", () => {
  it("should report the explicit skip", () => {
    expect(skipReasonOf({ HREADER_SKIP_CHROME: "1", CHROME_BIN: "/chrome" })).toBe(
      "HREADER_SKIP_CHROME=1（显式跳过）",
    );
  });

  it("should report a failed chrome probe (absent or empty CHROME_BIN)", () => {
    expect(skipReasonOf({})).toBe("找不到 Chrome（设 CHROME_BIN 指向可执行文件）");
    expect(skipReasonOf({ CHROME_BIN: "" })).toBe("找不到 Chrome（设 CHROME_BIN 指向可执行文件）");
  });

  it("should allow the run and always carry the reason in the skip line", () => {
    expect(skipReasonOf({ CHROME_BIN: "/chrome" })).toBeNull();
    expect(skipLineOf("找不到 Chrome")).toBe("SKIPPED: 找不到 Chrome\n");
  });
});
