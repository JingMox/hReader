// This layer: executable proof that "the three style exits serve the same source".
//
// What makes it red: any exit building its own CSS/spec (weak implementation) → bytes stop matching the repo's `theme.css` or
// `compileTone(spec)`; `_meta.origin` changing from `generated` to `file` → it read a different source;
// the out-of-repo layout (artifact without `styles/`) → all three exits must fail **together**, not the tool red while resource and prompt still answer shells
// (that is how "one strategy, two implementations" comes back).
//
// Forbidden as the main assertion: `toContain("some phrase")` — any weak implementation can cobble together a hardcoded phrase.

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
  if (found === undefined) throw new Error(`no ${id} among the builtin presets`);
  return found;
};

const injectedThemeOf = (html: string): string =>
  /<style id="hr-theme">([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? "";

/** `client.getPrompt()` returns `GetPromptResult` directly (unlike `callTool`, which wraps `{result}` around it). */
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

/** Each of the three exits contributes one original text: the three piles of bytes "same source" is compared over. */
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

describe("three style exits · the same source", () => {
  it("should build the tool css, the resource yaml and the prompt text from the same preset", async () => {
    const workspace = await workspaceIn("hreader-mcp-parity-");
    process.chdir(workspace);
    try {
      const preset = presetOf(PRESET_ID);
      const { applied, resourceText, resourceMeta, resourceMime, promptText } =
        await exitsOf(workspace);
      const expectedYaml = await readStyleSource(PRESET_ID, styleDepsOf(workspace));

      // ① Tool: the whole injected CSS block must equal the repo's `theme.css` byte for byte (one missing newline goes red).
      const themeCss = await readFile(
        join(REPO_ROOT, "styles", preset.inheritsVisual, "theme.css"),
        "utf8",
      );
      expect(isRecord(applied) && applied["isError"] === true).toBe(false);
      const injected = injectedThemeOf(await readFile(join(workspace, "a.html"), "utf8"));
      expect(injected.trim()).toBe(themeCss.trim());

      // ② Resource: `origin` must be `generated` (builtin presets are serialized by core, not a YAML that happens to sit on disk),
      //    and the body must equal `readStyleSource`'s output byte for byte (proving the adapter built no second copy).
      expect(resourceMime).toBe("application/yaml");
      expect(resourceMeta).toEqual({ origin: "generated" });
      expect(resourceText).toBe(expectedYaml.yaml);
      // ③ Prompt: **identical** to `compileTone(the same preset)`, not "contains some persona phrase".
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

/** Copy only the artifact, not `styles/`: exactly the "installed on someone else's machine" layout. All three exits asked in one pass. */
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

describe("three style exits · out-of-repo layout", () => {
  it("should fail all three exits instead of pretending only the tool is broken", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "hreader-mcp-parity-out-"));
    try {
      const { byId, stderrText } = await outOfRepoExitsOf(hostDir);

      // ① Tool: the code must be `style_io_failure` (not `unknown_style` — the style exists; its resources were not located).
      expect(textOf(byId.get(2)).startsWith("[style_io_failure] ")).toBe(true);
      // ② Resource and prompt must fail too: answering a shell means "this exit still pretends to work".
      expect(resultOf(byId.get(3))).toEqual({});
      expect(isRecord(byId.get(3)?.["error"])).toBe(true);
      expect(resultOf(byId.get(4))).toEqual({});
      expect(isRecord(byId.get(4)?.["error"])).toBe(true);
      // ③ Leave a trace at startup; do not make the host guess.
      expect(stderrText).toContain("WARNING 主题资源缺失：");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  }, 60_000);
});
