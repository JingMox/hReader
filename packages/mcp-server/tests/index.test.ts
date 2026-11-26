// This layer: the package entry's export surface — tests and future in-process embedding only know `@hreader/mcp-server` as the surface.

import { describe, expect, it } from "vitest";

import * as entry from "../src/index";

describe("@hreader/mcp-server", () => {
  it("should expose the server factory and the cli seams", () => {
    expect(typeof entry.createServer).toBe("function");
    expect(entry.SERVER_VERSION).toBe("1.1.0");
    expect(typeof entry.modeOf).toBe("function");
    expect(typeof entry.runMain).toBe("function");
    expect(typeof entry.startHttp).toBe("function");
    expect(typeof entry.styleIdsOf).toBe("function");
    expect(entry.STYLE_URI_PREFIX).toBe("hreader://styles/");
    expect(entry.UI_URI_PREFIX).toBe("ui://hreader/view/");
    expect(entry.UI_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(entry.USE_STYLE_PROMPT).toBe("use-hreader-style");
    expect(entry.USAGE).toContain("hreader-mcp");
  });
});
