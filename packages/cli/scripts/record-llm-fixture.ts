// One-shot recorder: hits the real model once and stores the **full response body** under `fixtures/llm/` (budget <= 10 real calls; replay afterwards).
// Not under `src` (excluded from coverage) and tests must not import it — run it by hand with `pnpm dlx tsx`.
// `pnpm verify` never runs it; re-record by hand when a model bump or prompt change makes the fixture stale (see `fixtures/llm/README.md`).
// Usage: OPENCODE_API_KEY=… pnpm dlx tsx packages/cli/scripts/record-llm-fixture.ts fixtures/extract/*.md --out fixtures/llm/ok.json

import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

import { extractStyleWithLlm } from "@hreader/core";
import type { CorpusFormat, CorpusText } from "@hreader/core";

import { LLM_TIMEOUT_MS, createLlmClient } from "../src/llm/client";
import { apiKeyOf, baseUrlOf, modelOf, sessionIdOf } from "../src/llm/session";

const USAGE =
  "用法：OPENCODE_API_KEY=… pnpm dlx tsx packages/cli/scripts/record-llm-fixture.ts <语料.md…> --out <fixture.json>";

const [, , ...argv] = process.argv;

const outAt = argv.indexOf("--out");

const out = outAt === -1 ? undefined : argv[outAt + 1];

const files = argv.filter((_, index) => index !== outAt && index !== outAt + 1);

const apiKey = apiKeyOf(process.env);

const formatOf = (path: string): CorpusFormat =>
  extname(path).toLowerCase() === ".html" ? "html" : "markdown";

if (out === undefined || files.length === 0 || apiKey === undefined) {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
} else {
  // Stored verbatim: the fixture must prove the raw response of a real model is consumed, including its redundancy and format quirks.
  const recordingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await fetch(input, init);
    const text = await response.text();
    writeFileSync(out, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const corpus: readonly CorpusText[] = files.map((path) => ({
    format: formatOf(path),
    text: readFileSync(path, "utf8"),
  }));
  const result = await extractStyleWithLlm({
    corpus,
    id: "fixture",
    name: "fixture",
    inheritsVisual: "atelier-editorial",
    llm: createLlmClient({
      apiKey,
      baseUrl: baseUrlOf(process.env),
      model: modelOf(process.env),
      sessionId: sessionIdOf(process.env),
      timeoutMs: LLM_TIMEOUT_MS,
      fetch: recordingFetch,
    }),
  });
  process.stdout.write(`已录制 ${out}：dropped ${String(result.dropped.length)} 条\n`);
}
