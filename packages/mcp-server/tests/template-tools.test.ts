// This layer: the four template tools end-to-end through the in-memory session — three-tier
// list, bounded get, create-from, save (incl. --global honoring HREADER_HOME), frozen error
// texts, workspace boundary refusals, bounded outputs and the extract-template prompt.

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  codeOf,
  isErrorResultOf,
  isRecord,
  payloadOf,
  sessionOf,
  textOf,
  uiUriOf,
} from "./harness";

const BUILTIN_IDS = ["blank-html", "brief", "minutes", "note", "report", "slides"];

let workspace = "";

const call = async (name: string, args: Record<string, unknown>) => {
  const session = await sessionOf();
  const result = await session.client.callTool({ name, arguments: args });
  await session.close();
  return result;
};

const managedPage = (): string =>
  "<!doctype html><html><head><title>样例</title>" +
  '<style id="hr-theme">body { color: #333 }</style></head>' +
  '<body><article data-hr-id="a1"><h1 data-hr-id="h1">样例</h1>' +
  '<section data-hr-id="s1"><p>正文</p><img src="p_files/a.png" alt="">' +
  "</section></article></body></html>";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-tpl-"));
  process.chdir(workspace);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("hr_list_templates / hr_get_template", () => {
  it("should list the six builtin templates", async () => {
    const result = await call("hr_list_templates", {});

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    const templates = payload["templates"];
    expect(Array.isArray(templates)).toBe(true);
    const ids = (templates as Record<string, unknown>[]).map((tpl) => tpl["id"]);
    expect(new Set(ids)).toEqual(new Set(BUILTIN_IDS));
    expect(
      (templates as Record<string, unknown>[]).every((tpl) => tpl["source"] === "builtin"),
    ).toBe(true);
    expect(payload["diagnostics"]).toEqual([]);
  });

  it("should return manifest plus bounded member texts for one template", async () => {
    const result = await call("hr_get_template", { id: "note" });

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload["source"]).toBe("builtin");
    const manifest = payload["manifest"];
    expect(isRecord(manifest) && manifest["id"]).toBe("note");
    expect(String(payload["entry"])).toContain("<title>");
    expect(String(payload["style"])).toContain("--hr-");
    expect(String(payload["guide"]).length).toBeGreaterThan(0);
    expect(payload["assets"]).toEqual([]);
  });

  it("should return null style and guide for a template without those members", async () => {
    const dir = join(workspace, ".hreader", "templates", "bare");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "template.json"),
      JSON.stringify({
        id: "bare",
        name: "Bare",
        description: "no style, no guide",
        version: 1,
        format: "html",
        entry: "index.html",
      }),
    );
    writeFileSync(join(dir, "index.html"), "<html><body>x</body></html>");

    const result = await call("hr_get_template", { id: "bare" });

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload["style"]).toBeNull();
    expect(payload["guide"]).toBeNull();
    expect(String(payload["entry"])).toContain("<body>x</body>");
  });

  it("should answer an unknown id with the frozen unknown_template text", async () => {
    const result = await call("hr_get_template", { id: "ghost" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("unknown_template");
    expect(textOf(result)).toContain("ghost");
  });

  it("should refuse a malformed id at the schema boundary", async () => {
    for (const id of ["../x", "a/b", "UPPER", "a b"]) {
      const result = await call("hr_get_template", { id });
      expect(isErrorResultOf(result)).toBe(true);
      expect(textOf(result)).toContain("-32602");
    }
  });
});

