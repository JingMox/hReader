// 这层管：AC-1 的"假安装"证据——`dist/` + `styles/` 一起拷到**没有仓库**的目录里，
// 真子进程 stdio 握手，对三个内置预设逐个 `hr_apply_style`，并断言样式**真的生效**（不是"没报错"）。
// 它测的是交付形态：`build` 里少了拷 `styles/` 那一步，本文件必红（M3.1.1 AC-7）。

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

/** 三个内置预设：换肤 id 就是预设 id（仓库只发一份 theme，三个预设都继承它）。 */
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

/** 随包发布的主题：`shipped` 是写进模拟安装目录的那份，`repo` 是仓库根的原件。 */
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

/** 工具成功帧的正文是 `{visual, tone}` 的 JSON；字段分开取，不做整体类型断言。 */
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

/** 对单个预设跑一次真进程：干净文档 → 握手 → `hr_apply_style` → 断言样式真的落盘。 */
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
  // 资源真的定位到了：启动 WARNING 一个字都没有，换肤也真的写了盘。
  expect(probe.stderrText).not.toContain("WARNING 主题资源缺失");
  const outcome = outcomeOf(textOf(frame));
  expect(outcome.changed).toBe(true);
  // 生效 = 落盘的 `<style id="hr-theme">` 内容与随包发布的那份 theme.css 逐字相同（core 原样拼接）。
  // 拿"写了个 style 标签"或"没报错"当证据，正是上一张卡栽过的坑。
  expect(themeOf(written)).toBe(theme.shipped);
  // 哨兵：模拟目录那份与仓库那份**只差这一行注释**。实现若偷懒去读仓库根那份，这两条必红——
  // 没有它们时 `shipped === repo`，"读包内"与"读仓库"在断言上完全不可分（F3-1）。
  expect(themeOf(written)).toContain(theme.sentinel);
  expect(themeOf(written)).not.toBe(theme.repo);
  expect(outcome.bytes).toBe(Buffer.byteLength(written, "utf8"));
  // 调性走的是另一条 core 链路（loadStyle → resolveThemePath），同样要能读到随包资源。
  expect(outcome.tone).toContain(preset.language.persona);
  return outcome;
};

describe("假安装（/tmp，无仓库）", () => {
  it("should style a document with every builtin preset when only dist/ and styles/ are shipped", async () => {
    // 一次真安装：只拷产物与资源，模拟 `npm i` 之后的包目录。
    const sim = await mkdtemp(join(tmpdir(), "hreader-install-sim-"));
    sims.push(sim);
    await cp(join(PACKAGE_ROOT, "dist"), join(sim, "dist"), { recursive: true });
    await cp(join(PACKAGE_ROOT, "styles"), join(sim, "styles"), { recursive: true });

    // 前提断言：这里真的没有仓库，资源就在产物旁边。
    expect(existsSync(join(sim, "packages"))).toBe(false);
    // 把模拟安装目录那份改写成"仓库原件 + 一行哨兵注释"：两份内容不同，才分得出实现读的是哪一份。
    const repo = await readFile(
      join(REPO_ROOT, "styles", "atelier-editorial", "theme.css"),
      "utf8",
    );
    const sentinel = `/* SENTINEL ${basename(sim)} */`;
    expect(repo).not.toContain("SENTINEL");
    const shippedTheme: ShippedTheme = { repo, sentinel, shipped: `${repo}\n${sentinel}\n` };
    await writeFile(
      join(sim, "styles", "atelier-editorial", "theme.css"),
      shippedTheme.shipped,
      "utf8",
    );

    const outcomes: ApplyOutcome[] = [];
    for (const preset of PRESETS) outcomes.push(await applyPresetOf(sim, shippedTheme, preset));
    // 结构性断言：三个预设都真的跑过（把循环改成"只测第一个"，这条立刻红）。
    expect(outcomes).toHaveLength(PRESETS.length);
  }, 120_000);
});
