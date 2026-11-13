// 这层管：`output.ts` / `usage.ts` / `exit-codes.ts` 的纯函数与冻结表；不跑子进程。

import { describe, expect, it } from "vitest";

import type {
  ApplyStyleResult,
  LintReport,
  Outline,
  PatchResult,
  ReadNodeResult,
} from "@hreader/core";

import { EXIT_FAILURE, EXIT_IO, EXIT_OK, EXIT_USAGE, exitCodeOf } from "../src/exit-codes";
import {
  dataLint,
  dataOutline,
  dataPatch,
  dataRead,
  dataStyle,
  dataTone,
  humanLint,
  humanOutline,
  humanPatch,
  humanRead,
  humanStyle,
  humanTone,
  jsonError,
  jsonOk,
} from "../src/output";
import { COMMAND_NAMES, isCommandName, usageText } from "../src/usage";
import type { CommandName } from "../src/usage";
import { atOf, fieldOf, keysOf } from "./harness";

const OUTLINE: Outline = {
  nodes: [
    {
      id: "hr-1",
      tag: "h2",
      level: 2,
      text: "标题",
      wordCount: 1,
      children: [{ id: "hr-2", tag: "p", level: 2, text: "子", wordCount: 1, children: [] }],
    },
  ],
  pendingAnnotations: [],
  wordCount: 2,
  diagnostics: [],
};

const PATCHED: PatchResult = {
  path: "a.html",
  bytes: 42,
  newIds: ["hr-9"],
  changed: true,
  historyPath: ".hreader/history/a/2026.html",
  undoable: true,
};

const UNCHANGED: PatchResult = { ...PATCHED, changed: false, historyPath: null, newIds: [] };

const READ: ReadNodeResult = {
  html: "<p>x</p>",
  annotations: [],
  truncated: false,
  diagnostics: [],
};

const STYLE: ApplyStyleResult = { path: "a.html", bytes: 42, changed: true };

const HITS: LintReport = {
  hits: [{ path: "hr-1", word: "boom", excerpt: "…boom…", offset: 3 }],
  truncated: false,
};

describe("output · JSON 信封", () => {
  it("should wrap data with a fixed ok-first envelope and a single newline", () => {
    expect(jsonOk("{}")).toBe('{"ok":true,"data":{}}\n');
    expect(jsonError("not_a_file", 'a"b')).toBe(
      '{"ok":false,"code":"not_a_file","message":"a\\"b"}\n',
    );
  });

  it("should keep the §3 key order for every data payload", () => {
    expect(keysOf(JSON.parse(dataPatch(PATCHED)))).toEqual([
      "path",
      "bytes",
      "newIds",
      "changed",
      "historyPath",
    ]);
    expect(keysOf(JSON.parse(dataRead(READ, ["hr-1"])))).toEqual(["html", "ids"]);
    expect(keysOf(JSON.parse(dataStyle(STYLE)))).toEqual(["path", "changed"]);
    expect(keysOf(JSON.parse(dataTone("p")))).toEqual(["prompt"]);
    expect(keysOf(JSON.parse(dataLint(HITS)))).toEqual(["hits"]);
  });
});

describe("output · hit 键序", () => {
  it("should keep the hit key order (path/word/excerpt/offset)", () => {
    expect(keysOf(atOf(fieldOf(JSON.parse(dataLint(HITS)), "hits"), 0))).toEqual([
      "path",
      "word",
      "excerpt",
      "offset",
    ]);
  });
});

describe("output · patch/outline 序列化", () => {
  it("should encode historyPath null only for a no-write patch", () => {
    expect(dataPatch(UNCHANGED)).toContain('"historyPath":null');
    expect(dataPatch(PATCHED)).toContain('"historyPath":".hreader/history/a/2026.html"');
    expect(dataPatch(PATCHED)).toContain('"changed":true');
    expect(dataPatch(UNCHANGED)).toContain('"changed":false');
  });

  it("should pass the outline through unchanged", () => {
    expect(JSON.parse(dataOutline(OUTLINE))).toEqual(OUTLINE);
  });

  it("should serialize annotations and diagnostics with the frozen key order", () => {
    const outline: Outline = {
      ...OUTLINE,
      pendingAnnotations: [{ id: "hr-a1", targetId: "hr-1", comment: '改"一下"' }],
      diagnostics: [{ code: "outline_node_without_id", severity: "warning", message: "x" }],
    };

    const text = dataOutline(outline);

    expect(text).toContain(
      '"pendingAnnotations":[{"id":"hr-a1","targetId":"hr-1","comment":"改\\"一下\\""}]',
    );
    expect(text).toContain(
      '"diagnostics":[{"code":"outline_node_without_id","severity":"warning","message":"x"}]',
    );
  });

  it("should serialize an empty lint report as an empty array", () => {
    expect(dataLint({ hits: [], truncated: true })).toBe('{"hits":[]}');
  });
});

