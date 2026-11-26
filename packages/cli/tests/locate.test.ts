// This layer covers `hr read`/`hr patch` addressing — all five actions accept a selector (not an id) as target,
// the two addressing paths to the same element are byte-identical, patching by selector leaves the document
// root id unchanged, and when both hops miss, the error code comes from the failure reason (not the target string's shape).

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checked, sha } from "./cli-support";
import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";
import { HrError, locateTarget, parseHtml, readNode } from "@hreader/core";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-root"><section data-hr-id="hr-sec">',
  '<p data-hr-id="hr-p">正文</p>',
  '<ul data-hr-id="hr-u"><li data-hr-id="hr-l1">一</li></ul>',
  '<table data-hr-id="hr-tb"><tbody data-hr-id="hr-tby">',
  '<tr data-hr-id="hr-tr1"><td data-hr-id="hr-td1">格</td></tr>',
  "</tbody></table>",
  "</section></article>",
  "</body></html>",
].join("\n");

/** A heading-less document: `<article>` present, readable text present, but no `<h1>`–`<h6>` at all. */
const UNTITLED = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-root"><p data-hr-id="hr-p">正文</p></article>',
  "</body></html>",
].join("\n");

const seed = (dir: string, name = "a.html", html = DOC): string => {
  const file = `${dir}/${name}`;
  writeFileSync(file, html);
  return file;
};

/** Run one `patch --json`; returns the exit code and the envelope (shared by both outcomes). */
const patchJson = async (
  dir: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly envelope: unknown }> => {
  const result = checked(await runCli(["patch", "a.html", ...args, "--json"], { cwd: dir }));
  return { code: result.code, envelope: parseJsonLine(result.stdout) };
};

interface ActionCase {
  readonly action: string;
  /** Selector target: single match (the ambiguity rules are pinned by `ambiguous-target.test.ts`). */
  readonly target: string;
  readonly html: string | undefined;
  /** Fragments that must appear / must disappear after the write. */
  readonly present: readonly string[];
  readonly absent: readonly string[];
}

const ACTIONS: readonly ActionCase[] = [
  {
    action: "replace",
    target: "ul",
    html: "<ul><li>换掉</li></ul>",
    present: ['<ul data-hr-id="hr-u"><li data-hr-id'],
    absent: ["一</li>"],
  },
  {
    action: "insert_before",
    target: "ul",
    html: "<p>前插</p>",
    present: ["前插", '<ul data-hr-id="hr-u">'],
    absent: [],
  },
  {
    action: "insert_after",
    target: "ul",
    html: "<p>后插</p>",
    present: ["后插"],
    absent: [],
  },
  {
    action: "append",
    target: "ul",
    html: "<li>追加</li>",
    present: ["追加</li>"],
    absent: [],
  },
  {
    action: "delete",
    target: "table",
    html: undefined,
    present: ['<p data-hr-id="hr-p">正文</p>'],
    absent: ["<table"],
  },
];

const patchArgsOf = (one: ActionCase): readonly string[] =>
  one.html === undefined
    ? [one.target, "--action", one.action]
    : [one.target, "--action", one.action, "--html", one.html];

describe("patch · all five actions can locate by selector", () => {
  it.each(ACTIONS)("should apply $action to a selector-addressed target", async (one) => {
    await withTempDir(async (dir) => {
      const file = seed(dir);

      const { code, envelope } = await patchJson(dir, patchArgsOf(one));

      expect(code).toBe(0);
      expect(fieldOf(envelope, "ok")).toBe(true);
      const after = readFileSync(file, "utf8");
      for (const needle of one.present) expect(after).toContain(needle);
      for (const needle of one.absent) expect(after).not.toContain(needle);
      // None of the five actions may touch the document root.
      expect(after).toContain('<article data-hr-id="hr-root">');
    });
  });
});

