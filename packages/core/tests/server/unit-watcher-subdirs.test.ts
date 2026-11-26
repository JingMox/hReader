// This layer: the recursive-watch contract — the recursion flag handed to the event
// source, subdirectory event names joined under the watched dir, the isLibraryPath
// noise policy, and burst handling. Injected sources + fake timers keep it deterministic.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { createEventRing } from "../../src/server/event-ring";
import { createHub } from "../../src/server/hub";
import { createRuntime } from "../../src/server/runtime";
import {
  createWatcher,
  DEBOUNCE_MS,
  isLibraryPath,
  type WatchFn,
  type WatchOptions,
} from "../../src/server/watcher";
import { nodeStyleDeps } from "../../src/style";
import { disposeWatchers, watcherLike } from "./casts";

type OnEvent = (event: string, name: string | undefined) => void;

const DOC = '<article data-hr-id="hr-a"><p data-hr-id="hr-b">一</p></article>';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  disposeWatchers();
  vi.useRealTimers();
});

const withFakeTimers = (run: () => void): void => {
  vi.useFakeTimers();
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
};

/** Injected event source: `fires` dispatches by hand, `mounts` records every
 *  `watchFn(dir, onEvent, options)` invocation so the recursion flag is observable. */
const fakeSource = (): {
  readonly fires: OnEvent[];
  readonly mounts: { readonly dir: string; readonly options: WatchOptions }[];
  readonly watch: WatchFn;
} => {
  const fires: OnEvent[] = [];
  const mounts: { dir: string; options: WatchOptions }[] = [];
  return {
    fires,
    mounts,
    watch: (dir, onEvent, options) => {
      fires.push(onEvent);
      mounts.push({ dir, options });
      return { close: () => undefined };
    },
  };
};

describe("isLibraryPath · content vs internal paths", () => {
  const root = join("tmp", "ws");

  it.each([
    "a.html",
    join("sub", "a.html"),
    join("a", "very", "deep", "nested", "file.html"),
    join("笔记 目录", "子🗂目录", "文 件.html"),
  ])("should accept the ordinary library path %s", (rel) => {
    expect(isLibraryPath(root, join(root, rel))).toBe(true);
  });

  it.each([
    ".hreader",
    join(".hreader", "history", "x.html"),
    join("sub", ".hreader", "x.html"),
    join(".git", "index"),
    join("sub", ".git", "objects", "pack"),
    join("node_modules", "pkg", "index.js"),
    join("sub", "deep", "node_modules", "pkg", "index.js"),
  ])("should reject the internal path %s", (rel) => {
    expect(isLibraryPath(root, join(root, rel))).toBe(false);
  });

  it("should reject a path escaping the watch root", () => {
    expect(isLibraryPath(root, join(root, "..", "outside.html"))).toBe(false);
  });

  it("should accept the root itself so the watch root is never ignored", () => {
    expect(isLibraryPath(root, root)).toBe(true);
  });
});

describe("isLibraryPath · temp-name leaf rules", () => {
  const root = join("tmp", "ws");

  it.each([
    ".hr-tmp.1.abc.doc.html",
    "doc.html.7654321",
    join("sub", "doc.html.123456"),
    "doc.html~",
    join("sub", "backup~"),
  ])("should reject the temp-shaped leaf %s", (rel) => {
    expect(isLibraryPath(root, join(root, rel))).toBe(false);
  });

  it.each(["doc.html.2024", join("drafts.202410", "notes.html"), join("backup~", "x.html")])(
    "should accept %s because the temp rule only applies to the leaf",
    (rel) => {
      expect(isLibraryPath(root, join(root, rel))).toBe(true);
    },
  );
});

describe("createWatcher · recursion flag handed to the source", () => {
  it("should request a recursive source for a whole-directory watch", () => {
    const { mounts, watch } = fakeSource();
    const watcher = createWatcher({ onFileChange: () => undefined }, watch);
    try {
      watcher.add("/tmp/dir", undefined);
      expect(mounts.map((mount) => mount.options)).toEqual([{ recursive: true }]);
    } finally {
      watcher.close();
    }
  });

  it("should request a non-recursive source for a single-file watch", () => {
    const { mounts, watch } = fakeSource();
    const watcher = createWatcher({ onFileChange: () => undefined }, watch);
    try {
      watcher.add("/tmp/dir", "a.html");
      expect(mounts.map((mount) => mount.options)).toEqual([{ recursive: false }]);
    } finally {
      watcher.close();
    }
  });
});

