// This layer: the artifact actually shipped — a high-risk surface.
// What is tested is `package.json`'s `bin` pointing at `dist/main.js` (the only thing a host will spawn), not src:
// a real subprocess over real stdio, verifying line by line that stdout carries only JSON-RPC frames; error paths must not leak one character to stdout either.
// Broken input and oversized frames live in `stream.test.ts`; the probe itself is `probe.ts`.

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { BUILTIN_STYLES, compileTone } from "@hreader/core";

import { ANNOTATED_DOC, isRecord } from "./harness";
import {
  INITIALIZED,
  INITIALIZE,
  HANDSHAKE_COUNT,
  REPO_ROOT,
  binPathOf,
  buildDist,
  byIdOf,
  linesOf,
  probeOf,
  resultOf,
  textOf,
  toolNamesOf,
} from "./probe";

beforeAll(buildDist, 180_000);
describe("dist/main.js · the thing a host spawns", () => {
  it("should point the package bin at the built artifact", async () => {
    const entry = await binPathOf();

    expect(entry.endsWith(join("dist", "main.js"))).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("should ship the artifact executable with a shebang so a host can exec it directly", async () => {
    const entry = await binPathOf();
    const [firstLine] = (await readFile(entry, "utf8")).split("\n");

    expect(firstLine).toBe("#!/usr/bin/env node");
    expect(statSync(entry).mode & 0o111).not.toBe(0);
  });

  it("should emit nothing but json-rpc frames on stdout", async () => {
    const { frames, lines, exitCode } = await probeOf(await binPathOf());

    expect(lines.length).toBe(HANDSHAKE_COUNT);
    expect(frames.every((frame) => frame["jsonrpc"] === "2.0")).toBe(true);
    expect(frames.every((frame) => frame["error"] === undefined)).toBe(true);
    expect(frames.map((frame) => frame["id"])).toEqual([1, 2, 3, 4]);
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe("dist/main.js · tool surface", () => {
  it("should keep the tool list complete inside that clean stream", async () => {
    const { frames } = await probeOf(await binPathOf());

    expect([...toolNamesOf(frames)].sort()).toEqual([
      "hr_apply_style",
      "hr_create_doc",
      "hr_create_from_template",
      "hr_get_meta",
      "hr_get_template",
      "hr_import_doc",
      "hr_list_annotations",
      "hr_list_templates",
      "hr_outline",
      "hr_patch_node",
      "hr_read_node",
      "hr_resolve_annotation",
      "hr_save_template",
      "hr_search",
      "hr_set_meta",
      "hr_undo",
    ]);
  }, 30_000);
});

const STYLE_PRESET = "atelier-editorial";

/** Three exits asked for the same preset: tool, resource, prompt — all three must serve the same style. */
const STYLE_EXIT_LINES = linesOf([
  INITIALIZE,
  INITIALIZED,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "hr_apply_style", arguments: { filePath: "a.html", visualId: STYLE_PRESET } },
  },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: `hreader://styles/${STYLE_PRESET}` },
  },
  {
    jsonrpc: "2.0",
    id: 4,
    method: "prompts/get",
    params: { name: "use-hreader-style", arguments: { toneId: STYLE_PRESET } },
  },
]);

/** The preset's visual axis lands at `inherits_visual`; the repo holds exactly that one `theme.css`. */
const presetOf = (id: string): (typeof BUILTIN_STYLES)[number] | undefined =>
  BUILTIN_STYLES.find((style) => style.id === id);

/** The prompt's body: `messages[0].content.text` (no JSON escaping layer, so multi-line fragments can actually be compared). */
const promptBodyOf = (answer: Record<string, unknown> | undefined): string => {
  const messages: unknown = resultOf(answer)["messages"];
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  const content: unknown = isRecord(first) ? first["content"] : undefined;
  return isRecord(content) && typeof content["text"] === "string" ? content["text"] : "";
};

const injectedThemeOf = (html: string): string =>
  /<style id="hr-theme">([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? "";

describe("dist/main.js · three style exits", () => {
  // A builtin preset's theme.css is findable in the source layout and absent from the bundle — only the real artifact can prove this.
  it("should serve a builtin preset through the tool, the resource and the prompt alike", async () => {
    const styleDir = await mkdtemp(join(tmpdir(), "hreader-mcp-style-"));
    await writeFile(join(styleDir, "a.html"), ANNOTATED_DOC, "utf8");
    const { frames, stderrText } = await probeOf(await binPathOf(), {
      lines: STYLE_EXIT_LINES,
      expected: 4,
      cwd: styleDir,
    });
    const byId = byIdOf(frames);
    const resource = JSON.stringify(resultOf(byId.get(3))["contents"]);
    const promptText = promptBodyOf(byId.get(4));
    const preset = presetOf(STYLE_PRESET);
    if (preset === undefined) throw new Error(`no ${STYLE_PRESET} among the builtin presets`);
    // All three exits must trace back to **the same source**: the tool's CSS equals the on-disk theme.css; resource and prompt equal the preset spec.
    const themeCss = await readFile(
      join(REPO_ROOT, "packages", "core", "themes", preset.inheritsVisual, "theme.css"),
      "utf8",
    );
    const toneSpec = compileTone(preset);
    const injected = injectedThemeOf(await readFile(join(styleDir, "a.html"), "utf8"));

    expect(stderrText).not.toContain("unknown_style");
    expect(resultOf(byId.get(2))["isError"]).toBeUndefined();
    // ① Tool: the injected style block is byte-identical to the preset's theme.css (one changed char goes red).
    expect(injected.trim()).toBe(themeCss.trim());
    // ② Resource: the YAML carries the same spec's persona, not some hardcoded phrase.
    expect(resource).toContain(preset.language.persona);
    // ③ Prompt: the compiled spec shares the resource's source; compileTone's first three lines serve as the anchor.
    expect(promptText).toContain(toneSpec.split("\n").slice(0, 3).join("\n").trim());
    expect(promptText).toContain(preset.language.persona);
    await rm(styleDir, { recursive: true, force: true });
  }, 30_000);
});

describe("dist/main.js · self-contained", () => {
  it("should run a real tools/call with no node_modules anywhere near it", async () => {
    // The only way to prove "self-contained": copy the artifact to a directory with zero dependencies, then really call a tool.
    const hostDir = await mkdtemp(join(tmpdir(), "hreader-host-sim-"));
    try {
      const entry = await binPathOf();
      await copyFile(entry, join(hostDir, "main.js"));
      await writeFile(join(hostDir, "doc.html"), ANNOTATED_DOC, "utf8");
      expect(existsSync(join(hostDir, "node_modules"))).toBe(false);

      const { frames, stderrText } = await probeOf(join(hostDir, "main.js"), {
        cwd: hostDir,
        lines: linesOf([
          INITIALIZE,
          INITIALIZED,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "hr_outline", arguments: { filePath: "doc.html" } },
          },
        ]),
        expected: 2,
      });

      const answer = byIdOf(frames).get(2);
      const outline: unknown = JSON.parse(textOf(answer));
      expect(resultOf(answer)["isError"]).toBeUndefined();
      expect(isRecord(outline) && Array.isArray(outline["nodes"])).toBe(true);
      expect(isRecord(outline) ? outline["wordCount"] : 0).toBeGreaterThan(0);
      // Out-of-repo layout: stderr gets exactly two lines — `workspace=` plus one "theme resources missing" WARNING (stdout unaffected).
      const stderrLines = stderrText.trimEnd().split("\n");
      expect(stderrLines).toHaveLength(2);
      expect(stderrLines[0]?.startsWith("[hreader-mcp] workspace=/")).toBe(true);
      expect(stderrLines[1]?.startsWith("[hreader-mcp] WARNING 主题资源缺失：")).toBe(true);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  }, 45_000);
});
