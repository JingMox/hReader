// Behavioral contract of `apply(ctx, config)`. The host is fake; styles go through real core.

import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILTIN_STYLES,
  compileTone,
  DEFAULT_STYLE_ID,
  HrError,
  loadStyle,
  nodeStyleDeps,
} from "@hreader/core";
import { describe, expect, it, vi } from "vitest";

import type { BundleConfig, HostContext } from "../src/index";
import { apply, inject, SECTION_NAME, SECTION_ORDER, stylesRootOf } from "../src/index";
import { fakeHostOf } from "./host";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A **non-default** builtin id: a hard condition for green (asserting only the default id lets "only default ids listed" slip through). */
const NON_DEFAULT_ID = BUILTIN_STYLES.find((style) => style.id !== DEFAULT_STYLE_ID)?.id ?? "";

/** Minimal legal shape of a project style file (snake_case keys from `packages/core/src/style/spec.ts`). */
const styleYamlOf = (id: string): string =>
  [
    `id: ${id}`,
    "name: 与内置撞名的项目风格",
    "description: 只为去重用例存在",
    "inherits_visual: atelier-editorial",
    "language_style:",
    "  persona: 讲人话。",
    "  narrative_rules:",
    "    - 一句一个意思。",
    "  sentence_rhythm:",
    "    max_paragraph_sentences: 3",
    "  vocabulary: {}",
  ].join("\n");

const configOf = (overrides: Partial<BundleConfig> = {}): BundleConfig => ({
  workspace: REPO_ROOT,
  ...overrides,
});

const compiledDefault = async (): Promise<string> =>
  compileTone((await loadStyle({ id: DEFAULT_STYLE_ID }, nodeStyleDeps(REPO_ROOT))).spec);

describe("apply: system prompt section", () => {
  it("should make section.text byte-identical to compileTone(loadStyle(default style))", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());

    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });

  it("should pin the section's name and order (order=100: content is persona, neither claiming identity nor mixing into tool guidance)", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());

    const section = host.sections.get(SECTION_NAME);
    expect(section?.name).toBe("hreader");
    expect(section?.order).toBe(SECTION_ORDER);
    expect(SECTION_ORDER).toBe(100);
  });

  it("should use the passed-in styleId when given explicitly", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf({ styleId: DEFAULT_STYLE_ID }));

    const expected = compileTone(
      (await loadStyle({ id: DEFAULT_STYLE_ID }, nodeStyleDeps(REPO_ROOT))).spec,
    );
    expect(host.sections.get(SECTION_NAME)?.text).toBe(expected);
  });
});

describe("apply: hreader service", () => {
  it("should provide { styleId, prompt } where prompt is the same fact as section.text", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());

    expect(host.services.get("hreader")).toEqual({
      styleId: DEFAULT_STYLE_ID,
      prompt: host.sections.get(SECTION_NAME)?.text,
    });
  });
});

describe("apply: cleanup", () => {
  it("should remove the section and the service after the host unloads", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());
    expect(host.sections.size).toBe(1);

    await host.disposeAll();

    expect(host.sections.size).toBe(0);
    expect(host.services.has("hreader")).toBe(false);
  });

  it("should leave only one section after two applies on the same ctx (never tripping the host's duplicate-name guard)", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());
    await apply(host.ctx, configOf());

    expect([...host.sections.keys()]).toEqual([SECTION_NAME]);
  });
});

describe("apply: unknown styleId", () => {
  it("should fail-fast with the received id and all available ids (incl. non-default builtins) in the error", async () => {
    const host = fakeHostOf();
    const failure: unknown = await apply(host.ctx, configOf({ styleId: "no-such-style" })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HrError);
    if (!(failure instanceof HrError)) throw new Error("上面的断言已保证是 HrError");
    expect(failure.code).toBe("unknown_style");
    expect(failure.message).toContain("no-such-style");
    for (const style of BUILTIN_STYLES) expect(failure.message).toContain(style.id);
    expect(NON_DEFAULT_ID).not.toBe("");
    expect(NON_DEFAULT_ID).not.toBe(DEFAULT_STYLE_ID);
    expect(host.sections.size).toBe(0);
  });

  it("should list an id only once when a project style shares it with a builtin (a duplicate must not pollute the options)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "hreader-dup-"));
    mkdirSync(join(workspace, ".hreader"), { recursive: true });
    writeFileSync(join(workspace, ".hreader", "style.yaml"), styleYamlOf(NON_DEFAULT_ID));

    const failure: unknown = await apply(
      fakeHostOf().ctx,
      configOf({ workspace, styleId: "no-such-style" }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(failure instanceof HrError)) throw new Error("预期 unknown_style 的 HrError");
    const listed = failure.message.split(NON_DEFAULT_ID).length - 1;
    expect(listed).toBe(1);
  });
});

