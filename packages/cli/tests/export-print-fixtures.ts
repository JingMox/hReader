// 这层管：`hr export` 用例的共享夹具（输入构造 / json 取值 / 4 MiB 量尺）；不做断言。

import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { exportPrintCommand, type ExportPrintInput } from "../src/commands/export-print";

export const LIMIT = 4 * 1024 * 1024;

export const ARTICLE = [
  "<!doctype html><html><head><title>导出样张</title></head><body>",
  '<article data-hr-id="doc">',
  "<h1>导出样张</h1>",
  '<section data-hr-id="s1"><h2>第一节</h2><p>正文一。</p></section>',
  '<section data-hr-id="s2"><h2>第二节</h2><p>正文二。</p>',
  '<img src="https://cdn.example/x.png" alt="外链">',
  "</section>",
  "</article></body></html>",
].join("\n");

type Overrides = Partial<Omit<ExportPrintInput, "workspace">>;

/**
 * `workspace` 不给覆盖口：`writeAtomic` 比的是 realpath，而 macOS 的 `/var` 会解析成 `/private/var`。
 * 文档与落盘都在同一个临时目录里，所以一律取文档所在目录的真实路径。
 */
export const inputOf = (path: string, overrides: Overrides = {}): ExportPrintInput => ({
  path,
  visual: "atelier-editorial",
  out: undefined,
  workspace: realpathSync(dirname(path)),
  json: false,
  force: false,
  warn: () => undefined,
  ...overrides,
});

export const jsonOf = async (input: ExportPrintInput): Promise<unknown> =>
  JSON.parse(await exportPrintCommand(input));

export const dataOf = (envelope: unknown): unknown => Reflect.get(Object(envelope), "data");

export const fieldOfData = (envelope: unknown, key: string): unknown =>
  Reflect.get(Object(dataOf(envelope)), key);

const docWithPadOf = (dir: string, pad: number): string => {
  const path = join(dir, "measure.html");
  writeFileSync(path, `<article><h1>大稿</h1><p>${"a".repeat(pad)}</p></article>`);
  return path;
};

/**
 * 4 MiB 边界按产物**最终字节**判（`>` 才拒），所以先量小稿再补 ASCII 填充。
 * 量尺与正稿必须同名：docId 进产物，换名会把文件名长度的偏移混进差值。
 */
export const writeProductOfBytes = async (dir: string, bytes: number): Promise<string> => {
  const offset = fieldOfData(await jsonOf(inputOf(docWithPadOf(dir, 1), { json: true })), "bytes");
  docWithPadOf(dir, 1 + (bytes - Number(offset)));
  return join(dir, "measure.html");
};
