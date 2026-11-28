// This layer covers the pure functions and frozen tables of `output.ts` / `usage.ts` / `exit-codes.ts`; no subprocess.

import { describe, expect, it } from "vitest";
import type { PrintHtmlResult } from "@hreader/renderer-html";
import { EXIT_FAILURE, EXIT_IO, EXIT_OK, EXIT_USAGE, exitCodeOf } from "../src/exit-codes";
import {
  bounded,
  dataAnnotationsList,
  dataAnnotationsMigrate,
  dataExport,
  dataImport,
  dataLint,
  dataOutline,
  dataPatch,
  dataRead,
  dataSearch,
  dataStyle,
  dataStyleExtract,
  dataTone,
  displayedPathOf,
  humanAnnotationsList,
  humanCheck,
  humanImport,
  humanLint,
  humanOutline,
  humanPatch,
  humanRead,
  humanSearch,
  humanStyle,
  humanTone,
  jsonError,
  jsonOk,
  term,
} from "../src/output";
import { COMMAND_NAMES, isCommandName, usageText } from "../src/usage";
import type { CommandName } from "../src/usage";
import { atOf, fieldOf, keysOf, listOf, parseJsonLine } from "./harness";
import type {
  ApplyStyleResult,
  DocAnnotationEntry,
  ExtractStyleLlmResult,
  ExtractStyleResult,
  ImportReport,
  LibrarySearchResult,
  LintReport,
  MigrateResult,
  Outline,
  PatchResult,
  ReadNodeResult,
  SidecarAnnotation,
} from "@hreader/core";

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
  replacedIds: [],
  changed: true,
  historyPath: ".hreader/history/a/2026.html",
  undoable: true,
};

