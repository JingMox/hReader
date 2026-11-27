// Interleaving probes for the self-write echo dedupe, replayed by hand through
// the injected event source — every "echo read the new bytes before noteWrite
// ran" ordering is driven deterministically instead of relying on load.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import type { SseEvent } from "../../src/server/contracts";
import { createEventRing, matchRoute } from "../../src/server/index";
import type { EventRing } from "../../src/server/event-ring";
import type { Written } from "../../src/server/handlers";
import { createHub, type Hub } from "../../src/server/hub";
import { revisionOf } from "../../src/server/revision";
import { createRuntime, type Runtime } from "../../src/server/runtime";
import type { WatchFn } from "../../src/server/watcher";
import { nodeStyleDeps } from "../../src/style";
import { requestLike } from "./casts";
import { DOC } from "./harness";

const roots: string[] = [];
const root = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const harnessOf = (
  workspace: string,
  home: string,
): {
  readonly runtime: Runtime;
  readonly hub: Hub;
  readonly ring: EventRing;
  readonly fire: (name: string) => void;
} => {
  const emits: ((event: string, name: string | undefined) => void)[] = [];
  const watch: WatchFn = (_dir, emit, options) => {
    if (!options.recursive) emits.push(emit);
    return { close: () => undefined };
  };
  const ring = createEventRing(32);
  const hub = createHub({ ring, heartbeatMs: 60_000 });
  const runtime = createRuntime(
    { workspace, docId: "doc.html", bodyMs: 1_000, home },
    { patch: nodePatchDeps, style: nodeStyleDeps(workspace), watch },
    hub,
  );
  return {
    runtime,
    hub,
    ring,
    fire: (name) => {
      for (const emit of emits) emit("change", name);
    },
  };
};

const docChanged = (ring: EventRing): readonly SseEvent[] =>
  ring.since(0).events.filter((event) => event.type === "doc.changed");

const revisions = (ring: EventRing): readonly unknown[] =>
  docChanged(ring).map((event) => event.payload["revision"]);

