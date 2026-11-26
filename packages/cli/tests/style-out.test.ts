// This layer covers whether `--out` lands on the discovery chain (`isDiscoveredStylePath`) — pure path comparison, two true and two false cases.

import { describe, expect, it } from "vitest";

import { nodeStyleDeps } from "@hreader/core";

import { isDiscoveredStylePath, undiscoveredHint } from "../src/style-out";

const depsOf = (workspace: string) => ({ ...nodeStyleDeps(workspace), home: "/home/u" });

describe("isDiscoveredStylePath", () => {
  const deps = depsOf("/work/doc");

  it("should accept the project-level .hreader/style.yaml", () => {
    expect(isDiscoveredStylePath("/work/doc/.hreader/style.yaml", "my-voice", deps)).toBe(true);
  });

  it("should accept the user-level ~/.hreader/styles/<id>/style.yaml", () => {
    expect(
      isDiscoveredStylePath("/home/u/.hreader/styles/my-voice/style.yaml", "my-voice", deps),
    ).toBe(true);
  });

  it("should normalize a path that walks through its own parent", () => {
    expect(
      isDiscoveredStylePath("/work/doc/.hreader/../.hreader/style.yaml", "my-voice", deps),
    ).toBe(true);
  });

  it("should accept the project path even when the requested id differs", () => {
    // Which id a project-level file names is checked by the load layer; the path itself is the only thing here (effective only for the same id).
    expect(isDiscoveredStylePath("/work/doc/.hreader/style.yaml", "other-id", deps)).toBe(true);
  });

  it("should reject a sibling export dir such as styles/<id>.yaml", () => {
    expect(isDiscoveredStylePath("/work/doc/styles/my-voice.yaml", "my-voice", deps)).toBe(false);
  });

  it("should reject a user path whose file name is not style.yaml", () => {
    expect(
      isDiscoveredStylePath("/home/u/.hreader/styles/my-voice/copy.yaml", "my-voice", deps),
    ).toBe(false);
  });
});

describe("undiscoveredHint", () => {
  it("should name both discovered targets", () => {
    const hint = undiscoveredHint(
      "/work/doc/styles/my-voice.yaml",
      "my-voice",
      depsOf("/work/doc"),
    );

    expect(hint).toContain("/work/doc/.hreader/style.yaml");
    expect(hint).toContain("/home/u/.hreader/styles/my-voice/style.yaml");
    expect(hint).not.toContain("错误");
  });
});
