// 这层管：`output.ts` / `usage.ts` / `exit-codes.ts` 的纯函数与冻结表；不跑子进程。

import { describe, expect, it } from "vitest";
import { EXIT_FAILURE, EXIT_IO, EXIT_OK, EXIT_USAGE, exitCodeOf } from "../src/exit-codes";
import {
  dataImport,
  dataLint,
  dataOutline,
  dataPatch,
  dataRead,
  dataStyle,
  dataTone,
  humanCheck,
  humanImport,
  humanLint,
  humanOutline,
  humanPatch,
  humanRead,
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
  ImportReport,
  LintReport,
  Outline,
  PatchResult,
  ReadNodeResult,
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

describe("output · JSON 信封", () => {
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
    const readKeys = ["html", "ids", "truncated", "diagnostics"]; // 四键恒在
    expect(keysOf(JSON.parse(dataRead(READ, ["hr-1"])))).toEqual(readKeys);
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
// 占位符与 `usage.ts` 的用法行同一个（`<nodeId|selector>`）：提示要能直接粘回命令行。
const EMPTY_OUTLINE_HINT =
  "（没有标题）\n本文没有标题；用 hr read a.html <nodeId|selector> 取内容\n";
describe("output · 人读文本", () => {
  it("should indent the outline tree by depth and end with one newline", () => {
    expect(humanOutline(OUTLINE)).toBe("- hr-1  标题  (1w)\n  - hr-2  子  (1w)\n");
  });

  it("should print an empty outline as a named hint with a runnable next step (docs/05:120)", () => {
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

describe("usage · 单一事实源", () => {
  it("should name all thirteen commands", () => {
    expect(COMMAND_NAMES.join(" ")).toBe(
      "new import normalize outline read patch check style undo export pdf png serve",
    );
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

describe("exit-codes · 冻结表", () => {
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
// `invalid_selector` 的机器可读成因（`reason`/`count`/`candidates`）从 `jsonError` 的 `data`
// 出去，调用方靠 `data.reason` 分支——所以这里钉的是键集而不是整段报文。
describe("output · JSON 错误信封的 data 键", () => {
  it("should emit data verbatim after message when the error carries machine-readable causes", () => {
    expect(jsonError("invalid_selector", "无法解析：p[", { reason: "syntax" })).toBe(
      '{"ok":false,"code":"invalid_selector","message":"无法解析：p[","data":{"reason":"syntax"}}\n',
    );
  });

  it("should keep the data key out entirely when there is nothing machine-readable to say", () => {
    // `node_not_found` 不带 `data`：多一个空对象会让调用方的 `data.reason` 分支走向"有成因"。
    expect(jsonError("node_not_found", "没有这个节点")).toBe(
      '{"ok":false,"code":"node_not_found","message":"没有这个节点"}\n',
    );
  });
});
/** 片段根 id 被忽略、落回目标 id，片段内部还带出两个新 id。 */
const WITH_EXTRAS: PatchResult = {
  path: "b.html",
  bytes: 149,
  newIds: ["p-1-2", "hr-x1", "hr-x2"],
  replacedIds: [{ from: "hr-a392514c", to: "p-1-2" }],
  changed: true,
  historyPath: null,
  undoable: false,
};

/** 同样是一次"片段 id 被忽略"，但片段里没有更深层的可寻址节点。 */
const NO_EXTRAS: PatchResult = { ...WITH_EXTRAS, newIds: ["p-1-2"] };

// `replace` 的片段根自带 `data-hr-id` 算"被忽略"，片段内部其它可寻址节点由产品重新分配——
// 人读回执要把"id 变更"与"顺带新增的 id"两段都印出来，映射之外为空时整段必须消失
//（留下 ", +0 ids: " 等于凭空报了个空列表）。
describe("output · replace 之后的人读回执", () => {
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
/** `dataPatch` 只给 payload，行尾的 `\n` 由 `runCli` 那份输出契约负责，这里补齐后复用同一套解析。 */
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

// 片段解析诊断不再静默丢弃：`duplicate_attribute` 这类"字节里少了一个属性"必须能被机器读到，
// 所以 `warnings` 在诊断非空时出现在 `dataPatch` 信封上。
describe("dataPatch · warnings 键只在非空时出现", () => {
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

// 人读回执要剥终端控制字符：标题、文件名、诊断正文来自不受信的文档与磁盘，
// 原样进终端可以染色、挪光标、OSC 8 挂假链接、bidi 反转显示——剥的是字符不是文案。
describe("term · 人读输出的终端安全化", () => {
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

describe("人读回执 · 不受信字段过 term", () => {
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
    // --json 是机器契约：剥字符就改了数据，JSON.stringify 的转义已经足够安全。
    const parsed = JSON.parse(dataImport("out.html", 100, report)) as { readonly title: string };
    expect(parsed.title).toBe("\x1b[31mT\u202a");
  });
});
