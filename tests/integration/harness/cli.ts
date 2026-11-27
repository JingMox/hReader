// This layer owns: the execution wrapper for the real `hr` binary
// (dist/cli.mjs, not src — journeys test the packaged artifact).

import { join } from "node:path";

import { assert, assertEq, parseJson } from "./check.ts";
import { CLI_BIN } from "./env.ts";
import { run, type RunOptions, type RunResult } from "./proc.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export const hr = (args: readonly string[], options: RunOptions = {}): Promise<RunResult> =>
  run(process.execPath, [CLI_BIN, ...args], options);

/** The `--json` contract: exactly one line, parseable, boolean `ok`. */
export const jsonOf = (result: RunResult, label: string): JsonObject => {
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  assertEq(lines.length, 1, `${label}: --json stdout line count`);
  const parsed = parseJson(lines[0] ?? "", label);
  assert(
    typeof parsed === "object" && parsed !== null && typeof Reflect.get(parsed, "ok") === "boolean",
    `${label}: --json output is missing the ok field`,
  );
  return parsed as JsonObject;
};

export const dataOf = (result: RunResult, label: string): JsonObject => {
  const body = jsonOf(result, label);
  assert(body["ok"] === true, `${label}: command failed ${JSON.stringify(body)}`);
  const data = body["data"];
  assert(typeof data === "object" && data !== null, `${label}: data is not an object`);
  return data as JsonObject;
};

export const errorOf = (result: RunResult, label: string): { readonly code: string } => {
  const body = jsonOf(result, label);
  assert(
    body["ok"] === false,
    `${label}: expected failure but it succeeded ${JSON.stringify(body)}`,
  );
  const code = body["code"];
  assert(typeof code === "string", `${label}: error body is missing code`);
  return { code };
};

/** Create a managed document (the fixed first step of a journey): returns `hr new`'s data + the on-disk bytes. */
export const newDoc = async (
  ws: string,
  name: string,
  extra: readonly string[] = [],
): Promise<JsonObject> => {
  const result = await hr(["new", name, "--workspace", ws, "--json", ...extra], { cwd: ws });
  assertEq(result.code, 0, `hr new ${name} exit code`);
  return dataOf(result, `hr new ${name}`);
};

export const docPath = (ws: string, name: string): string => join(ws, name);
