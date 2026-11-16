// 这层管：被交付的那个产物——AC-4 要求的高风险面。
// 测的是 `package.json` 的 `bin` 指向的 `dist/main.js`（宿主唯一会 spawn 的东西），不是 src：
// 真子进程、真 stdio，逐行验证 stdout 只有 JSON-RPC 帧；错误路径同样不许往 stdout 漏一个字符。
// 坏输入与超限帧在 `stream.test.ts`，探针本身在 `probe.ts`。

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
      "hr_outline",
      "hr_patch_node",
      "hr_read_node",
      "hr_resolve_annotation",
      "hr_undo",
    ]);
  }, 30_000);
});

const STYLE_PRESET = "atelier-editorial";

/** 三条出口问同一个预设：工具、资源、prompt——它们必须给出同一份风格。 */
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

/** 预设的视觉维度落在 `inherits_visual`；仓库里只有那一份 `theme.css`。 */
const presetOf = (id: string): (typeof BUILTIN_STYLES)[number] | undefined =>
  BUILTIN_STYLES.find((style) => style.id === id);

/** prompt 的正文：`messages[0].content.text`（不经过 JSON 转义，多行片段才比得动）。 */
const promptBodyOf = (answer: Record<string, unknown> | undefined): string => {
  const messages: unknown = resultOf(answer)["messages"];
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  const content: unknown = isRecord(first) ? first["content"] : undefined;
  return isRecord(content) && typeof content["text"] === "string" ? content["text"] : "";
};

const injectedThemeOf = (html: string): string =>
  /<style id="hr-theme">([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? "";

describe("dist/main.js · 风格三出口", () => {
  // G3 P0-2：内置预设的 theme.css 在源码布局里找得到、在 bundle 里找不到——只有真产物能证明这件事。
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
    if (preset === undefined) throw new Error(`内置预设里没有 ${STYLE_PRESET}`);
    // 三个出口必须都回到**同一份源**：工具的 CSS 等于盘上的 theme.css，资源与 prompt 等于预设 spec。
    const themeCss = await readFile(
      join(REPO_ROOT, "styles", preset.inheritsVisual, "theme.css"),
      "utf8",
    );
    const toneSpec = compileTone(preset);
    const injected = injectedThemeOf(await readFile(join(styleDir, "a.html"), "utf8"));

    expect(stderrText).not.toContain("unknown_style");
    expect(resultOf(byId.get(2))["isError"]).toBeUndefined();
    // ① 工具：注入的样式块与预设的 theme.css 逐字一致（改一个字符就红）。
    expect(injected.trim()).toBe(themeCss.trim());
    // ② 资源：YAML 里带的是同一份 spec 的人设，而不是某个写死的短语。
    expect(resource).toContain(preset.language.persona);
    // ③ prompt：编译出的规约与资源同源，取 compileTone 的前三行当落地锚。
    expect(promptText).toContain(toneSpec.split("\n").slice(0, 3).join("\n").trim());
    expect(promptText).toContain(preset.language.persona);
    await rm(styleDir, { recursive: true, force: true });
  }, 30_000);
});

describe("dist/main.js · self-contained", () => {
  it("should run a real tools/call with no node_modules anywhere near it", async () => {
    // 唯一能证明"自包含"的办法：把产物拷到一个没有任何依赖的目录，然后真的调一次工具。
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
      // 仓库外布局：stderr 只有两行——`workspace=` 与一条"主题资源缺失"的 WARNING（stdout 不受影响）。
      const stderrLines = stderrText.trimEnd().split("\n");
      expect(stderrLines).toHaveLength(2);
      expect(stderrLines[0]?.startsWith("[hreader-mcp] workspace=/")).toBe(true);
      expect(stderrLines[1]?.startsWith("[hreader-mcp] WARNING 主题资源缺失：")).toBe(true);
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  }, 45_000);
});
