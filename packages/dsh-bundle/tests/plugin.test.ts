// 这层管：`apply(ctx, config)` 的行为契约。宿主是假宿主，样式走真 core。

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

/** 一个**非默认**的内置 id：判绿硬条件（只断言默认 id 等于让"只列默认 id"混过去）。 */
const NON_DEFAULT_ID = BUILTIN_STYLES.find((style) => style.id !== DEFAULT_STYLE_ID)?.id ?? "";

/** 项目风格文件的最小合法形状（`packages/core/src/style/spec.ts` 的 snake_case 键名）。 */
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

describe("apply：system prompt section", () => {
  it("section.text 与 compileTone(loadStyle(默认样式)) 逐字节相同", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());

    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });

  it("section 的 name 与 order 钉死（order=100：内容属于 persona，不抢 identity 也不混进 tool guidance）", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());

    const section = host.sections.get(SECTION_NAME);
    expect(section?.name).toBe("hreader");
    expect(section?.order).toBe(SECTION_ORDER);
    expect(SECTION_ORDER).toBe(100);
  });

  it("显式传 styleId 时用传进来的那个", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf({ styleId: DEFAULT_STYLE_ID }));

    const expected = compileTone(
      (await loadStyle({ id: DEFAULT_STYLE_ID }, nodeStyleDeps(REPO_ROOT))).spec,
    );
    expect(host.sections.get(SECTION_NAME)?.text).toBe(expected);
  });
});

describe("apply：hreader 服务", () => {
  it("provide 出 { styleId, prompt }，prompt 与 section.text 是同一份事实", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());

    expect(host.services.get("hreader")).toEqual({
      styleId: DEFAULT_STYLE_ID,
      prompt: host.sections.get(SECTION_NAME)?.text,
    });
  });
});

describe("apply：清理", () => {
  it("宿主卸载后 section 与服务都被摘掉", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());
    expect(host.sections.size).toBe(1);

    await host.disposeAll();

    expect(host.sections.size).toBe(0);
    expect(host.services.has("hreader")).toBe(false);
  });

  it("同一 ctx 连续 apply 两次只留一个 section（不撞宿主的重名保护）", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf());
    await apply(host.ctx, configOf());

    expect([...host.sections.keys()]).toEqual([SECTION_NAME]);
  });
});

describe("apply：未知 styleId", () => {
  it("fail-fast，错误里带上拿到的 id 与全部可用 id（含非默认内置）", async () => {
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

  it("项目风格与内置同 id 时，清单里只出现一次（重复 id 不污染可选项）", async () => {
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
 * 以 YAML 解析后的运行期形状调 `apply`：`config.workspace` 是用户手写的，`workspace: 123` 这种错
 * 完全在类型系统之外，而本仓禁 `as`/`any`，故走 `Reflect.apply` 的类型擦除（同
 * `packages/core/tests/html-support.ts` 的 `callWithUnknown`）。
 */
const applyWithRawWorkspace = (ctx: HostContext, workspace: unknown): Promise<unknown> => {
  // `Reflect.apply` 回的是 `any`：先收成 `unknown`，再把同步/异步两种结局统一成 Promise。
  const outcome: unknown = Reflect.apply(apply, undefined, [ctx, { workspace }]);
  return Promise.resolve(outcome);
};

/** 跑一段代码并收下 stderr，用来断言 WARNING 原话（`no-console` 在这里管不到 `process.stderr`）。 */
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

describe("apply：workspace 从哪来", () => {
  it("没给 workspace 时回落 cwd，并往 stderr 打一行 WARNING", async () => {
    const host = fakeHostOf();
    const said = await stderrOf(() => apply(host.ctx, {}));

    expect(said).toEqual([
      `[hreader] config.workspace 未配置，使用宿主进程 cwd=${process.cwd()}\n`,
    ]);
    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });

  it("相对路径按 cwd 解析成绝对路径（prompt 与绝对路径写法一致）", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf({ workspace: "." }));

    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });

  it("路径不存在时 fail-fast，错误点名 config.workspace", async () => {
    const host = fakeHostOf();

    await expect(
      apply(host.ctx, configOf({ workspace: "/no-such-workspace-hreader" })),
    ).rejects.toThrowError(/config\.workspace/u);
    expect(host.sections.size).toBe(0);
  });
});

describe("apply：workspace 的 `..` 守卫与 containment 钉子", () => {
  it("原始串含 `..` 段时 fail-fast（不靠 `resolve` 静默把 `..` 吃掉）", async () => {
    const host = fakeHostOf();

    await expect(apply(host.ctx, configOf({ workspace: "../../" }))).rejects.toThrowError(
      /不能含 "\.\." 段/u,
    );
    expect(host.sections.size).toBe(0);
  });

  it("不要求 workspace 落在 cwd 之内：本包只读风格文件、从不写盘，containment 归 packages/core/src/io/paths.ts:73-79", async () => {
    const host = fakeHostOf();
    await apply(host.ctx, configOf({ workspace: "/tmp" }));

    expect(host.sections.get(SECTION_NAME)?.text).toBe(await compiledDefault());
  });
});

describe("apply：workspace 不是字符串（config 来自手写 YAML，运行期形状不受 TS 约束）", () => {
  it.each<[string, unknown, string]>([
    ["number（`workspace: 123`）", 123, "number"],
    ["null（`workspace: null`）", null, "null"],
    ['数组（`workspace: ["a"]`）', ["a"], "object"],
  ])("workspace 是 %s 时报 invalid_input，不是裸 TypeError", async (_label, raw, kind) => {
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
  });
});

describe("apply：workspace 给了但不合法", () => {
  it("workspace 指向一个文件时同样 fail-fast（只认目录）", async () => {
    const host = fakeHostOf();
    const file = join(mkdtempSync(join(tmpdir(), "hreader-ws-")), "article.md");
    writeFileSync(file, "# hi\n");

    await expect(apply(host.ctx, configOf({ workspace: file }))).rejects.toThrowError(
      /config\.workspace/u,
    );
    expect(host.sections.size).toBe(0);
  });

  it("workspace 是空字符串时 fail-fast（不把 '' 当 cwd）", async () => {
    const host = fakeHostOf();

    await expect(apply(host.ctx, configOf({ workspace: "" }))).rejects.toThrowError(
      /config\.workspace/u,
    );
    expect(host.sections.size).toBe(0);
  });
});

describe("stylesRootOf：内置 styles 在哪", () => {
  it("旁边有 `styles/` 时用它（dist 布局：`dist/styles`）", () => {
    const pkg = mkdtempSync(join(tmpdir(), "hreader-dist-"));
    mkdirSync(join(pkg, "styles", "atelier-editorial"), { recursive: true });

    expect(stylesRootOf(pathToFileURL(join(pkg, "index.js")))).toBe(join(pkg, "styles") + "/");
  });

  it("没有时回落仓库根 `styles/`（`vitest` 跑的是源码，不经 dist）", () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));

    expect(stylesRootOf()).toBe(`${repo}styles/`);
  });
});

describe("inject", () => {
  it("只依赖 systemPrompt", () => {
    expect(inject).toEqual(["systemPrompt"]);
  });
});
