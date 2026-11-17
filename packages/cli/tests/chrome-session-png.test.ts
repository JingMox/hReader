// 这层管：`renderPngOf` 的进程内成功路径（视口参数如何落到 CDP、进程组与临时目录是否收拾干净）。
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderPngOf } from "../src/chrome/session";
import { DEVTOOLS_LINE, NEVER, renderSetupOf } from "./chrome-session-setup";

describe("renderPngOf · 成功路径", () => {
  it("把整页高交给 setDeviceMetricsOverride，并按 scale 折算设备像素", async () => {
    const setup = renderSetupOf({ contentHeight: 900.4 });
    const pending = renderPngOf({
      html: "<p>x</p>",
      width: 800,
      scale: 2,
      maxHeight: 20_000,
      stop: NEVER,
      timeoutMs: 1000,
      deps: setup.deps,
    });
    setup.fake.stderr(DEVTOOLS_LINE);
    const image = await pending;
    expect([image.width, image.height, image.clipped]).toEqual([1600, 1802, false]);
    expect(existsSync(setup.dirs[0] ?? "")).toBe(false);
    expect(setup.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