describe("patch · the code and `data` when both hops fail", () => {
  it("should report invalid_selector with reason `syntax` when the target breaks the attribute quoting", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir);
      const before = readFileSync(file);

      const { code, envelope } = await patchJson(dir, ['a"b', "--action", "delete"]);

      expect(code).toBe(1);
      expect(fieldOf(envelope, "code")).toBe("invalid_selector");
      // The only shape that makes `[data-hr-id="…"]` itself illegal: `"`/`\`/newline. The code flips here (not node_not_found).
      expect(fieldOf(fieldOf(envelope, "data"), "reason")).toBe("syntax");
      // One sentence in the message: the target is not a legal id (`"` makes `[data-hr-id="…"]` itself illegal) — the syntax sentence.
      expect(String(fieldOf(envelope, "message"))).toContain('选择器 "a\\"b" 无法解析：');
      expect(readFileSync(file).equals(before)).toBe(true);
    });
  });

  it("should report node_not_found and omit the `data` key for a plain miss", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      const { code, envelope } = await patchJson(dir, ["hr-nope", "--action", "delete"]);

      expect(code).toBe(1);
      expect(fieldOf(envelope, "code")).toBe("node_not_found");
      // When `data === undefined` the whole key is absent: callers branch on `hasOwn`, never guess at empty objects.
      expect(keysOf(envelope)).toEqual(["ok", "code", "message"]);
    });
  });
});

describe("outline · end-to-end hint for a heading-less document", () => {
  it("should print the two-line hint with the cwd-relative path, exit 0", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", UNTITLED);

      const result = checked(await runCli(["outline", "a.html"], { cwd: dir }));

      expect(result.code).toBe(0);
      // Two raw lines: the second must be copy-paste runnable, so the path is from the user's view (cwd-relative), not the temp dir's absolute path.
      expect(result.stdout).toBe(
        "（没有标题）\n本文没有标题；用 hr read a.html <nodeId|selector> 取内容\n",
      );
      expect(result.stdout).not.toContain(dir);
    });
  });
});
const PARITY_DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-root"><section data-hr-id="hr-sec">',
  '<p data-hr-id="hr-p">前<span>甲</span>中<span>乙</span>后</p>',
  '<ul data-hr-id="hr-u"><li data-hr-id="hr-l1">一</li><li data-hr-id="hr-l2">二</li></ul>',
  "</section></article>",
  "</body></html>",
].join("\n");

const ROOT_OPEN = '<article data-hr-id="hr-root">';

/** Run a command that must succeed; returns the raw stdout (the object of byte-exact comparison). */
const stdoutOf = async (dir: string, args: readonly string[]): Promise<string> => {
  const result = checked(await runCli(args, { cwd: dir }));
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
};

const seedParity = (dir: string): string => {
  const file = `${dir}/a.html`;
  writeFileSync(file, PARITY_DOC);
  return file;
};

const dataOf = (envelope: unknown): unknown => fieldOf(envelope, "data");

/** Run one `read --json` and take `data` (the full JSON is no longer required byte-identical; comparison sinks to fields). */
const readDataOf = async (dir: string, target: string): Promise<unknown> =>
  dataOf(parseJsonLine(await stdoutOf(dir, ["read", "a.html", target, "--json"])));

const diagnosticCodesOf = (data: unknown): readonly unknown[] => {
  const diagnostics: unknown = fieldOf(data, "diagnostics");
  return Array.isArray(diagnostics)
    ? diagnostics.map((diagnostic) => fieldOf(diagnostic, "code"))
    : [];
};

/** The three fields that really describe the element must agree; `diagnostics` is excluded (ambiguity warnings vary with the selector). */
const expectSameReadData = (left: unknown, right: unknown): void => {
  for (const key of ["html", "ids", "truncated"]) {
    expect(fieldOf(left, key)).toEqual(fieldOf(right, key));
  }
};

/**
 * Two-way parity for non-addressable elements: human-read HTML and `data`'s three fields are byte-identical;
 * but a `span` hitting 2 must carry `ambiguous_selector`, a descendant selector hitting 1 must not.
 * The full JSON is no longer required identical: the warning says "the selector is ambiguous", not "who this element is".
 */
const expectSpanParity = async (dir: string): Promise<void> => {
  const byTag = await stdoutOf(dir, ["read", "a.html", "span"]);
  const byChild = await stdoutOf(dir, ["read", "a.html", "p > span:nth-of-type(1)"]);
  expect(byChild).toBe(byTag);
  expect(byTag).toContain("<span>甲</span>");

  const dataByTag = await readDataOf(dir, "span");
  const dataByChild = await readDataOf(dir, "p > span:nth-of-type(1)");
  expectSameReadData(dataByTag, dataByChild);
  // Guard rail: taking the first by default must not be silently allowed.
  expect(diagnosticCodesOf(dataByTag)).toContain("ambiguous_selector");
  expect(diagnosticCodesOf(dataByChild)).not.toContain("ambiguous_selector");
};

