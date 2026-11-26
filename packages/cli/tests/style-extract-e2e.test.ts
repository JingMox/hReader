// 这层管：端到端——CLI 真跑一遍把 yaml 写到盘，再用公开的 loadStyle/compileTone/lintByStyle 消费它。
// LLM 版与纯统计版各走一遍：产物是"用户下一次写作的全部输入"。断言要能证伪链路（条数/人设/请求体），
// 只证"能 load"的套话对"合并层丢字段""--no-llm 仍联网"这类错误全盲。

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compileTone, lintByStyle, loadStyle, nodeStyleDeps } from "@hreader/core";
import type { DocumentModel, StyleSpec } from "@hreader/core";

import { run, type CliIo } from "../src/run";

const REPO = join(import.meta.dirname, "../../..");

/** 三篇 fixture 是统计层的真值来源，端到端必须用同一份语料，否则"能消费"只是对合成输入成立。 */
const CORPUS = ["engineering-playbook.md", "plugin-usage-notes.md", "style-authoring.md"].map(
  (name) => join(REPO, "fixtures/extract", name),
);

/** 每篇语料的**篇首独有串**：按 argv 顺序出现才证明"三篇都进了 prompt 且顺序没被打乱"。 */
const ANCHORS = ["## 阳台园艺手记", "### 宿主插件使用说明", "# 访谈式自定义风格"];

/**
 * 逆字典序传同一批语料：按路径排序后再拼 prompt 的实现在升序 `CORPUS` 下也能过，
 * 只有"顺序与路径序相反"这一例能证伪，所以两套锚点各钉一份。
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

/** 按 `a.0.b` 取嵌套值（纯数字段走数组下标）：fixture 是外部数据，取不到要返回 undefined 而不是抛。 */
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

/** 录像里模型给的原文：`ok.json` 的 content 就落在 persona 上，逐字比对才能证"真走了 LLM 而不是静默降级"。 */
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

/** 段落 → 节点：lint 只看节点文本，用真语料段落比手搓句子更能证明"词表能命中真文本"。 */
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

describe("style extract · 端到端（LLM 版）", () => {
  it("should write a yaml that carries every merged field and can be consumed", async () => {
    const sent = sentOf();
    const result = await extractOf("e2e-llm", [], { key: CANARY, fetch: replayOf(sent) });
    expect(result.code).toBe(0);

    const spec = await loadedOf(result.path);
    expect(sent.bodies).toHaveLength(1);
    // 条数钉在录像上：合并层"只留第一条"之类的退化在"能 load"下看不出来。
    expect(spec.language.narrativeRules).toHaveLength(6);
    expect(spec.language.examples).toHaveLength(2);
    expect(spec.language.persona).toBe(PERSONA);
    // 「赋能」只在模型建议里，统计词表没有它；并集写成交集就会丢。
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

describe("style extract · 端到端（请求体）", () => {
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

describe("style extract · 端到端（纯统计版）", () => {
  it("should produce an equally consumable yaml with --no-llm and never touch the network", async () => {
    const sent = sentOf();
    const result = await extractOf("e2e-stat", ["--no-llm"], {
      key: CANARY,
      fetch: replayOf(sent),
    });
    expect(result.code).toBe(0);
    expect(sent.bodies).toHaveLength(0);

    const spec = await loadedOf(result.path);
    // 统计层只出 3 条规则、0 组例子：与 LLM 版区分开，才能钉住"哪条路径真的跑了"。
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

describe("style extract · 端到端反向", () => {
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
