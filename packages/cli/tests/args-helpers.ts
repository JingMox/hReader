// 这层管：`parseArgs` 表的共享夹具（parse / expectFailure / CWD）；不做断言。

import { expect } from "vitest";

import { parseArgs } from "../src/args";

export const CWD = "/repo";

/** 顶层缺命令时的清单串：命令一多就会长到被 prettier 折行，抽出来免得把用例撑爆限行。 */
export const COMMAND_LIST_HINT =
  "缺少命令：new | normalize | outline | read | patch | check | style | undo | export | pdf | png | serve";

export const parse = (argv: readonly string[], cwd: string = CWD) => parseArgs(argv, cwd);

/**
 * 失败信封**恒定**是 `{ ok:false, message, topic }`：`parseArgs` 的类型里没有 json，
 * "错误也要带 --json"由 `run.ts` 依据 argv 自己决定（见 units-run 的用例）。
 * 所以这里只断"信封里恰好是这三个字段"。
 */
export const expectFailure = (
  argv: readonly string[],
  message: string,
  topic: string | undefined,
): void => {
  expect(parse(argv)).toEqual({ ok: false, message, topic });
};
