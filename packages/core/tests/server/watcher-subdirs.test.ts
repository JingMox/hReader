// This layer: recursive directory watching against the real filesystem — subdirectory
// add/change/unlink/rename, deep nesting, unicode directory names, ignored internals,
// and symlink boundaries. Real chokidar (an injected source cannot exercise traversal);
// waits poll SSE frames — bounded retries, never blind sleeps.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cookieOf,
  DOC,
  defaultSeed,
  httpCall,
  openSse,
  type SseFrame,
  withServer,
} from "./harness";
import { withPost } from "./wire";

const settle = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const LIBRARY_WAIT_MS = 5000;

/**
 * `act` may be re-run inside a bounded window: a write landing inside the watcher's
 * mount blind window is legitimately invisible to the event source, so the action is
 * retried until its `library.changed` frame shows up — instead of assuming delivery.
 */
const actUntilLibraryFrame = async (
  sse: { readonly frames: readonly SseFrame[] },
  needle: string,
  act: () => void,
): Promise<SseFrame> => {
  const deadline = Date.now() + LIBRARY_WAIT_MS;
  for (;;) {
    act();
    const windowEnd = Math.min(Date.now() + 800, deadline);
    while (Date.now() < windowEnd) {
      const hit = sse.frames.find(
        (frame) => frame.event === "library.changed" && frame.data.includes(needle),
      );
      if (hit !== undefined) return hit;
      await settle(20);
    }
    if (Date.now() >= deadline) break;
  }
  throw new Error(
    `no library.changed frame carrying ${needle}; frames=${JSON.stringify(sse.frames)}`,
  );
};

const subSeed = (workspace: string): void => {
  defaultSeed(workspace);
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "sub", "inner.html"), DOC, "utf8");
};

describe("watcher · subdirectory writes broadcast library.changed", () => {
  it("should broadcast library.changed carrying the relative path when a file is created in a subdirectory", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const frame = await actUntilLibraryFrame(sse, "sub/new.html", () => {
        writeFileSync(join(ctx.workspace, "sub", "new.html"), DOC, "utf8");
      });
      sse.close();

      expect(frame.data).toContain('"path":"sub/new.html"');
    }, subSeed);
  });

  it("should broadcast library.changed when a subdirectory file is modified", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const frame = await actUntilLibraryFrame(sse, "sub/inner.html", () => {
        writeFileSync(
          join(ctx.workspace, "sub", "inner.html"),
          `${DOC}\r\n<!-- modified -->`,
          "utf8",
        );
      });
      sse.close();

      expect(frame.data).toContain('"path":"sub/inner.html"');
    }, subSeed);
  });

  it("should broadcast library.changed when a subdirectory file is deleted", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const file = join(ctx.workspace, "sub", "inner.html");
      const frame = await actUntilLibraryFrame(sse, "sub/inner.html", () => {
        // Recreate before removing so a retry still produces a real unlink.
        writeFileSync(file, DOC, "utf8");
        unlinkSync(file);
      });
      sse.close();

      expect(frame.data).toContain('"path":"sub/inner.html"');
    }, subSeed);
  });

  it("should broadcast library.changed for both sides of a rename inside a subdirectory", async () => {
    await withServer(
      async (ctx) => {
        const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
        await sse.waitFor(1);
        const from = join(ctx.workspace, "sub", "old.html");
        const to = join(ctx.workspace, "sub", "new.html");
        await actUntilLibraryFrame(sse, "sub/new.html", () => {
          if (!existsSync(from)) writeFileSync(from, DOC, "utf8");
          renameSync(from, to);
        });
        await settle(400);
        sse.close();

        expect(
          sse.frames.some(
            (frame) => frame.event === "library.changed" && frame.data.includes("sub/old.html"),
          ),
        ).toBe(true);
      },
      (workspace) => {
        subSeed(workspace);
        writeFileSync(join(workspace, "sub", "old.html"), DOC, "utf8");
      },
    );
  });

  it("should broadcast library.changed for a file four levels deep", async () => {
    await withServer(
      async (ctx) => {
        const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
        await sse.waitFor(1);
        const frame = await actUntilLibraryFrame(sse, "a/b/c/d/deep.html", () => {
          writeFileSync(join(ctx.workspace, "a", "b", "c", "d", "deep.html"), DOC, "utf8");
        });
        sse.close();

        expect(frame.data).toContain('"path":"a/b/c/d/deep.html"');
      },
      (workspace) => {
        defaultSeed(workspace);
        mkdirSync(join(workspace, "a", "b", "c", "d"), { recursive: true });
      },
    );
  });

  it("should broadcast library.changed when a new folder is created in a subdirectory and a file written into it", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const frame = await actUntilLibraryFrame(sse, "sub/fresh/x.html", () => {
        mkdirSync(join(ctx.workspace, "sub", "fresh"), { recursive: true });
        writeFileSync(join(ctx.workspace, "sub", "fresh", "x.html"), DOC, "utf8");
      });
      sse.close();

      expect(frame.data).toContain('"path":"sub/fresh/x.html"');
    }, subSeed);
  });

  it("should broadcast library.changed for files under directories containing CJK, emoji, and spaces", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const names = ["笔记 目录", "emoji 🗂", "with space"];
      for (const name of names) {
        mkdirSync(join(ctx.workspace, name), { recursive: true });
        const frame = await actUntilLibraryFrame(sse, `${name}/x.html`, () => {
          writeFileSync(join(ctx.workspace, name, "x.html"), DOC, "utf8");
        });
        expect(frame.data).toContain(`"path":"${name}/x.html"`);
      }
      sse.close();
    });
  });

  it("should publish doc.changed — not library.changed — when the opened subdirectory doc is edited externally", async () => {
    await withServer(async (ctx) => {
      const opened = await httpCall(ctx.port, {
        path: "/api/doc/sub%2Finner.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(opened.status).toBe(200);
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeFileSync(
        join(ctx.workspace, "sub", "inner.html"),
        `${DOC}\r\n<!-- external -->`,
        "utf8",
      );
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(frame.data).toContain('"docId":"sub/inner.html"');
      expect(
        sse.frames.some(
          (item) => item.event === "library.changed" && item.data.includes("inner.html"),
        ),
      ).toBe(false);
    }, subSeed);
  });
});

