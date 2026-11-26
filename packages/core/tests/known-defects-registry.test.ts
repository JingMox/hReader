// 这层管：**已知缺陷登记表（KD）的机器校验**——仓库不许出现"没有登记的 it.fails"，
// 也不许出现"用普通 it 断言坏行为"的负向钉住。
// 规则：每条 `it.fails` 必须带 `// KD-nn`，每个编号必须在 `tests/known-defects.ts` 里登记，
// 且唯一编号数不得超过 `KNOWN_DEFECTS_CAP`（只减不增）。叙述性台账留在本地，不进版本库。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { KNOWN_DEFECTS, KNOWN_DEFECTS_CAP } from "./known-defects";

const REPO = join(import.meta.dirname, "../../..");
const PACKAGES = join(REPO, "packages");

interface Offence {
  readonly where: string;
  readonly problem: string;
}

const SELF = join(REPO, "packages/core/tests/known-defects-registry.test.ts");
const NEEDLE = `it.${String()}fails(`;

const testFilesOf = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (path === SELF) continue;
    if (statSync(path).isDirectory()) testFilesOf(path, out);
    else if (name.endsWith(".ts") && path.includes(`${join("", "tests")}/`)) out.push(path);
  }
  return out;
};

interface Site {
  readonly file: string;
  readonly line: number;
  readonly marker: string | undefined;
}

/** `it.fails(` 的位置 + 就近 2 行内（上方）的 `// KD-nn` 标记。 */
const sitesOf = (file: string): Site[] => {
  // 本文件里也会出现字面量 `it.fails(`（扫描器自身的判断），排除掉以免自指。
  const lines = readFileSync(file, "utf8").split("\n");
  const sites: Site[] = [];
  for (const [index, text] of lines.entries()) {
    if (!text.includes(NEEDLE)) continue;
    const window = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
    const marker = /\/\/\s*(KD-\d{2})\b/.exec(window)?.[1];
    sites.push({ file: relative(REPO, file), line: index + 1, marker });
  }
  return sites;
};

describe("KD 登记表 · 源码与表一致", () => {
  const sites = testFilesOf(PACKAGES)
    .filter((file) => file !== import.meta.filename)
    .flatMap(sitesOf);

  it("should find at least one it.fails (otherwise this guard is vacuous)", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("should give every it.fails a KD-nn marker within two lines above it", () => {
    const offences: Offence[] = sites
      .filter((site) => site.marker === undefined)
      .map((site) => ({
        where: `${site.file}:${String(site.line)}`,
        problem: "缺少 // KD-nn 标记",
      }));

    expect(offences).toEqual([]);
  });

  it("should register every marker in tests/known-defects.ts", () => {
    const registered = KNOWN_DEFECTS.map((defect) => defect.id);
    const offences: Offence[] = sites
      .filter((site) => site.marker !== undefined && !registered.includes(site.marker))
      .map((site) => ({
        where: `${site.file}:${String(site.line)}`,
        problem: `${String(site.marker)} 不在登记表里`,
      }));

    expect(offences).toEqual([]);
  });
});

describe("KD 登记表 · 上限", () => {
  const sites = testFilesOf(PACKAGES).flatMap(sitesOf);

  it("should keep the registry free of entries that no longer have an it.fails", () => {
    const markers = new Set(sites.map((site) => site.marker));
    const stale = KNOWN_DEFECTS.filter((defect) => !markers.has(defect.id)).map(
      (defect) => defect.id,
    );

    expect(stale).toEqual([]);
  });

  it("should keep the unique KD count at or below KNOWN_DEFECTS_CAP", () => {
    const unique = new Set(sites.map((site) => site.marker));
    const ids = KNOWN_DEFECTS.map((defect) => defect.id);

    expect(ids).toHaveLength(KNOWN_DEFECTS_CAP);
    expect(unique.size).toBeLessThanOrEqual(KNOWN_DEFECTS_CAP);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("should give every entry a KD-nn shaped id and a one-line English summary", () => {
    const offences: Offence[] = KNOWN_DEFECTS.flatMap((defect) => {
      const problems: string[] = [];
      if (!/^KD-\d{2}$/u.test(defect.id)) problems.push(`id 形状不对：${defect.id}`);
      if (defect.summary.trim().length === 0 || defect.summary.includes("\n"))
        problems.push("summary 必须是单行非空英文概述");
      return problems.map((problem) => ({ where: defect.id, problem }));
    });

    expect(offences).toEqual([]);
  });
});

// ---- 负向钉住禁令 ----
// 缺陷只能走 `it.fails` + KD 表；普通 `it` 里"断言坏行为还在"一律违规。
// 机器可判的部分：用例标题带"现状/today/钉住缺陷"这类标记词，却写成普通 `it`。
const NEGATIVE_TITLE = /today|现状|钉住缺陷|仍是坏的|仍然是坏的/iu;

const plainTitlesOf = (file: string): { file: string; line: number; title: string }[] => {
  const lines = readFileSync(file, "utf8").split("\n");
  return lines.flatMap((text, index) => {
    const match = /^\s*it\((?:"([^"]+)"|'([^']+)')/u.exec(text);
    const title = match?.[1] ?? match?.[2];
    return title === undefined ? [] : [{ file: relative(REPO, file), line: index + 1, title }];
  });
};

describe("负向钉住禁令", () => {
  it("should never pin a defect with a plain it(): use it.fails + KD instead", () => {
    const offences = testFilesOf(PACKAGES)
      .flatMap(plainTitlesOf)
      .filter((site) => NEGATIVE_TITLE.test(site.title))
      .map((site) => `${site.file}:${String(site.line)} → ${site.title}`);

    expect(offences).toEqual([]);
  });
});
