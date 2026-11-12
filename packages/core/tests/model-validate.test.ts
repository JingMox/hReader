import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, validateDocument } from "../src/index";
import { DIAGNOSTIC_SEVERITY } from "../src/html/constants";
import type { Diagnostic, DiagnosticCode } from "../src/index";

// 卡片 M1.2 契约 2：validateDocument 与 M1.1 的诊断同处一个 code 空间、按文档序稳定、
// 按 `code|path|message` 去重；四个新码的严重度与"每处一条"的粒度都在这里钉住。

const validate = (html: string): readonly Diagnostic[] =>
  validateDocument(injectNodeIds(parseHtml(html)).parsed);

const triplesOf = (diagnostics: readonly Diagnostic[]): readonly string[] =>
  diagnostics.map((diagnostic) =>
    [diagnostic.code, diagnostic.path ?? "", diagnostic.message].join("|"),
  );

describe("validateDocument · duplicate_id", () => {
  it("should report every occurrence of a repeated id, with its own path", () => {
    const diagnostics = validate(
      '<article data-hr-id="doc"><p data-hr-id="dup">a</p><p data-hr-id="dup">b</p><p data-hr-id="dup">c</p></article>',
    );

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "duplicate_id",
      "duplicate_id",
      "duplicate_id",
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "html[0]>body[0]>article[0]>p[0]",
      "html[0]>body[0]>article[0]>p[1]",
      "html[0]>body[0]>article[0]>p[2]",
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'data-hr-id="dup" 重复出现（共 3 处）',
      'data-hr-id="dup" 重复出现（共 3 处）',
      'data-hr-id="dup" 重复出现（共 3 处）',
    ]);
  });
});

describe("validateDocument · duplicate_id · 续", () => {
  it("should count the article itself when it shares the id", () => {
    const diagnostics = validate(
      '<article data-hr-id="dup"><p data-hr-id="dup">a</p><p data-hr-id="dup">b</p></article>',
    );

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]?.message).toContain("共 3 处");
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.path)).size).toBe(3);
  });

  it("should be an error and keep document order stable across calls", () => {
    const injected = injectNodeIds(
      parseHtml(
        '<article data-hr-id="doc"><p data-hr-id="d">a</p><p data-hr-id="d">b</p></article>',
      ),
    );

    expect(validateDocument(injected.parsed).map((diagnostic) => diagnostic.severity)).toEqual([
      "error",
      "error",
    ]);
    expect(triplesOf(validateDocument(injected.parsed))).toEqual(
      triplesOf(validateDocument(injected.parsed)),
    );
  });
});

describe("validateDocument · heading_level_jump", () => {
  it("should warn on a two level jump", () => {
    const diagnostics = validate("<article><h2>a</h2><h4>b</h4></article>");

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["heading_level_jump"]);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.message).toBe("标题层级从 h2 跳到 h4（跳级 >1）");
    expect(diagnostics[0]?.path).toBe("html[0]>body[0]>article[0]>h4[0]");
  });

  it("should warn when an h1 is followed by an h3", () => {
    expect(validate("<article><h1>t</h1><h3>u</h3></article>").map((d) => d.code)).toEqual([
      "heading_level_jump",
    ]);
  });

  it("should stay quiet for h2 followed by h3 and for repeated h2", () => {
    expect(validate("<article><h2>a</h2><h3>b</h3></article>")).toEqual([]);
    expect(validate("<article><h2>a</h2><h2>b</h2></article>")).toEqual([]);
  });

  it("should accept a single h1 inside the article (v2 removed the skip-root code)", () => {
    expect(validate("<article><h1>t</h1></article>")).toEqual([]);
    expect(Object.hasOwn(DIAGNOSTIC_SEVERITY, "heading_level_skip_root")).toBe(false);
  });

  it("should still track headings that have no article ancestor", () => {
    const diagnostics = validate("<div><h2>a</h2><h4>b</h4></div>");

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "heading_level_jump",
      "missing_article",
    ]);
  });
});

describe("validateDocument · article 数量", () => {
  it("should report multiple_article once per surplus article", () => {
    const diagnostics = validate(
      '<article data-hr-id="a1">x</article><article data-hr-id="a2">y</article><article data-hr-id="a3">z</article>',
    );

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "multiple_article",
      "multiple_article",
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "html[0]>body[0]>article[1]",
      "html[0]>body[0]>article[2]",
    ]);
    expect(diagnostics[0]?.message).toBe("文档里有 3 个 <article>（应为 1 个）");
  });

  it("should report missing_article without a path", () => {
    const [diagnostic, ...rest] = validate("<div>a</div>");

    expect(rest).toEqual([]);
    expect(diagnostic?.code).toBe("missing_article");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toBe("文档里没有 <article>");
    expect(diagnostic === undefined ? true : "path" in diagnostic).toBe(false);
  });
});