/**
 * Calls `apply` with a runtime shape like parsed YAML: `config.workspace` is hand-written by users,
 * `workspace: 123`-style errors live entirely outside the type system, and this repo bans
 * `as`/`any` — hence `Reflect.apply` type erasure (same as `callWithUnknown` in
 * `packages/core/tests/html-support.ts`).
 */
const applyWithRawWorkspace = (ctx: HostContext, workspace: unknown): Promise<unknown> => {
  // `Reflect.apply` returns `any`: narrow to `unknown` first, then unify sync/async outcomes into a Promise.
  const outcome: unknown = Reflect.apply(apply, undefined, [ctx, { workspace }]);
  return Promise.resolve(outcome);
};

/** Runs a stretch of code capturing stderr, to assert the WARNING verbatim (`no-console` does not reach `process.stderr` here). */
const stderrOf = async (run: () => Promise<void>): Promise<string[]> => {
  const said: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    said.push(String(chunk));
    return true;
  });

  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return said;
};

describe("apply: where workspace comes from", () => {
  it("should fall back to cwd and write one WARNING line to stderr when workspace is absent", async () => {
    const host = fakeHostOf();
    const said = await stderrOf(() => apply(host.ctx, {}));

    expect(said).toEqual([
      `[hreader] config.workspace 未配置，使用宿主进程 cwd=${process.cwd()}\n`,
    ]);
    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });

  it("should resolve a relative path against cwd (prompt identical to the absolute-path form)", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf({ workspace: "." }));

    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });

  it("should fail-fast on a nonexistent path, naming config.workspace in the error", async () => {
    const host = fakeHostOf();

    await expect(
      apply(host.ctx, configOf({ workspace: "/no-such-workspace-hreader" })),
    ).rejects.toThrowError(/config\.workspace/u);
    expect(host.sections.size).toBe(0);
  });
});

describe("apply: `..` guard and containment pin for workspace", () => {
  it("should fail-fast on a raw string containing a `..` segment (never relying on `resolve` to swallow `..` silently)", async () => {
    const host = fakeHostOf();

    await expect(apply(host.ctx, configOf({ workspace: "../../" }))).rejects.toThrowError(
      /不能含 "\.\." 段/u,
    );
    expect(host.sections.size).toBe(0);
  });

  it("should not require workspace inside cwd: this package only reads style files and never writes; containment lives in packages/core/src/io/paths.ts:73-79", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf({ workspace: "/tmp" }));

    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });
});

describe("apply: non-string workspace (config comes from hand-written YAML, runtime shape is not TS-bound)", () => {
  it.each<[string, unknown, string]>([
    ["number (`workspace: 123`)", 123, "number"],
    ["null (`workspace: null`)", null, "null"],
    ['array (`workspace: ["a"]`)', ["a"], "object"],
  ])(
    "should report invalid_input, not a bare TypeError, when workspace is %s",
    async (_label, raw, kind) => {
      const host = fakeHostOf();
      const failure = await applyWithRawWorkspace(host.ctx, raw).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(HrError);
      if (!(failure instanceof HrError)) throw new Error("上面的断言已保证是 HrError");
      expect(failure.code).toBe("invalid_input");
      expect(failure.message).toContain("config.workspace");
      expect(failure.message).toContain(kind);
      expect(host.sections.size).toBe(0);
    },
  );
});

describe("apply: a given but invalid workspace", () => {
  it("should also fail-fast when workspace points at a file (only directories count)", async () => {
    const host = fakeHostOf();
    const file = join(mkdtempSync(join(tmpdir(), "hreader-ws-")), "article.md");
    writeFileSync(file, "# hi\n");

    await expect(apply(host.ctx, configOf({ workspace: file }))).rejects.toThrowError(
      /config\.workspace/u,
    );
    expect(host.sections.size).toBe(0);
  });

  it("should fail-fast on an empty-string workspace ('' is not cwd)", async () => {
    const host = fakeHostOf();

    await expect(apply(host.ctx, configOf({ workspace: "" }))).rejects.toThrowError(
      /config\.workspace/u,
    );
    expect(host.sections.size).toBe(0);
  });
});

describe("stylesRootOf: where builtin styles live", () => {
  it("should use a sibling `styles/` when present (dist layout: `dist/styles`)", () => {
    const pkg = mkdtempSync(join(tmpdir(), "hreader-dist-"));
    mkdirSync(join(pkg, "styles", "atelier-editorial"), { recursive: true });

    expect(stylesRootOf(pathToFileURL(join(pkg, "index.js")))).toBe(join(pkg, "styles") + "/");
  });

  it("should fall back to the repo-root `styles/` without it (`vitest` runs sources, not dist)", () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));

    expect(stylesRootOf()).toBe(`${repo}styles/`);
  });
});

describe("inject", () => {
  it("should depend only on systemPrompt", () => {
    expect(inject).toEqual(["systemPrompt"]);
  });
});
