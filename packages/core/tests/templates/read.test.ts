// This layer: readTemplate — member reads for builtin and fs templates, the unknown/invalid error pair,
// symlink-escape refusal (files and dirs), link-loop truncation, and raced read failures.

import { describe, expect, it } from "vitest";

import type { HrError } from "../../src/hr-error";
import { readTemplate } from "../../src/templates";
import { codeOfAsync, systemError } from "../io/harness";
import {
  depsAt,
  fakeFs,
  htmlTemplate,
  manifestText,
  rootsOf,
  seedDirs,
  type FakeFs,
  USER_TEMPLATES,
  WS,
} from "./harness";

const TPL = `${USER_TEMPLATES}/my-tpl`;

const setup = (files: Record<string, string>, dirs: readonly string[] = []): FakeFs => {
  const fake = fakeFs(files);
  seedDirs(fake, USER_TEMPLATES, TPL, WS, ...dirs);
  return fake;
};

const errorOf = async (run: () => Promise<unknown>): Promise<HrError> => {
  try {
    await run();
  } catch (error: unknown) {
    return error as HrError;
  }
  throw new Error("expected a throw but none happened");
};

describe("readTemplate · builtin templates", () => {
  it("should load every builtin with manifest, entry, style and guide", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    for (const id of ["note", "report", "minutes", "brief", "slides", "blank-html"]) {
      const template = await readTemplate(id, rootsOf(), depsAt(fake));
      expect(template.source).toBe("builtin");
      expect(template.manifest.id).toBe(id);
      expect(template.entry.length).toBeGreaterThan(0);
      expect(template.style?.length).toBeGreaterThan(0);
      expect(template.guide?.length).toBeGreaterThan(0);
      expect(template.assets).toHaveLength(0);
    }
  });
});

describe("readTemplate · fs templates", () => {
  it("should load entry/style/guide text and the assets rel list", async () => {
    const fake = setup(
      htmlTemplate(TPL, {
        style: "body { color: red }",
        guide: "# How to write",
        assets: { "pic.png": "PNG", "sub/nested.txt": "deep" },
      }),
      [`${TPL}/assets`, `${TPL}/assets/sub`],
    );

    const template = await readTemplate("my-tpl", rootsOf(), depsAt(fake));
    expect(template.source).toBe("user");
    expect(template.entry).toContain("<title>T</title>");
    expect(template.style).toBe("body { color: red }");
    expect(template.guide).toBe("# How to write");
    expect([...template.assets].sort()).toEqual(["assets/pic.png", "assets/sub/nested.txt"]);
  });

  it("should resolve authored member paths over the defaults", async () => {
    const fake = setup({
      [`${TPL}/template.json`]: manifestText({
        id: "my-tpl",
        entry: "pages/main.html",
        style: "css/theme.css",
        guide: "docs/how.md",
      }),
      [`${TPL}/pages/main.html`]: "<html><body>authored</body></html>",
      [`${TPL}/css/theme.css`]: "authored-css",
      [`${TPL}/docs/how.md`]: "authored-guide",
    });
    seedDirs(fake, `${TPL}/pages`, `${TPL}/css`, `${TPL}/docs`);

    const template = await readTemplate("my-tpl", rootsOf(), depsAt(fake));
    expect(template.entry).toContain("authored");
    expect(template.style).toBe("authored-css");
    expect(template.guide).toBe("authored-guide");
  });

  it("should leave style/guide undefined when the defaults are absent", async () => {
    const fake = setup(htmlTemplate(TPL));
    const template = await readTemplate("my-tpl", rootsOf(), depsAt(fake));

    expect(template.style).toBeUndefined();
    expect(template.guide).toBeUndefined();
  });
});

describe("readTemplate · errors", () => {
  it("should report unknown_template for absent and illegal ids", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    for (const id of ["nope", "Bad Id", "a/b", "..", "a\\b"]) {
      expect(await codeOfAsync(() => readTemplate(id, rootsOf(), depsAt(fake)))).toBe(
        "unknown_template",
      );
    }
  });

  it("should wrap a member that goes missing between walk and read", async () => {
    const fake = setup(htmlTemplate(TPL, { style: "css" }));
    fake.fail("readFile", systemError("ENOENT"), (path: string) => path.endsWith("style.css"));

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("style.css");
  });

  it("should wrap a non-UTF8 member as broken template", async () => {
    const fake = fakeFs(htmlTemplate(TPL));
    seedDirs(fake, USER_TEMPLATES, TPL, WS);
    fake.state.files.set(`${TPL}/index.html`, new Uint8Array([0xff, 0xfe, 0x41]));

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("index.html");
  });
});

