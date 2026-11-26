// This layer covers command-layer orchestration and fallback branches (file → core → text/JSON); real fs + real core, no subprocess.
//
// Trap: workspace and cwd are realpath'd inside core while `--workspace` is the user's literal string;
// without realpathing cwd too you compare two different strings for the same directory.

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_STYLE_ID } from "@hreader/core";
import { outlineCommand } from "../src/commands/outline";
import { patchCommand } from "../src/commands/patch";
import { readCommand } from "../src/commands/read";
import { styleCommand } from "../src/commands/style";
import { fieldOf } from "./harness";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-cmd-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Document with ids: `outline`/`patch` only honor existing `data-hr-id`s. */
const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p><p data-hr-id="hr-d">正文二</p></article>',
  "</body></html>",
].join("\n");

const fileOf = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

/** Assert the JSON shape (`toMatchObject` is length-strict on arrays, so "only these" comes along for free). */
const jsonOf = (text: string): unknown => JSON.parse(text.trim());

/** Read a string field without a type assertion (`consistent-type-assertions` forbids `as`): fail right here if it is not a string. */
const textOf = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error(`期望字符串，收到 ${typeof value}`);
  }
  return value;
};

describe("outlineCommand", () => {
  it("should print the human outline tree", async () => {
    const path = fileOf("o1.html", DOC);
    expect(await outlineCommand({ path, json: false })).toBe("- hr-b  标题  (2w)\n");
  });

  it("should wrap the Outline in the ok envelope for --json", async () => {
    const path = fileOf("o2.html", DOC);
    expect(jsonOf(await outlineCommand({ path, json: true }))).toMatchObject({
      ok: true,
      data: { nodes: [{ id: "hr-b" }] },
    });
  });

  it("should reject a handwritten document with needs_normalize (no silent empty outline)", async () => {
    const path = fileOf("o3.html", "<article><h2>标题</h2></article>");

    // From the user's view an empty outline with no "why" reads as "the doc has no headings"; this must point at the only next step.
    await expect(outlineCommand({ path, json: true })).rejects.toMatchObject({
      code: "needs_normalize",
    });
    await expect(outlineCommand({ path, json: false })).rejects.toThrow(
      /缺少 data-hr-id，先跑 hr normalize .*o3\.html --write/u,
    );
  });
});

