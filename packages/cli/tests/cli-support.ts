// This layer holds real documents and assertion preludes shared by cli tests (stateless); no assertion decisions.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { CliResult } from "./harness";
import { expectNoAnsi } from "./harness";

export const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文</p></article>',
  "</body></html>",
].join("\n");

export const sha = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export const seed = (dir: string, name = "a.html", html = DOC): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

/**
 * Take the first `<tag>`'s `data-hr-id` in the doc: ids only exist **after normalization**, so always read
 * them from the file and never hardcode them in cases — a hardcoded id degrades "content addressing" into
 * golden comparison.
 */
export const idOfTag = (html: string, tag: string): string => {
  const id = new RegExp(`<${tag} data-hr-id="(hr-[0-9a-f]{8})"`, "u").exec(html)?.[1];
  if (id === undefined) throw new Error(`after normalize <${tag}> has no data-hr-id`);
  return id;
};

/** Every subprocess result passes through this: no ANSI, no signal. */
export const checked = (result: CliResult): CliResult => {
  expectNoAnsi(result);
  expect(result.signal).toBeNull();
  return result;
};
