// 这层管：cli 测试共享的真文档与断言前置（无状态）；不做断言决策。

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

/** 所有子进程结果都过一遍：无 ANSI、无 signal。 */
export const checked = (result: CliResult): CliResult => {
  expectNoAnsi(result);
  expect(result.signal).toBeNull();
  return result;
};