describe("read · byte-identical results across the two addressing paths", () => {
  it("should print the same bytes for `read ul` and `read <that ul's id>`", async () => {
    await withTempDir(async (dir) => {
      seedParity(dir);

      // The same html (the HumanRead channel).
      const byTag = await stdoutOf(dir, ["read", "a.html", "ul"]);
      const byId = await stdoutOf(dir, ["read", "a.html", "hr-u"]);
      expect(byId).toBe(byTag);

      // Byte-identical under `--json` too: no "addressing source" field inside `data` varies by entry.
      const jsonByTag = await stdoutOf(dir, ["read", "a.html", "ul", "--json"]);
      const jsonById = await stdoutOf(dir, ["read", "a.html", "hr-u", "--json"]);
      expect(jsonById).toBe(jsonByTag);
      expect(jsonById).toContain('"html":"<ul data-hr-id=\\"hr-u\\">');
    });
  });

  it("should print the same bytes for an unaddressable element reached two ways", async () => {
    await withTempDir(async (dir) => {
      seedParity(dir);
      // The `<span>` has no `data-hr-id` on disk: only selectors reach it, and both selectors must land on the same element.
      // The human channel still compares byte-identical; `--json` no longer requires the whole envelope equal (`span` carries an ambiguity warning, the descendant selector does not — see the helper comment).
      await expectSpanParity(dir);
    });
  });
});

