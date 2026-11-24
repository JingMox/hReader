// 这层管：`hr read`/`hr patch` 的寻址——五种 action 都能用选择器（不是 id）当目标、同一元素的两种
// 寻址路径逐字节一致、用选择器 patch 后文档根 id 不变，以及两跳都没命中时错误码由失败原因定
// （不由目标串形态定）。

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

/** 无标题文档：`<article>` 在、可读文本在，但没有任何 `<h1>`–`<h6>`。 */
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

/** 跑一条 `patch --json`，返回退出码与信封（两种结局共用）。 */
const patchJson = async (
  dir: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly envelope: unknown }> => {
  const result = checked(await runCli(["patch", "a.html", ...args, "--json"], { cwd: dir }));
  return { code: result.code, envelope: parseJsonLine(result.stdout) };
};

interface ActionCase {
  readonly action: string;
  /** 选择器目标：单匹配（多义口径由 `ambiguous-target.test.ts` 钉）。 */
  readonly target: string;
  readonly html: string | undefined;
  /** 落盘后必须出现 / 必须消失的片段。 */
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

describe("patch · 五种 action 都能用选择器定位", () => {
  it.each(ACTIONS)("should apply $action to a selector-addressed target", async (one) => {
    await withTempDir(async (dir) => {
      const file = seed(dir);

      const { code, envelope } = await patchJson(dir, patchArgsOf(one));

      expect(code).toBe(0);
      expect(fieldOf(envelope, "ok")).toBe(true);
      const after = readFileSync(file, "utf8");
      for (const needle of one.present) expect(after).toContain(needle);
      for (const needle of one.absent) expect(after).not.toContain(needle);
      // 五种 action 都不许动文档根。
      expect(after).toContain('<article data-hr-id="hr-root">');
    });
  });
});

describe("patch · 两跳都失败时的码与 `data`", () => {
  it("should report invalid_selector with reason `syntax` when the target breaks the attribute quoting", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir);
      const before = readFileSync(file);

      const { code, envelope } = await patchJson(dir, ['a"b', "--action", "delete"]);

      expect(code).toBe(1);
      expect(fieldOf(envelope, "code")).toBe("invalid_selector");
      // 唯一能让 `[data-hr-id="…"]` 本身非法的形态：`"`/`\`/换行。码在这里反过来（不是 node_not_found）。
      expect(fieldOf(fieldOf(envelope, "data"), "reason")).toBe("syntax");
      // F19 起报文只有一句：目标不是合规 id（`"` 让 `[data-hr-id="…"]` 本身非法），报 syntax 那一句。
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
      // `data === undefined` 时整个键不出现：调用方按 `hasOwn` 分支，不用猜空对象。
      expect(keysOf(envelope)).toEqual(["ok", "code", "message"]);
    });
  });
});