describe("validateDocument · 与 M1.1 诊断合并", () => {
  it("should keep M1.1 diagnostics first and remain stable across calls", () => {
    const html =
      "<article><h2>a</h2><h4>b</h4><p data-hr-id='Bad Id'>x</p><p data-hr-id='dup'>1</p><p data-hr-id='dup'>2</p></article>";
    const injected = injectNodeIds(parseHtml(html));
    const first = validateDocument(injected.parsed);

    expect(first.map((diagnostic) => diagnostic.code)).toEqual([
      "invalid_hr_id",
      "heading_level_jump",
      "duplicate_id",
      "duplicate_id",
    ]);
    expect(triplesOf(validateDocument(injected.parsed))).toEqual(triplesOf(first));
  });

  it("should not emit the same code|path|message twice", () => {
    const diagnostics = validate(
      '<article data-hr-id="doc"><h2>a</h2><h4>b</h4><div data-hr-component="nope">x</div><p data-hr-id="Bad Id">y</p></article>',
    );
    const triples = triplesOf(diagnostics);

    expect(triples.length).toBeGreaterThan(2);
    expect(new Set(triples).size).toBe(triples.length);
  });

  it("should map every new code to the severity the card fixes", () => {
    expect(DIAGNOSTIC_SEVERITY["duplicate_id" satisfies DiagnosticCode]).toBe("error");
    expect(DIAGNOSTIC_SEVERITY["missing_article" satisfies DiagnosticCode]).toBe("error");
    expect(DIAGNOSTIC_SEVERITY["multiple_article" satisfies DiagnosticCode]).toBe("error");
    expect(DIAGNOSTIC_SEVERITY["heading_level_jump" satisfies DiagnosticCode]).toBe("warning");
  });
});

describe("validateDocument · 与 M1.1 诊断合并 · 续", () => {
  it("should flag an illegal id that reached validate without injection", () => {
    const diagnostics = validateDocument(
      parseHtml('<article data-hr-id="Bad Id"><p>a</p></article>'),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid_hr_id"]);
    expect(diagnostics[0]?.message).toBe('data-hr-id="Bad Id" 不合法（应为非空 [a-z0-9-]）');
    expect(diagnostics[0]?.path).toBe("html[0]>body[0]>article[0]");
  });

  it("should flag an empty data-hr-id on any element", () => {
    const diagnostics = validateDocument(
      parseHtml('<article data-hr-id="doc"><p data-hr-id="">a</p></article>'),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid_hr_id"]);
    expect(diagnostics[0]?.message).toBe('data-hr-id="" 不合法（应为非空 [a-z0-9-]）');
    expect(diagnostics[0]?.path).toBe("html[0]>body[0]>article[0]>p[0]");
  });

  it("should report an article without data-hr-id instead of throwing", () => {
    // 未注入的输入：validate 只诊断（可恢复），toDocumentModel 才抛 invalid_document（不可恢复）。
    const diagnostics = validateDocument(parseHtml("<article><p>a</p></article>"));

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid_hr_id"]);
    expect(diagnostics[0]?.message).toBe("<article> 缺少 data-hr-id");
    expect(diagnostics[0]?.severity).toBe("warning");
  });
});

// 卡片 v3 #11：两层的 path 必须逐字同构（无前导 `>`，语法 `tag[i]>tag[i]>…`，锚在 `html[0]`）。
// 下面这条把**同一份源文本、同一个 `<p>`** 同时送进两层：该 `<p>` 的 `data-hr-id` 对两层都不合法，
// 于是 inject 层与 validate 层各报一条 `invalid_hr_id`，两条的 `path` 可以直接 `===` 比对。
// 任何一层改口径（加前导 `>`、换分隔符、从 body 起算、兄弟序号偏位）都会红。
// 注：不能用“合法重复 id”来构造 —— inject 的 `used` 集合是**预扫描**的（实测：生成 id 遇到文档已有的
// `hr-xxxxxxxx` 会退避成 `hr-xxxxxxxx-2`），所以注入完成后不可能出现与已有 id 相同的重复，两层永远
// 不会在同一个节上分别报 `invalid_hr_id` 与 `duplicate_id`。
describe("validateDocument · path 与 injectNodeIds 同构", () => {
  const CLASH = '<article data-hr-id="doc"><div><p data-hr-id="Bad Id">a</p></div></article>';

  it("should give one element byte-identical paths in both layers", () => {
    const fromInject = injectNodeIds(parseHtml(CLASH)).parsed.diagnostics.find(
      (diagnostic) => diagnostic.code === "invalid_hr_id",
    );
    const fromValidate = validateDocument(parseHtml(CLASH)).find(
      (diagnostic) => diagnostic.code === "invalid_hr_id",
    );

    expect(fromInject?.path).toBe("html[0]>body[0]>article[0]>div[0]>p[0]");
    expect(fromValidate?.path).toBe(fromInject?.path);
    expect(fromInject?.path).not.toMatch(/^>/u);
  });
});

// 合并键是 `code|path|message`，而 `multiple_article` / `missing_article` 没有 path ——
// 所以同一批诊断里必然同时出现"有 path"与"无 path"两种键。这条用例专门喂这两类，
// 让 `validate.ts` 合并时 `diagnostic.path ?? ""` 的两条路径都真的被执行。
describe("validateDocument · 合并键的 path 缺省", () => {
  it("should merge a path-less diagnostic together with a path-bearing one", () => {
    const diagnostics = validateDocument(parseHtml('<div data-hr-id="Bad Id">x</div>'));
    const byCode = new Map(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic]));

    expect([...byCode.keys()].sort()).toEqual(["invalid_hr_id", "missing_article"]);
    expect(byCode.get("missing_article")?.path).toBeUndefined();
    expect(byCode.get("invalid_hr_id")?.path).toBe("html[0]>body[0]>div[0]");
  });
});
