// This layer covers the selector dialect — grammar errors are always `invalid_selector` + `reason:"syntax"`, bare
// ids succeed through the fallback chain, and only a grammar-legal bare id that matches nothing reports
// `node_not_found`; legal `data-hr-id`s may carry uppercase and underscores, and ids match byte-exactly (no case folding).

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha } from "./cli-support";
import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";

const DOC = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<h2 data-hr-id="hr-h2">标题</h2>',
  '<p data-hr-id="hr-a1">正文</p>',
  "</article></body></html>",
].join("\n");

/** Five literals that "look like selectors but fail the grammar", plus one literal starting with `"`. */
const SYNTAX_SELECTORS = ["p[", "p[0]", "a b", "*", "div>p", '"hr-a1"'] as const;

const seed = (dir: string): string => {
  const file = `${dir}/a.html`;
  writeFileSync(file, DOC);
  return file;
};

interface Envelope {
  readonly code: number | null;
  readonly stdout: string;
  readonly parsed: unknown;
}

const jsonRun = async (dir: string, args: readonly string[]): Promise<Envelope> => {
  const result = await runCli([...args, "--json"], { cwd: dir });
  return { code: result.code, stdout: result.stdout, parsed: parseJsonLine(result.stdout) };
};

const codeOf = (parsed: unknown): unknown => fieldOf(parsed, "code");

const messageOf = (parsed: unknown): string => String(fieldOf(parsed, "message"));

/** The checkable shape of "only one sentence": a single line that does not glue two hops' conclusions together. */
const expectOneHopMessage = (message: string): void => {
  expect(message.includes("\n")).toBe(false);
  expect(message).not.toContain("按选择器");
  expect(message).not.toContain("按 node id");
  expect(message).not.toContain("只会命中第一个");
};

describe("grammatically bad selectors always get invalid_selector + reason:syntax on read", () => {
  it.each(SYNTAX_SELECTORS)(
    "should refuse read target %s as invalid_selector/syntax",
    async (target) => {
      await withTempDir(async (dir) => {
        seed(dir);
        const { code, parsed } = await jsonRun(dir, ["read", "a.html", target]);

        expect(code).toBe(1);
        expect(codeOf(parsed)).toBe("invalid_selector");
        expect(fieldOf(fieldOf(parsed, "data"), "reason")).toBe("syntax");
        const message = messageOf(parsed);
        expect(message).toContain("无法解析");
        // The message echoes the target as a JSON literal: a `"`-carrying target appears in escaped form there.
        expect(message).toContain(target.replaceAll('"', '\\"'));
        expectOneHopMessage(message);
      });
    },
  );
});

describe("grammatically bad selectors always get invalid_selector + reason:syntax on patch", () => {
  it.each(SYNTAX_SELECTORS)(
    "should refuse patch target %s as invalid_selector/syntax",
    async (target) => {
      await withTempDir(async (dir) => {
        const file = seed(dir);
        const before = sha(file);
        const { code, parsed } = await jsonRun(dir, [
          "patch",
          "a.html",
          target,
          "--action",
          "delete",
        ]);

        expect(code).toBe(1);
        expect(codeOf(parsed)).toBe("invalid_selector");
        expect(fieldOf(fieldOf(parsed, "data"), "reason")).toBe("syntax");
        expectOneHopMessage(messageOf(parsed));
        // The refusal happens before any write: the original bytes must not move at all (backup/history included).
        expect(sha(file)).toBe(before);
      });
    },
  );
});

describe("bare ids are unharmed by the new logic: an existing bare id still reads and patches", () => {
  it("should still read a bare id that is itself a parseSelector syntax error", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "hr-a1"]);

      expect(code).toBe(0);
      expect(fieldOf(parsed, "ok")).toBe(true);
      expect(String(fieldOf(fieldOf(parsed, "data"), "html"))).toContain('data-hr-id="hr-a1"');
    });
  });

  it("should still patch a bare id that is itself a parseSelector syntax error", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir);
      const { code, parsed } = await jsonRun(dir, [
        "patch",
        "a.html",
        "hr-a1",
        "--action",
        "replace",
        "--html",
        '<p data-hr-id="hr-a1">改过了</p>',
      ]);

      expect(code).toBe(0);
      expect(fieldOf(fieldOf(parsed, "data"), "changed")).toBe(true);
      expect(String(fieldOf(fieldOf(parsed, "data"), "path"))).toBe(file);
    });
  });
});

