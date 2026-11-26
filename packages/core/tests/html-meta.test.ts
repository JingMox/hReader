import { describe, expect, it } from "vitest";

import { parseHtml } from "../src/index";
import { codesOf, messagesOf, requireElement } from "./html-support";

const META = (payload: string): string =>
  `<article><p>x</p></article><script id="hr-meta" type="application/json">${payload}</script>`;

describe('parseHtml · <script id="hr-meta"> 校验', () => {
  it("should accept a well-formed JSON metadata block", () => {
    const parsed = parseHtml(
      META('{"version":"1.0","annotations":[{"id":"ann-01","targetId":"hr-1"}]}'),
    );

    expect(codesOf(parsed)).toEqual([]);
    expect(requireElement(parsed.root, "script").attrs).toEqual([
      ["id", "hr-meta"],
      ["type", "application/json"],
    ]);
  });

  it("should report invalid metadata JSON as script_in_meta", () => {
    const parsed = parseHtml(META("{not json"));

    expect(codesOf(parsed)).toEqual(["script_in_meta"]);
    expect(messagesOf(parsed)[0]).toContain("不是完整 JSON");
    expect(parsed.diagnostics[0]?.path).toBe("script#hr-meta");
  });

  it("should report a metadata block truncated by </script> and keep the truncated text", () => {
    const parsed = parseHtml(META('{"x":"</script>"}'));
    const parsedCodes = codesOf(parsed);
    const script = requireElement(parsed.root, "script");

    expect(parsedCodes).toContain("script_in_meta");
    expect(script.children).toEqual([{ kind: "text", value: '{"x":"' }]);
  });
});

describe("parseHtml · meta 块的边界文本", () => {
  it("should not report an empty metadata block", () => {
    expect(codesOf(parseHtml(META("")))).toEqual([]);
  });

  it("should not report a whitespace-only metadata block", () => {
    expect(codesOf(parseHtml(META("\n\t  ")))).toEqual([]);
  });

  it("should leave a non-metadata script alone even when its content is not JSON", () => {
    expect(codesOf(parseHtml('<script type="text/template">not json</script>'))).toEqual([]);
  });
});
