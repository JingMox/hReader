// This layer covers the annotate integration inside `widgets/foreign`:
// optional mounting, the forced `allow-scripts` sandbox while annotate mode
// is active, single-use-token refresh instead of `?r=` reloads, the blocked
// navigation delegation, `annotationsChanged`, and the destroy cascade.

import { describe, expect, it } from "vitest";

import type { AnnotateEnv, AnnotateIo } from "../src/widgets/annotate.ts";
import { mountForeign, type DocPermissions, type ForeignDeps } from "../src/widgets/foreign.ts";
import { createFakeHost, type FakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";
const FRAME = `${ROOT} #hr-foreign-frame`;
const BTN = `${ROOT} #hr-annotate-btn`;
const POP = `${ROOT} #hr-annotate-pop`;

const permsOf = (over: Partial<DocPermissions> = {}): DocPermissions => ({
  scripts: false,
  network: false,
  scriptsSource: "doc",
  networkSource: "doc",
  modes: { scripts: "per-doc", network: "per-doc" },
  ...over,
});

const attrsOf = (fake: FakeHost, selector: string, name: string): readonly string[] =>
  fake.calls
    .filter((call) => call.op === "attr" && call.args[0] === selector && call.args[1] === name)
    .map((call) => call.args[2] ?? "");

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const annotateDeps = (): {
  readonly annotate: { readonly io: AnnotateIo; readonly env: AnnotateEnv };
  readonly mints: () => number;
  readonly lists: () => number;
  readonly offs: string[];
} => {
  let mints = 0;
  let lists = 0;
  const offs: string[] = [];
  const io: AnnotateIo = {
    mint: () => {
      mints += 1;
      return Promise.resolve(`/f/cap/frame?at=t${String(mints)}`);
    },
    list: () => {
      lists += 1;
      return Promise.resolve([]);
    },
    add: () => Promise.resolve(),
  };
  const env: AnnotateEnv = {
    onMessage: () => () => {
      offs.push("message");
    },
    frameWindow: () => ({}),
    postToFrame: () => undefined,
    frameRect: () => undefined,
    viewport: () => ({ width: 1024, height: 768 }),
  };
  return {
    annotate: { io, env },
    mints: () => mints,
    lists: () => lists,
    offs,
  };
};

const depsOf = (fake: FakeHost, over: Partial<ForeignDeps> = {}): ForeignDeps => ({
  host: fake.host,
  parent: ROOT,
  docId: "doc.html",
  info: { cls: "foreign", scripts: true, permissions: permsOf(), frameUrl: "/f/cap/doc.html" },
  setPermissions: (patch) => Promise.resolve({ ...permsOf(), ...patch }),
  normalize: () => Promise.resolve(),
  theme: undefined,
  ...over,
});

const enter = async (fake: FakeHost): Promise<void> => {
  fake.fire(BTN, "click", {});
  await tick();
};

describe("foreign · annotate integration", () => {
  it("should mount no annotate surface without the dep", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake));
    expect(fake.calls.filter((c) => c.args.some((a) => a.includes("annotate")))).toHaveLength(0);
  });

  it("should paint the annotate button for foreign docs and hide it for normalizable", () => {
    const { annotate } = annotateDeps();
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { annotate }));
    expect(attrsOf(fake, BTN, "hidden")).toContain("<removed>");

    const fake2 = createFakeHost();
    mountForeign(
      depsOf(fake2, {
        annotate,
        info: { cls: "normalizable", scripts: false, frameUrl: "/f/cap/n.html" },
      }),
    );
    expect(attrsOf(fake2, BTN, "hidden")).toContain("");
  });

  it("should force allow-scripts while active and restore the permission sandbox on exit", async () => {
    const { annotate } = annotateDeps();
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { annotate }));
    // Baseline: scripts denied → empty sandbox at mount.
    expect(attrsOf(fake, FRAME, "sandbox")).toEqual([""]);

    await enter(fake);
    const sandboxWrites = attrsOf(fake, FRAME, "sandbox");
    expect(sandboxWrites.at(-1)).toBe("allow-scripts");
    const srcs = attrsOf(fake, FRAME, "src");
    expect(srcs.at(-1)).toBe("/f/cap/frame?at=t1");

    fake.fire(BTN, "click", {}); // exit → permission sandbox + doc URL restored
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/f/cap/doc.html");
  });

  it("should re-mint on refresh instead of a cache-bust reload while active", async () => {
    const { annotate, mints } = annotateDeps();
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake, { annotate }));
    await enter(fake);
    handle.refresh();
    await tick();
    expect(mints()).toBe(2);
    // The annotate frame URL is single-use: a second minted URL, never `?r=`.
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/f/cap/frame?at=t2");

    // Inactive: refresh is the normal cache-bust reload.
    fake.fire(BTN, "click", {}); // exit
    handle.refresh("rev9");
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/f/cap/doc.html?r=rev9");
  });

  it("should delegate a blocked frame navigation to annotate refresh while active", async () => {
    const { annotate, mints } = annotateDeps();
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { annotate }));
    await enter(fake);
    // Burn the expected-load bookkeeping: mount nav + annotate nav = 2 credits.
    fake.fire(FRAME, "load", {});
    fake.fire(FRAME, "load", {});
    // A document-driven navigation with network denied → blocked, annotate re-mints.
    fake.fire(FRAME, "load", {});
    await tick();
    expect(mints()).toBe(2);
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/f/cap/frame?at=t2");
  });

  it("should keep allow-scripts through syncInfo repaints while active", async () => {
    const { annotate } = annotateDeps();
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake, { annotate }));
    await enter(fake);
    handle.syncInfo({
      cls: "foreign",
      scripts: true,
      permissions: permsOf(), // still scripts off; sandbox must not drop to ""
      frameUrl: "/f/cap/doc.html",
    });
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("allow-scripts");
  });

  it("should forward annotationsChanged only to an active annotate widget", async () => {
    const { annotate, lists } = annotateDeps();
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake, { annotate }));
    handle.annotationsChanged(); // inactive → dropped inside annotate
    await tick();
    expect(lists()).toBe(0);

    await enter(fake);
    handle.annotationsChanged();
    await tick();
    expect(lists()).toBe(1);
  });

  it("should cascade destroy into the annotate widget", async () => {
    const { annotate, offs } = annotateDeps();
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake, { annotate }));
    await enter(fake);
    handle.destroy();
    expect(offs).toContain("message");
    expect(attrsOf(fake, BTN, "hidden").at(-1)).toBe("");
    expect(attrsOf(fake, POP, "hidden").at(-1)).toBe("");
  });
});