describe("readTemplate · symlinks", () => {
  it("should refuse a member symlink that escapes the template dir", async () => {
    const fake = setup({
      ...htmlTemplate(TPL),
      "/outside/secret.png": "SECRET",
    });
    fake.state.links.set(`${TPL}/assets`, "/outside");
    seedDirs(fake, "/outside", `${TPL}/assets`);

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("assets");
  });

  it("should refuse a symlinked file member that resolves outside", async () => {
    const fake = setup(htmlTemplate(TPL));
    fake.state.links.set(`${TPL}/evil.css`, "/etc/passwd");

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("evil.css");
  });

  it("should refuse a symlink that cannot be resolved at all", async () => {
    const fake = setup(htmlTemplate(TPL));
    fake.state.links.set(`${TPL}/dead`, "/gone/nowhere");

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("dead");
  });

  it("should follow a symlinked asset file that stays inside the template", async () => {
    const fake = setup(htmlTemplate(TPL, { assets: { "real.png": "PNG" } }), [`${TPL}/assets`]);
    fake.state.links.set(`${TPL}/assets/alias.png`, `${TPL}/assets/real.png`);

    const template = await readTemplate("my-tpl", rootsOf(), depsAt(fake));
    expect([...template.assets].sort()).toEqual(["assets/alias.png", "assets/real.png"]);
  });

  it("should follow a symlinked directory that stays inside the template", async () => {
    const fake = setup({
      ...htmlTemplate(TPL),
      [`${TPL}/real-assets/pic.png`]: "PNG",
    });
    seedDirs(fake, `${TPL}/real-assets`);
    fake.state.links.set(`${TPL}/assets`, `${TPL}/real-assets`);

    const template = await readTemplate("my-tpl", rootsOf(), depsAt(fake));
    expect(template.assets).toEqual(["assets/pic.png"]);
  });

  it("should truncate link cycles via the visited set instead of looping", async () => {
    const fake = setup({
      ...htmlTemplate(TPL),
      [`${TPL}/sub/note.txt`]: "x",
    });
    seedDirs(fake, `${TPL}/sub`);
    fake.state.links.set(`${TPL}/loop`, `${TPL}/sub`);
    fake.state.links.set(`${TPL}/self`, TPL);

    const template = await readTemplate("my-tpl", rootsOf(), depsAt(fake));
    expect(template.manifest.id).toBe("my-tpl");
  });

  it("should refuse a template dir whose own realpath cannot resolve", async () => {
    const fake = setup(htmlTemplate(TPL));
    fake.fail("realpath", systemError("EACCES"), (path: string) => path === TPL);

    expect(await codeOfAsync(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)))).toBe(
      "invalid_template",
    );
  });

  it("should report a mid-walk readdir failure as a broken template", async () => {
    const fake = setup({
      ...htmlTemplate(TPL),
      [`${TPL}/sub/note.txt`]: "x",
    });
    seedDirs(fake, `${TPL}/sub`);
    fake.fail("readdir", systemError("EIO"), (path: string) => path === `${TPL}/sub`);

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("读目录");
  });

  it("should report a member that vanishes between listing and lstat", async () => {
    const fake = setup({
      ...htmlTemplate(TPL),
      [`${TPL}/ghost.txt`]: "x",
    });
    fake.fail("lstat", systemError("ENOENT"), (path: string) => path === `${TPL}/ghost.txt`);

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("检查成员");
  });

  it("should refuse a plain dir whose realpath escapes after an ancestor swap", async () => {
    // TOCTOU: `/t/sub` itself is not a link, but between lstat and realpath the template root is swapped for an escaping link.
    const fake = setup({
      ...htmlTemplate(TPL),
      [`${TPL}/sub/note.txt`]: "x",
    });
    seedDirs(fake, `${TPL}/sub`, "/outside", "/outside/sub");
    fake.once(
      "lstat",
      (path: string) => path === `${TPL}/sub`,
      () => fake.state.links.set(TPL, "/outside"),
    );

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("跑出模板");
  });
});
