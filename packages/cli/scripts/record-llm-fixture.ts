// 一次性录制脚本：真跑一次模型，把**完整响应体**存进 `fixtures/llm/`（D12：≤10 次真调用，录完即回放）。
// 不进 `src`（不参与覆盖率），也不许被测试 import —— 用 `pnpm dlx tsx` 手工跑。
// `pnpm verify` 永不执行它；模型换代或 prompt 改动导致 fixture 失真时手工重录（见 `fixtures/llm/README.md`）。
// 用法：OPENCODE_API_KEY=… pnpm dlx tsx packages/cli/scripts/record-llm-fixture.ts fixtures/extract/*.md --out fixtures/llm/ok.json

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
  // 原样存盘：fixture 要能证明"真模型的原始响应"能被吃下，包括它的赘余与格式瑕疵。
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
