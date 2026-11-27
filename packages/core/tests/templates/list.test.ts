// 这层管：三级来源的合并清单——builtin < user < workspace 的覆盖序、损坏诊断、不回落语义。

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

describe("listTemplates · 内置清单", () => {
  it("should list the six builtins sorted by id with no diagnostics", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    const list = await listTemplates(rootsOf(), depsAt(fake));

    expect(list.templates.map((tpl) => tpl.id)).toEqual(BUILTIN_IDS);
    expect(list.templates.every((tpl) => tpl.source === "builtin")).toBe(true);
    expect(list.templates.every((tpl) => tpl.tags.length > 0)).toBe(true);
    expect(list.diagnostics).toHaveLength(0);
  });
});

describe("listTemplates · 覆盖序", () => {
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
    // 目录条目本身是符号链接也算候选；id 校验看的是链接名（词法目录名），不是目标目录名。
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

describe("listTemplates · 损坏诊断与不回落", () => {
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
    // 赢了坑但坏掉的 workspace 版照样占坑：list 里没有 user 版的 note，诊断里能看到 workspace 版为什么坏。
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

    // 根目录不可读不是"某个模板坏了"——没法枚举时整单失败，而不是静默当空。
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
