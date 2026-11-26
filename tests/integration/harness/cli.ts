// 这层管：`hr` 真二进制的执行封装（dist/cli.mjs，不是 src——旅程测的就是打包产物）。

import { join } from "node:path";

import { assert, assertEq, parseJson } from "./check.ts";
import { CLI_BIN } from "./env.ts";
import { run, type RunOptions, type RunResult } from "./proc.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export const hr = (args: readonly string[], options: RunOptions = {}): Promise<RunResult> =>
  run(process.execPath, [CLI_BIN, ...args], options);

/** `--json` 契约：恰好一行、可解析、`ok` 布尔。 */
export const jsonOf = (result: RunResult, label: string): JsonObject => {
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  assertEq(lines.length, 1, `${label}：--json 的 stdout 行数`);
  const parsed = parseJson(lines[0] ?? "", label);
  assert(
    typeof parsed === "object" && parsed !== null && typeof Reflect.get(parsed, "ok") === "boolean",
    `${label}：--json 输出缺 ok 字段`,
  );
  return parsed as JsonObject;
};

export const dataOf = (result: RunResult, label: string): JsonObject => {
  const body = jsonOf(result, label);
  assert(body["ok"] === true, `${label}：命令失败 ${JSON.stringify(body)}`);
  const data = body["data"];
  assert(typeof data === "object" && data !== null, `${label}：data 不是对象`);
  return data as JsonObject;
};

export const errorOf = (result: RunResult, label: string): { readonly code: string } => {
  const body = jsonOf(result, label);
  assert(body["ok"] === false, `${label}：预期失败却成功 ${JSON.stringify(body)}`);
  const code = body["code"];
  assert(typeof code === "string", `${label}：错误体缺 code`);
  return { code };
};

/** 新建托管文档（旅程的固定第一步）：回 `hr new` 的 data + 落盘字节。 */
export const newDoc = async (
  ws: string,
  name: string,
  extra: readonly string[] = [],
): Promise<JsonObject> => {
  const result = await hr(["new", name, "--workspace", ws, "--json", ...extra], { cwd: ws });
  assertEq(result.code, 0, `hr new ${name} 退出码`);
  return dataOf(result, `hr new ${name}`);
};

export const docPath = (ws: string, name: string): string => join(ws, name);
