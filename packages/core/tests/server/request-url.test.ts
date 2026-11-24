// 这层管：`runtime.dispatch` 对"手搓请求对象"的防线——`req.url` 缺失时给 400，
// 而不是把一个永远进不去的 `?? "/"` 默认值留在生产代码里（P0-3 收口后的显式守卫）。
// 真 `createRuntime` + 真 fs，只把 `req` 换成不含 `url` 的 `IncomingMessage`。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createEventRing } from "../../src/server/event-ring";
import { createHub } from "../../src/server/hub";
import { nodePatchDeps } from "../../src/io/node-fs";
import { createRuntime } from "../../src/server/runtime";
import { nodeStyleDeps } from "../../src/style";
import { disposeWatchers, requestLike, watcherLike } from "./casts";

const roots: string[] = [];
afterAll(() => {
  disposeWatchers();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const runtimeOf = (): { dispose: () => void; runtime: ReturnType<typeof createRuntime> } => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-nourl-")));
  roots.push(workspace);
  writeFileSync(join(workspace, "doc.html"), "<!doctype html><article id='a'>x</article>", "utf8");
  const hub = createHub({ ring: createEventRing(4), heartbeatMs: 60_000 });
  const runtime = createRuntime(
    { workspace, docId: "doc.html", bodyMs: 200 },
    { patch: nodePatchDeps, style: nodeStyleDeps(workspace), watch: () => watcherLike() },
    hub,
  );
  return {
    runtime,
    dispose: () => {
      runtime.close();
      hub.close();
    },
  };
};

describe("runtime · 静态路由缺 req.url → 400 invalid_request", () => {
  it.each(["home", "assets", "theme", "themes"] as const)(
    "should reject a %s route without a URL",
    async (kind) => {
      const { runtime, dispose } = runtimeOf();
      const reply = await runtime.dispatch(
        { method: "GET", segments: [], auth: "none", kind },
        {},
        requestLike({ url: undefined }),
      );
      dispose();

      expect(reply.status).toBe(400);
      expect(String(reply.body)).toContain("invalid_request");
      expect(String(reply.body)).toContain("请求行缺少 URL");
    },
  );

  it("should still serve a normal home request that carries a URL", async () => {
    const { runtime, dispose } = runtimeOf();

    {
      const req = requestLike({
        url: "/?doc=doc.html",
        method: "GET",
        headers: { host: "127.0.0.1:1" },
      });
      const reply = await runtime.dispatch(
        { method: "GET", segments: [], auth: "none", kind: "home" },
        {},
        req,
      );

      expect(reply.status).toBe(200);
      dispose();
    }
  });
});
