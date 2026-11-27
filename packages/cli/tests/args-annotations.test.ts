// This layer pins `hr annotations <list|migrate>` argument handling at the parse level:
// `--status` is scoped to `annotations list` — everywhere else it stays `未知参数：--status`,
// exactly like before the option existed (tokenize-phase failures carry no topic).

import { describe, expect, it } from "vitest";

import { expectFailure, parse } from "./args-helpers";

describe("parseArgs · annotations list", () => {
  it("should accept --status with each real filter value", () => {
    for (const status of ["pending", "resolved", "all"]) {
      expect(parse(["annotations", "list", "f.html", "--status", status])).toMatchObject({
        ok: true,
        intent: { kind: "annotationsList", status },
      });
    }
    expect(parse(["annotations", "list", "f.html", "--status=pending"])).toMatchObject({
      ok: true,
      intent: { kind: "annotationsList", status: "pending" },
    });
  });

  it("should default --status to all and reject an unknown value at the intent layer", () => {
    expect(parse(["annotations", "list", "f.html"])).toMatchObject({
      ok: true,
      intent: { status: "all" },
    });
    expectFailure(
      ["annotations", "list", "f.html", "--status", "wat"],
      "--status 必须是 pending | resolved | all 之一",
      "annotations",
    );
    expect(parse(["annotations", "list", "f.html", "--status"])).toEqual({
      ok: false,
      message: "参数 --status 缺少取值",
    });
  });

  it("should keep --status unknown outside annotations list", () => {
    expect(parse(["outline", "f.html", "--status", "x"])).toEqual({
      ok: false,
      message: "未知参数：--status",
    });
    expect(parse(["outline", "f.html", "--status"])).toEqual({
      ok: false,
      message: "未知参数：--status",
    });
    expect(parse(["annotations", "migrate", "f.html", "--status", "x"])).toEqual({
      ok: false,
      message: "未知参数：--status",
    });
    expect(parse(["annotations", "--status", "x", "list", "f.html"])).toEqual({
      ok: false,
      message: "未知参数：--status",
    });
  });
});
