// `puppeteer-core` 的 types.d.ts 引用这些 DOM 全局名；根 tsconfig 的 lib 只有 ES2023
// （`skipLibCheck: false` 是仓库门禁，不能动）。这只是类型占位——适配层用到的
// connect/pdf/screenshot/setViewport/createCDPSession 签名里都不出现它们，
// 值空间不受影响，CLI 里照样不能写 `document`/`window`。
type Element = unknown;
type Node = unknown;
type HTMLFormElement = Element;
type HTMLIFrameElement = Element;
type HTMLInputElement = Element;
type HTMLScriptElement = Element;
type HTMLStyleElement = Element;
type HTMLElementTagNameMap = Record<string, Element>;
type SVGElementTagNameMap = Record<string, Element>;