describe("patch · root id unchanged after locating by selector", () => {
  it("should keep the document root's id after a selector-addressed patch", async () => {
    await withTempDir(async (dir) => {
      const file = seedParity(dir);

      const result = checked(
        await runCli(["patch", "a.html", "ul", "--action", "append", "--html", "<li>三</li>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(0);
      // After the write the root element's open tag is byte-identical (the id is content-derived; selector locating must not swap it).
      const after = readFileSync(file, "utf8");
      expect(after).toContain(ROOT_OPEN);
      expect(after.match(/data-hr-id="hr-root"/gu)).toHaveLength(1);
      // The root is still readable by its old id, and what is read is the patched tree.
      const root = await stdoutOf(dir, ["read", "a.html", "hr-root"]);
      expect(root).toContain("三</li>");
      // The target `<ul>`'s own id is unchanged too: the new `<li>` has an id, `<ul>` is still `hr-u`.
      expect(after).toContain('<ul data-hr-id="hr-u">');
    });
  });

  it("should keep the root id even when the patched target is the root itself", async () => {
    await withTempDir(async (dir) => {
      const file = seedParity(dir);

      const result = checked(
        await runCli(["patch", "a.html", "article", "--action", "append", "--html", "<p>尾</p>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(0);
      expect(readFileSync(file, "utf8")).toContain(ROOT_OPEN);
    });
  });
});
/** The doc has only one section with id `s2`: `#S2` is therefore "uppercase id, no such node", not a grammar error. */
const MISS_DOC = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<section data-hr-id="s2">小节</section>',
  '<p data-hr-id="hr-a1">正文</p>',
  "</article></body></html>",
].join("\n");

interface MissCase {
  readonly target: string;
  readonly code: "node_not_found" | "invalid_selector";
  /** On `node_not_found` the whole `data` key is absent, hence `undefined`. */
  readonly reason: "syntax" | undefined;
  /** The message must start **verbatim** like this: one sentence, and its subject is the string the user typed. */
  readonly opens: string;
}

const MISSES: readonly MissCase[] = [
  {
    target: "#S2",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有匹配 "#S2" 的节点。',
  },
  {
    target: "#nope",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有匹配 "#nope" 的节点。',
  },
  {
    target: "article > div:nth-of-type(9)",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有匹配 "article > div:nth-of-type(9)" 的节点。',
  },
  {
    target: "hr-NOPE",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有 id 为 "hr-NOPE" 的节点。',
  },
  {
    target: "p[",
    code: "invalid_selector",
    reason: "syntax",
    opens: '选择器 "p[" 无法解析：',
  },
  { target: ">", code: "invalid_selector", reason: "syntax", opens: '选择器 ">" 无法解析：' },
];

interface Envelope {
  readonly code: number | null;
  readonly parsed: unknown;
}

const jsonRun = async (dir: string, args: readonly string[]): Promise<Envelope> => {
  const result = checked(await runCli([...args, "--json"], { cwd: dir }));
  return { code: result.code, parsed: parseJsonLine(result.stdout) };
};

/** The message is one sentence: no newline, and it does not glue both hops' conclusions together. */
const expectOneSentence = (message: string): void => {
  expect(message.includes("\n")).toBe(false);
  expect(message).not.toContain("按选择器");
  expect(message).not.toContain("按 node id");
};

const expectMiss = (result: Envelope, one: MissCase): void => {
  expect(result.code).toBe(1);
  expect(fieldOf(result.parsed, "code")).toBe(one.code);
  const message = String(fieldOf(result.parsed, "message"));
  expect(message.startsWith(one.opens)).toBe(true);
  expectOneSentence(message);
  if (one.reason === undefined) {
    // When `data === undefined` the whole key is absent: callers branch on `hasOwn`, never guess at empty objects.
    expect(keysOf(result.parsed)).toEqual(["ok", "code", "message"]);
    return;
  }
  expect(keysOf(result.parsed)).toEqual(["ok", "code", "message", "data"]);
  expect(fieldOf(fieldOf(result.parsed, "data"), "reason")).toBe(one.reason);
};

const seedMiss = (dir: string): string => {
  const file = `${dir}/a.html`;
  writeFileSync(file, MISS_DOC);
  return file;
};

/** `read` and `patch` share one locating chain: both commands must give the same code for the same string, and neither may touch the file. */
const expectBothCommands = async (one: MissCase): Promise<void> => {
  await withTempDir(async (dir) => {
    const file = seedMiss(dir);
    const before = sha(file);

    expectMiss(await jsonRun(dir, ["read", "a.html", one.target]), one);
    expect(sha(file)).toBe(before);

    expectMiss(await jsonRun(dir, ["patch", "a.html", one.target, "--action", "delete"]), one);
    expect(sha(file)).toBe(before);
    expect(readFileSync(file, "utf8")).toBe(MISS_DOC);
  });
};

describe("when both hops miss, the code comes from the failure, not the target string's shape", () => {
  it.each(MISSES)("should report $code for target $target", expectBothCommands);
});

/** Take only `code`: non-`HrError`s are re-thrown (they are internal errors, not to be asserted as user errors). */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error.code;
    throw error;
  }
  throw new Error("expected failure, but it succeeded");
};

describe("the same string must give the same code in locateTarget and readNode (guard against layer drift)", () => {
  const parsed = parseHtml(MISS_DOC);
  /** Except `hr-NOPE`: it is a bare id, and the two entries genuinely do different things with it (see the next case). */
  const SHARED = MISSES.filter((one) => one.target !== "hr-NOPE");

  it.each(SHARED)("should agree on the code for $target", (one) => {
    const located = codeOf(() => locateTarget(parsed, one.target));
    const read = codeOf(() => readNode(parsed, one.target));

    expect(located).toBe(one.code);
    expect(read).toBe(located);
  });

  it("should diverge on a bare id: locateTarget falls back, readNode does not", () => {
    // `hr-NOPE` matches `HR_ID_PATTERN`, so locateTarget takes the second hop (the bare-id fallback is the main path);
    // `readNode` is just a selector evaluator — to it `hr-NOPE` is a grammar error. Different codes on both sides is
    // **right**: forcing agreement would mean sneaking the fallback into readNode, which squeezes two data flows back into one function.
    expect(codeOf(() => locateTarget(parsed, "hr-NOPE"))).toBe("node_not_found");
    expect(codeOf(() => readNode(parsed, "hr-NOPE"))).toBe("invalid_selector");
    expect(codeOf(() => readNode(parsed, '[data-hr-id="hr-NOPE"]'))).toBe("node_not_found");
  });
});
