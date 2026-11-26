// `puppeteer-core`'s types.d.ts references these DOM globals; the root tsconfig's lib is ES2023 only
// (`skipLibCheck: false` is a repo gate and stays). These are type placeholders only — they never
// appear in the connect/pdf/screenshot/setViewport/createCDPSession signatures the adapter uses,
// so the value space is untouched and the CLI still cannot reference `document`/`window`.
type Element = unknown;
type Node = unknown;
type HTMLFormElement = Element;
type HTMLIFrameElement = Element;
type HTMLInputElement = Element;
type HTMLScriptElement = Element;
type HTMLStyleElement = Element;
type HTMLElementTagNameMap = Record<string, Element>;
type SVGElementTagNameMap = Record<string, Element>;
