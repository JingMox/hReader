// 这层管：M1.3 的公开面边界 —— 该有的在、不该溜出来的没有。
// 为什么"包含 + 禁止项"不是放水：
//   1. 必需项逐条点名（少一个即红，报错直指缺的名字）；
//   2. 禁止项是一张**闭名清单**（`FORBIDDEN`），覆盖了 M1.3 新增的每一个内部符号与常量，
//      再加一条前缀闸（`budget`/`derive`/`OUTLINE_`/`annotations`/`word`）兜住改名后的变体；
//   3. 门面文件自身用 `Object.keys` 全等断言，多导出任何一个内部函数都会红。

import { describe, expect, it } from "vitest";

import * as coreEntry from "../../core/src/index";
import * as metaEntry from "../../core/src/meta/index";
import * as opsEntry from "../../core/src/ops/index";

/** M1.3 之前必须已经在的核心公开面（见 `entry-points.test.ts` 的 REQUIRED 表）。 */
const PRIOR_RUNTIME_EXPORTS = [
  "HrError",
  "buildOutline",
  "injectNodeIds",
  "parseHtml",
  "readNode",
  "serializeHtml",
  "toDocumentModel",
  "validateDocument",
] as const;

/** M1.3/M1.4 引入的内部符号：任何一个出现在公开面都算"漏出"。 */
const FORBIDDEN_LEAKS: readonly string[] = [
  "BLOCKED_CONTENT_TAGS",
  "DEFAULT_MAX_BYTES",
  "MAX_BYTES_LIMIT",
  "META_ANCHOR_ID",
  "OUTLINE_ANNOTATION_LIMIT",
  "OUTLINE_BUDGET_BYTES",
  "SHELL_TAGS",
  "THEME_ANCHOR_ID",
  "ambiguousSelector",
  "annotationsFor",
  "attributeOf",
  "fitSubtree",
  "identifierOf",
  "isForbiddenTarget",
  "parseSelector",
  "resolveSelector",
  "stripShell",
  "strippedShell",
  "truncatedOutput",
  "withinSubtree",
  "PENDING_ANNOTATION_STATUS",
  "annotationsOf",
  "budgetOutline",
  "deriveOutline",
  "findMetaScript",
  "firstArticleOf",
  "isRecord",
  "levelOf",
  "parseMeta",
  "readMeta",
  "sectionLevelOf",
  "stringFieldOf",
  "truncateOutline",
  "wordCountOf",
];

/** 改名/拆分后的变体：前缀闸，避免"改成 `budget` 就逃掉闭名清单"。 */
const FORBIDDEN_PREFIXES: readonly string[] = [
  "OUTLINE_",
  "annotations",
  "budget",
  "derive",
  "word",
];

/** `allowed` 是"该门面自己规格里就该有"的几个名字（否则闭名清单会把合法导出误判为漏出）。 */
const leaked = (
  surface: Readonly<Record<string, unknown>>,
  allowed: readonly string[] = [],
): string[] =>
  Object.keys(surface).filter(
    (name) =>
      !allowed.includes(name) &&
      (FORBIDDEN_LEAKS.includes(name) ||
        FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))),
  );

describe("core public surface · outline boundary", () => {
  it("should keep every prior runtime export and add buildOutline", () => {
    // M1.4 的 readNode 由 `PRIOR_RUNTIME_EXPORTS` 覆盖（同一张表覆盖到最新一版公开面）。
    for (const name of PRIOR_RUNTIME_EXPORTS) {
      expect(Object.keys(coreEntry), `missing ${name}`).toContain(name);
    }
    expect(typeof coreEntry.buildOutline).toBe("function");
  });

  it("should not leak any internal outline/meta symbol", () => {
    expect(leaked(coreEntry)).toEqual([]);
  });
});

describe("ops facade", () => {
  it("should expose exactly applyPatch/buildOutline/locateTarget/parseFragment/patchTargetIdOf/readNode at runtime", () => {
    // `locateTarget` 是 `read`/`patch` 共用的 `<nodeId|selector>` 解析器（docs/05:98 AC9），
    // 必须与它们同住一层，否则 `patch` 会自己再写一份重试链；`patchTargetIdOf` 是 F18 给 patch 的“取一个 id”收口。
    expect(Object.keys(opsEntry).sort()).toEqual([
      "applyPatch",
      "buildOutline",
      "locateTarget",
      "parseFragment",
      "patchTargetIdOf",
      "readNode",
    ]);
  });

  it("should not leak outline internals", () => {
    expect(leaked(opsEntry)).toEqual([]);
  });
});

describe("meta facade", () => {
  it("should expose the reader and the status constant", () => {
    expect(Object.keys(metaEntry).sort()).toEqual(["PENDING_ANNOTATION_STATUSES", "readMeta"]);
    expect([...metaEntry.PENDING_ANNOTATION_STATUSES].sort()).toEqual(["pending", "pending_ai"]);
  });

  it("should not leak meta internals", () => {
    expect(leaked(metaEntry, ["PENDING_ANNOTATION_STATUSES", "readMeta"])).toEqual([]);
  });
});
