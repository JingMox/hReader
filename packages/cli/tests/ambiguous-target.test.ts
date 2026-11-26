// This layer covers ambiguous/dual-interpretation targets — on multiple candidates the message gives
// `reason/count/candidates` (first 5 in document order), and when one literal is both a tag name and another element's id it refuses to pick for you (`reason:"ambiguous"`) and lists all three escapes.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checked, sha } from "./cli-support";
import { fieldOf, listOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** 7 `<p>`s whose document order is exactly the reverse of `sort()` ascending. */
const DOC_ORDER_IDS = ["hr-z", "hr-y", "hr-x", "hr-w", "hr-v", "hr-u", "hr-t"] as const;

const docWith = (body: string): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    `<article data-hr-id="hr-root"><section data-hr-id="hr-sec">${body}</section></article>`,
    "</body></html>",
  ].join("\n");

const paragraphsOf = (ids: readonly string[]): string =>
  ids.map((id, index) => `<p data-hr-id="${id}">第 ${String(index + 1)} 段</p>`).join("");

interface Refusal {
  readonly code: number | null;
  readonly codeField: unknown;
  readonly message: string;
  readonly data: unknown;
}

/** Run a `patch --json` that must fail: returns the exit code and the four envelope fields to assert. */
const refusalOf = async (dir: string, target: string): Promise<Refusal> => {
  const result = checked(
    await runCli(["patch", "a.html", target, "--action", "delete", "--json"], { cwd: dir }),
  );
  const envelope = parseJsonLine(result.stdout);
  return {
    code: result.code,
    codeField: fieldOf(envelope, "code"),
    message: String(fieldOf(envelope, "message")),
    data: fieldOf(envelope, "data"),
  };
};

const candidatesOf = (data: unknown): readonly unknown[] => listOf(fieldOf(data, "candidates"));
const countOf = (data: unknown): unknown => fieldOf(data, "count");

const DOC_ORDER_CANDIDATES = ["hr-z", "hr-y", "hr-x", "hr-w", "hr-v"] as const;

/**
 * The core criterion for candidate truncation: first 5 in document order, and **none** of the first 5
 * lexicographically appears in it. The latter is the sensitive spot for a `.sort()` mutation: the two
 * top-5 sets have no overlap on this corpus.
 */
const expectDocOrderCandidates = (data: unknown): void => {
  const candidates = candidatesOf(data);
  expect(candidates).toEqual(DOC_ORDER_CANDIDATES);
  expect(candidates).not.toEqual([...DOC_ORDER_IDS].sort().slice(0, 5));
  // The 6th and 7th (`hr-u`/`hr-t`) stay out of candidates but are counted by `count`.
  expect(candidates).not.toContain("hr-u");
  expect(candidates).not.toContain("hr-t");
  expect(countOf(data)).toBe(7);
};

/** Envelope header + human message (same candidates, same order, total appended at the tail). */
const expectAmbiguousEnvelope = (refused: Refusal): void => {
  expect(refused.code).toBe(1);
  expect(refused.codeField).toBe("invalid_selector");
  expect(fieldOf(refused.data, "reason")).toBe("ambiguous");
  expect(refused.message).toContain("命中 7 个可寻址元素");
  expect(refused.message).toContain("hr-z、hr-y、hr-x、hr-w、hr-v…等 7 个");
};

const expectDocOrderRefusal = (refused: Refusal): void => {
  expectAmbiguousEnvelope(refused);
  expectDocOrderCandidates(refused.data);
};

describe("patch · ambiguous message candidates are truncated in document order", () => {
  it("should list the first five candidates in document order, not in sorted order", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, docWith(paragraphsOf(DOC_ORDER_IDS)));
      const before = readFileSync(`${dir}/a.html`);

      expectDocOrderRefusal(await refusalOf(dir, "p"));
      // A refusal does not touch disk.
      expect(readFileSync(`${dir}/a.html`).equals(before)).toBe(true);
    });
  });

  it("should cap candidates at five but still count the sixth match", async () => {
    await withTempDir(async (dir) => {
      // `CANDIDATE_LIMIT + 1` hits: candidates are truncated by exactly one, `count` ignores the truncation.
      writeFileSync(`${dir}/a.html`, docWith(paragraphsOf(DOC_ORDER_IDS.slice(0, 6))));

      const refused = await refusalOf(dir, "p");

      expect(candidatesOf(refused.data)).toEqual(DOC_ORDER_CANDIDATES);
      expect(countOf(refused.data)).toBe(6);
      expect(refused.message).toContain("…等 6 个");
    });
  });

  it("should not append the overflow hint when the count fits the candidate list", async () => {
    await withTempDir(async (dir) => {
      // Exactly 5 hits: all candidates listed, no "... etc" tail allowed.
      writeFileSync(`${dir}/a.html`, docWith(paragraphsOf(DOC_ORDER_IDS.slice(0, 5))));

      const refused = await refusalOf(dir, "p");

      expect(candidatesOf(refused.data)).toEqual(DOC_ORDER_CANDIDATES);
      expect(countOf(refused.data)).toBe(5);
      expect(refused.message).not.toContain("…等");
    });
  });
});

