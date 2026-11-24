// 这层管：`hr new` / `hr check` 的结果 → 人读文本 / 单行 JSON；不做 IO、不判断退出码。
// 从 `output.ts` 拆出来只为守住 `max-lines: 300`，契约（单行、键序固定）与那边一致。

/** `Diagnostic` 不在 core 的公开面单列 `path` 之外的形状；这里用结构类型，与 `output.ts` 同一取舍。 */
interface IssueShape {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly path?: string;
}

interface NewDocReport {
  readonly path: string;
  readonly kind: string;
  readonly title: string;
  readonly bytes: number;
}

/** `path` 键恒在（没有定位时为 `null`）：`--json` 的形状不随诊断种类变。 */
const issueJson = (issue: IssueShape): string =>
  JSON.stringify({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    path: issue.path ?? null,
  });

export const dataCheck = (issues: readonly IssueShape[]): string =>
  `{"issues":[${issues.map(issueJson).join(",")}],"count":${String(issues.length)}}`;

const issueLine = (issue: IssueShape): string =>
  `${issue.severity}: ${issue.code} — ${issue.message}${issue.path === undefined ? "" : ` @ ${issue.path}`}\n`;

/** 没问题也要有一行：0 字节 stdout 读起来像“没跑”。 */
export const humanCheck = (issues: readonly IssueShape[], path: string): string =>
  issues.length === 0
    ? `ok ${path}（没有排版问题）\n`
    : `${issues.map(issueLine).join("")}${path}：${String(issues.length)} 条问题\n`;

export const dataNew = (report: NewDocReport): string =>
  JSON.stringify({
    path: report.path,
    kind: report.kind,
    title: report.title,
    bytes: report.bytes,
  });

export const humanNew = (report: NewDocReport, path: string): string =>
  `created ${path} (${report.kind}, ${String(report.bytes)} bytes)\n`;
