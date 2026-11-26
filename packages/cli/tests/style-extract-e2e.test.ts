// This layer is end-to-end — the CLI really runs once writing yaml to disk, then the public loadStyle/compileTone/lintByStyle consume it.
// The LLM and pure-stats versions each run once: the artifact is "all the input for the user's next writing".
// Assertions must be able to falsify the chain (entry counts/persona/request body) — a "it loads" platitude is blind to "merge layer drops fields" or "--no-llm still phones home".

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compileTone, lintByStyle, loadStyle, nodeStyleDeps } from "@hreader/core";
import type { DocumentModel, StyleSpec } from "@hreader/core";

import { run, type CliIo } from "../src/run";

const REPO = join(import.meta.dirname, "../../..");

/** The three fixtures are the statistical layer's ground truth; the e2e must use the same corpus or "it can be consumed" only holds on synthetic input. */
const CORPUS = ["engineering-playbook.md", "plugin-usage-notes.md", "style-authoring.md"].map(
  (name) => join(REPO, "fixtures/extract", name),
);

/** Each corpus piece's **opening-only string**: appearing in argv order proves "all three entered the prompt and order was not scrambled". */
const ANCHORS = ["## 阳台园艺手记", "### 宿主插件使用说明", "# 访谈式自定义风格"];

/**
 * Pass the same corpus in reverse lexicographic order: an implementation sorting paths before building the
 * prompt would still pass under ascending `CORPUS`; only "order opposite to path order" falsifies it, so the two anchors pin one copy each.
 */
const REVERSED = ["style-authoring.md", "plugin-usage-notes.md", "engineering-playbook.md"].map(
  (name) => join(REPO, "fixtures/extract", name),
);

const REVERSED_ANCHORS = ["# 访谈式自定义风格", "### 宿主插件使用说明", "## 阳台园艺手记"];

const RECORDED = readFileSync(join(REPO, "fixtures/llm/ok.json"), "utf8");

const parsedOf = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a nested value by `a.0.b` (numeric segments are array indices): fixtures are external data, so a miss returns undefined instead of throwing. */
const at = (root: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, key) => {
    if (Array.isArray(acc)) {
      const index = Number(key);
      return Number.isInteger(index) ? acc[index] : undefined;
    }
    return isRecord(acc) ? acc[key] : undefined;
  }, root);

const textAt = (root: unknown, path: string): string => {
  const value = at(root, path);
  if (typeof value !== "string") throw new Error(`录像缺少字段：${path}`);
  return value;
};

const personaOf = (raw: string): string =>
  textAt(parsedOf(textAt(parsedOf(raw), "choices.0.message.content")), "persona");

/** The verbatim content the model gave in the recording: `ok.json`'s content lands on persona — only a byte-exact compare proves "the LLM really ran, not a silent downgrade". */
const PERSONA = personaOf(RECORDED);

const CANARY = "sk-test-LEAKCANARY";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-e2e-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Extract {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly path: string;
}

interface Sent {
  readonly urls: string[];
  readonly bodies: string[];
}

const sentOf = (): Sent => ({ urls: [], bodies: [] });

const replayOf =
  (sent: Sent, body = RECORDED): typeof globalThis.fetch =>
  (input, init) => {
    sent.urls.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    sent.bodies.push(typeof init?.body === "string" ? init.body : "");
    return Promise.resolve(new Response(body));
  };

const extractOf = async (
  id: string,
  extra: readonly string[],
  net: { readonly key?: string; readonly fetch?: typeof globalThis.fetch } = {},
  corpus: readonly string[] = CORPUS,
): Promise<Extract> => {
  const out: string[] = [];
  const err: string[] = [];
  const path = join(dir, `${id}.yaml`);
  const io: CliIo = {
    cwd: dir,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
    env: net.key === undefined ? {} : { OPENCODE_API_KEY: net.key },
    ...(net.fetch === undefined ? {} : { fetch: net.fetch }),
  };
  const code = await run(
    ["style", "extract", ...corpus, "--id", id, "--out", `${id}.yaml`, ...extra],
    io,
  );
  return { code, out: out.join(""), err: err.join(""), path };
};

const loadedOf = async (path: string): Promise<StyleSpec> =>
  (await loadStyle({ path }, nodeStyleDeps(dir))).spec;

/** Paragraph → node: lint only sees node text; real corpus paragraphs beat hand-made sentences at proving "the wordlist hits real text". */
const nodesOf = (text: string): readonly DocumentModel[] =>
  text
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block, index) => ({ id: `p${String(index)}`, tag: "p", text: block, children: [] }));

const promptOf = (raw: string): string => {
  const content = at(parsedOf(raw), "messages.0.content");
  return typeof content === "string" ? content : "";
};

