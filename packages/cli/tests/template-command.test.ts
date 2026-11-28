// This layer covers `hr template <list|show|new|save>` end to end — both output modes, the
// three-tier merge, save → create round-trips, write rules and locale/exit-code behavior.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { templateNewCommand } from "../src/commands/template";
import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";
import { runIn, type Captured } from "./support/capture";

const BUILTIN_IDS = ["blank-html", "brief", "minutes", "note", "report", "slides"];

const jsonData = (result: Captured): Record<string, unknown> => {
  const envelope = parseJsonLine(result.stdout);
  return fieldOf(envelope, "data") as Record<string, unknown>;
};

const managedPage = (title: string): string =>
  "<!doctype html>\n" +
  `<html><head><meta charset="utf-8"><title>${title}</title>` +
  '<style id="hr-theme">body { color: #222 }</style></head>' +
  `<body><article data-hr-id="a1"><h1 data-hr-id="h1">${title}</h1>` +
  '<section data-hr-id="s1"><p>正文</p>' +
  '<img src="page_files/chart.png" alt=""></section></article></body></html>';

/** The real `~/.hreader` recursive listing (read-only): `null` when the dir or the passwd entry is absent. */
const realHreaderSnapshot = (): readonly string[] | null => {
  try {
    const root = join(userInfo().homedir, ".hreader");
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${join(entry.parentPath, entry.name)}`)
      .sort();
  } catch {
    return null;
  }
};

// File-level proof of issue #58's contract: nothing in this file — a test, or a mutant
// reaching past `--home` — may add, rename or remove anything under the account's real
// `~/.hreader`. The snapshot is read-only and tolerates the dir being absent.
let realHreaderBefore: readonly string[] | null = null;
beforeAll(() => {
  realHreaderBefore = realHreaderSnapshot();
});
afterAll(() => {
  expect(realHreaderSnapshot()).toEqual(realHreaderBefore);
});

describe("hr template list", () => {
  it("should print a table of the builtin templates", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["template", "list"], { home: join(dir, "home") });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trimEnd().split("\n");
      expect(lines[0]).toMatch(/^id\s+name\s+format\s+source\s+tags$/);
      for (const id of BUILTIN_IDS) {
        expect(result.stdout).toContain(id);
      }
      expect(result.stdout).toContain("builtin");
    });
  });

  it("should print { templates, diagnostics } with --json", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["template", "list", "--json"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(0);
      const data = jsonData(result);
      expect(keysOf(data)).toEqual(["templates", "diagnostics"]);
      const templates = data["templates"] as Record<string, unknown>[];
      expect(templates.length).toBe(BUILTIN_IDS.length);
      expect(new Set(templates.map((tpl) => tpl["id"]))).toEqual(new Set(BUILTIN_IDS));
      expect(templates.every((tpl) => tpl["source"] === "builtin")).toBe(true);
      expect(data["diagnostics"]).toEqual([]);
    });
  });

  it("should truncate an over-long cell in the human table", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));
      expect(
        (
          await runIn(dir, [
            "template",
            "save",
            "page.html",
            "--id",
            "long",
            "--name",
            "x".repeat(60),
          ])
        ).code,
      ).toBe(0);

      const result = await runIn(dir, ["template", "list"], { home: join(dir, "home") });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`${"x".repeat(40)}…`);
    });
  });

  it("should warn on stderr and record a diagnostic for a broken workspace template", async () => {
    await withTempDir(async (dir) => {
      const broken = join(dir, ".hreader", "templates", "broken");
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, "template.json"), "{not-json");

      const human = await runIn(dir, ["template", "list"], { home: join(dir, "home") });
      expect(human.code).toBe(0);
      expect(human.stderr).toContain("warning:");
      expect(human.stderr).toContain("broken");

      const json = await runIn(dir, ["template", "list", "--json"], {
        home: join(dir, "home"),
      });
      const diagnostics = jsonData(json)["diagnostics"] as Record<string, unknown>[];
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.["source"]).toBe("workspace");
    });
  });
});

describe("hr template show", () => {
  it("should print the manifest, member sizes and the full guide", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["template", "show", "note"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("id: note");
      expect(result.stdout).toContain("format: managed");
      expect(result.stdout).toContain("source: builtin");
      expect(result.stdout).toMatch(/entry: \d+ bytes/);
      expect(result.stdout).toContain("--- guide.md ---");
    });
  });

  it("should print manifest+members with --json", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["template", "show", "note", "--json"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(0);
      const data = jsonData(result);
      expect([...keysOf(data)].sort()).toEqual(
        ["assets", "entry", "guide", "manifest", "source", "style"].sort(),
      );
      const manifest = data["manifest"] as Record<string, unknown>;
      expect(manifest["id"]).toBe("note");
      expect(typeof data["entry"]).toBe("string");
      expect(data["style"]).not.toBeNull();
    });
  });

  it("should print （无） sizes and skip the guide block for a memberless template", async () => {
    await withTempDir(async (dir) => {
      const bare = join(dir, ".hreader", "templates", "bare");
      mkdirSync(bare, { recursive: true });
      writeFileSync(
        join(bare, "template.json"),
        JSON.stringify({
          id: "bare",
          name: "Bare",
          description: "memberless",
          version: 1,
          format: "html",
          entry: "index.html",
        }),
      );
      writeFileSync(join(bare, "index.html"), "<html><body>x</body></html>");

      const result = await runIn(dir, ["template", "show", "bare"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("style: （无）");
      expect(result.stdout).toContain("guide: （无）");
      expect(result.stdout).not.toContain("--- guide.md ---");

      const json = await runIn(dir, ["template", "show", "bare", "--json"], {
        home: join(dir, "home"),
      });
      const data = jsonData(json);
      expect(data["style"]).toBeNull();
      expect(data["guide"]).toBeNull();
    });
  });

  it("should collapse an over-long asset list into a count tail", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));
      mkdirSync(join(dir, "page_files"));
      for (let index = 0; index < 55; index += 1) {
        writeFileSync(join(dir, "page_files", `a${String(index)}.bin`), "x");
      }
      expect((await runIn(dir, ["template", "save", "page.html", "--id", "many"])).code).toBe(0);

      const result = await runIn(dir, ["template", "show", "many"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("assets: 55 个");
      expect(result.stdout).toContain("…（共 55 个）");
      // a9 sorts last lexicographically — it lands in the collapsed tail.
      expect(result.stdout).toContain("  assets/a49.bin");
      expect(result.stdout).not.toContain("  assets/a9.bin");
    });
  });

  it("should add the missing newline after a guide that does not end with one", async () => {
    await withTempDir(async (dir) => {
      const bare = join(dir, ".hreader", "templates", "g");
      mkdirSync(bare, { recursive: true });
      writeFileSync(
        join(bare, "template.json"),
        JSON.stringify({
          id: "g",
          name: "G",
          description: "no trailing newline",
          version: 1,
          format: "html",
          entry: "index.html",
          guide: "guide.md",
        }),
      );
      writeFileSync(join(bare, "index.html"), "<html><body>x</body></html>");
      writeFileSync(join(bare, "guide.md"), "# G\nno-newline");

      const result = await runIn(dir, ["template", "show", "g"], { home: join(dir, "home") });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--- guide.md ---\n# G\nno-newline\n");
    });
  });

  it("should fail with unknown_template for a missing id", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["template", "show", "nope", "--json"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("unknown_template");
    });
  });
});

describe("hr template new / hr new --template", () => {
  it("should create a document from a builtin template", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["template", "new", "doc.html", "--template", "note"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^created doc\.html \(note, \d+ bytes\)\n$/);
      const html = readFileSync(join(dir, "doc.html"), "utf8");
      expect(html).toContain('<style id="hr-theme">');
      expect(html).toContain("data-hr-id");
    });
  });

  it("should mirror `hr new`'s receipt shape in --json", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(
        dir,
        ["template", "new", "doc.html", "--template", "note", "--title", "Q4", "--json"],
        { home: join(dir, "home") },
      );

      expect(result.code).toBe(0);
      const data = jsonData(result);
      expect(keysOf(data)).toEqual(["path", "template", "title", "bytes", "assets"]);
      expect(data["template"]).toBe("note");
      expect(data["title"]).toBe("Q4");
      expect(data["assets"]).toEqual([]);
      const html = readFileSync(join(dir, "doc.html"), "utf8");
      expect(html).toContain("<title>Q4</title>");
      expect(html).toContain("<h1");
    });
  });

  it("should report title null in --json when none is given", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, [
        "template",
        "new",
        "doc.html",
        "--template",
        "note",
        "--json",
      ]);

      expect(result.code).toBe(0);
      expect(jsonData(result)["title"]).toBeNull();
    });
  });

  it("should accept the `hr new --template` alias with identical output bytes", async () => {
    await withTempDir(async (dir) => {
      const viaAlias = await runIn(dir, ["new", "a.html", "--template", "note", "--title", "T"]);
      const viaDirect = await runIn(dir, [
        "template",
        "new",
        "b.html",
        "--template",
        "note",
        "--title",
        "T",
      ]);

      expect(viaAlias.code).toBe(0);
      expect(viaDirect.code).toBe(0);
      expect(readFileSync(join(dir, "a.html"), "utf8")).toBe(
        readFileSync(join(dir, "b.html"), "utf8"),
      );
    });
  });

  it("should fail with unknown_template and create nothing for a missing template", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(
        dir,
        ["template", "new", "doc.html", "--template", "ghost", "--json"],
        { home: join(dir, "home") },
      );

      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("unknown_template");
      expect(existsSync(join(dir, "doc.html"))).toBe(false);
    });
  });

  it("should fall back to the workspace-relative path when no displayPath is given", async () => {
    await withTempDir(async (dir) => {
      // The dispatch layer always passes displayPath; a direct call without it prints
      // the create result's own path.
      const out = await templateNewCommand({
        file: "direct.html",
        template: "note",
        title: undefined,
        workspace: dir,
        home: join(dir, "home"),
        json: false,
      });

      expect(out).toMatch(/^created direct\.html \(note, \d+ bytes\)\n$/);
      expect(existsSync(join(dir, "direct.html"))).toBe(true);
    });
  });

  it("should refuse --template combined with --kind as a usage error", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["new", "a.html", "--template", "note", "--kind", "report"]);

      expect(result.code).toBe(2);
      expect(existsSync(join(dir, "a.html"))).toBe(false);
    });
  });
});

describe("hr template save", () => {
  it("should save a page plus <stem>_files into the workspace tier", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("季度复盘"));
      mkdirSync(join(dir, "page_files"));
      writeFileSync(join(dir, "page_files", "chart.png"), "PNG");

      const result = await runIn(dir, ["template", "save", "page.html", "--id", "q3"], {
        home: join(dir, "home"),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^saved .*templates\/q3 \(q3, managed, \+1 assets\)\n$/);
      const dir0 = join(dir, ".hreader", "templates", "q3");
      expect(readFileSync(join(dir0, "style.css"), "utf8")).toBe("body { color: #222 }");
      expect(readFileSync(join(dir0, "assets", "chart.png"), "utf8")).toBe("PNG");
      const entry = readFileSync(join(dir0, "index.html"), "utf8");
      expect(entry).toContain('<style id="hr-theme"></style>');
      expect(entry).toContain('src="assets/chart.png"');

      // The new template is immediately visible and usable.
      const list = await runIn(dir, ["template", "list", "--json"], {
        home: join(dir, "home"),
      });
      const templates = jsonData(list)["templates"] as Record<string, unknown>[];
      expect(templates.find((tpl) => tpl["id"] === "q3")?.["source"]).toBe("workspace");

      const reuse = await runIn(dir, ["template", "new", "reuse.html", "--template", "q3"]);
      expect(reuse.code).toBe(0);
      const html = readFileSync(join(dir, "reuse.html"), "utf8");
      expect(html).toContain("body { color: #222 }");
      expect(html).toContain('src="reuse_files/chart.png"');
      expect(readFileSync(join(dir, "reuse_files", "chart.png"), "utf8")).toBe("PNG");
    });
  });

  it("should print the saved manifest shape with --json", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));

      const result = await runIn(
        dir,
        [
          "template",
          "save",
          "page.html",
          "--id",
          "mine",
          "--name",
          "我的模板",
          "--description",
          "说明",
          "--json",
        ],
        { home: join(dir, "home") },
      );

      expect(result.code).toBe(0);
      const data = jsonData(result);
      expect(keysOf(data)).toEqual(["id", "dir", "format", "scope", "assets"]);
      expect(data["id"]).toBe("mine");
      expect(data["scope"]).toBe("workspace");
      const manifest = JSON.parse(
        readFileSync(join(dir, ".hreader", "templates", "mine", "template.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifest["name"]).toBe("我的模板");
      expect(manifest["description"]).toBe("说明");
    });
  });

  it("should fail with file_exists when the id is already taken", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));
      const io = { home: join(dir, "home") };
      expect((await runIn(dir, ["template", "save", "page.html", "--id", "mine"], io)).code).toBe(
        0,
      );

      const again = await runIn(
        dir,
        ["template", "save", "page.html", "--id", "mine", "--json"],
        io,
      );
      expect(again.code).toBe(1);
      expect(fieldOf(parseJsonLine(again.stdout), "code")).toBe("file_exists");
    });
  });

  it("should land under --home / HREADER_HOME when --global is given", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));
      const home = join(dir, "user-home");
      mkdirSync(home);

      const viaFlag = await runIn(dir, [
        "template",
        "save",
        "page.html",
        "--id",
        "via-flag",
        "--global",
        "--home",
        home,
      ]);
      expect(viaFlag.code).toBe(0);
      expect(existsSync(join(home, ".hreader", "templates", "via-flag", "index.html"))).toBe(true);
      expect(existsSync(join(dir, ".hreader", "templates", "via-flag"))).toBe(false);

      const viaEnv = await runIn(
        dir,
        ["template", "save", "page.html", "--id", "via-env", "--global"],
        { env: { HREADER_HOME: home } },
      );
      expect(viaEnv.code).toBe(0);
      expect(existsSync(join(home, ".hreader", "templates", "via-env", "index.html"))).toBe(true);
    });
  });

  it("should land in the isolated worker HOME when --global is given without --home", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));

      const result = await runIn(dir, [
        "template",
        "save",
        "page.html",
        "--id",
        "isolated-home",
        "--global",
      ]);

      expect(result.code).toBe(0);
      // No --home and no io injection: the worker's isolated HOME (tests/setup/isolate-home.ts)
      // is the only net — the template must land there and never in the passwd home.
      const userTier = join(homedir(), ".hreader", "templates", "isolated-home");
      expect(existsSync(join(userTier, "index.html"))).toBe(true);
      expect(existsSync(join(userInfo().homedir, ".hreader", "templates", "isolated-home"))).toBe(
        false,
      );
    });
  });

  it("should land in the isolated worker HOME for a real subprocess too (env inheritance)", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));

      const result = await runCli(
        ["template", "save", "page.html", "--id", "isolated-sub", "--global", "--json"],
        { cwd: dir },
      );

      expect(result.code).toBe(0);
      // The child inherits the worker's HOME/HREADER_HOME, so its user tier is the temp home.
      expect(
        existsSync(join(homedir(), ".hreader", "templates", "isolated-sub", "index.html")),
      ).toBe(true);
      expect(existsSync(join(userInfo().homedir, ".hreader", "templates", "isolated-sub"))).toBe(
        false,
      );
    });
  });

  it("should refuse a missing --home directory as a usage error", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));

      const result = await runIn(dir, [
        "template",
        "save",
        "page.html",
        "--id",
        "t",
        "--global",
        "--home",
        join(dir, "nope"),
      ]);

      expect(result.code).toBe(2);
    });
  });

  it("should refuse bad ids, non-html sources and out-of-workspace paths", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "page.html"), managedPage("P"));
      writeFileSync(join(dir, "page.txt"), "x");
      const cases: [argv: string[], code: string][] = [
        [["template", "save", "page.html", "--id", "../x"], "invalid_input"],
        [["template", "save", "page.txt", "--id", "t"], "invalid_input"],
        [["template", "save", "missing.html", "--id", "t"], "not_a_file"],
        [["template", "save", "../page.html", "--id", "t"], "path_outside_workspace"],
      ];
      for (const [argv, code] of cases) {
        const result = await runIn(dir, [...argv, "--json"], { home: join(dir, "home") });
        expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe(code);
      }
    });
  });

  it("should handle Chinese, emoji and space in the file name and fields", async () => {
    await withTempDir(async (dir) => {
      const file = "我的 文档/🚀 note.html";
      mkdirSync(join(dir, "我的 文档"));
      writeFileSync(join(dir, file), managedPage("火箭笔记"));

      const result = await runIn(
        dir,
        ["template", "save", file, "--id", "rocket", "--name", "火箭模板 🚀"],
        { home: join(dir, "home") },
      );

      expect(result.code).toBe(0);
      const dir0 = join(dir, ".hreader", "templates", "rocket");
      const manifest = JSON.parse(readFileSync(join(dir0, "template.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(manifest["name"]).toBe("火箭模板 🚀");
      const guide = readFileSync(join(dir0, "guide.md"), "utf8");
      expect(guide).toContain("🚀 note.html");
      expect(guide).toContain("火箭笔记");
    });
  });
});

describe("hr new without --template · unchanged behavior (differential)", () => {
  const KINDS = ["note", "report", "minutes", "brief", "slides"] as const;
  const VISUALS = [undefined, "atelier-editorial", "deck-noir"] as const;
  /** The visual each same-named builtin template embeds (`hr new` defaults to atelier-editorial; `slides` ships deck-noir). */
  const TEMPLATE_VISUAL: Record<(typeof KINDS)[number], string> = {
    note: "atelier-editorial",
    report: "atelier-editorial",
    minutes: "atelier-editorial",
    brief: "atelier-editorial",
    slides: "deck-noir",
  };

  it("should produce byte-identical output across repeated runs for every kind×visual", async () => {
    await withTempDir(async (dir) => {
      for (const kind of KINDS) {
        for (const visual of VISUALS) {
          const args = ["new", `k-${kind}-${visual ?? "d"}.html`, "--kind", kind, "--title", "T"];
          const argv = visual === undefined ? args : [...args, "--visual", visual];
          const first = await runIn(dir, argv);
          const second = await runIn(dir, [
            ...argv.slice(0, 1),
            `k2-${kind}-${visual ?? "d"}.html`,
            ...argv.slice(2),
          ]);
          expect(first.code).toBe(0);
          expect(second.code).toBe(0);
          expect(readFileSync(join(dir, `k-${kind}-${visual ?? "d"}.html`), "utf8")).toBe(
            readFileSync(join(dir, `k2-${kind}-${visual ?? "d"}.html`), "utf8"),
          );
        }
      }
    });
  });

  it("should produce the same bytes as drafting from the same-named builtin template", async () => {
    await withTempDir(async (dir) => {
      for (const kind of KINDS) {
        const viaNew = await runIn(dir, [
          "new",
          `n-${kind}.html`,
          "--kind",
          kind,
          "--title",
          "T",
          "--visual",
          TEMPLATE_VISUAL[kind],
        ]);
        const viaTemplate = await runIn(dir, [
          "template",
          "new",
          `t-${kind}.html`,
          "--template",
          kind,
          "--title",
          "T",
        ]);
        expect(viaNew.code).toBe(0);
        expect(viaTemplate.code).toBe(0);
        expect(readFileSync(join(dir, `n-${kind}.html`), "utf8")).toBe(
          readFileSync(join(dir, `t-${kind}.html`), "utf8"),
        );
      }
    });
  });
});