describe("createWatcher · subdirectory event delivery", () => {
  it("should deliver a nested event as the path joined under the watched dir", () => {
    withFakeTimers(() => {
      const { fires, watch } = fakeSource();
      const changes: string[] = [];
      const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
      try {
        watcher.add("/tmp/dir", undefined);
        fires[0]?.("change", join("sub", "inner.html"));
        vi.advanceTimersByTime(DEBOUNCE_MS * 2);
        expect(changes).toEqual([join("/tmp/dir", "sub", "inner.html")]);
      } finally {
        watcher.close();
      }
    });
  });

  it("should drop an event carrying an empty name instead of reporting the root itself", () => {
    withFakeTimers(() => {
      const { fires, watch } = fakeSource();
      const changes: string[] = [];
      const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
      try {
        watcher.add("/tmp/dir", undefined);
        fires[0]?.("change", "");
        vi.advanceTimersByTime(DEBOUNCE_MS * 2);
        expect(changes).toEqual([]);
      } finally {
        watcher.close();
      }
    });
  });

  it("should deliver each file exactly once under a wide burst from a single mount", () => {
    withFakeTimers(() => {
      const { fires, watch } = fakeSource();
      const changes: string[] = [];
      const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, watch);
      try {
        watcher.add("/tmp/dir", undefined);
        const names: string[] = [];
        for (let index = 0; index < 300; index += 1) {
          names.push(join(`dir${String(index % 12)}`, `f${String(index)}.html`));
        }
        for (const name of names) fires[0]?.("add", name);
        vi.advanceTimersByTime(DEBOUNCE_MS * 2);
        // One mounted source covers the whole subtree — no per-file mounts, no repeats.
        expect(fires).toHaveLength(1);
        expect(new Set(changes).size).toBe(names.length);
        expect(changes).toEqual(names.map((name) => join("/tmp/dir", name)));
      } finally {
        watcher.close();
      }
    });
  });
});