describe("watcher · internals and temp names stay silent", () => {
  const noiseSeed = (workspace: string): void => {
    defaultSeed(workspace);
    mkdirSync(join(workspace, ".hreader", "history"), { recursive: true });
    mkdirSync(join(workspace, ".git", "objects"), { recursive: true });
    mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
  };

  it("should stay silent for writes inside .hreader, .git, and node_modules", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeFileSync(join(ctx.workspace, ".hreader", "history", "x.html"), DOC, "utf8");
      writeFileSync(join(ctx.workspace, ".git", "objects", "obj.html"), DOC, "utf8");
      writeFileSync(join(ctx.workspace, "node_modules", "pkg", "deep.html"), DOC, "utf8");
      const marker = await actUntilLibraryFrame(sse, "marker.html", () => {
        writeFileSync(join(ctx.workspace, "marker.html"), `${DOC}m`, "utf8");
      });
      expect(marker.data).toContain('"path":"marker.html"');
      await settle(500);
      sse.close();

      const leaked = sse.frames.filter(
        (frame) =>
          frame.data.includes(".hreader") ||
          frame.data.includes(".git") ||
          frame.data.includes("node_modules"),
      );
      expect(leaked).toEqual([]);
    }, noiseSeed);
  });

  it("should not broadcast library.changed for hReader's own .hreader churn during a patch", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const patch = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: JSON.stringify({
          docId: "doc.html",
          action: "append",
          targetId: "hr-d",
          fragment: "<b>x</b>",
        }),
      });
      expect(patch.status).toBe(200);
      await sse.waitForEvent("doc.changed");
      await settle(500);
      sse.close();

      const leaked = sse.frames.filter(
        (frame) => frame.event === "library.changed" && frame.data.includes(".hreader"),
      );
      expect(leaked).toEqual([]);
    });
  });

  it("should stay silent for atomic temp names inside subdirectories but still report their real neighbors", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeFileSync(join(ctx.workspace, "sub", "doc.html.7654321"), DOC, "utf8");
      writeFileSync(join(ctx.workspace, "sub", ".hr-tmp.7.abcdef.doc.html"), DOC, "utf8");
      // A temp-shaped *directory* name does not make its contents noise: the residue
      // rule only applies to leaf file names, like atomic.ts's own convention.
      mkdirSync(join(ctx.workspace, "sub", "drafts.202410"), { recursive: true });
      const control = await actUntilLibraryFrame(sse, "sub/drafts.202410/f.html", () => {
        writeFileSync(join(ctx.workspace, "sub", "drafts.202410", "f.html"), DOC, "utf8");
      });
      expect(control.data).toContain('"path":"sub/drafts.202410/f.html"');
      await settle(500);
      sse.close();

      const leaked = sse.frames.filter(
        (frame) => frame.data.includes(".hr-tmp") || frame.data.includes("doc.html.7654321"),
      );
      expect(leaked).toEqual([]);
    }, subSeed);
  });
});

describe("watcher · symlink boundaries", () => {
  it("should not broadcast library.changed for writes inside a symlink pointing outside the workspace", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "hr-outside-")));
    try {
      await withServer(async (ctx) => {
        symlinkSync(outside, join(ctx.workspace, "out-link"));
        const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
        await sse.waitFor(1);
        writeFileSync(join(outside, "secret.html"), DOC, "utf8");
        const marker = await actUntilLibraryFrame(sse, "marker.html", () => {
          writeFileSync(join(ctx.workspace, "marker.html"), `${DOC}m`, "utf8");
        });
        expect(marker.data).toContain('"path":"marker.html"');
        await settle(500);
        sse.close();

        const leaked = sse.frames.filter(
          (frame) => frame.data.includes("secret") || frame.data.includes("out-link/"),
        );
        expect(leaked).toEqual([]);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("should keep serving and watching normally when the workspace contains a symlink cycle", async () => {
    await withServer(
      async (ctx) => {
        const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
        await sse.waitFor(1);
        const frame = await actUntilLibraryFrame(sse, "marker.html", () => {
          writeFileSync(join(ctx.workspace, "marker.html"), `${DOC}m`, "utf8");
        });
        const health = await httpCall(ctx.port, { path: "/healthz" });
        await settle(400);
        sse.close();

        expect(frame.data).toContain('"path":"marker.html"');
        expect(health.status).toBe(200);
        expect(
          sse.frames.some((item) => item.data.includes("loop-a/") || item.data.includes("loop-b/")),
        ).toBe(false);
      },
      (workspace) => {
        defaultSeed(workspace);
        // a → b and b → a: traversal must give up on the pair instead of looping.
        symlinkSync(join(workspace, "loop-b"), join(workspace, "loop-a"));
        symlinkSync(join(workspace, "loop-a"), join(workspace, "loop-b"));
      },
    );
  });
});
