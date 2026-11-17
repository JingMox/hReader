// 这层管：`@hreader/renderer-html` 的公开出口（只放打印稿渲染面）；不承载实现。

export { printHtmlOf, printHtmlReportOf } from "./print-html";
export type { PrintHtmlInput, PrintHtmlResult } from "./print-html";
export { PRINT_CSS } from "./print-css";
export type { PaperSize } from "./print-css";
export { THEMES } from "./styles/atelier-editorial";
export type { VisualTheme } from "./styles/atelier-editorial";