const settle = async (ms = 300): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const waitForFrame = async (ring: EventRing): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (docChanged(ring).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

const reqOf = (body: unknown) => {
  const raw = Buffer.from(JSON.stringify(body));
  const req = requestLike({
    on: (event: string, handler: (chunk?: Buffer) => void) => {
      if (event === "data") handler(raw);
      if (event === "end") handler();
      return req;
    },
  });
  return req;
};

const patchDispatch = (runtime: Runtime, targetId: string, fragment: string) => {
  const matched = matchRoute("POST", "/api/patch");
  if (matched.kind !== "route") throw new Error("patch route did not match");
  return runtime.dispatch(
    matched.route,
    matched.params,
    reqOf({ docId: "doc.html", action: "replace", targetId, fragment }),
  );
};

const writtenOf = (target: Written["target"], revision: string): Written => ({
  reply: { status: 200, headers: {}, body: "" },
  target,
  revision,
  changed: true,
  changedNodes: [],
});

describe("echo dedupe · interleaving probes", () => {
  it("(c) two queued real patches end on the disk revision, each revision announced at most once", async () => {
    const workspace = root("hr-ic-ws-");
    const home = root("hr-ic-home-");
    const file = join(workspace, "doc.html");
    writeFileSync(file, DOC, "utf8");
    const { runtime, hub, ring, fire } = harnessOf(workspace, home);
    try {
      await runtime.remember("doc.html");
      // Two real dispatches queue on the same doc; fs echoes are fired while both are in flight.
      const a = patchDispatch(runtime, "hr-c", '<p data-hr-id="hr-c">甲写</p>');
      const b = patchDispatch(runtime, "hr-d", '<p data-hr-id="hr-d">乙写</p>');
      const sprinkler = setInterval(() => {
        fire("doc.html");
      }, 30);
      const [ra, rb] = await Promise.all([a, b]);
      clearInterval(sprinkler);
      fire("doc.html");
      await settle();
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      const disk = revisionOf(readFileSync(file));
      const frames = docChanged(ring);
      expect(frames.length).toBeGreaterThan(0);
      // No revision may be announced twice (dup-free stream).
      expect(new Set(revisions(ring)).size).toBe(frames.length);
      // The last frame must match what is on disk.
      expect(frames[frames.length - 1]?.payload["revision"]).toBe(disk);
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("(c-inv) probe: an inverted noteWrite order leaves a stale last frame", async () => {
    // Hand-driven boundary probe: same-doc writes are serialized by the doc queue and
    // noteWrite order follows dispatchWrite resolution order, so this ordering should
    // be unreachable through real dispatch — but if it ever happened, the last frame
    // is a stale revision (pre-existing hazard, not introduced by the dedupe).
    const workspace = root("hr-ici-ws-");
    const home = root("hr-ici-home-");
    const file = join(workspace, "doc.html");
    writeFileSync(file, DOC, "utf8");
    const { runtime, hub, ring, fire } = harnessOf(workspace, home);
    try {
      const target = await runtime.remember("doc.html");
      const aBytes = DOC.replace("正文一", "甲写");
      const bBytes = DOC.replace("正文二", "乙写");
      writeFileSync(file, aBytes, "utf8");
      writeFileSync(file, bBytes, "utf8"); // B wins on disk
      const ra = revisionOf(Buffer.from(aBytes));
      const rb = revisionOf(readFileSync(file));
      fire("doc.html");
      await waitForFrame(ring); // echo announces R_B (last disk state)
      await settle();
      // B's noteWrite: dedupe skips (R_B already announced). Then A's runs late.
      runtime.noteWrite(writtenOf(target, rb));
      runtime.noteWrite(writtenOf(target, ra));
      const frames = docChanged(ring);
      // The stream ends on R_A while the disk holds R_B — stale until the next event.
      expect(frames[frames.length - 1]?.payload["revision"]).toBe(ra);
      // A later fs event still converges the reader to the disk revision.
      fire("doc.html");
      await settle();
      const after = docChanged(ring);
      expect(after[after.length - 1]?.payload["revision"]).toBe(rb);
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("(d) an external edit inside the window still gets its frame out", async () => {
    const workspace = root("hr-id-ws-");
    const home = root("hr-id-home-");
    const file = join(workspace, "doc.html");
    writeFileSync(file, DOC, "utf8");
    const { runtime, hub, ring, fire } = harnessOf(workspace, home);
    try {
      const target = await runtime.remember("doc.html");
      // Our patch lands R1; the queued echo announces it before noteWrite runs.
      writeFileSync(file, DOC.replace("正文一", "回声一"), "utf8");
      const r1 = revisionOf(readFileSync(file));
      fire("doc.html");
      await waitForFrame(ring);
      await settle();
      // Write path completes: dedupe skips the second R1 frame.
      runtime.noteWrite(writtenOf(target, r1));
      expect(revisions(ring)).toEqual([r1]);
      // External edit lands afterwards: genuinely different bytes must publish.
      writeFileSync(file, DOC.replace("正文一", "外部改"), "utf8");
      const r2 = revisionOf(readFileSync(file));
      fire("doc.html");
      await settle();
      const revs = revisions(ring);
      expect(revs).toContain(r2);
      expect(revs[revs.length - 1]).toBe(r2);
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("(d2) an external edit landing before the echo read still publishes, then the write path must not erase it", async () => {
    const workspace = root("hr-id2-ws-");
    const home = root("hr-id2-home-");
    const file = join(workspace, "doc.html");
    writeFileSync(file, DOC, "utf8");
    const { runtime, hub, ring, fire } = harnessOf(workspace, home);
    try {
      const target = await runtime.remember("doc.html");
      // Our write R1 then an external R2 land before the echo is read.
      writeFileSync(file, DOC.replace("正文一", "回声一"), "utf8");
      const r1 = revisionOf(readFileSync(file));
      writeFileSync(file, DOC.replace("正文一", "外部改"), "utf8");
      const r2 = revisionOf(readFileSync(file));
      fire("doc.html");
      await waitForFrame(ring);
      await settle();
      // The echo reads R2 (latest bytes) and announces the external revision.
      expect(revisions(ring)).toContain(r2);
      // The write path then publishes its own R1 frame — stale ordering, pre-existing.
      runtime.noteWrite(writtenOf(target, r1));
      const revs = revisions(ring);
      expect(revs[revs.length - 1]).toBe(r1);
      // Convergence still comes from a later event.
      fire("doc.html");
      await settle();
      const after = revisions(ring);
      expect(after[after.length - 1]).toBe(r2);
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("(e) a write still publishes when the active doc switched inside the window", async () => {
    const workspace = root("hr-ie-ws-");
    const home = root("hr-ie-home-");
    const file = join(workspace, "doc.html");
    const other = join(workspace, "other.html");
    writeFileSync(file, DOC, "utf8");
    writeFileSync(other, DOC.replace("正文一", "另一篇"), "utf8");
    const { runtime, hub, ring } = harnessOf(workspace, home);
    try {
      const target = await runtime.remember("doc.html");
      writeFileSync(file, DOC.replace("正文一", "回声一"), "utf8");
      const r1 = revisionOf(readFileSync(file));
      // Active doc switched mid-window.
      await runtime.remember("other.html");
      runtime.noteWrite(writtenOf(target, r1));
      expect(docChanged(ring)).toHaveLength(1);
      expect(revisions(ring)[0]).toBe(r1);
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should still publish when remember silently adopts the written revision inside the window", async () => {
    // Regression probe: remember() bumps state.revision without publishing. If a read
    // route re-remembers the written doc inside the window, the dedupe must not
    // mistake that silent adoption for a watcher-side announce — otherwise the
    // frame is never emitted.
    const workspace = root("hr-ir-ws-");
    const home = root("hr-ir-home-");
    const file = join(workspace, "doc.html");
    const other = join(workspace, "other.html");
    writeFileSync(file, DOC, "utf8");
    writeFileSync(other, DOC.replace("正文一", "另一篇"), "utf8");
    const { runtime, hub, ring, fire } = harnessOf(workspace, home);
    try {
      // The reader is viewing other.html; a write to doc.html is in flight.
      await runtime.remember("other.html");
      // patchFile lands the new bytes on doc.html.
      writeFileSync(file, DOC.replace("正文一", "回声一"), "utf8");
      const r1 = revisionOf(readFileSync(file));
      fire("doc.html");
      await settle();
      // A read route navigates to doc.html mid-window: remember loads it, reads R1,
      // and sets state.revision = R1 without publishing anything.
      const target = await runtime.remember("doc.html");
      // The fs echo now hits the sha gate: R1 === state.revision, silenced.
      fire("doc.html");
      await settle();
      // The write path completes: nothing was ever announced for doc.html, so the
      // frame must go out — silently adopting R1 is not an announcement.
      runtime.noteWrite(writtenOf(target, r1));
      expect(docChanged(ring).length).toBeGreaterThan(0);
      expect(revisions(ring)).toContain(r1);
    } finally {
      runtime.close();
      hub.close();
    }
  });
});
