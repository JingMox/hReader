import { chdir, cwd } from "node:process";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, serializeHtml } from "../src/index";
import type { InjectedNodeIds } from "../src/index";
import {
  attributeValue,
  codesOf,
  collectElements,
  findElement,
  requireElement,
} from "./html-support.test";

const HR_ID = "data-hr-id";

const SAMPLE_DOC =
  '<article><h2>标题</h2><section data-hr-component="split-compare"><p>a</p><p>b</p></section></article>';
const ID_SHAPE = /^hr-[0-9a-f]{8}(-\d+)?$/u;

const inject = (html: string): InjectedNodeIds => injectNodeIds(parseHtml(html));

const idOf = (injected: InjectedNodeIds, tag: string): string | undefined => {
  const element = findElement(injected.parsed.root, tag);
  return element === undefined ? undefined : attributeValue(element, HR_ID);
};

const idAttributes = (
  injected: InjectedNodeIds,
  tag: string,
): readonly (readonly [string, string])[] =>
  requireElement(injected.parsed.root, tag).attrs.filter(([name]) => name === HR_ID);

describe("injectNodeIds · 注入范围", () => {
  it("should inject block elements inside article and nothing outside it", () => {
    const injected = inject("<main><p>o</p></main><article><h2>a</h2><p>b</p></article>");
    const outside = requireElement(injected.parsed.root, "main").children[0];

    // M1.2 v2：最外层 <article> 自身也进注入清单（模型根需要 data-hr-id）。
    expect(injected.injected).toHaveLength(3);
    if (outside?.kind !== "element") {
      throw new Error("expected an element below <main>");
    }
    const article = requireElement(injected.parsed.root, "article");
    expect(attributeValue(outside, HR_ID)).toBeUndefined();
    expect(attributeValue(article, HR_ID)).toMatch(ID_SHAPE);
    expect(attributeValue(requireElement(article, "p"), HR_ID)).toMatch(ID_SHAPE);
    expect(attributeValue(requireElement(article, "h2"), HR_ID)).toMatch(ID_SHAPE);
  });
});

describe("injectNodeIds · 注入范围 · 续", () => {
  it("should inject the article element itself since M1.2 v2", () => {
    const injected = inject("<article><p>a</p></article>");

    // v2 裁定 1 反转了 M1.1 的旧断言：模型根必须带 data-hr-id，所以 article 自身是注入目标。
    expect(injected.injected).toHaveLength(2);
    expect(attributeValue(requireElement(injected.parsed.root, "article"), HR_ID)).toMatch(
      ID_SHAPE,
    );
  });

  it("should keep article scope across nested articles", () => {
    const injected = inject("<article><article><p>a</p></article></article>");
    // requireElement 从自身开始找，会返回外层 article 自己；这里按文档序取两个 article 再分。
    const articles = collectElements(injected.parsed.root).filter(
      (element) => element.tag === "article",
    );
    const [outer, inner] = articles;
    if (outer === undefined || inner === undefined) {
      throw new Error("expected an outer and an inner <article>");
    }

    // 只有最外层 article 自身 + 内层 p 被注入；内层 article 因 insideArticle 为真而不注入。
    expect(injected.injected).toHaveLength(2);
    expect(attributeValue(outer, HR_ID)).toMatch(ID_SHAPE);
    expect(attributeValue(inner, HR_ID)).toBeUndefined();
  });
});

describe("injectNodeIds · div 与词表", () => {
  // F10：`div` 无条件进 `ADDRESSABLE_TAGS` —— 批注与 patch 要能命中普通容器，
  // 不再要求 `data-hr-component`。这条用例守着“别再把它按组件属性分等级”。
  it("should give a plain div the same id treatment as a component div", () => {
    const injected = inject(
      '<article><div>a</div><div data-hr-component="kpi-bento">b</div></article>',
    );

    const withIds = collectElements(injected.parsed.root).filter(
      (element) => attributeValue(element, HR_ID) !== undefined,
    );
    // article 自身也带 id，因此再按 component 属性把那个 div 挑出来（文档序里它在 article 之后）。
    const tagged = withIds.find(
      (element) => attributeValue(element, "data-hr-component") === "kpi-bento",
    );
    expect(injected.injected).toHaveLength(3);
    expect(withIds).toHaveLength(3);
    expect(withIds.filter((element) => element.tag === "div")).toHaveLength(2);
    expect(tagged?.tag).toBe("div");
  });

  it("should give distinct ids to distinct elements in the same document", () => {
    const injected = inject(
      "<article><h2>t</h2><p>a</p><p>a</p><section><p>a</p></section></article>",
    );

    expect(injected.injected).toHaveLength(6);
    expect(new Set(injected.injected).size).toBe(6);
  });
});

describe("injectNodeIds · 块级词表", () => {
  // 行内与未知标签仍然不拿 id；`h5`/`h6`/`div` 在 F10 之后是寻址面成员，所以都该有 id。
  it("should skip inline and unknown tags but id h5, h6 and plain div", () => {
    const html =
      "<article><nav>n</nav><h5>t</h5><h6>t</h6><span>s</span><div>d</div><article><p>a</p></article></article>";

    const injected = inject(html);
    const span = requireElement(injected.parsed.root, "span");

    expect(injected.injected).toHaveLength(6);
    expect(attributeValue(span, HR_ID)).toBeUndefined();
  });
});

describe("injectNodeIds · 真实文档", () => {
  it("should inject every block tag the card enumerates", () => {
    const tags = [
      "section",
      "header",
      "footer",
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "ul",
      "ol",
      "li",
      "table",
      "figure",
      "details",
      "pre",
      "blockquote",
    ];
    const html = `<article>${tags.map((tag) => `<${tag}>x</${tag}>`).join("")}</article>`;

    expect(inject(html).injected).toHaveLength(tags.length + 1);
  });
});

