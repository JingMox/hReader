// This layer: the merged three-tier list — the builtin < user < workspace shadowing order, breakage diagnostics, and no-fallback semantics.

import { describe, expect, it } from "vitest";

import { listTemplates, readTemplate } from "../../src/templates";
import { codeOfAsync, systemError } from "../io/harness";
import {
  depsAt,
  fakeFs,
  HOME,
  htmlTemplate,
  manifestText,
  rootsOf,
  seedDirs,
  USER_TEMPLATES,
  WS,
  WS_TEMPLATES,
} from "./harness";

const BUILTIN_IDS = ["blank-html", "brief", "minutes", "note", "report", "slides"];

describe("listTemplates · builtin list", () => {
  it("should list the six builtins sorted by id with no diagnostics", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    const list = await listTemplates(rootsOf(), depsAt(fake));

    expect(list.templates.map((tpl) => tpl.id)).toEqual(BUILTIN_IDS);
    expect(list.templates.every((tpl) => tpl.source === "builtin")).toBe(true);
    expect(list.templates.every((tpl) => tpl.tags.length > 0)).toBe(true);
    expect(list.diagnostics).toHaveLength(0);
  });
});

describe("listTemplates · shadowing order", () => {
  it("should merge user and workspace templates over builtins", async () => {
    const fake = fakeFs({
      ...htmlTemplate(`${USER_TEMPLATES}/note`, {
        manifest: manifestText({ id: "note", name: "User Note" }),
      }),
      ...htmlTemplate(`${WS_TEMPLATES}/note`, {
        manifest: manifestText({ id: "note", name: "Workspace Note" }),
      }),
      ...htmlTemplate(`${USER_TEMPLATES}/custom`, {
        manifest: manifestText({ id: "custom", name: "Custom" }),
      }),
    });
    seedDirs(
      fake,
      USER_TEMPLATES,
      WS_TEMPLATES,
      `${USER_TEMPLATES}/note`,
      `${WS_TEMPLATES}/note`,
      `${USER_TEMPLATES}/custom`,
      WS,
    );

    const list = await listTemplates(rootsOf(), depsAt(fake));
    const note = list.templates.find((tpl) => tpl.id === "note");
    const custom = list.templates.find((tpl) => tpl.id === "custom");

    expect(note?.source).toBe("workspace");
    expect(note?.name).toBe("Workspace Note");
    expect(custom?.source).toBe("user");
  });

  it("should skip regular files at the roots without a diagnostic", async () => {
    const fake = fakeFs({
      [`${USER_TEMPLATES}/stray.txt`]: "not a template",
      ...htmlTemplate(`${USER_TEMPLATES}/mine`),
    });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/mine`, WS);

    const list = await listTemplates(rootsOf(), depsAt(fake));
    expect(list.templates.map((tpl) => tpl.id)).toContain("mine");
    expect(list.diagnostics).toHaveLength(0);
  });

  it("should scan a template dir reached through a symlinked entry", async () => {
    // A symlinked dir entry is a candidate too; the id check reads the link name (the lexical dir name), not the target's dir name.
    const realDir = `${HOME}/shared/real-dir`;
    const fake = fakeFs(
      htmlTemplate(realDir, {
        manifest: manifestText({ id: "linked", name: "Linked Template" }),
      }),
    );
    seedDirs(fake, USER_TEMPLATES, realDir, WS);
    fake.state.links.set(`${USER_TEMPLATES}/linked`, realDir);

    const list = await listTemplates(rootsOf(), depsAt(fake));
    const linked = list.templates.find((tpl) => tpl.id === "linked");

    expect(linked?.source).toBe("user");
    expect(linked?.name).toBe("Linked Template");
    expect(list.diagnostics).toHaveLength(0);
  });
});

describe("listTemplates · breakage diagnostics and no-fallback", () => {
  it("should report a broken template instead of crashing the whole list", async () => {
    const fake = fakeFs({
      ...htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest: "{nope" }),
      ...htmlTemplate(`${USER_TEMPLATES}/fine`),
    });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/my-tpl`, `${USER_TEMPLATES}/fine`, WS);

    const list = await listTemplates(rootsOf(), depsAt(fake));
    expect(list.templates.map((tpl) => tpl.id)).toContain("fine");
    expect(list.templates.map((tpl) => tpl.id)).not.toContain("my-tpl");
    expect(list.diagnostics).toEqual([
      { id: "my-tpl", source: "user", message: expect.stringContaining("JSON") as string },
    ]);
  });

  it("should NOT fall back to a healthy lower-priority template when the winner is broken", async () => {
    const fake = fakeFs({
      ...htmlTemplate(`${USER_TEMPLATES}/note`, {
        manifest: manifestText({ id: "note", name: "User Note" }),
      }),
      ...htmlTemplate(`${WS_TEMPLATES}/note`, { manifest: "{broken" }),
    });
    seedDirs(
      fake,
      USER_TEMPLATES,
      WS_TEMPLATES,
      `${USER_TEMPLATES}/note`,
      `${WS_TEMPLATES}/note`,
      WS,
    );

    const list = await listTemplates(rootsOf(), depsAt(fake));
    // The broken workspace copy still occupies the slot it won: no user-tier note in the list,
    // and the diagnostics show why the workspace copy is broken.
    expect(list.templates.map((tpl) => tpl.id)).not.toContain("note");
    expect(list.diagnostics.some((diag) => diag.id === "note" && diag.source === "workspace")).toBe(
      true,
    );

    expect(await codeOfAsync(() => readTemplate("note", rootsOf(), depsAt(fake)))).toBe(
      "invalid_template",
    );
  });

  it("should still surface a healthy workspace override and diagnose the shadowed broken one", async () => {
    const fake = fakeFs({
      ...htmlTemplate(`${USER_TEMPLATES}/mine`, { manifest: "{broken" }),
      ...htmlTemplate(`${WS_TEMPLATES}/mine`, {
        manifest: manifestText({ id: "mine", name: "Workspace Mine" }),
      }),
    });
    seedDirs(
      fake,
      USER_TEMPLATES,
      WS_TEMPLATES,
      `${USER_TEMPLATES}/mine`,
      `${WS_TEMPLATES}/mine`,
      WS,
    );

    const list = await listTemplates(rootsOf(), depsAt(fake));
    const mine = list.templates.find((tpl) => tpl.id === "mine");

    expect(mine?.source).toBe("workspace");
    expect(list.diagnostics.some((diag) => diag.id === "mine" && diag.source === "user")).toBe(
      true,
    );
  });

  it("should translate a non-HrError inspection failure into a diagnostic too", async () => {
    const fake = fakeFs({
      ...htmlTemplate(`${USER_TEMPLATES}/mine`),
    });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/mine`, WS);
    fake.fail(
      "lstat",
      new Error("weird fs state"),
      (path: string) => path === `${USER_TEMPLATES}/mine`,
    );

    const list = await listTemplates(rootsOf(), depsAt(fake));
    expect(list.diagnostics.some((diag) => diag.id === "mine")).toBe(true);
  });

  it("should propagate a non-ENOENT failure of the templates root itself", async () => {
    const fake = fakeFs({
      ...htmlTemplate(`${USER_TEMPLATES}/mine`),
    });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/mine`, WS);

    // An unreadable root is not "one broken template" — when enumeration is impossible the whole call fails instead of silently reporting empty.
    fake.fail("readdir", systemError("EACCES"), (path: string) => path === USER_TEMPLATES);
    expect(await codeOfAsync(() => listTemplates(rootsOf(), depsAt(fake)))).toBe(
      "invalid_template",
    );
  });

  it("should treat a missing templates root as an empty tier", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    const list = await listTemplates(rootsOf(), depsAt(fake));

    expect(list.templates.map((tpl) => tpl.id)).toEqual(BUILTIN_IDS);
  });
});