describe("patch · hits on non-addressable elements", () => {
  it("should count 0 addressable for inline-only matches and refuse as node_not_found", async () => {
    await withTempDir(async (dir) => {
      // None of the three `<span>`s has `data-hr-id` (inline elements are not in `ADDRESSABLE_TAGS` and normalize adds none):
      // 3 hits, 0 addressable. If the implementation judged ambiguity by total hits it would wrongly report `invalid_selector` here.
      writeFileSync(
        `${dir}/a.html`,
        docWith('<p data-hr-id="hr-p">前<span>甲</span>中<span>乙</span>后<span>丙</span></p>'),
      );

      const refused = await refusalOf(dir, "span");

      expect(refused.code).toBe(1);
      expect(refused.codeField).toBe("node_not_found");
      expect(refused.message).toContain("不可寻址");
      expect(refused.message).not.toContain("invalid_selector");
    });
  });
});
/** core's `CANDIDATE_LIMIT`: the message prints only the first 5 candidates. */
const CANDIDATE_LIMIT = 5;

const docWithIds = (body: string): string =>
  [
    "<!doctype html>",
    '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
    `<body data-hr-id="hr-body"><article data-hr-id="hr-root">${body}</article></body></html>`,
  ].join("\n");

/** Dual-interpretation corpus: an `<h2>` has id `hr-h2`, and another element that is **not** an `<h2>` has id exactly `h2`. */
const DUAL = docWithIds(
  ['<h2 data-hr-id="hr-h2">标题</h2>', '<div data-hr-id="h2">div 也叫 h2</div>'].join(""),
);

const liOf = (count: number): string =>
  `<ul data-hr-id="hr-ul">${Array.from(
    { length: count },
    (_unused, index) => `<li data-hr-id="hr-l${String(index + 1)}">第 ${String(index + 1)} 项</li>`,
  ).join("")}</ul>`;

interface Envelope {
  readonly code: number | null;
  readonly stdout: string;
  readonly parsed: unknown;
}

const run = async (dir: string, html: string, args: readonly string[]): Promise<Envelope> => {
  writeFileSync(`${dir}/a.html`, html);
  const result = await runCli([...args, "--json"], { cwd: dir });
  return { code: result.code, stdout: result.stdout, parsed: parseJsonLine(result.stdout) };
};

const dataOf = (parsed: unknown): unknown => fieldOf(parsed, "data");

const numberIn = (data: unknown, key: string): number => {
  const value = fieldOf(data, key);
  expect(typeof value).toBe("number");
  return Number(value);
};

const candidatesIn = (data: unknown): readonly unknown[] => listOf(fieldOf(data, "candidates"));

const htmlIn = (parsed: unknown): string => String(fieldOf(dataOf(parsed), "html"));

/** Invariant: the candidate list is exactly what remains after the addressable total is clipped by the limit. */
const expectCandidateInvariant = (data: unknown): void => {
  expect(candidatesIn(data)).toHaveLength(Math.min(numberIn(data, "count"), CANDIDATE_LIMIT));
};

