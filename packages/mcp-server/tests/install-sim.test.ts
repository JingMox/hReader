// This layer: "fake install" evidence — `dist/` + `styles/` copied together into a directory **with no repo**,
// a real-subprocess stdio handshake, `hr_apply_style` on each of the three builtin presets, asserting the styles **really take effect** (not "no error").
// It tests the delivery shape: if `build` ever drops the `styles/` copy step, this file must go red.

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { BUILTIN_STYLES } from "@hreader/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isRecord } from "./harness";
import {
  HANDSHAKE,
  HANDSHAKE_COUNT,
  PACKAGE_ROOT,
  REPO_ROOT,
  byIdOf,
  buildDist,
  probeOf,
  textOf,
} from "./probe";

const APPLY_ID = 5;

/** Test each builtin preset: the reskin entry is the preset id; the theme actually written is found via each preset's `inheritsVisual`. */
const PRESETS = BUILTIN_STYLES;

const DOC_HTML =
  '<!doctype html>\n<html lang="zh-CN">\n<head><title>t</title></head>\n' +
  "<body><article><h1>标题</h1><p>正文</p></article></body>\n</html>\n";

const THEME_BLOCK = /<style id="hr-theme">([\s\S]*?)<\/style>/u;

const themeOf = (html: string): string => THEME_BLOCK.exec(html)?.[1] ?? "";

const applyLineOf = (presetId: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: APPLY_ID,
    method: "tools/call",
    params: {
      name: "hr_apply_style",
      arguments: { filePath: "doc.html", visualId: presetId, toneId: presetId },
    },
  });

/** Themes shipped with the package: `shipped` is the copy inside the simulated install dir, `repo` is the repo-root original. */
interface ShippedTheme {
  readonly shipped: string;
  readonly repo: string;
  readonly sentinel: string;
}

interface ApplyOutcome {
  readonly bytes: unknown;
  readonly changed: unknown;
  readonly tone: string;
}

/** The success frame's body is `{visual, tone}` JSON; fields are read individually, no whole-shape type assertion. */
const outcomeOf = (text: string): ApplyOutcome => {
  const parsed: unknown = JSON.parse(text);
  const visual = isRecord(parsed) ? parsed["visual"] : undefined;
  const tone = isRecord(parsed) ? parsed["tone"] : undefined;
  return {
    bytes: isRecord(visual) ? visual["bytes"] : undefined,
    changed: isRecord(visual) ? visual["changed"] : undefined,
    tone: typeof tone === "string" ? tone : "",
  };
};

const sims: string[] = [];

beforeAll(async () => {
  await buildDist();
});

afterAll(async () => {
  await Promise.all(sims.map((sim) => rm(sim, { recursive: true, force: true })));
});

/** Run one real process per preset: clean doc → handshake → `hr_apply_style` → assert the style really landed on disk. */
const applyPresetOf = async (
  sim: string,
  theme: ShippedTheme,
  preset: (typeof PRESETS)[number],
): Promise<ApplyOutcome> => {
  const work = join(sim, `work-${preset.id}`);
  await mkdir(work, { recursive: true });
  const docPath = join(work, "doc.html");
  await writeFile(docPath, DOC_HTML, "utf8");

  const probe = await probeOf(join(sim, "dist", "main.js"), {
    cwd: work,
    expected: HANDSHAKE_COUNT + 1,
    lines: [...HANDSHAKE, applyLineOf(preset.id)],
  });
  const frame = byIdOf(probe.frames).get(APPLY_ID);
  const written = await readFile(docPath, "utf8");

  expect(frame?.["error"]).toBeUndefined();
  // The resources really resolved: not one byte of startup WARNING, and the reskin really wrote to disk.
  expect(probe.stderrText).not.toContain("WARNING 主题资源缺失");
  const outcome = outcomeOf(textOf(frame));
  expect(outcome.changed).toBe(true);
  // "Took effect" = the landed `<style id="hr-theme">` is byte-identical to the shipped theme.css (core concatenates it verbatim).
  // Taking "wrote a style tag" or "did not error" as proof is exactly the pit we fell into before.
  expect(themeOf(written)).toBe(theme.shipped);
  // Sentinel: the simulated copy differs from the repo copy **by exactly this one comment line**. If the implementation lazily reads the repo-root copy, these two must go red —
  // without them `shipped === repo`, and "read package-local" vs "read repo" are indistinguishable to the assertion.
  expect(themeOf(written)).toContain(theme.sentinel);
  expect(themeOf(written)).not.toBe(theme.repo);
  expect(outcome.bytes).toBe(Buffer.byteLength(written, "utf8"));
  // Tone goes through a different core chain (loadStyle → resolveThemePath); it must read the shipped resources too.
  expect(outcome.tone).toContain(preset.language.persona);
  return outcome;
};

describe("fake install (/tmp, no repo)", () => {
  it("should style a document with every builtin preset when only dist/ and styles/ are shipped", async () => {
    // A real install: only artifacts and resources are copied, mimicking the package directory after `npm i`.
    const sim = await mkdtemp(join(tmpdir(), "hreader-install-sim-"));
    sims.push(sim);
    await cp(join(PACKAGE_ROOT, "dist"), join(sim, "dist"), { recursive: true });
    await cp(join(PACKAGE_ROOT, "styles"), join(sim, "styles"), { recursive: true });

    // Premise assertion: there is really no repo here — resources sit next to the artifacts.
    expect(existsSync(join(sim, "packages"))).toBe(false);
    // Every visual theme directory is rewritten as "repo original + one sentinel comment line": only differing contents can tell which copy the implementation reads.
    const themes = new Map<string, ShippedTheme>();
    for (const preset of PRESETS) {
      const visualId = preset.inheritsVisual;
      if (themes.has(visualId)) continue;
      const repo = await readFile(
        join(REPO_ROOT, "packages", "core", "themes", visualId, "theme.css"),
        "utf8",
      );
      const sentinel = `/* SENTINEL ${basename(sim)} ${visualId} */`;
      expect(repo).not.toContain("SENTINEL");
      const theme: ShippedTheme = { repo, sentinel, shipped: `${repo}\n${sentinel}\n` };
      themes.set(visualId, theme);
      await writeFile(join(sim, "styles", visualId, "theme.css"), theme.shipped, "utf8");
    }

    const outcomes: ApplyOutcome[] = [];
    for (const preset of PRESETS) {
      const theme = themes.get(preset.inheritsVisual);
      if (theme === undefined)
        throw new Error(`sentinel missing the visual theme: ${preset.inheritsVisual}`);
      outcomes.push(await applyPresetOf(sim, theme, preset));
    }
    // Structural assertion: every preset really ran (change the loop to "only the first" and this goes red instantly).
    expect(outcomes).toHaveLength(PRESETS.length);
  }, 120_000);
});