describe("only a grammar-legal bare id that matches nothing reports node_not_found", () => {
  it("should report an absent bare id as node_not_found without a data key", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "hr-nope"]);

      expect(code).toBe(1);
      expect(codeOf(parsed)).toBe("node_not_found");
      expect(keysOf(parsed)).toEqual(["ok", "code", "message"]);
      expect(messageOf(parsed)).toContain('"hr-nope"');
      expectOneHopMessage(messageOf(parsed));
    });
  });
});

describe("the human message is single-hop (no two explanations glued together)", () => {
  it("should print one hop for a syntax error in human mode", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["read", "a.html", "p["], { cwd: dir });
      const lines = result.stdout.trimEnd().split("\n");

      expect(result.code).toBe(1);
      expect(lines).toHaveLength(1);
      expectOneHopMessage(lines[0] ?? "");
    });
  });

  it("should print one hop for an absent bare id in human mode", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["read", "a.html", "hr-nope"], { cwd: dir });
      const lines = result.stdout.trimEnd().split("\n");

      expect(result.code).toBe(1);
      expect(lines).toHaveLength(1);
      expectOneHopMessage(lines[0] ?? "");
    });
  });
});

describe("an empty <article> still walks both paths (the code does not change just because there is no content)", () => {
  const EMPTY = [
    "<!doctype html>",
    '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
    '<body data-hr-id="hr-body"><article data-hr-id="hr-root"></article></body></html>',
  ].join("\n");

  it("should read the empty article itself", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, EMPTY);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "hr-root"]);

      expect(code).toBe(0);
      expect(String(fieldOf(fieldOf(parsed, "data"), "html"))).toBe(
        '<article data-hr-id="hr-root"></article>',
      );
      expect(fieldOf(fieldOf(parsed, "data"), "truncated")).toBe(false);
    });
  });

  it("should report a tag selector with no match as node_not_found (its literal is a legal id)", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, EMPTY);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "div"]);

      expect(code).toBe(1);
      expect(codeOf(parsed)).toBe("node_not_found");
      expect(messageOf(parsed)).toContain('"div"');
    });
  });
});
const DIALECT_DOC = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<p data-hr-id="hr-Ab12">大写那一个</p>',
  '<p data-hr-id="hr-ab12">小写那一个</p>',
  '<p data-hr-id="hr_Ab_12">下划线那一个</p>',
  "</article></body></html>",
].join("\n");

const htmlOf = async (dir: string, target: string): Promise<string> => {
  const result = await runCli(["read", "a.html", target, "--json"], { cwd: dir });
  expect(result.code).toBe(0);
  return String(fieldOf(fieldOf(parseJsonLine(result.stdout), "data"), "html"));
};

describe("ids match verbatim (uppercase/underscore)", () => {
  it("should resolve #hr-Ab12 to the uppercase id", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DIALECT_DOC);
      const html = await htmlOf(dir, "#hr-Ab12");

      expect(html).toContain('data-hr-id="hr-Ab12"');
      expect(html).toContain("大写那一个");
    });
  });

  it("should keep hr-Ab12 and hr-ab12 apart instead of case-folding", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DIALECT_DOC);

      expect(await htmlOf(dir, "#hr-ab12")).toContain("小写那一个");
      expect(await htmlOf(dir, "hr-Ab12")).toContain("大写那一个");
      expect(await htmlOf(dir, "hr-ab12")).toContain("小写那一个");
    });
  });

  it("should resolve ids containing underscores on both the #id and bare-id paths", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DIALECT_DOC);

      expect(await htmlOf(dir, "#hr_Ab_12")).toContain("下划线那一个");
      expect(await htmlOf(dir, "hr_Ab_12")).toContain("下划线那一个");
    });
  });
});