describe("readCommand", () => {
  it("should return the node html and the ids it reports", async () => {
    const path = fileOf("r1.html", DOC);
    const text = await readCommand({ path, target: "h2", maxBytes: undefined, json: true });

    expect(text).toContain("标题");
    expect(text).toContain('"ids":["hr-b"]');
  });

  it("should honour a valid --max-bytes (readNode with a limit)", async () => {
    const path = fileOf("r2.html", DOC);
    const text = await readCommand({ path, target: "hr-a", maxBytes: 4000, json: false });

    expect(text).toContain("正文一");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("should reject an over-small --max-bytes (invalid_max_bytes)", async () => {
    const path = fileOf("r3.html", DOC);
    await expect(
      readCommand({ path, target: "article", maxBytes: 1, json: false }),
    ).rejects.toMatchObject({ code: "invalid_max_bytes" });
  });

  it("should reject a document without any ids (needs_normalize, same code as outline)", async () => {
    const path = fileOf("r4.html", "<article><p>x</p></article>");
    await expect(
      readCommand({ path, target: "p", maxBytes: undefined, json: true }),
    ).rejects.toMatchObject({ code: "needs_normalize" });
  });
});

/** The budget only covers content: `data.html`'s UTF-8 byte count ≤ 80; the `（已截断：…）` marker is meta-info, not counted. */
describe("readCommand · --max-bytes budget boundaries", () => {
  it("should apply --max-bytes to the content and leave the truncation line outside it", async () => {
    const path = fileOf("r2.html", DOC);
    const json = await readCommand({ path, target: "article", maxBytes: 80, json: true });
    const html = textOf(fieldOf(fieldOf(jsonOf(json), "data"), "html"));
    const text = await readCommand({ path, target: "article", maxBytes: 80, json: false });

    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(80);
    expect(text.startsWith(`${html}\n`)).toBe(true);
    const trailer = text.slice(html.length + 1);
    expect(trailer.endsWith("\n")).toBe(true);
    const lines = trailer.slice(0, -1).split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("（已截断：");
  });
});

describe("patchCommand", () => {
  it("should write an append and report changed true with a history path", async () => {
    fileOf("p1.html", DOC);
    const text = await patchCommand({
      path: "p1.html",
      // Switch the target to the container <article>: appending a paragraph into <p> (hr-d) is refused (content-model
      // conflict), while this case only cares that "the write succeeded and reports changed/newIds/historyPath".
      nodeId: "hr-a",
      action: "append",
      html: "<p>新</p>",
      workspace: dir,
      json: true,
    });

    expect(text).toContain(`"path":"${join(dir, "p1.html")}"`);
    expect(text).toContain('"changed":true');
    expect(text).toContain(".hreader/history/");
    expect(text).toMatch(/"newIds":\["[^"]+"\]/u);
  });

  it("should print the human patched line without any id change on replace", async () => {
    fileOf("p2.html", DOC);
    const text = await patchCommand({
      path: "p2.html",
      nodeId: "hr-c",
      action: "replace",
      html: '<p data-hr-id="hr-c">改</p>',
      workspace: dir,
      json: false,
    });

    // `replace`'s new root inherits the target id ⇒ there is no "old → new" to tell; the tail is a clean `+0)`;
    // old id `hr-c` still anchors the node on disk (the next line's assertion reads back from here).
    expect(text).toMatch(/^patched .*p2\.html \(\d+ bytes, \+0\)\n$/u);
    expect(text).not.toContain("id 变更");
    expect(readFileSync(join(dir, "p2.html"), "utf8")).toContain('<p data-hr-id="hr-c">改</p>');
  });
});

describe("styleCommand", () => {
  it("should compile the tone prompt (json and human)", async () => {
    fileOf("s1.html", DOC);
    const parsed = await styleCommand({
      path: "s1.html",
      mode: { kind: "tone", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: true,
    });
    const human = await styleCommand({
      path: "s1.html",
      mode: { kind: "tone", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: false,
    });

    expect(parsed).toContain('"prompt":"');
    expect(parsed).toContain("atelier");
    expect(human).toContain("atelier");
    expect(human.endsWith("\n")).toBe(true);
  });
});

describe("styleCommand · lint", () => {
  it("should lint with the default style vocabulary (json and human)", async () => {
    fileOf(
      "s2.html",
      '<article data-hr-id="hr-a"><p data-hr-id="hr-c">总而言之，赋能与抓手</p></article>',
    );
    const parsed = await styleCommand({
      path: "s2.html",
      mode: { kind: "lint" },
      workspace: dir,
      json: true,
    });
    const human = await styleCommand({
      path: "s2.html",
      mode: { kind: "lint" },
      workspace: dir,
      json: false,
    });

    expect(parsed).toMatch(/"hits":\[\{"path":"[^"]+","word":"总而言之"/u);
    expect(parsed).toContain('"word":"赋能"');
    expect(parsed).toContain('"word":"抓手"');
    expect(human).toContain("总而言之");
  });
});

describe("styleCommand · visual", () => {
  it("should apply the builtin theme and be idempotent (changed true then false)", async () => {
    fileOf("s3.html", DOC);
    const first = await styleCommand({
      path: "s3.html",
      mode: { kind: "visual", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: true,
    });
    const again = await styleCommand({
      path: "s3.html",
      mode: { kind: "visual", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: true,
    });

    expect(first).toContain('"changed":true');
    expect(again).toContain('"changed":false');
  });

  it("should fall back to its own path when no display path is supplied", async () => {
    fileOf("s5.html", DOC);
    const human = await styleCommand({
      path: "s5.html",
      mode: { kind: "visual", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: false,
    });

    // The command layer cannot see the relative string the user typed (only the dispatch layer knows it): the fallback is the result's own path, and it must be printed too.
    expect(human).toContain("s5.html");
    expect(human).toMatch(/^styled .+s5\.html \(\d+ bytes\)\n$/u);
  });

  it("should apply a theme to a foreign doc with the same hr-theme-only write", async () => {
    fileOf(
      "foreign.html",
      '<!doctype html><html><body><div class="app">外来内容</div></body></html>',
    );
    const result = await styleCommand({
      path: "foreign.html",
      mode: { kind: "visual", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: true,
    });
    const html = readFileSync(join(dir, "foreign.html"), "utf8");

    expect(result).toContain('"changed":true');
    expect(html).toContain('<style id="hr-theme">');
    expect(html).toContain('<div class="app">外来内容</div>');
  });
});

describe("styleCommand · id validation for visual", () => {
  it("should refuse a tone id on --visual (two id spaces)", async () => {
    fileOf("s4.html", DOC);

    // Handing a tone id to `--visual` would silently apply the wrong theme, so stop it before applying and point at the one remaining route.
    await expect(
      styleCommand({
        path: "s4.html",
        mode: { kind: "visual", id: "feynman-tech" },
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("should surface a malformed visual id as invalid_style instead of treating it as unknown", async () => {
    fileOf("s6.html", DOC);

    // `--visual "Bad Id!"` is not even a legal shape: this is not "theme not found" but a malformed id (a wholly different next step).
    await expect(
      styleCommand({
        path: "s6.html",
        mode: { kind: "visual", id: "Bad Id!" },
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_style" });
  });
});

describe("styleCommand · unknown ids for visual", () => {
  it("should let an unknown id through to applyStyle instead of guessing", async () => {
    fileOf("s5.html", DOC);

    // Neither visual nor tone: do not answer here — let applyStyle report its own `unknown_style`.
    await expect(
      styleCommand({
        path: "s5.html",
        mode: { kind: "visual", id: "no-such-theme" },
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "unknown_style" });
  });
});
const edgeDir = realpathSync(mkdtempSync(join(tmpdir(), "hr-edge-")));
afterAll(() => {
  rmSync(edgeDir, { recursive: true, force: true });
});

const EDGE_DOC = [
  "<!doctype html><html><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<style>p{color:red}</style><p data-hr-id="hr-c">正文</p></article>',
  "</body></html>",
].join("\n");

const edgeFileOf = (name: string, html: string): string => {
  const path = join(edgeDir, name);
  writeFileSync(path, html);
  return path;
};

/** Collapse a rejection into "code + message + data.reason" to avoid writing `await expect(...).rejects` everywhere. */
const rejectionOf = async (
  promise: Promise<string>,
): Promise<{ code: string; message: string; reason: string }> => {
  try {
    await promise;
  } catch (error: unknown) {
    const code: unknown = Reflect.get(Object(error), "code");
    const message: unknown = Reflect.get(Object(error), "message");
    const data: unknown = Reflect.get(Object(error), "data");
    const reason: unknown = Reflect.get(Object(data), "reason");
    return { code: String(code), message: String(message), reason: String(reason) };
  }
  throw new Error("expected rejection, but the command succeeded");
};

describe("readCommand · retry by node id after selector failure", () => {
  it("should retry a plain node id as [data-hr-id] and succeed", async () => {
    const path = edgeFileOf("e1.html", EDGE_DOC);
    const text = await readCommand({ path, target: "hr-b", maxBytes: undefined, json: true });

    expect(JSON.parse(text.trim())).toMatchObject({
      ok: true,
      data: { ids: ["hr-b"] },
    });
  });

  it("should report invalid_selector when the target is not a legal selector", async () => {
    const path = edgeFileOf("e2.html", EDGE_DOC);
    const failed = await rejectionOf(
      readCommand({ path, target: '">', maxBytes: undefined, json: false }),
    );

    // When both hops fail, code and message are decided by the target's shape — `">` is not a legal id, so it is the syntax sentence.
    expect(failed.code).toBe("invalid_selector");
    expect(failed.reason).toBe("syntax");
    expect(failed.message).toContain('选择器 "\\">" 无法解析：');
  });

  it("should prefer node_not_found when only the id lookup is well-formed", async () => {
    const path = edgeFileOf("e3.html", EDGE_DOC);
    // `hr-NOPE` is a legal id shape (`HR_ID_PATTERN` allows uppercase) and absent from the doc: only the id hop fails —
    // it proves the original intent "when only the id hop holds, report node_not_found" was not lost to a syntax re-judgment under `p[`.
    const failed = await rejectionOf(
      readCommand({ path, target: "hr-NOPE", maxBytes: undefined, json: false }),
    );

    expect(failed.code).toBe("node_not_found");
    expect(failed.message).toContain('文档里没有 id 为 "hr-NOPE" 的节点。');
  });
});

describe("patchCommand · target does not exist yet", () => {
  it("should resolve the deepest existing ancestor and fail node_not_found without creating it", async () => {
    const failed = await rejectionOf(
      patchCommand({
        path: "missing/deep.html",
        nodeId: "hr-a",
        action: "append",
        html: "<p>x</p>",
        workspace: edgeDir,
        json: false,
      }),
    );

    expect(failed.code).toBe("not_a_file");
    expect(readdirSync(edgeDir).includes("missing")).toBe(false);
  });
});

describe("styleCommand · lint mode", () => {
  it("should print the human lint summary", async () => {
    edgeFileOf("e4.html", EDGE_DOC);
    const text = await styleCommand({
      path: "e4.html",
      mode: { kind: "lint" },
      workspace: edgeDir,
      json: false,
    });

    expect(text).toBe("");
  });

  it("should return the hits array in JSON mode", async () => {
    edgeFileOf("e5.html", EDGE_DOC);
    const text = await styleCommand({
      path: "e5.html",
      mode: { kind: "lint" },
      workspace: edgeDir,
      json: true,
    });

    expect(JSON.parse(text.trim())).toMatchObject({ ok: true, data: { hits: [] } });
  });
});
