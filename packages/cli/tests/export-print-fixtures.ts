// This layer holds shared fixtures for `hr export` cases (input construction / json field reads / the 4 MiB measuring stick); no assertions.

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
 * `workspace` takes no override: `writeAtomic` compares realpaths and macOS `/var` resolves to `/private/var`.
 * Doc and output live in the same temp dir, so always take the real path of the doc's directory.
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
 * The 4 MiB boundary is judged on the artifact's **final byte count** (rejects only `>`), so measure the small
 * draft first, then pad with ASCII. Ruler and real draft must share the name: docId enters the artifact, and
 * a different name would mix filename-length offset into the delta.
 */
export const writeProductOfBytes = async (dir: string, bytes: number): Promise<string> => {
  const offset = fieldOfData(await jsonOf(inputOf(docWithPadOf(dir, 1), { json: true })), "bytes");
  docWithPadOf(dir, 1 + (bytes - Number(offset)));
  return join(dir, "measure.html");
};