describe("injectNodeIds · docs/02 骨架", () => {
  it("should inject the real docs/02 document without touching the meta script", () => {
    const html = [
      "<!DOCTYPE html><html><head><title>t</title></head><body><article>",
      '<section data-hr-id="sec-problem"><h2>标题</h2><p>正文</p></section>',
      '<section data-hr-component="kpi-bento"><h2>指标</h2></section>',
      "</article>",
      '<script id="hr-meta">{"version":"1.0"}</script>',
      "</body></html>",
    ].join("");
    const injected = inject(html);

    expect(injected.injected).toHaveLength(5);
    expect(idOf(injected, "section")).toBe("sec-problem");
    expect(attributeValue(requireElement(injected.parsed.root, "script"), HR_ID)).toBeUndefined();
    expect(codesOf(injected.parsed)).toEqual([]);
  });
});

describe("injectNodeIds · 既有 ID", () => {
  it("should keep a valid existing id without reporting it as injected", () => {
    const injected = inject('<article><p data-hr-id="custom-1">a</p></article>');

    expect(idOf(injected, "p")).toBe("custom-1");
    // 既有 id 不进 injected；article 自身没有 id，于是只有它一条。
    expect(injected.injected).toHaveLength(1);
    expect(attributeValue(requireElement(injected.parsed.root, "article"), HR_ID)).toBe(
      injected.injected[0],
    );
    expect(codesOf(injected.parsed)).toEqual([]);
  });

  it("should rewrite an invalid existing id and report invalid_hr_id", () => {
    const injected = inject('<article><p data-hr-id="Bad Id">a</p></article>');

    const [diagnostic] = injected.parsed.diagnostics;
    expect(diagnostic?.code).toBe("invalid_hr_id");
    expect(diagnostic?.message).toContain('data-hr-id="Bad Id"');
    expect(diagnostic?.path).toBe("html[0]>body[1]>article[0]>p[0]");
    expect(idOf(injected, "p")).toMatch(ID_SHAPE);
    expect(idAttributes(injected, "p")).toHaveLength(1);
  });

  it("should treat an empty data-hr-id as invalid", () => {
    const injected = inject('<article><p data-hr-id="">a</p></article>');

    expect(codesOf(injected.parsed)).toEqual(["invalid_hr_id"]);
    expect(idOf(injected, "p")).toMatch(ID_SHAPE);
  });

  it("should append diagnostics after the parse-level ones instead of replacing them", () => {
    const injected = inject(
      '<article><p data-hr-id="X">a</p><div data-hr-component="nope">b</div></article>',
    );

    expect(codesOf(injected.parsed)).toEqual(["invalid_component", "invalid_hr_id"]);
  });
});

describe("injectNodeIds · 确定性", () => {
  it("should produce byte-identical output for the same input twice", () => {
    const first = inject(SAMPLE_DOC);
    const second = inject(SAMPLE_DOC);

    expect(serializeHtml(second.parsed)).toBe(serializeHtml(first.parsed));
    expect(second.injected).toEqual(first.injected);
  });

  it("should not depend on the process cwd", () => {
    const original = cwd();
    const baseline = serializeHtml(inject(SAMPLE_DOC).parsed);
    try {
      chdir(tmpdir());
      expect(serializeHtml(inject(SAMPLE_DOC).parsed)).toBe(baseline);
    } finally {
      chdir(original);
    }
  });

  it("should stay stable across 20 interleaved injections", async () => {
    const baseline = serializeHtml(inject(SAMPLE_DOC).parsed);
    const tasks = Array.from({ length: 20 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return serializeHtml(inject(SAMPLE_DOC).parsed);
    });
    const results = await Promise.all(tasks);

    expect(results).toHaveLength(20);
    expect(new Set(results)).toEqual(new Set([baseline]));
  });
});

describe("injectNodeIds · 幂等性", () => {
  it("should be idempotent: re-injecting already-injected output injects nothing", () => {
    const once = inject(SAMPLE_DOC);
    const twice = injectNodeIds(once.parsed);

    expect(twice.injected).toEqual([]);
    expect(serializeHtml(twice.parsed)).toBe(serializeHtml(once.parsed));
  });
});

describe("injectNodeIds · ID 冲突后缀", () => {
  const baseDoc = "<article><p>a</p></article>";

  it("should append -2 when the computed base id is already taken", () => {
    const base = idOf(inject(baseDoc), "p");
    if (base === undefined) {
      throw new Error("expected an injected id");
    }
    const injected = inject(`<article><span data-hr-id="${base}">z</span><p>a</p></article>`);

    expect(idOf(injected, "p")).toBe(`${base}-2`);
  });

  it("should walk past taken suffixes instead of reusing them", () => {
    const base = idOf(inject(baseDoc), "p");
    if (base === undefined) {
      throw new Error("expected an injected id");
    }
    const injected = inject(
      `<article><span data-hr-id="${base}">z</span><span data-hr-id="${base}-2">z</span><p>a</p></article>`,
    );

    expect(idOf(injected, "p")).toBe(`${base}-3`);
  });

  it("should keep suffixed ids stable on a second run", () => {
    const base = idOf(inject(baseDoc), "p");
    if (base === undefined) {
      throw new Error("expected an injected id");
    }
    const seeded = inject(`<article><span data-hr-id="${base}">z</span><p>a</p></article>`);
    const again = injectNodeIds(seeded.parsed);

    expect(again.injected).toEqual([]);
    expect(idOf(again, "p")).toBe(`${base}-2`);
  });
});