describe("hr_create_from_template", () => {
  it("should default to the blank-html template and return a ui resource uri", async () => {
    const result = await call("hr_create_from_template", { target: "blank.html" });

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload["path"]).toBe("blank.html");
    expect(uiUriOf(result)).toContain("ui://hreader/view/");
    const html = readFileSync(join(workspace, "blank.html"), "utf8");
    expect(html).toContain("<title>Untitled</title>");
  });

  it("should draft from a builtin kind template with a title", async () => {
    const result = await call("hr_create_from_template", {
      id: "note",
      target: "doc.html",
      title: "周报",
    });

    expect(isErrorResultOf(result)).toBe(false);
    const html = readFileSync(join(workspace, "doc.html"), "utf8");
    expect(html).toContain("<title>周报</title>");
    expect(html).toContain("data-hr-id");
    expect(html).toContain('<style id="hr-theme">');
  });

  it("should answer an unknown template id and a taken target with coded errors", async () => {
    writeFileSync(join(workspace, "taken.html"), "x");

    const unknown = await call("hr_create_from_template", {
      id: "ghost",
      target: "new.html",
    });
    expect(isErrorResultOf(unknown)).toBe(true);
    expect(codeOf(unknown)).toBe("unknown_template");
    expect(existsSync(join(workspace, "new.html"))).toBe(false);

    const exists = await call("hr_create_from_template", { target: "taken.html" });
    expect(isErrorResultOf(exists)).toBe(true);
    expect(codeOf(exists)).toBe("file_exists");
  });
});

