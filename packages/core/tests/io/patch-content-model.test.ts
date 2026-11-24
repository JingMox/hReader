// 这层管：`applyPatch` 的内容模型判定在**进程内**的两面——目标选错了（行内元素），
// 以及片段装不进容器（只装行内内容的容器遇到块级片段）。
//
// CLI 那侧的症状用例（退出码、磁盘字节、路径回显）在 `packages/cli/tests/content-model-conflict.test.ts`；
// 这里只保证判定逻辑本身被真跑过，不重复黑盒断言。

import { describe, expect, it } from "vitest";

import type { HtmlElementNode } from "../../src/html/constants";
import { HrError } from "../../src/hr-error";
import { assertFragmentFits } from "../../src/ops/patch-node/content";
import { applyPatch } from "../../src/ops/patch-node";

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error.code;
    throw error;
  }
  throw new Error("没有被拒");
};

const containerDoc = (tag: string): string =>
  `<article data-hr-id="hr-a"><${tag} data-hr-id="hr-x">t</${tag}></article>`;

describe("applyPatch · 目标必须是块级元素", () => {
  const INLINE_TARGET_DOC =
    '<article data-hr-id="hr-a"><p><b data-hr-id="hr-b">强调</b></p></article>';

  it("should reject a replace whose target is an inline element with invalid_input", () => {
    const code = codeOf(() =>
      applyPatch(INLINE_TARGET_DOC, {
        targetId: "hr-b",
        action: "replace",
        html: "<div>块</div>",
      }),
    );

    // 码是 `invalid_input`（不是 `content_model_conflict`）：父容器 `<p>` 装不下 `<div>` 这件事
    // 根本轮不到判定——目标是行内的 `<b>`，patch 的最小改动单元是块。
    expect(code).toBe("invalid_input");
  });
});