describe("outline · 无标题文档的端到端提示（docs/05:120）", () => {
  it("should print the two-line hint with the cwd-relative path, exit 0", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", UNTITLED);

      const result = checked(await runCli(["outline", "a.html"], { cwd: dir }));

      expect(result.code).toBe(0);
      // 两行原文：第二行必须能照抄执行，所以路径按用户视角（cwd 相对），不是临时目录绝对路径。
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

/** 跑一条必须成功的命令，返回 stdout 原文（逐字节比较的对象）。 */
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

/** 跑一条 `read --json` 并取 `data`（整份 JSON 不再要求逐字节相同，比较下沉到字段）。 */
const readDataOf = async (dir: string, target: string): Promise<unknown> =>
  dataOf(parseJsonLine(await stdoutOf(dir, ["read", "a.html", target, "--json"])));

const diagnosticCodesOf = (data: unknown): readonly unknown[] => {
  const diagnostics: unknown = fieldOf(data, "diagnostics");
  return Array.isArray(diagnostics)
    ? diagnostics.map((diagnostic) => fieldOf(diagnostic, "code"))
    : [];
};

/** 真正描述元素的三个字段必须一致；`diagnostics` 不在此列（歧义警告随选择器变）。 */
const expectSameReadData = (left: unknown, right: unknown): void => {
  for (const key of ["html", "ids", "truncated"]) {
    expect(fieldOf(left, key)).toEqual(fieldOf(right, key));
  }
};

/**
 * 不可寻址元素的两路 parity：人读 HTML 与 `data` 三字段逐字节相同；
 * 但 `span` 命中 2 个必须带 `ambiguous_selector`，子选择器命中 1 个不得带。
 * 不再要求整份 JSON 相同：警告讲的是“选择器有歧义”，不是“这个元素是谁”。
 */
const expectSpanParity = async (dir: string): Promise<void> => {
  const byTag = await stdoutOf(dir, ["read", "a.html", "span"]);
  const byChild = await stdoutOf(dir, ["read", "a.html", "p > span:nth-of-type(1)"]);
  expect(byChild).toBe(byTag);
  expect(byTag).toContain("<span>甲</span>");

  const dataByTag = await readDataOf(dir, "span");
  const dataByChild = await readDataOf(dir, "p > span:nth-of-type(1)");
  expectSameReadData(dataByTag, dataByChild);
  // 护栏：默认取第一个不能被静默允许。
  expect(diagnosticCodesOf(dataByTag)).toContain("ambiguous_selector");
  expect(diagnosticCodesOf(dataByChild)).not.toContain("ambiguous_selector");
};

describe("read · 两种寻址路径的逐字节一致性", () => {
  it("should print the same bytes for `read ul` and `read <that ul's id>`", async () => {
    await withTempDir(async (dir) => {
      seedParity(dir);

      // 同一份 html（HumanRead 通道）。
      const byTag = await stdoutOf(dir, ["read", "a.html", "ul"]);
      const byId = await stdoutOf(dir, ["read", "a.html", "hr-u"]);
      expect(byId).toBe(byTag);

      // `--json` 同样逐字节：`data` 里没有任何「寻址来源」字段会因入口不同而变。
      const jsonByTag = await stdoutOf(dir, ["read", "a.html", "ul", "--json"]);
      const jsonById = await stdoutOf(dir, ["read", "a.html", "hr-u", "--json"]);
      expect(jsonById).toBe(jsonByTag);
      expect(jsonById).toContain('"html":"<ul data-hr-id=\\"hr-u\\">');
    });
  });

  it("should print the same bytes for an unaddressable element reached two ways", async () => {
    await withTempDir(async (dir) => {
      seedParity(dir);
      // `<span>` 在盘上没有 `data-hr-id`：只能靠选择器摸进去，且两条选择器都得落到同一个元素上。
      // 人读通道仍逐字节相同；`--json` 不再要求整份相同（`span` 带歧义警告、子选择器不带，见 helper 注释）。
      await expectSpanParity(dir);
    });
  });
});

describe("patch · 用选择器定位后根 id 不变", () => {
  it("should keep the document root's id after a selector-addressed patch", async () => {
    await withTempDir(async (dir) => {
      const file = seedParity(dir);

      const result = checked(
        await runCli(["patch", "a.html", "ul", "--action", "append", "--html", "<li>三</li>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(0);
      // 落盘后根元素的开标签逐字不变（id 是内容派生的，选择器定位不许把它换掉）。
      const after = readFileSync(file, "utf8");
      expect(after).toContain(ROOT_OPEN);
      expect(after.match(/data-hr-id="hr-root"/gu)).toHaveLength(1);
      // 根仍然按老 id 读得到，且读到的是打过补丁的那棵树。
      const root = await stdoutOf(dir, ["read", "a.html", "hr-root"]);
      expect(root).toContain("三</li>");
      // 目标 `<ul>` 自己的 id 也没变：新 `<li>` 有 id，`<ul>` 还是 `hr-u`。
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
/** 文档里只有一个 id 为 `s2` 的小节：`#S2` 因此是"大写 id 查无此节点"，不是文法错。 */
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
  /** `node_not_found` 时整个 `data` 键不出现，故为 `undefined`。 */
  readonly reason: "syntax" | undefined;
  /** 报文必须**逐字**这么开头：一句话，且主语是用户敲的那个串。 */
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

/** 报文只有一句：不换行，也不把两跳的结论拼在一起。 */
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
    // `data === undefined` 时整个键不出现：调用方按 `hasOwn` 分支，不用猜空对象。
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

/** `read` 与 `patch` 共用同一条定位链：两条命令对同一个串必须给出同一个码，且都不许动文件。 */
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

describe("两跳都没命中时码由失败码定，不由目标串形态定", () => {
  it.each(MISSES)("should report $code for target $target", expectBothCommands);
});

/** 只取 `code`：非 `HrError` 一律重新抛出（那是内部错，不该被当成用户错断言）。 */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error.code;
    throw error;
  }
  throw new Error("期望失败，但成功了");
};

describe("同一串 locateTarget 与 readNode 必须同码（防两层漂移）", () => {
  const parsed = parseHtml(MISS_DOC);
  /** `hr-NOPE` 除外：它是裸 id，两个入口对它做的事本来就不同（见下一条用例）。 */
  const SHARED = MISSES.filter((one) => one.target !== "hr-NOPE");

  it.each(SHARED)("should agree on the code for $target", (one) => {
    const located = codeOf(() => locateTarget(parsed, one.target));
    const read = codeOf(() => readNode(parsed, one.target));

    expect(located).toBe(one.code);
    expect(read).toBe(located);
  });

  it("should diverge on a bare id: locateTarget falls back, readNode does not", () => {
    // `hr-NOPE` 符合 `HR_ID_PATTERN`，所以 locateTarget 会走第二跳（裸 id 回退，F1 的主路径）；
    // `readNode` 只是选择器求值器，`hr-NOPE` 在它那里是文法错。两边"不同码"是对的——
    // 硬要一致就得让 readNode 偷偷实现回退，那才是把两条数据流塞回一个函数。
    expect(codeOf(() => locateTarget(parsed, "hr-NOPE"))).toBe("node_not_found");
    expect(codeOf(() => readNode(parsed, "hr-NOPE"))).toBe("invalid_selector");
    expect(codeOf(() => readNode(parsed, '[data-hr-id="hr-NOPE"]'))).toBe("node_not_found");
  });
});