const firstSentenceOf = (persona: string): string => {
  const [first] = persona.split(/(?<=[。！？!?])/u);
  return (first ?? persona).trim();
};

describe("style extract · end-to-end (LLM version)", () => {
  it("should write a yaml that carries every merged field and can be consumed", async () => {
    const sent = sentOf();
    const result = await extractOf("e2e-llm", [], { key: CANARY, fetch: replayOf(sent) });
    expect(result.code).toBe(0);

    const spec = await loadedOf(result.path);
    expect(sent.bodies).toHaveLength(1);
    // The count is pinned to the recording: a merge-layer regression like "keeps only the first" is invisible under "it loads".
    expect(spec.language.narrativeRules).toHaveLength(6);
    expect(spec.language.examples).toHaveLength(2);
    expect(spec.language.persona).toBe(PERSONA);
    // 「赋能」 only lives in the model's suggestions, not the statistical wordlist; writing union as intersection would drop it.
    expect(spec.language.vocabulary.forbidden).toContain("赋能");
  });

  it("should compile the merged spec into a tone the host can apply", async () => {
    const sent = sentOf();
    const spec = await loadedOf(
      (await extractOf("e2e-tone", [], { key: CANARY, fetch: replayOf(sent) })).path,
    );

    const tone = compileTone(spec);
    expect(tone).toContain(firstSentenceOf(spec.language.persona));
    for (const rule of spec.language.narrativeRules) expect(tone).toContain(rule);
    for (const word of spec.language.vocabulary.forbidden) expect(tone).toContain(word);
  });
});

describe("style extract · end-to-end (request body)", () => {
  it("should send all three corpora in argv order", async () => {
    const sent = sentOf();
    await extractOf("e2e-order", [], { key: CANARY, fetch: replayOf(sent) });

    const prompt = promptOf(sent.bodies[0] ?? "");
    const positions = ANCHORS.map((anchor) => prompt.indexOf(anchor));
    for (const at of positions) expect(at).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("should keep the argv order even when it differs from path order", async () => {
    const sent = sentOf();
    await extractOf("e2e-order-rev", [], { key: CANARY, fetch: replayOf(sent) }, REVERSED);

    const prompt = promptOf(sent.bodies[0] ?? "");
    const positions = REVERSED_ANCHORS.map((anchor) => prompt.indexOf(anchor));
    for (const at of positions) expect(at).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("should let the style's own vocabulary hit real corpus text", async () => {
    const spec = await loadedOf(
      (await extractOf("e2e-lint", [], { key: CANARY, fetch: replayOf(sentOf()) })).path,
    );
    const forbidden = spec.language.vocabulary.forbidden[0] ?? "";
    const report = lintByStyle(nodesOf(`这里顺手改掉：${forbidden}`), spec.language.vocabulary);

    expect(forbidden.length).toBeGreaterThan(0);
    expect(report.hits[0]?.word).toBe(forbidden);
  });
});

describe("style extract · end-to-end (pure-stats version)", () => {
  it("should produce an equally consumable yaml with --no-llm and never touch the network", async () => {
    const sent = sentOf();
    const result = await extractOf("e2e-stat", ["--no-llm"], {
      key: CANARY,
      fetch: replayOf(sent),
    });
    expect(result.code).toBe(0);
    expect(sent.bodies).toHaveLength(0);

    const spec = await loadedOf(result.path);
    // The statistical layer only produces 3 rules, 0 example groups: separating it from the LLM version pins "which path really ran".
    expect(spec.language.narrativeRules).toHaveLength(3);
    expect(spec.language.examples).toHaveLength(0);

    const tone = compileTone(spec);
    expect(tone).toContain(firstSentenceOf(spec.language.persona));
    for (const rule of spec.language.narrativeRules) expect(tone).toContain(rule);
    for (const word of spec.language.vocabulary.forbidden) expect(tone).toContain(word);

    const report = lintByStyle(
      nodesOf(readFileSync(CORPUS[1] ?? "", "utf8")),
      spec.language.vocabulary,
    );
    expect(Array.isArray(report.hits)).toBe(true);
    expect(typeof report.truncated).toBe("boolean");
  });
});

describe("style extract · end-to-end reverse", () => {
  it("should reject a yaml whose persona line was deleted", async () => {
    const source = await extractOf("e2e-broken", ["--no-llm"]);
    const text = readFileSync(source.path, "utf8");
    const stripped = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("persona:"))
      .join("\n");

    expect(stripped).not.toBe(text);
    writeFileSync(join(dir, "broken.yaml"), stripped);
    await expect(loadStyle({ path: join(dir, "broken.yaml") }, nodeStyleDeps(dir))).rejects.toThrow(
      /persona/u,
    );
  });
});
