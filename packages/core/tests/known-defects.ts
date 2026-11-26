// 已知缺陷登记表（KD）的机器可读半区：每条负向钉住的用例必须带 `// KD-nn` 标记且在这里有同号条目；
// 表里也不许保留已经没有钉住用例的失效条目。`KNOWN_DEFECTS_CAP` 是只减不增的棘轮。
// 详细叙述留在本地（不入库的缺陷台账）；本文件必须可被公开——每条只用一句英文概述。
// 注意：登记表扫描器按用例调用字面量扫 tests/ 下所有 .ts，本文件的注释不能写出那个调用形式。

export interface KnownDefect {
  /** 钉住该缺陷的用例行内标记（`// KD-nn`）。 */
  readonly id: string;
  /** 一句话英文概述这个已确认、尚未修的缺陷。 */
  readonly summary: string;
}

/** 登记表条数上限（棘轮，只减不增）：加新条目必须先下调它。 */
export const KNOWN_DEFECTS_CAP = 8;

export const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    id: "KD-01",
    summary:
      "Derived model folds NBSP / ideographic space instead of keeping them (only ASCII whitespace may fold).",
  },
  {
    id: "KD-02",
    summary:
      "Derived model does not separate text that follows a folded block subtree (block boundary must behave like <br>).",
  },
  {
    id: "KD-03",
    summary:
      "A latin run split by inline markup is counted per text node, so one word becomes two.",
  },
  {
    id: "KD-04",
    summary: "With several <article> elements the outline sees the last one instead of the first.",
  },
  {
    id: "KD-05",
    summary:
      "Truncation stops at code-point boundaries: it can orphan combining marks and cut ZWJ emoji families.",
  },
  {
    id: "KD-08",
    summary:
      "Auth boundary: the daemon token is reused as the session cookie instead of a random 32-byte session secret.",
  },
  {
    id: "KD-09",
    summary: "Under --json a usage failure emits no JSON envelope on stdout.",
  },
  {
    id: "KD-10",
    summary:
      "An empty --html-stdin is not reported as a usage error (and emits no --json envelope).",
  },
];
