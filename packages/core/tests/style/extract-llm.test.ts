// 这层管：`extractStyleWithLlm` 的编排契约（建议不可用即失败、建议照合并、统计层不被影响）。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { extractStyle, extractStyleWithLlm } from "../../src/style/extract";
import type { CorpusText, LlmPort } from "../../src/style/extract";
import { parseStyleText } from "../../src/style/spec";

const CORPUS: readonly CorpusText[] = [
  { format: "markdown", text: "第一段只有一句。\n\n第二段两句。还带一个转折。" },
];

const INPUT = {
  corpus: CORPUS,
  id: "llm-style",
  name: "组合风格",
  inheritsVisual: "atelier-editorial",
};

/** 只回放一份响应：组合层不该关心传输细节，这正是 `LlmPort` 的边界。 */
const portOf = (content: string): LlmPort => ({
  complete: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content } }] })),
});

const failureOf = async (content: string): Promise<HrError> => {
  try {
    await extractStyleWithLlm({ ...INPUT, llm: portOf(content) });
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("期望抛错，但调用成功了");
};

describe("extractStyleWithLlm · 判据", () => {
  it("should fail with llm_failure when the response has no usable field", async () => {
    const error = await failureOf("{}");

    expect(error.code).toBe("llm_failure");
    expect(error.message).toBe("模型没有返回可用的风格建议（响应里没有可用的字段）");
  });

  it("should name the dropped reason when the response is not JSON", async () => {
    const error = await failureOf("模型今天不想说话");

    expect(error.message).toBe("模型没有返回可用的风格建议（content: unparsable）");
  });
});

describe("extractStyleWithLlm · 合并", () => {
  it("should take the suggestion, keep the statistics and stay parseable", async () => {
    const stat = extractStyle(INPUT);
    const result = await extractStyleWithLlm({
      ...INPUT,
      llm: portOf(
        JSON.stringify({
          persona: "短句作者",
          narrative_rules: ["少用形容词"],
          rhythm_style: "短句为主",
          forbidden: ["值得注意的是"],
          examples: [{ bad: "很长的句子", good: "短的句子" }],
          vibes: "多余键",
        }),
      ),
    });

    expect(result.spec.language.persona).toBe("短句作者");
    expect(result.spec.language.narrativeRules).toEqual(["少用形容词"]);
    expect(result.spec.language.rhythm.maxParagraphSentences).toBe(
      stat.stats.maxParagraphSentences,
    );
    expect(result.stats).toEqual(stat.stats);
    // 统计层已占满 `MAX_FORBIDDEN=24`，所以追加词只能落成一条聚合的 `too_long`（不是静默丢弃）。
    expect(result.dropped).toEqual([
      { field: "vibes", reason: "not_owned" },
      { field: "forbidden", reason: "too_long" },
    ]);
    expect(parseStyleText(result.yaml, INPUT.id)).toEqual(result.spec);
  });
});