describe("hr_save_template", () => {
  const seedPage = (): void => {
    writeFileSync(join(workspace, "p.html"), managedPage());
    mkdirSync(join(workspace, "p_files"));
    writeFileSync(join(workspace, "p_files", "a.png"), "PNG");
  };

  it("should save a page plus assets into the workspace tier and list it", async () => {
    seedPage();

    const result = await call("hr_save_template", { file: "p.html", id: "mine" });

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload).toEqual({
      id: "mine",
      dir: ".hreader/templates/mine",
      format: "managed",
      scope: "workspace",
      assets: ["assets/a.png"],
    });
    const dir = join(workspace, ".hreader", "templates", "mine");
    expect(readFileSync(join(dir, "style.css"), "utf8")).toBe("body { color: #333 }");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain('src="assets/a.png"');

    const list = payloadOf(await call("hr_list_templates", {}));
    const found = (list["templates"] as Record<string, unknown>[]).find(
      (tpl) => tpl["id"] === "mine",
    );
    expect(found?.["source"]).toBe("workspace");
  });

  it("should honor name/description/style/guide overrides", async () => {
    seedPage();

    const result = await call("hr_save_template", {
      file: "p.html",
      id: "custom",
      name: "自定义",
      description: "说明文字",
      style: "h1 { color: red }",
      guide: "# 指南\n自定义内容",
    });

    expect(isErrorResultOf(result)).toBe(false);
    const dir = join(workspace, ".hreader", "templates", "custom");
    expect(readFileSync(join(dir, "style.css"), "utf8")).toBe("h1 { color: red }");
    expect(readFileSync(join(dir, "guide.md"), "utf8")).toBe("# 指南\n自定义内容");
    const manifest = JSON.parse(readFileSync(join(dir, "template.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest["name"]).toBe("自定义");
  });

  it("should land in the user tier under HREADER_HOME when global is true", async () => {
    seedPage();
    const home = join(workspace, "user-home");
    mkdirSync(home);
    vi.stubEnv("HREADER_HOME", home);

    const result = await call("hr_save_template", {
      file: "p.html",
      id: "global-t",
      global: true,
    });

    expect(isErrorResultOf(result)).toBe(false);
    expect(payloadOf(result)["dir"]).toBe("~/.hreader/templates/global-t");
    expect(existsSync(join(home, ".hreader", "templates", "global-t", "index.html"))).toBe(true);
    expect(existsSync(join(workspace, ".hreader", "templates", "global-t"))).toBe(false);
  });

  it("should fall back to os.homedir() for the user tier when HREADER_HOME is unset or empty", async () => {
    seedPage();
    // The worker home is shared across files: writing into it would leak into other tests'
    // user-tier listings in the same worker. HOME/USERPROFILE get a per-test dir instead.
    const osHome = join(workspace, "os-home");
    mkdirSync(osHome);
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("USERPROFILE", osHome);
    expect(homedir()).toBe(osHome);
    for (const [stub, id] of [
      [undefined, "unset-home"],
      ["", "empty-home"],
    ] as const) {
      vi.stubEnv("HREADER_HOME", stub);

      const result = await call("hr_save_template", { file: "p.html", id, global: true });

      expect(isErrorResultOf(result)).toBe(false);
      expect(existsSync(join(homedir(), ".hreader", "templates", id, "index.html"))).toBe(true);
    }
  });

  it("should refuse a second save under the same id", async () => {
    seedPage();
    expect(isErrorResultOf(await call("hr_save_template", { file: "p.html", id: "t" }))).toBe(
      false,
    );

    const again = await call("hr_save_template", { file: "p.html", id: "t" });
    expect(isErrorResultOf(again)).toBe(true);
    expect(codeOf(again)).toBe("file_exists");
  });

  it("should refuse out-of-workspace files and symlink escapes", async () => {
    const outside = join(tmpdir(), `outside-${String(Date.now())}.html`);
    writeFileSync(outside, "<html></html>");
    try {
      const abs = await call("hr_save_template", { file: outside, id: "t" });
      expect(isErrorResultOf(abs)).toBe(true);
      expect(codeOf(abs)).toBe("path_outside_workspace");

      symlinkSync(outside, join(workspace, "link.html"));
      const link = await call("hr_save_template", { file: "link.html", id: "t" });
      expect(isErrorResultOf(link)).toBe(true);
      expect(codeOf(link)).toBe("path_outside_workspace");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("should refuse a style that would break out of the style block", async () => {
    seedPage();

    const result = await call("hr_save_template", {
      file: "p.html",
      id: "evil",
      style: "a{}</style><script>alert(1)</script>",
    });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("invalid_theme");
    expect(existsSync(join(workspace, ".hreader", "templates", "evil"))).toBe(false);
  });
});

describe("hr_*_template · bounded outputs", () => {
  it("should truncate a giant guide with a marker in hr_get_template", async () => {
    writeFileSync(join(workspace, "p.html"), managedPage());
    const giantGuide = `# G\n${"x".repeat(200_000)}`;
    const saved = await call("hr_save_template", {
      file: "p.html",
      id: "big",
      guide: giantGuide,
    });
    expect(isErrorResultOf(saved)).toBe(false);

    const got = payloadOf(await call("hr_get_template", { id: "big" }));
    const guide = String(got["guide"]);
    expect(guide).toContain("[truncated");
    expect(guide.length).toBeLessThan(giantGuide.length);
  });

  it("should truncate an over-long manifest name", async () => {
    writeFileSync(join(workspace, "p.html"), managedPage());
    const saved = await call("hr_save_template", {
      file: "p.html",
      id: "longname",
      name: "n".repeat(5_000),
    });
    expect(isErrorResultOf(saved)).toBe(false);

    const got = payloadOf(await call("hr_get_template", { id: "longname" }));
    const manifest = got["manifest"];
    expect(isRecord(manifest) && String(manifest["name"])).toContain("[truncated");
    expect(String((manifest as Record<string, unknown>)["name"]).length).toBeLessThan(5_000);
  });
});

describe("extract-template prompt", () => {
  it("should be listed with its arguments", async () => {
    const session = await sessionOf();
    const { prompts } = await session.client.listPrompts();
    await session.close();

    const prompt = prompts.find((one) => one.name === "extract-template");
    expect(prompt).toBeDefined();
    const argNames = prompt?.arguments?.map((arg) => arg.name) ?? [];
    for (const name of ["file1", "file2", "file3", "file4", "file5", "id", "global"]) {
      expect(argNames).toContain(name);
    }
  });

  it("should render the recipe with the given files and id", async () => {
    const session = await sessionOf();
    const result = await session.client.getPrompt({
      name: "extract-template",
      arguments: { file1: "a.html", file2: "b.html", id: "my-tpl", global: "true" },
    });
    await session.close();

    const body = String(Reflect.get(Object(result.messages[0]?.content), "text") ?? "");
    expect(body).toContain("1. a.html");
    expect(body).toContain("2. b.html");
    expect(body).toContain("hr_save_template");
    expect(body).toContain('"my-tpl"');
    expect(body).toContain("global`: true");
  });

  it("should render a single sample and default global to false", async () => {
    const session = await sessionOf();
    const result = await session.client.getPrompt({
      name: "extract-template",
      arguments: { file1: "only.html", id: "one-tpl" },
    });
    await session.close();

    const body = String(Reflect.get(Object(result.messages[0]?.content), "text") ?? "");
    expect(body).toContain("1 sample page(s)");
    expect(body).toContain("1. only.html");
    expect(body).toContain('"only.html"');
    expect(body).toContain("global`: false");
  });
});
