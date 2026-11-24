// 这层管："三条风格出口对同一份源"的可执行证明。
//
// 它会因为什么而红：任一条出口自己拼一份 CSS/spec（弱实现）→ 与 repo 里的 `theme.css` 或
// `compileTone(spec)` 的字节不再相等；`_meta.origin` 从 `generated` 变成 `file` → 说明它读了别的源；
// 仓库外布局（产物脱离 `styles/`）→ 三条出口必须**一起**失败，而不是工具红了、资源与 prompt 还在回空壳
// （"同一策略两份实现"就是这么回来的）。
//
// 禁止用 `toContain("某句短语")` 当主断言：一句写死的短语能被任何弱实现凑齐。

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILTIN_STYLES, compileTone, readStyleSource } from "@hreader/core";
import { styleDepsOf } from "../src/style-deps";
import { beforeAll, describe, expect, it } from "vitest";

import { ANNOTATED_DOC, isRecord, leaveWorkspace, sessionOf, workspaceIn } from "./harness";
import {
  INITIALIZE,
  INITIALIZED,
  REPO_ROOT,
  binPathOf,
  buildDist,
  byIdOf,
  linesOf,
  probeOf,
  resultOf,
  textOf,
} from "./probe";

beforeAll(buildDist, 180_000);

const PRESET_ID = "atelier-editorial";

const presetOf = (id: string): (typeof BUILTIN_STYLES)[number] => {
  const found = BUILTIN_STYLES.find((style) => style.id === id);
  if (found === undefined) throw new Error(`内置预设里没有 ${id}`);
  return found;
};

const injectedThemeOf = (html: string): string =>
  /<style id="hr-theme">([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? "";

/** `client.getPrompt()` 直接返回 `GetPromptResult`（不像 `callTool` 外面还套一层 `{result}`）。 */
const textBlockOf = (answer: unknown): string => {
  const messages: unknown = isRecord(answer) ? answer["messages"] : undefined;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  const content: unknown = isRecord(first) ? first["content"] : undefined;
  const text: unknown = isRecord(content) ? content["text"] : undefined;
  return typeof text === "string" ? text : "";
};

interface Exits {
  readonly applied: unknown;
  readonly resourceText: string;
  readonly resourceMeta: unknown;
  readonly resourceMime: string | undefined;
  readonly promptText: string;
}

/** 三条出口各取一份原文：这是"同一份源"要比的三堆字节。 */
const exitsOf = async (workspace: string): Promise<Exits> => {
  await writeFile(join(workspace, "a.html"), ANNOTATED_DOC, "utf8");
  const session = await sessionOf();
  const applied: unknown = await session.client.callTool({
    name: "hr_apply_style",
    arguments: { filePath: "a.html", visualId: PRESET_ID },
  });
  const resource = await session.client.readResource({ uri: `hreader://styles/${PRESET_ID}` });
  const prompt: unknown = await session.client.getPrompt({
    name: "use-hreader-style",
    arguments: { toneId: PRESET_ID },
  });
  await session.close();
  const content = resource.contents[0];
  return {
    applied,
    resourceText: content !== undefined && "text" in content ? content.text : "",
    resourceMeta: Reflect.get(content ?? {}, "_meta"),
    resourceMime: content?.mimeType,
    promptText: textBlockOf(prompt),
  };
};

describe("风格三出口 · 同一份源", () => {
  it("should build the tool css, the resource yaml and the prompt text from the same preset", async () => {
    const workspace = await workspaceIn("hreader-mcp-parity-");
    process.chdir(workspace);
    try {
      const preset = presetOf(PRESET_ID);
      const { applied, resourceText, resourceMeta, resourceMime, promptText } =
        await exitsOf(workspace);
      const expectedYaml = await readStyleSource(PRESET_ID, styleDepsOf(workspace));

      // ① 工具：注入的整块 CSS 必须与 repo 里那份 `theme.css` 逐字相等（少一个换行也红）。
      const themeCss = await readFile(
        join(REPO_ROOT, "styles", preset.inheritsVisual, "theme.css"),
        "utf8",
      );
      expect(isRecord(applied) && applied["isError"] === true).toBe(false);
      const injected = injectedThemeOf(await readFile(join(workspace, "a.html"), "utf8"));
      expect(injected.trim()).toBe(themeCss.trim());

      // ② 资源：`origin` 必须是 `generated`（内置档由 core 序列化，不是盘上碰巧有一份 YAML），
      //    正文与 `readStyleSource` 的产物逐字相等（证明适配层没自己拼第二份）。
      expect(resourceMime).toBe("application/yaml");
      expect(resourceMeta).toEqual({ origin: "generated" });
      expect(resourceText).toBe(expectedYaml.yaml);
      // ③ prompt：与 `compileTone(同一份 preset)` **全等**，不是"包含某句人设"。
      expect(promptText).toBe(compileTone(preset));
    } finally {
      await leaveWorkspace(workspace);
    }
  }, 60_000);
});

interface BothExits {
  readonly byId: Map<unknown, Record<string, unknown>>;
  readonly stderrText: string;
}

/** 只拷产物、不拷 `styles/`：这正是"装到别人机器上"的布局。三条出口一次问完。 */
const outOfRepoExitsOf = async (hostDir: string): Promise<BothExits> => {
  const entry = join(hostDir, "main.js");
  await cp(await binPathOf(), entry);
  await writeFile(join(hostDir, "a.html"), ANNOTATED_DOC, "utf8");
  const { frames, stderrText } = await probeOf(entry, {
    cwd: hostDir,
    expected: 4,
    lines: linesOf([
      INITIALIZE,
      INITIALIZED,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "hr_apply_style", arguments: { filePath: "a.html", visualId: PRESET_ID } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: `hreader://styles/${PRESET_ID}` },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "prompts/get",
        params: { name: "use-hreader-style", arguments: { toneId: PRESET_ID } },
      },
    ]),
  });
  return { byId: byIdOf(frames), stderrText };
};

describe("风格三出口 · 仓库外布局", () => {
  it("should fail all three exits instead of pretending only the tool is broken", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "hreader-mcp-parity-out-"));
    try {
      const { byId, stderrText } = await outOfRepoExitsOf(hostDir);

      // ① 工具：码必须是 `style_io_failure`（不是 `unknown_style`——风格存在，是资源没定位到）。
      expect(textOf(byId.get(2)).startsWith("[style_io_failure] ")).toBe(true);
      // ② 资源与 prompt 也必须失败：回空壳就等于"这条出口还在假装能用"。
      expect(resultOf(byId.get(3))).toEqual({});
      expect(isRecord(byId.get(3)?.["error"])).toBe(true);
      expect(resultOf(byId.get(4))).toEqual({});
      expect(isRecord(byId.get(4)?.["error"])).toBe(true);
      // ③ 启动就留痕，别让宿主只能靠猜。
      expect(stderrText).toContain("WARNING 主题资源缺失：");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  }, 60_000);
});
