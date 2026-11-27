// This layer: resolveNewTarget — path resolution for "the target may not exist yet" (io/paths.ts).
// Same lexical gates as resolveTarget; the only difference is the boundary lands on the nearest existing ancestor.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveNewTarget } from "../../src/io/paths";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  systemError,
  type FakeFs,
} from "./harness";

const WS = "/ws";

const fsOf = (fake: FakeFs) => {
  const clock = fixedClock(0);
  return depsOf(fake.port, clock.clock, recordingSleep(clock).sleep).fs;
};

const attempt = (fake: FakeFs, file: string, workspace = WS): Promise<string> =>
  codeOfAsync(() => resolveNewTarget({ workspace, file }, fsOf(fake)));

describe("resolveNewTarget · normal resolution", () => {
  it("should resolve a missing file to ancestor realpath + tail", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    const target = await resolveNewTarget({ workspace: WS, file: "new.html" }, fsOf(fake));

    expect(target.absolute).toBe(join(WS, "new.html"));
    expect(target.relative).toBe("new.html");
    expect(target.workspace).toBe(WS);
  });

  it("should tolerate missing parent directories and keep the full tail", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    const target = await resolveNewTarget(
      { workspace: WS, file: "docs/deep/new.html" },
      fsOf(fake),
    );

    expect(target.absolute).toBe(join(WS, "docs", "deep", "new.html"));
    expect(target.relative).toBe("docs/deep/new.html");
  });

  it("should still resolve when the target already exists (file_exists is the writer's job)", async () => {
    const fake = fakeFs({ "/ws/existing.html": "x" });
    const target = await resolveNewTarget({ workspace: WS, file: "existing.html" }, fsOf(fake));

    expect(target.absolute).toBe(join(WS, "existing.html"));
  });

  it("should treat a target inside the workspace as inside even via a linked parent", async () => {
    const fake = fakeFs({ "/ws/real/keep.html": "x" });
    fake.state.dirs.add(WS);
    fake.state.dirs.add("/ws/real/sub");
    fake.state.links.set("/ws/alias", "/ws/real");

    const target = await resolveNewTarget(
      { workspace: WS, file: "alias/sub/new.html" },
      fsOf(fake),
    );

    expect(target.absolute).toBe(join("/ws/real", "sub", "new.html"));
    expect(target.relative).toBe("real/sub/new.html");
  });
});

describe("resolveNewTarget · lexical gates (same as resolveTarget)", () => {
  it("should reject the same bad shapes as resolveTarget", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    expect(await attempt(fake, "../out.html")).toBe("path_outside_workspace");
    expect(await attempt(fake, join(WS, "abs.html"))).toBe("path_outside_workspace");
    expect(await attempt(fake, "")).toBe("not_a_file");
    expect(await attempt(fake, "a\0b.html")).toBe("invalid_request");
    expect(await attempt(fake, ".")).toBe("path_outside_workspace");
    expect(await attempt(fake, ".hreader/x.html")).toBe("path_outside_workspace");
  });

  it("should reject a relative workspace", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    expect(await attempt(fake, "a.html", "relative/ws")).toBe("invalid_input");
  });
});

describe("resolveNewTarget · ancestor boundary", () => {
  it("should reject when the nearest existing ancestor resolves outside", async () => {
    const fake = fakeFs({ "/outside/keep.html": "x" });
    fake.state.dirs.add("/outside");
    fake.state.dirs.add(WS);
    fake.state.links.set("/ws/out", "/outside");

    expect(await attempt(fake, "out/sub/new.html")).toBe("path_outside_workspace");
  });

  it("should stop walking at a realpath failure that is not ENOENT/ENOTDIR", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail(
      "realpath",
      systemError("EACCES"),
      (path: string) => path === join(WS, "sub", "new.html"),
    );

    expect(await attempt(fake, "sub/new.html")).toBe("io_failure");
  });
});