describe("runtime · subdirectory event routing", () => {
  const ringOf = (): {
    ring: ReturnType<typeof createEventRing>;
    hub: ReturnType<typeof createHub>;
  } => {
    const ring = createEventRing(16);
    return { ring, hub: createHub({ ring, heartbeatMs: 60_000 }) };
  };

  const waitFor = async (ready: () => boolean, budgetMs = 3000): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    while (!ready() && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  };

  interface Mount {
    readonly dir: string;
    readonly options: WatchOptions;
    readonly fire: OnEvent;
  }

  /** Every mount fires every event: file watches name-filter themselves, so the
   *  directory watch receives the relative path and file watches the basename. */
  const runtimeOf = (
    workspace: string,
  ): {
    runtime: ReturnType<typeof createRuntime>;
    hub: ReturnType<typeof createHub>;
    ring: ReturnType<typeof createEventRing>;
    mounts: Mount[];
  } => {
    const { ring, hub } = ringOf();
    const mounts: Mount[] = [];
    const watch: WatchFn = (dir, onEvent, options) => {
      const mount: Mount = { dir, options, fire: onEvent };
      mounts.push(mount);
      return watcherLike();
    };
    const runtime = createRuntime(
      { workspace, docId: "doc.html", bodyMs: 200 },
      {
        patch: nodePatchDeps,
        style: nodeStyleDeps(workspace),
        watch,
      },
      hub,
    );
    return { runtime, hub, ring, mounts };
  };

  it("should publish doc.changed — not library.changed — for the active doc inside a subdirectory", async () => {
    const workspace = tmp("hr-subdir-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "sub", "inner.html"), DOC, "utf8");
    const { runtime, hub, ring, mounts } = runtimeOf(workspace);
    try {
      await waitFor(() => mounts.length >= 1);
      await runtime.remember("sub/inner.html");
      writeFileSync(join(workspace, "sub", "inner.html"), `${DOC}\r\n<!-- external -->`, "utf8");
      // The recursive directory watch reports the workspace-relative name while the
      // file watch mounted during remember reports the basename — both must route
      // to doc.changed through the same realPath comparison.
      for (const mount of mounts) mount.fire("change", join("sub", "inner.html"));
      mounts.at(-1)?.fire("change", "inner.html");
      await waitFor(() => ring.since(0).events.length > 0);
      const events = ring.since(0).events;
      const types = events.map((event) => event.type);
      expect(types).toContain("doc.changed");
      expect(types).not.toContain("library.changed");
      expect(JSON.stringify(events[0]?.payload)).toContain('"docId":"sub/inner.html"');
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should publish library.changed carrying the relative path for a nested file", async () => {
    const workspace = tmp("hr-libsub-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    const { runtime, hub, ring, mounts } = runtimeOf(workspace);
    try {
      await waitFor(() => mounts.length >= 1);
      for (const mount of mounts) mount.fire("add", join("sub", "deep", "new.html"));
      await waitFor(() => ring.since(0).events.length > 0);
      const events = ring.since(0).events;
      expect(events[0]?.type).toBe("library.changed");
      expect(events[0]?.payload["path"]).toBe("sub/deep/new.html");
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should publish library.changed for a neighboring subdirectory file while a subdirectory doc is active", async () => {
    const workspace = tmp("hr-neighbor-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "sub", "inner.html"), DOC, "utf8");
    const { runtime, hub, ring, mounts } = runtimeOf(workspace);
    try {
      await waitFor(() => mounts.length >= 1);
      await runtime.remember("sub/inner.html");
      for (const mount of mounts) mount.fire("change", join("sub", "other.html"));
      await waitFor(() => ring.since(0).events.length > 0);
      const events = ring.since(0).events;
      expect(events[0]?.type).toBe("library.changed");
      expect(events[0]?.payload["path"]).toBe("sub/other.html");
      expect(events.some((event) => event.type === "doc.changed")).toBe(false);
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should stay silent for events under .git and node_modules", async () => {
    const workspace = tmp("hr-internals-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    const { runtime, hub, ring, mounts } = runtimeOf(workspace);
    try {
      await waitFor(() => mounts.length >= 1);
      for (const mount of mounts) {
        mount.fire("change", join(".git", "index"));
        mount.fire("change", join("node_modules", "pkg", "index.js"));
        mount.fire("change", join("sub", ".hreader", "state.json"));
        mount.fire("change", "marker.html");
      }
      await waitFor(() => ring.since(0).events.length > 0);
      const events = ring.since(0).events;
      expect(events.map((event) => event.type)).toEqual(["library.changed"]);
      expect(events[0]?.payload["path"]).toBe("marker.html");
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should stay silent for an event path escaping the workspace root", async () => {
    const workspace = tmp("hr-escape-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    const { runtime, hub, ring, mounts } = runtimeOf(workspace);
    try {
      await waitFor(() => mounts.length >= 1);
      for (const mount of mounts) {
        mount.fire("change", join("..", "escape.html"));
        mount.fire("change", "marker.html");
      }
      await waitFor(() => ring.since(0).events.length > 0);
      const events = ring.since(0).events;
      expect(events.map((event) => event.type)).toEqual(["library.changed"]);
      expect(events[0]?.payload["path"]).toBe("marker.html");
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should still route doc.changed for an active doc inside node_modules", async () => {
    const workspace = tmp("hr-nmdoc-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(workspace, "node_modules", "pkg", "doc.html"), DOC, "utf8");
    const { runtime, hub, ring, mounts } = runtimeOf(workspace);
    try {
      await waitFor(() => mounts.length >= 1);
      await runtime.remember(join("node_modules", "pkg", "doc.html"));
      writeFileSync(
        join(workspace, "node_modules", "pkg", "doc.html"),
        `${DOC}\r\n<!-- external -->`,
        "utf8",
      );
      // The file watch mounted during remember is the newest mount; its basename
      // event must route to doc.changed even though the path carries an internal
      // segment (internal filtering only applies to the library listing, not to
      // the realPath comparison for the active document).
      mounts.at(-1)?.fire("change", "doc.html");
      await waitFor(() => ring.since(0).events.length > 0);
      const events = ring.since(0).events;
      const types = events.map((event) => event.type);
      expect(types).toContain("doc.changed");
      expect(types).not.toContain("library.changed");
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should keep doc.changed routing under a symlinked workspace for a doc inside a subdirectory", async () => {
    const realWs = tmp("hr-linksub-real-");
    mkdirSync(join(realWs, "sub"));
    writeFileSync(join(realWs, "sub", "inner.html"), DOC, "utf8");
    const linkRoot = tmp("hr-linksub-root-");
    const linkWs = join(linkRoot, "ws-link");
    symlinkSync(realWs, linkWs);
    const { runtime, hub, ring, mounts } = runtimeOf(linkWs);
    try {
      await waitFor(() => mounts.length >= 1);
      await runtime.remember("sub/inner.html");
      writeFileSync(join(realWs, "sub", "inner.html"), `${DOC}\r\n<!-- external -->`, "utf8");
      for (const mount of mounts) mount.fire("change", join("sub", "inner.html"));
      mounts.at(-1)?.fire("change", "inner.html");
      await waitFor(() => ring.since(0).events.length > 0);
      const events = ring.since(0).events;
      const types = events.map((event) => event.type);
      expect(types).toContain("doc.changed");
      expect(types).not.toContain("library.changed");
      expect(JSON.stringify(events[0]?.payload)).toContain('"docId":"sub/inner.html"');
    } finally {
      runtime.close();
      hub.close();
    }
  });
});