describe("applyPatch · 只装行内内容的容器", () => {
  it("should reject a paragraph appended into a paragraph and name both tags", () => {
    const run = (): unknown =>
      applyPatch(containerDoc("p"), { targetId: "hr-x", action: "append", html: "<p>子</p>" });

    expect(codeOf(run)).toBe("content_model_conflict");
    // 报文要用户能照着改：点出容器、点出片段，再给一条下一步。
    expect(() => run()).toThrow(/<p> 是段落（只装行内内容）.装不下子节点 <p>/u);
    expect(() => run()).toThrow(/article\/section\/div/u);
  });

  it("should reject inside a pre and describe it as a preformatted block", () => {
    const run = (): unknown =>
      applyPatch(containerDoc("pre"), { targetId: "hr-x", action: "append", html: "<p>子</p>" });

    expect(codeOf(run)).toBe("content_model_conflict");
    expect(() => run()).toThrow(/预排版块/u);
  });

  it("should reject inside a heading and describe it as a heading", () => {
    const run = (): unknown =>
      applyPatch(containerDoc("h1"), { targetId: "hr-x", action: "append", html: "<p>子</p>" });

    expect(codeOf(run)).toBe("content_model_conflict");
    expect(() => run()).toThrow(/标题（只装行内内容）/u);
  });

  it("should accept an inline fragment appended into a paragraph", () => {
    const outcome = applyPatch(containerDoc("p"), {
      targetId: "hr-x",
      action: "append",
      html: "<b>行内</b>",
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.html).toContain("<b>行内</b>");
  });
});

describe("assertFragmentFits · 兜底的容器名", () => {
  it("should describe a legend as a generic inline-content container", () => {
    // `legend` 在规范里同属"只装行内内容"，但不是 `BLOCK_TAGS`，patch 选不中它；
    // 报文只能给兜底说法（不点名具体标签），否则兜底分支就成了死代码。
    const error = fitsErrorOf("legend", "div");

    expect(error.code).toBe("content_model_conflict");
    expect(error.message).toContain("行内内容容器");
  });
});

describe("applyPatch · replace 看的是直接父容器", () => {
  const ARTICLE_DOC = '<article data-hr-id="hr-a"><p data-hr-id="hr-p">正文</p></article>';

  it("should allow replacing a paragraph with a div when the article can hold it", () => {
    const outcome = applyPatch(ARTICLE_DOC, {
      targetId: "hr-p",
      action: "replace",
      html: "<div>块</div>",
    });

    // 父容器是 `<article>`：装得下块级就是合法改动，不查祖先链。
    expect(outcome.changed).toBe(true);
    // docs/05:57：`replace` 的新根继承目标 id（`hr-p`），换标签也不换锚点。
    expect(outcome.html).toBe(
      '<article data-hr-id="hr-a"><div data-hr-id="hr-p">块</div></article>',
    );
  });
});

/** 直接调判定函数用的最小元素节点：这里只要 tag，不碰解析器。 */
const elementOf = (tag: string): HtmlElementNode => ({
  kind: "element",
  tag,
  attrs: [],
  children: [],
});

const fitsErrorOf = (containerTag: string, fragmentTag: string): HrError => {
  try {
    assertFragmentFits(elementOf(containerTag), elementOf(fragmentTag));
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error(`<${containerTag}> 装下了 <${fragmentTag}>：本应被拒`);
};

/**
 * 这些容器标签不是 `BLOCK_TAGS`（`packages/core/src/html/constants.ts`），patch 选不中它们，
 * 所以经 `applyPatch` 永远走不到下面这些判定——直调 `assertFragmentFits` 是为了让这张表本身
 * 有测试守着：谁改表就得让这里跟着动。
 */
const FORBIDDEN_SUBTREE_CASES: readonly { readonly container: string; readonly child: string }[] = [
  { container: "li", child: "li" },
  { container: "table", child: "tr" },
  { container: "table", child: "td" },
  { container: "dd", child: "dt" },
  { container: "dt", child: "dd" },
  { container: "a", child: "a" },
  { container: "button", child: "button" },
  { container: "form", child: "form" },
  { container: "option", child: "option" },
];

describe("assertFragmentFits · 解析器会改树的组合", () => {
  it.each(FORBIDDEN_SUBTREE_CASES)(
    "should reject <$child> inside <$container> because parsing would change the tree",
    ({ container, child }) => {
      const error = fitsErrorOf(container, child);

      // 拒绝理由是"写出去解析回来不是同一棵树"，所以码是内容模型冲突，不是语法错。
      expect(error.code).toBe("content_model_conflict");
      expect(error.message).toContain("会改结构");
      expect(error.message).toContain("<" + container + ">");
      expect(error.message).toContain("<" + child + ">");
    },
  );

  it("should still accept a paragraph inside a list because it does not change the tree", () => {
    // 审计裁定的边界：`<ul><p>` 只是内容模型不合规，解析器不重排，所以不登记、不拒。
    expect(() => {
      assertFragmentFits(elementOf("ul"), elementOf("p"));
    }).not.toThrow();
  });
});

describe("assertFragmentFits · select 只装 option/optgroup", () => {
  it("should reject a div inside a select", () => {
    const error = fitsErrorOf("select", "div");

    expect(error.code).toBe("content_model_conflict");
    expect(error.message).toContain("<option>");
    expect(error.message).toContain("<optgroup>");
  });

  it.each(["option", "optgroup"])("should accept a %s inside a select", (child) => {
    expect(() => {
      assertFragmentFits(elementOf("select"), elementOf(child));
    }).not.toThrow();
  });
});

describe("assertFragmentFits · 结构容器只装固定几类子节点（②）", () => {
  it("should reject a paragraph inside a table and explain foster parenting", () => {
    const error = fitsErrorOf("table", "p");

    expect(error.code).toBe("content_model_conflict");
    expect(error.message).toContain("目标 <table> 只装");
    // `<table>` 的报文要比别的容器多一句：内容会被挪到表格之前，这是用户看不出症状的那一类。
    expect(error.message).toContain("foster-parent");
  });

  it("should give the plain next step for a non-table structural container", () => {
    const error = fitsErrorOf("select", "div");

    expect(error.message).toContain("要加内容请 append");
    expect(error.message).not.toContain("foster-parent");
  });
});

describe("assertFragmentFits · 表格结构元素只能在表格上下文里（③）", () => {
  it("should reject a row whose container is not a table part", () => {
    const error = fitsErrorOf("section", "tr");

    expect(error.code).toBe("content_model_conflict");
    expect(error.message).toContain("表格结构元素 <tr>");
    // 报文得给下一步：哪个容器收得下。
    expect(error.message).toContain("<table>/<tbody>/<tr>");
  });

  it.each([
    { container: "tbody", child: "tr" },
    { container: "thead", child: "tr" },
    { container: "tfoot", child: "tr" },
    { container: "tr", child: "td" },
    { container: "tr", child: "th" },
  ])("should accept a <$child> inside <$container>", ({ container, child }) => {
    expect(() => {
      assertFragmentFits(elementOf(container), elementOf(child));
    }).not.toThrow();
  });
});

describe("assertFragmentFits · 内容按字面文本处理的容器", () => {
  it.each(["script", "style", "textarea", "title"])(
    "should reject a <b> inside <%s> because it comes back as text",
    (container) => {
      const error = fitsErrorOf(container, "b");

      expect(error.code).toBe("content_model_conflict");
      expect(error.message).toContain("字面文本");
    },
  );
});

describe("assertFragmentFits · 非元素片段", () => {
  it("should skip the judgement when the fragment is not an element", () => {
    // 片段根的合法性由 `parseFragment` 负责；这里遇到文本节点只跳过，不二次报错。
    expect(() => {
      assertFragmentFits(elementOf("p"), { kind: "text", value: "纯文本" });
    }).not.toThrow();
  });
});
