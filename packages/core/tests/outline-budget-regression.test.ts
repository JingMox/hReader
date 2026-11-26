// 这层管：2000 节大纲的预算回归——必须"装得下、报得清"。
// 这条用例是最重要的守门员：诊断聚合/限流/截断报告只要退化，它就会红。
//
// 为什么是这个形状：
//   * `outline_node_without_id` 的报文**不含 id**，所以 2000 条同码诊断会折叠成 2 条
//     （`<section>` / `<h3>` 各一条），报文里带"同报文 2000 条"的真实计数；
//   * `annotation_target_missing` 的报文**含 targetId**，2000 条互不相同 → 只能按 `code` 限流：
//     保留 3 条，剩余 1997 条进"另有 N 条诊断省略"；
//   * 两条路径一起把"折叠"与"限流"都压到真实规模上，实现若把 `count` 写死或拿扫描上限充数必红。
// 注：任务单写的是 `invalid_hr_id`，但 `buildOutline` 不跑 `validateDocument`（那是 model 层的门面），
// outline 侧对应的码是 `outline_node_without_id`；这里用它钉住同一件事，并额外用批注码钉住限流。
// 合法 id 是 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`，所以这里的反例必须是**首位非字母**，
// 不能用 `sec_0`（它在旧模式下反例、在新模式下合法，会让这条回归悄悄变成空转）。

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "../src/index";
import type { Outline } from "../src/index";

const SECTIONS = 2000;
const ANNOTATIONS = 2000;

const badSection = (index: number): string =>
  `<section data-hr-id="1sec-${String(index)}"><h3 data-hr-id="1head-${String(index)}">标题 ${String(index)}</h3></section>`;

const keepSection = (index: number): string =>
  `<section data-hr-id="keep-${String(index)}"><h3 data-hr-id="keep-head-${String(index)}">保留 ${String(index)}</h3></section>`;

const metaWithMissingTargets = (): string =>
  JSON.stringify({
    annotations: Array.from({ length: ANNOTATIONS }, (_, index) => ({
      id: `ann-${String(index)}`,
      targetId: `missing-${String(index)}`,
      comment: "看这里",
      status: "pending_ai",
    })),
  });

const buildHuge = (): Outline =>
  buildOutline(
    parseHtml(
      `<article data-hr-id="doc"><script id="hr-meta">${metaWithMissingTargets()}</script>` +
        `${keepSection(0)}${keepSection(1)}${keepSection(2)}` +
        `${Array.from({ length: SECTIONS }, (_, index) => badSection(index)).join("")}</article>`,
    ),
  );

const codesOf = (outline: Outline): readonly string[] =>
  outline.diagnostics.map((diagnostic) => diagnostic.code);

describe("hr_outline · 2000 节预算回归", () => {
  const outline = buildHuge();

  it("should keep the whole outline under the 8KB budget", () => {
    expect(JSON.stringify(outline).length).toBeLessThanOrEqual(8192);
    expect(outline.nodes.length).toBeGreaterThan(0);
  });

  it("should keep diagnostics under 1024 bytes", () => {
    expect(JSON.stringify(outline.diagnostics).length).toBeLessThanOrEqual(1024);
  });

  it("should fold identical messages and report the real count", () => {
    const folded = outline.diagnostics.filter(
      (diagnostic) => diagnostic.code === "outline_node_without_id",
    );

    expect(folded.length).toBe(2);
    for (const diagnostic of folded) {
      expect(diagnostic.message).toContain(`同报文 ${String(SECTIONS)} 条`);
    }
  });

  it("should cap a distinct-message code at three entries", () => {
    expect(codesOf(outline).filter((code) => code === "annotation_target_missing").length).toBe(3);
  });

  it("should emit exactly one truncation report with the real omitted scale", () => {
    const truncated = outline.diagnostics.filter(
      (diagnostic) => diagnostic.code === "outline_truncated",
    );

    expect(truncated.length).toBe(1);
    expect(truncated[0]?.message).toContain(
      `另有 ${String(ANNOTATIONS - 3)} 条诊断省略（annotation_target_missing ${String(ANNOTATIONS - 3)} 条）`,
    );
  });
});
