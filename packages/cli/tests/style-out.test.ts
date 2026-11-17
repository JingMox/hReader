// 这层管：`--out` 落点是否落在发现链上（`isDiscoveredStylePath`）——纯路径比较，两组真两组假。

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
    // 项目级文件里写哪个 id 由加载层比对，路径本身只有一个（同 id 才生效）。
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