describe("output · 人读文本", () => {
  it("should indent the outline tree by depth and end with one newline", () => {
    expect(humanOutline(OUTLINE)).toBe("- hr-1  标题  (1w)\n  - hr-2  子  (1w)\n");
  });

  it("should print an empty outline as a single newline", () => {
    expect(humanOutline({ ...OUTLINE, nodes: [] })).toBe("");
  });

  it("should print read html plus a newline", () => {
    expect(humanRead(READ)).toBe("<p>x</p>\n");
  });

  it("should print patched/unchanged lines with byte counts", () => {
    expect(humanPatch(PATCHED)).toBe("patched a.html (42 bytes, +1 ids)\n");
    expect(humanPatch(UNCHANGED)).toBe("unchanged a.html (42 bytes)\n");
  });

  it("should print one lint line per hit, then a trailing newline", () => {
    expect(humanLint(HITS)).toBe("hr-1: boom — …boom…\n");
    expect(humanLint({ hits: [], truncated: false })).toBe("");
  });

  it("should print tone prompts verbatim plus a newline", () => {
    expect(humanTone("一二\n三")).toBe("一二\n三\n");
  });

  it("should print styled/unchanged lines", () => {
    expect(humanStyle(STYLE)).toBe("styled a.html (42 bytes)\n");
    expect(humanStyle({ ...STYLE, changed: false })).toBe("unchanged a.html (42 bytes)\n");
  });
});

describe("usage · 单一事实源", () => {
  it("should name all five commands", () => {
    expect(COMMAND_NAMES).toEqual(["outline", "read", "patch", "style", "serve"]);
    expect(isCommandName("patch")).toBe(true);
    expect(isCommandName("nope")).toBe(false);
    expect(isCommandName(undefined)).toBe(false);
  });
});

describe("usage · 字面量清单", () => {
  it("should list every flag literal in the root usage", () => {
    const root = usageText(undefined);
    for (const flag of [
      "--json",
      "--workspace",
      "--help",
      "--max-bytes",
      "--action",
      "--html",
      "--html-file",
      "--html-stdin",
      "--visual",
      "--tone",
      "--lint",
    ]) {
      expect(root).toContain(flag);
    }
    for (const action of ["replace", "insert_before", "insert_after", "append", "delete"]) {
      expect(root).toContain(action);
    }
    for (const name of COMMAND_NAMES) expect(root).toContain(`hr ${name}`);
  });

  const SECTIONS: readonly (readonly [CommandName, string])[] = [
    ["outline", "打印 <article> 的缩进大纲"],
    ["read", "--max-bytes <n>"],
    ["patch", "delete 不接受任何 --html* 来源。"],
    ["style", "--visual <id>"],
  ];

  it.each(SECTIONS)("should append the %s section", (topic, needle) => {
    const text = usageText(topic);
    expect(text).toContain(needle);
    expect(text).toContain(`用法：hr ${topic}`);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("exit-codes · AC2 冻结表", () => {
  it("should expose the five constants", () => {
    expect([EXIT_OK, EXIT_FAILURE, EXIT_USAGE, EXIT_IO]).toEqual([0, 1, 2, 3]);
  });

  it.each([
    ["invalid_html", 1],
    ["no_article", 1],
    ["node_not_found", 1],
    ["invalid_selector", 1],
    ["invalid_document", 1],
    ["node_not_allowed", 1],
    ["invalid_max_bytes", 1],
    ["invalid_input", 1],
    ["locked", 1],
    ["invalid_fragment", 1],
    ["forbidden_content", 1],
    ["undo_unavailable", 1],
    ["invalid_style", 1],
    ["unknown_style", 1],
    ["invalid_theme", 1],
    ["path_outside_workspace", 3],
    ["not_a_file", 3],
    ["io_failure", 3],
    ["style_io_failure", 3],
    ["invalid_utf8", 3],
  ] as const)("should map %s to exit %d", (code, expected) => {
    expect(exitCodeOf(code)).toBe(expected);
  });
});
