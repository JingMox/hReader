// This layer: builtin 模板清单（D11：由 TS 数据模块提供，运行时不读文件系统）。
// 5 个 managed 形态模板（骨架来自 `newDocumentHtml`，CSS 内嵌自 styles/<visual>/theme.css）
// + 1 个 `blank-html`（自由 HTML）。纯数据装配，无 IO。

import { newDocumentHtml } from "../../layout/kinds";
import type { TemplateManifest } from "../contracts";
import { GUIDES, BLANK_HTML_GUIDE } from "./guides";
import { THEME_CSS } from "./theme-css";

/** 内置模板的内存形态：manifest + 成员文本（assets 一律为空；三个成员都随模板发布）。 */
export interface BuiltinTemplate {
  readonly manifest: TemplateManifest;
  readonly entry: string;
  readonly style: string;
  readonly guide: string;
}

/** 模板自带的占位标题：`createFromTemplate` 统一替换 `<title>` 与首个 `<h1>`。 */
const PLACEHOLDER_TITLE = "Untitled";

const manifest = (input: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly format: "html" | "managed";
  readonly tags: readonly string[];
}): TemplateManifest => ({ ...input, version: 1 });

const kindTemplate = (
  id: "note" | "report" | "minutes" | "brief" | "slides",
  name: string,
  description: string,
  visualId: "atelier-editorial" | "deck-noir",
): BuiltinTemplate => ({
  manifest: manifest({
    id,
    name,
    description,
    format: "managed",
    tags: ["doc-kind"],
  }),
  entry: newDocumentHtml({ kind: id, title: PLACEHOLDER_TITLE }),
  style: THEME_CSS[visualId],
  guide: GUIDES[id],
});

const BLANK_HTML_ENTRY = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PLACEHOLDER_TITLE}</title>
</head>
<body>
<main>
<h1>${PLACEHOLDER_TITLE}</h1>
<p>Lead paragraph: one sentence that carries the whole page.</p>
<section>
<h2>Section</h2>
<p>Content.</p>
</section>
</main>
</body>
</html>
`;

const BLANK_HTML_STYLE = `/* Neutral starter stylesheet for free-form HTML: system fonts, readable measure, generous line height. */
body {
  margin: 0;
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 1rem;
  line-height: 1.7;
  color: #1d1d1f;
  background: #ffffff;
}

main {
  max-width: 42rem;
  margin: 0 auto;
  padding: 2.5rem 1rem;
}
`;

/** 顺序即 list 输出序（同 id 下用户级/工作区级覆盖，见 service.ts）。 */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  kindTemplate(
    "note",
    "Note",
    "One-section note: conclusion first, then expansion.",
    "atelier-editorial",
  ),
  kindTemplate(
    "report",
    "Report",
    "Full report: conclusion, evidence, comparison, risks, actions.",
    "atelier-editorial",
  ),
  kindTemplate(
    "minutes",
    "Meeting minutes",
    "Decisions, discussion, action items, transcript.",
    "atelier-editorial",
  ),
  kindTemplate(
    "brief",
    "Decision brief",
    "One page: recommendation, evidence, cost, next steps.",
    "atelier-editorial",
  ),
  kindTemplate(
    "slides",
    "Slide deck",
    "One section per 16:9 page; h1 is the title page.",
    "deck-noir",
  ),
  {
    manifest: manifest({
      id: "blank-html",
      name: "Blank HTML",
      description: "Clean semantic HTML5 skeleton: free structure, neutral starter stylesheet.",
      format: "html",
      tags: ["starter"],
    }),
    entry: BLANK_HTML_ENTRY,
    style: BLANK_HTML_STYLE,
    guide: BLANK_HTML_GUIDE,
  },
];