describe("dual-interpretation refusal (count = addressable total, matches = selector hits)", () => {
  it("should refuse `read h2` as ambiguous with count 2 / matches 1", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, ["read", "a.html", "h2"]);

      expect(code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      const data = dataOf(parsed);
      expect(fieldOf(data, "reason")).toBe("ambiguous");
      expect(numberIn(data, "count")).toBe(2);
      expect(numberIn(data, "matches")).toBe(1);
      expect(candidatesIn(data)).toEqual(["hr-h2", "h2"]);
      expectCandidateInvariant(data);
    });
  });

  it("should refuse `patch h2` as ambiguous and keep every byte", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUAL);
      const before = sha(`${dir}/a.html`);
      const result = await runCli(["patch", "a.html", "h2", "--action", "delete", "--json"], {
        cwd: dir,
      });
      const parsed = parseJsonLine(result.stdout);

      expect(result.code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      expect(fieldOf(dataOf(parsed), "reason")).toBe("ambiguous");
      expect(numberIn(dataOf(parsed), "count")).toBe(2);
      expect(sha(`${dir}/a.html`)).toBe(before);
    });
  });
});

describe("each of the three escapes promised in the message actually works", () => {
  it("should resolve `#h2` to the element whose id is h2, not the <h2> tag", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, ["read", "a.html", "#h2"]);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain('data-hr-id="h2"');
      expect(htmlIn(parsed)).toContain("div 也叫 h2");
    });
  });

  it('should resolve `[data-hr-id="h2"]` to the attribute match', async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, ["read", "a.html", '[data-hr-id="h2"]']);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain("div 也叫 h2");
    });
  });

  it("should resolve `article > h2:nth-of-type(1)` to the tag path", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, [
        "read",
        "a.html",
        "article > h2:nth-of-type(1)",
      ]);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain('data-hr-id="hr-h2"');
      expect(htmlIn(parsed)).toContain("标题");
    });
  });
});

describe("the dual-interpretation message itself lists all three escapes", () => {
  it("should mention all three escape hatches in the ambiguous message", async () => {
    await withTempDir(async (dir) => {
      const { parsed } = await run(dir, DUAL, ["read", "a.html", "h2"]);
      const message = String(fieldOf(parsed, "message"));

      expect(message).toContain("'#h2'");
      expect(message).toContain('[data-hr-id="h2"]');
      expect(message).toContain(":nth-of-type(");
    });
  });
});

describe("count equals candidates.length when untruncated", () => {
  it("should report count 3 / matches 3 when the 3 hits fit under the limit", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, docWithIds(liOf(3)), [
        "patch",
        "a.html",
        "li",
        "--action",
        "replace",
        "--html",
        "<li>x</li>",
      ]);

      expect(code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      const data = dataOf(parsed);
      expect(fieldOf(data, "reason")).toBe("ambiguous");
      expect(numberIn(data, "count")).toBe(3);
      expect(numberIn(data, "matches")).toBe(3);
      expect(candidatesIn(data)).toHaveLength(3);
      expectCandidateInvariant(data);
    });
  });
});

describe("count keeps the total while candidates drop to 5 when truncated", () => {
  it("should keep count 7 while truncating candidates to 5", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, docWithIds(liOf(7)), [
        "patch",
        "a.html",
        "li",
        "--action",
        "replace",
        "--html",
        "<li>x</li>",
      ]);

      expect(code).toBe(1);
      const data = dataOf(parsed);
      expect(numberIn(data, "count")).toBe(7);
      expect(numberIn(data, "matches")).toBe(7);
      expect(candidatesIn(data)).toHaveLength(CANDIDATE_LIMIT);
      // Untruncated: `count === candidates.length`; truncated: they differ — this invariant keeps `count` from being noise.
      expectCandidateInvariant(data);
      expect(numberIn(data, "count")).toBeGreaterThan(candidatesIn(data).length);
    });
  });
});

describe("colliding tag: the doc has a real <li> and another element whose id is also li", () => {
  const CLI = docWithIds(
    [
      '<ul data-hr-id="hr-ul"><li data-hr-id="hr-l1">一</li></ul>',
      '<div data-hr-id="li">div 的 id 也叫 li</div>',
    ].join(""),
  );

  it("should refuse the bare `li` as ambiguous (count 2 / matches 1)", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, CLI, ["read", "a.html", "li"]);

      expect(code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      const data = dataOf(parsed);
      expect(fieldOf(data, "reason")).toBe("ambiguous");
      expect(numberIn(data, "count")).toBe(2);
      expect(numberIn(data, "matches")).toBe(1);
      expectCandidateInvariant(data);
    });
  });

  it("should still let `#li` pick the element whose id is li", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, CLI, ["read", "a.html", "#li"]);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain("div 的 id 也叫 li");
    });
  });
});