const REPLACED: PatchResult = {
  path: "b.html",
  bytes: 149,
  newIds: [],
  replacedIds: [{ from: "hr-a392514c", to: "p-1-2" }],
  changed: true,
  historyPath: ".hreader/history/b/2026.html",
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

describe("output · JSON envelope", () => {
  it("should wrap data with a fixed ok-first envelope and a single newline", () => {
    expect(jsonOk("{}")).toBe('{"ok":true,"data":{}}\n');
    expect(jsonError("not_a_file", 'a"b')).toBe(
      '{"ok":false,"code":"not_a_file","message":"a\\"b"}\n',
    );
  });

  it("should keep the frozen key order for every data payload", () => {
    expect(keysOf(JSON.parse(dataPatch(PATCHED)))).toEqual([
      "path",
      "bytes",
      "newIds",
      "changed",
      "historyPath",
    ]);
    expect(keysOf(JSON.parse(dataPatch(REPLACED)))).toEqual([
      "path",
      "bytes",
      "newIds",
      "changed",
      "historyPath",
      "replacedIds",
    ]);
    const readKeys = ["html", "ids", "truncated", "diagnostics"]; // all four keys always present
    expect(keysOf(JSON.parse(dataRead(READ, ["hr-1"])))).toEqual(readKeys);
    expect(keysOf(JSON.parse(dataStyle(STYLE)))).toEqual(["path", "changed"]);
    expect(keysOf(JSON.parse(dataTone("p")))).toEqual(["prompt"]);
    expect(keysOf(JSON.parse(dataLint(HITS)))).toEqual(["hits"]);
  });
});

describe("output · hit key order", () => {
  it("should keep the hit key order (path/word/excerpt/offset)", () => {
    expect(keysOf(atOf(fieldOf(JSON.parse(dataLint(HITS)), "hits"), 0))).toEqual([
      "path",
      "word",
      "excerpt",
      "offset",
    ]);
  });
});

describe("output · patch/outline serialization", () => {
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
// The placeholder is the same one as `usage.ts`'s usage line (`<nodeId|selector>`): the hint must paste straight back into a command line.
const EMPTY_OUTLINE_HINT =
  "（没有标题）\n本文没有标题；用 hr read a.html <nodeId|selector> 取内容\n";
describe("output · human-readable text", () => {
  it("should indent the outline tree by depth and end with one newline", () => {
    expect(humanOutline(OUTLINE)).toBe("- hr-1  标题  (1w)\n  - hr-2  子  (1w)\n");
  });

  it("should print an empty outline as a named hint with a runnable next step", () => {
    expect(humanOutline({ ...OUTLINE, nodes: [] }, "a.html")).toBe(EMPTY_OUTLINE_HINT);
    expect(humanOutline({ ...OUTLINE, nodes: [] })).toContain("hr read <文件>");
  });

  it("should print read html plus a newline", () => {
    expect(humanRead(READ)).toBe("<p>x</p>\n");
  });

  it("should print patched/unchanged lines with byte counts", () => {
    expect(humanPatch(PATCHED)).toBe("patched a.html (42 bytes, +1 ids: hr-9)\n");
    expect(humanPatch(UNCHANGED)).toBe("unchanged a.html (42 bytes)\n");
  });

  it("should print the ignored fragment id mapping when the fragment brought its own id", () => {
    expect(humanPatch(REPLACED)).toBe("patched b.html (149 bytes, id 变更: hr-a392514c → p-1-2)\n");
  });

  it("should print one lint line per hit with the in-block offset, then a trailing newline", () => {
    expect(humanLint(HITS)).toBe("hr-1:3: boom — …boom…\n");
    expect(humanLint({ hits: [], truncated: false })).toBe("");
  });

  it("should print tone prompts verbatim plus a newline", () => {
    expect(humanTone("一二\n三")).toBe("一二\n三\n");
  });

  it("should print styled/unchanged lines, naming the theme when unchanged", () => {
    expect(humanStyle(STYLE)).toBe("styled a.html (42 bytes)\n");
    expect(humanStyle({ ...STYLE, changed: false })).toBe(
      'unchanged a.html (42 bytes，主题已与文档里的 <style id="hr-theme"> 一致)\n',
    );
  });
});

describe("annotations output · merged entries and migrate receipts", () => {
  const annotation = (
    opts: { id?: string; selector?: string | null; note?: string } = {},
  ): SidecarAnnotation => ({
    id: opts.id ?? "an-1",
    ...(opts.selector === null ? {} : { selector: opts.selector ?? "body > p" }),
    anchor: { exact: "摘录", prefix: "", suffix: "", start: 0 },
    note: opts.note ?? "批注内容",
    status: "pending",
    createdAt: "t",
    author: "user",
    replies: [],
  });

  const entry = (patch: Partial<DocAnnotationEntry> = {}): DocAnnotationEntry => ({
    source: "sidecar",
    annotation: annotation(),
    anchor: { ok: true, start: 0, end: 2, via: "selector" },
    ...patch,
  });

  it("should print one line per entry and mark the unlocated ones 未定位", () => {
    const located = entry();
    const lost = entry({
      annotation: annotation({ id: "an-2" }),
      anchor: { ok: false, reason: "orphaned", via: "none" },
    });
    const bare = entry({ annotation: annotation({ id: "an-3", selector: null }) });
    const quiet = entry({ annotation: annotation({ id: "an-4", note: "" }) });

    const text = humanAnnotationsList([located, lost, bare, quiet], "doc.html");

    expect(text).toContain("共 4 条");
    expect(text).toContain("已定位（selector，0-2）");
    expect(text).toContain("未定位（orphaned）");
    // No nodeId and no selector: the target column falls back to `-`.
    expect(text).toContain("→ - ·");
    // An empty note prints the anchored excerpt instead of a blank.
    expect(text).toContain("(sidecar) 摘录 →");
  });

  it("should serialize the entry wire shape including nodeId/selector nulls and a failed relocation", () => {
    const lost = entry({
      annotation: annotation({ id: "an-2", selector: null }),
      anchor: { ok: false, reason: "anchor_lost", via: "body" },
    });

    const data = JSON.parse(dataAnnotationsList("doc.html", [entry(), lost], ["diag"])) as {
      annotations: Record<string, unknown>[];
    };
    const [first, second] = data.annotations;
    expect(first?.["nodeId"]).toBeNull();
    expect(first?.["relocation"]).toMatchObject({ ok: true, via: "selector" });
    expect(second?.["selector"]).toBeNull();
    expect(second?.["relocation"]).toMatchObject({ ok: false, reason: "anchor_lost" });
  });

  it("should serialize historyPath null only for a no-write migrate", () => {
    const base: MigrateResult = {
      migrated: 1,
      skipped: 0,
      changed: true,
      historyPath: "/h/snap.json",
      diagnostics: [],
    };
    const written = JSON.parse(dataAnnotationsMigrate(base, "doc.html")) as Record<string, unknown>;
    expect(written["historyPath"]).toBe("/h/snap.json");

    const untouched = JSON.parse(
      dataAnnotationsMigrate({ ...base, changed: false, historyPath: null }, "doc.html"),
    ) as Record<string, unknown>;
    expect(untouched["historyPath"]).toBeNull();
  });
});

describe("usage · single source of truth", () => {
  it("should name all sixteen commands", () => {
    expect(COMMAND_NAMES.join(" ")).toBe(
      "new import normalize outline read patch check style undo export pdf png serve template annotations search",
    );
    expect(isCommandName("patch")).toBe(true);
    expect(isCommandName("nope")).toBe(false);
    expect(isCommandName(undefined)).toBe(false);
  });
});

describe("usage · literal inventory", () => {
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

describe("exit-codes · frozen table", () => {
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
    ["invalid_payload", 1],
    ["nothing_to_undo", 1],
    ["anchor_lost", 1],
    ["invalid_style", 1],
    ["unknown_style", 1],
    ["invalid_theme", 1],
    ["path_outside_workspace", 3],
    ["not_a_file", 3],
    ["io_failure", 3],
    ["style_io_failure", 3],
    ["invalid_utf8", 3],
    ["chrome_missing", 3],
    ["chrome_failed", 3],
    ["render_timeout", 3],
    ["render_empty", 3],
  ] as const)("should map %s to exit %d", (code, expected) => {
    expect(exitCodeOf(code)).toBe(expected);
  });
});
// `invalid_selector`'s machine-readable cause (`reason`/`count`/`candidates`) leaves through `jsonError`'s `data`,
// and callers branch on `data.reason` — so what is pinned here is the key set, not the full message.
describe("output · the data key of the JSON error envelope", () => {
  it("should emit data verbatim after message when the error carries machine-readable causes", () => {
    expect(jsonError("invalid_selector", "无法解析：p[", { reason: "syntax" })).toBe(
      '{"ok":false,"code":"invalid_selector","message":"无法解析：p[","data":{"reason":"syntax"}}\n',
    );
  });

  it("should keep the data key out entirely when there is nothing machine-readable to say", () => {
    // `node_not_found` carries no `data`: an extra empty object would send the caller's `data.reason` branch down "has a cause".
    expect(jsonError("node_not_found", "没有这个节点")).toBe(
      '{"ok":false,"code":"node_not_found","message":"没有这个节点"}\n',
    );
  });
});
/** The fragment root id is ignored, falling back to the target id, while two deeper new ids come out of the fragment. */
const WITH_EXTRAS: PatchResult = {
  path: "b.html",
  bytes: 149,
  newIds: ["p-1-2", "hr-x1", "hr-x2"],
  replacedIds: [{ from: "hr-a392514c", to: "p-1-2" }],
  changed: true,
  historyPath: null,
  undoable: false,
};

/** The same "fragment id ignored", except the fragment holds no deeper addressable nodes. */
const NO_EXTRAS: PatchResult = { ...WITH_EXTRAS, newIds: ["p-1-2"] };

// `replace`'s fragment-root `data-hr-id` counts as "ignored"; other addressable nodes inside the fragment are
// reassigned by the product — the human receipt must print both the "id change" and the "incidental new ids"
// segments, and the second must vanish whole when empty (a leftover ", +0 ids: " would report an empty list out of thin air).
describe("output · the human receipt after replace", () => {
  it("should print the mapping and then the extra ids the fragment brought along", () => {
    expect(humanPatch(WITH_EXTRAS)).toBe(
      "patched b.html (149 bytes, id 变更: hr-a392514c → p-1-2, +2 ids: hr-x1, hr-x2)\n",
    );
  });

  it("should drop the extra-ids tail entirely when every new id is already mapped", () => {
    expect(humanPatch(NO_EXTRAS)).toBe(
      "patched b.html (149 bytes, id 变更: hr-a392514c → p-1-2)\n",
    );
  });
});
/** `dataPatch` only emits the payload; the trailing `\n` is `runCli`'s output contract — here it is added so the same parsing is reused. */
const decode = (payload: string): unknown => parseJsonLine(`${payload}\n`);

const WARNED: PatchResult = {
  path: "a.html",
  bytes: 42,
  newIds: ["hr-9"],
  replacedIds: [],
  changed: true,
  historyPath: ".hreader/history/a/2026.html",
  undoable: true,
  warnings: [
    {
      code: "duplicate_attribute",
      severity: "warning",
      message: "<p> 上重复的 title 已丢弃前一个",
    },
  ],
};

const CLEAN: PatchResult = { ...WARNED, warnings: [] };

// Fragment-parse diagnostics are no longer silently dropped: a `duplicate_attribute`-style "byte lost an
// attribute" must be machine-readable, so `warnings` appears on the `dataPatch` envelope whenever diagnostics are non-empty.
describe("dataPatch · the warnings key only appears when non-empty", () => {
  it("should append a warnings key and carry the diagnostic through", () => {
    const parsed = decode(dataPatch(WARNED));

    expect(keysOf(parsed)).toEqual([
      "path",
      "bytes",
      "newIds",
      "changed",
      "historyPath",
      "warnings",
    ]);
    expect(listOf(fieldOf(parsed, "warnings"))).toHaveLength(1);
  });

  it("should not print the key at all when the list is empty", () => {
    expect(keysOf(decode(dataPatch(CLEAN)))).not.toContain("warnings");
    expect(dataPatch(CLEAN)).not.toContain("warnings");
  });
});

// The human receipt must strip terminal control characters: titles, filenames, and diagnostic bodies come from
// untrusted docs and disk — verbatim into a terminal they can paint colors, move the cursor, hang fake OSC 8 links, or bidi-flip display. Characters are stripped, not copy.
describe("term · terminal-safe human output", () => {
  it("should strip CSI colour and cursor sequences", () => {
    expect(term("\x1b[31m红\x1b[0m标题\x1b[2J")).toBe("红标题");
    expect(term("\x1b[2;5H光标")).toBe("光标");
  });

  it("should strip OSC 8 hyperlinks but keep the label text", () => {
    expect(term("\x1b]8;;https://evil.example\x07点击\x1b]8;;\x07")).toBe("点击");
    expect(term("\x1b]8;;https://evil.example\x1b\\label\x1b]8;;\x1b\\")).toBe("label");
  });

  it("should strip bidi overrides and isolates from filenames", () => {
    expect(term("\u202egnidorpmi\u202c.html")).toBe("gnidorpmi.html");
    expect(term("a\u2066evil\u2069b")).toBe("aevilb");
  });

  it("should strip stray ESC, DEL and C1 controls but keep \\n and \\t", () => {
    expect(term("a\x1bb\x7fc\x9b31md")).toBe("abc31md");
    expect(term("列1\t列2\n行2")).toBe("列1\t列2\n行2");
  });

  it("should leave plain Chinese and emoji titles byte-identical", () => {
    expect(term("中文标题 📖 第二章")).toBe("中文标题 📖 第二章");
  });
});

describe("bounded · the stderr line cap", () => {
  const LONE_LEAD = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;
  const LONE_TAIL = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

  it("should not split a surrogate pair when the cap lands inside an emoji", () => {
    // 8191 'a' + 😀 = 8193 code units: the 8192-unit cut falls between the emoji's two halves.
    const written = bounded(`${"a".repeat(8191)}😀`);
    expect(written).not.toMatch(LONE_LEAD);
    expect(written).not.toMatch(LONE_TAIL);
    expect(written).toContain("…[truncated 2 chars]");
    expect(written.startsWith("a".repeat(8191))).toBe(true);
  });

  it("should keep a surrogate pair whose tail ends exactly on the cap", () => {
    // 8190 'a' + 😀 + 'b' = 8193 units: the cut lands just after the whole pair — keep it, drop 'b'.
    const written = bounded(`${"a".repeat(8190)}😀b`);
    expect(written).toContain("😀");
    expect(written).toContain("…[truncated 1 chars]");
    expect(written).not.toMatch(LONE_LEAD);
    expect(written).not.toMatch(LONE_TAIL);
  });

  it("should leave a text exactly at the cap untouched, emoji included", () => {
    const exact = `${"a".repeat(8190)}😀`;
    expect(bounded(exact)).toBe(exact);
  });

  it("should preserve a surrogate that is already lone in the input", () => {
    // Malformed input is echoed, not "fixed": the cut must not create new lone surrogates, but it does
    // not silently drop a pre-existing one either.
    const written = bounded(`${"a".repeat(8191)}\uD800b`);
    expect(written.startsWith(`${"a".repeat(8191)}\uD800`)).toBe(true);
    expect(written).toContain("…[truncated 1 chars]");
  });
});

describe("human receipts · untrusted fields go through term", () => {
  it("should sanitize titles inside humanImport", () => {
    const report: ImportReport = {
      kind: "report",
      title: "\x1b[31m邪恶\x1b[0m\u202a标题",
      titleSource: "title",
      trunk: "main",
      trunkTag: "main",
      sections: 1,
      removedElements: 0,
      strippedAttributes: 0,
      discarded: [],
    };
    const text = humanImport(report, "out.html", 100);

    expect(text).toContain("邪恶标题");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\u202a");
  });

  it("should sanitize RTL-overridden filenames inside humanCheck and humanLint", () => {
    const evil = "doc-\u202ehtm.html";
    const check = humanCheck([], evil);
    const lint = humanLint({
      hits: [{ path: evil, word: "\x1b[7m词", excerpt: "x\x1b[Ky", offset: 0 }],
      truncated: false,
    });

    expect(check).toContain("doc-htm.html");
    expect(check).not.toContain("\u202e");
    expect(lint).not.toContain("\x1b");
    expect(lint).not.toContain("\u202e");
  });

  it("should sanitize outline node text and the empty-outline display path", () => {
    const outline: Outline = {
      nodes: [
        { id: "hr-1", tag: "h2", level: 2, text: "\x1b[1m粗\x1b[0m", wordCount: 1, children: [] },
      ],
      pendingAnnotations: [],
      wordCount: 1,
      diagnostics: [],
    };

    const text = humanOutline(outline);
    expect(text).toContain("粗");
    expect(text).not.toContain("\x1b");
  });

  it("should leave the read-document artifact untouched but sanitize its truncation note", () => {
    const html = "<p>\x1b[31m文档正文</p>";
    const result: ReadNodeResult = {
      html,
      annotations: [],
      truncated: true,
      diagnostics: [{ code: "truncated_output", severity: "warning", message: "截断\x1b[2J说明" }],
    };
    const text = humanRead(result);

    expect(text).toContain(html);
    expect(text).toContain("截断说明");
  });

  it("should keep control characters escaped-but-verbatim inside --json output", () => {
    const report: ImportReport = {
      kind: "report",
      title: "\x1b[31mT\u202a",
      titleSource: "title",
      trunk: "main",
      trunkTag: "main",
      sections: 1,
      removedElements: 0,
      strippedAttributes: 0,
      discarded: [],
    };
    // --json is a machine contract: stripping characters would alter data; JSON.stringify's escaping is already safe.
    const parsed = JSON.parse(dataImport("out.html", 100, report)) as { readonly title: string };
    expect(parsed.title).toBe("\x1b[31mT\u202a");
  });
});

// join(",") survives only while every test fixture array has ≤1 element — the separator is invisible in a single-element array.
// Here every outward JSON gets a ≥2-element fixture: separator mutations (`""`/`"Stryker"`) break it into invalid JSON or shifted fields.
const diag = (code: string): NonNullable<PatchResult["warnings"]>[number] => {
  const entry: NonNullable<PatchResult["warnings"]>[number] = {
    code: code as never,
    severity: "warning",
    message: `m-${code}`,
  };
  return entry;
};

describe("output · outward JSON multi-element separators and field names", () => {
  it("should comma-separate multiple nodes, children, annotations and diagnostics in dataOutline", () => {
    const outline: Outline = {
      nodes: [
        {
          id: "hr-1",
          tag: "h1",
          level: 1,
          text: "t1",
          wordCount: 1,
          children: [
            { id: "hr-2", tag: "p", level: 2, text: "c1", wordCount: 1, children: [] },
            { id: "hr-3", tag: "p", level: 2, text: "c2", wordCount: 1, children: [] },
          ],
        },
        { id: "hr-4", tag: "h2", level: 1, text: "t2", wordCount: 1, children: [] },
      ],
      pendingAnnotations: [
        { id: "an-1", targetId: "hr-1", comment: "x" },
        { id: "an-2", targetId: "hr-4", comment: "y" },
      ],
      wordCount: 4,
      diagnostics: [diag("d1"), diag("d2")],
    };
    expect(JSON.parse(dataOutline(outline))).toEqual(outline);
  });

  it("should comma-separate multiple diagnostics in dataRead", () => {
    const result: ReadNodeResult = {
      html: "<p>x</p>",
      annotations: [],
      truncated: true,
      diagnostics: [diag("truncated_output"), diag("d2")],
    };
    const parsed = JSON.parse(dataRead(result, ["hr-1", "hr-2"])) as {
      ids: string[];
      diagnostics: { code: string }[];
    };
    expect(parsed.ids).toEqual(["hr-1", "hr-2"]);
    expect(parsed.diagnostics.map((item) => item.code)).toEqual(["truncated_output", "d2"]);
  });

  it("should comma-separate multiple warnings in dataPatch", () => {
    const result: PatchResult = {
      ...WARNED,
      warnings: [diag("w1"), diag("w2")],
    };
    const parsed = decode(dataPatch(result)) as { warnings: { code: string }[] };
    expect(parsed.warnings.map((item) => item.code)).toEqual(["w1", "w2"]);
  });

  it("should comma-separate multiple hits in dataLint", () => {
    const report: LintReport = {
      hits: [
        { path: "hr-1", word: "a", excerpt: "…a…", offset: 1 },
        { path: "hr-2", word: "b", excerpt: "…b…", offset: 2 },
      ],
      truncated: false,
    };
    const parsed = JSON.parse(dataLint(report)) as { hits: { path: string }[] };
    expect(parsed.hits.map((item) => item.path)).toEqual(["hr-1", "hr-2"]);
  });
});

// Relative paths only display inside cwd: out of bounds (cwd itself, parents, siblings) falls back to absolute —
// a relative string outside would mislead where the file is; an absolute path inside would stretch every receipt line.
describe("displayedPathOf · relative inside cwd, absolute outside", () => {
  const cwd = "/ws/site";

  it.each([
    ["/ws/site/a/b.html", "a/b.html"],
    ["/ws/site/a.html", "a.html"],
    ["/ws/site/..dot/f.html", "..dot/f.html"],
  ])("should show cwd-internal path %s as %s", (path, expected) => {
    expect(displayedPathOf(path, cwd)).toBe(expected);
  });

  it.each(["/ws/site", "/ws/other/x.html", "/else/y.html", "/ws"])(
    "should fall back to the absolute path for %s",
    (path) => {
      expect(displayedPathOf(path, cwd)).toBe(path);
    },
  );
});

// humanRead appends the truncation line only when a diagnostic with code === "truncated_output" exists:
// mutating the condition to always-true/always-false/changed code would tear the human output away from the data layer.
describe("humanRead · exact matching of the truncation hint", () => {
  it("should append the truncation line only for the truncated_output code", () => {
    const withTrunc: ReadNodeResult = {
      html: "<p>x</p>",
      annotations: [],
      truncated: true,
      diagnostics: [diag("other_diag"), diag("truncated_output")],
    };
    expect(humanRead(withTrunc)).toBe("<p>x</p>\nm-truncated_output\n");
    const withoutTrunc: ReadNodeResult = { ...withTrunc, diagnostics: [diag("other_diag")] };
    expect(humanRead(withoutTrunc)).toBe("<p>x</p>\n");
  });
});

// humanPatch joins id-change pairs with ", " and warnings with "\n"; two or more of each is needed to see the separators.
describe("humanPatch · separators across multiple id pairs and warnings", () => {
  it("should join two replaced pairs with ', ' and two warnings with newlines", () => {
    const result: PatchResult = {
      path: "b.html",
      bytes: 10,
      newIds: [],
      replacedIds: [
        { from: "hr-1", to: "p-1" },
        { from: "hr-2", to: "p-2" },
      ],
      changed: true,
      historyPath: null,
      undoable: true,
      warnings: [
        { ...diag("w1"), message: "第一" },
        { ...diag("w2"), message: "第二" },
      ],
    };
    expect(humanPatch(result)).toBe(
      "patched b.html (10 bytes, id 变更: hr-1 → p-1, hr-2 → p-2)\n" +
        "warning: w1 — 第一\nwarning: w2 — 第二\n",
    );
  });
});

// dataExport's out field: null = stdout-only, written as null; a path = quoted. Both branches must be present.
describe("dataExport · the null and path branches of out", () => {
  const report = { html: "<p>x</p>", bytes: 8, droppedImages: 0 } as unknown as PrintHtmlResult;
  it("should encode out as null or quoted path", () => {
    expect(JSON.parse(dataExport(report, null))).toEqual({
      html: "<p>x</p>",
      bytes: 8,
      droppedImages: 0,
      out: null,
    });
    expect(JSON.parse(dataExport(report, "o.html"))).toEqual({
      html: "<p>x</p>",
      bytes: 8,
      droppedImages: 0,
      out: "o.html",
    });
  });
});

// dataStyleExtract's whole-object assertion (existing cases only toContain, which separator/field-name mutations defeat) + multi-element dropped + the statsJson field name.
describe("dataStyleExtract · the complete JSON shape", () => {
  const result = {
    spec: { id: "s", name: "n", description: "", inheritsVisual: "v", language: {} },
    yaml: "a: b\n",
    stats: { paragraphs: 2, sentences: 3, averageSentenceChars: 1.5, maxParagraphSentences: 2 },
  } as unknown as ExtractStyleResult;

  it("should serialize path, stats fields and yaml exactly", () => {
    expect(JSON.parse(dataStyleExtract(result, null))).toEqual({
      path: null,
      stats: { paragraphs: 2, sentences: 3, averageSentenceChars: 1.5, maxParagraphSentences: 2 },
      yaml: "a: b\n",
    });
  });

  it("should comma-separate multiple dropped items", () => {
    const parsed = JSON.parse(
      dataStyleExtract(result, "a.yaml", [
        { field: "f1", reason: "r1" },
        { field: "f2", reason: "r2" },
      ] as unknown as ExtractStyleLlmResult["dropped"]),
    ) as { dropped: { field: string }[] };
    expect(parsed.dropped.map((item) => item.field)).toEqual(["f1", "f2"]);
  });
});

// humanImport's three trunk branches (trunkTag → <tag>; main → <main>; fallback <body>), the dropped-detail segment, and the title-source label table.
describe("humanImport · the three trunk branches and dropped details", () => {
  const base: ImportReport = {
    kind: "report",
    title: "T",
    titleSource: "h1",
    trunk: "main",
    trunkTag: undefined,
    sections: 1,
    removedElements: 2,
    strippedAttributes: 3,
    discarded: [],
  };

  it.each([
    ["option", "--title"],
    ["title", "<title>"],
    ["h1", "首个 <h1>"],
    ["fallback", "兜底文案"],
  ] as const)("should label titleSource %s as %s", (source, label) => {
    expect(humanImport({ ...base, titleSource: source }, "o.html", 5)).toContain(`（${label}）`);
  });

  it("should render trunkTag, main and body fallbacks", () => {
    expect(humanImport({ ...base, trunk: "largest", trunkTag: "article" }, "o.html", 5)).toContain(
      "主干：<article>",
    );
    expect(humanImport(base, "o.html", 5)).toContain("主干：<main>");
    expect(humanImport({ ...base, trunk: "body" }, "o.html", 5)).toContain("主干：<body>");
  });

  it("should list each discarded row and omit the section when empty", () => {
    const dropped: ImportReport["discarded"] = [
      { what: "<script>", reason: "脚本", count: 2 },
      { what: "<form>", reason: "控件", count: 1 },
    ];
    const text = humanImport({ ...base, discarded: dropped }, "o.html", 5);
    expect(text).toContain("丢弃明细：");
    expect(text).toContain("<script> ×2（脚本）");
    expect(text).toContain("<form> ×1（控件）");
    expect(humanImport(base, "o.html", 5)).not.toContain("丢弃明细");
  });
});

describe("hr search output", () => {
  const base: LibrarySearchResult = {
    results: [
      {
        path: "a.html",
        title: "维修手册",
        kind: "doc",
        score: 2.5,
        snippet: "摩托车 发动机",
        highlights: [[0, 3]],
      },
      {
        path: "a.html",
        title: "维修手册",
        kind: "annotation",
        annotationId: "an-123",
        score: 1.1,
        snippet: "换\n全合成机油",
        highlights: [[1, 5]],
      },
    ],
    total: 2,
    combine: "and",
    truncated: false,
    diagnostics: [],
  };

  it("should print one line per hit with the kind tag and a folded snippet", () => {
    const text = humanSearch(base);
    expect(text).toContain("search（共 2 条命中）");
    expect(text).toContain("a.html [文档] 摩托车 发动机");
    expect(text).toContain("a.html [批注 an-123] 换 全合成机油");
    expect(text).not.toContain("上限");
  });

  it("should mark a truncated library and survive a missing annotationId", () => {
    const truncated: LibrarySearchResult = {
      results: [
        {
          path: "b.html",
          title: "",
          kind: "annotation",
          score: 0.5,
          snippet: "note",
          highlights: [],
        },
      ],
      total: 1,
      combine: "or",
      truncated: true,
      diagnostics: [],
    };
    const text = humanSearch(truncated);
    expect(text).toContain("b.html [批注 -] note");
    expect(text).toContain("结果是前缀");
  });

  it("should serialize the full envelope under --json", () => {
    const data = JSON.parse(dataSearch(base)) as LibrarySearchResult;
    expect(data.total).toBe(2);
    expect(data.results[0]?.kind).toBe("doc");
  });
});
