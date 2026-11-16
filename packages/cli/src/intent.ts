// 这层管：argv 解析的公共类型与四个小工具（失败信封 / 未用 flag / 公共字段 / 绝对路径）；不含具体命令。

import { resolve } from "node:path";
import type { PatchAction } from "@hreader/core";

import type { Raw } from "./tokens";
import type { CommandName } from "./usage";

export type HtmlSource =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };

export type StyleMode =
  | { readonly kind: "visual"; readonly id: string }
  | { readonly kind: "tone"; readonly id: string }
  | { readonly kind: "lint" };

interface Common {
  readonly json: boolean;
  readonly workspace: string;
}

export type Intent =
  | { readonly kind: "help"; readonly topic: CommandName | undefined }
  | ({ readonly kind: "outline"; readonly path: string } & Common)
  | ({
      readonly kind: "read";
      readonly path: string;
      readonly target: string;
      readonly maxBytes: number | undefined;
    } & Common)
  | ({
      readonly kind: "patch";
      readonly path: string;
      readonly nodeId: string;
      readonly action: PatchAction;
      readonly html: HtmlSource | undefined;
    } & Common)
  | ({ readonly kind: "style"; readonly path: string; readonly mode: StyleMode } & Common)
  | ({
      readonly kind: "styleExtract";
      /** 语料文件（绝对路径）；顺序即 argv 顺序，统计层对顺序不敏感但报告里要能复现。 */
      readonly files: readonly string[];
      readonly id: string;
      readonly name: string;
      /** 是否由文件名 slug 兜底：`run.ts` 据此在 stderr 说明"用了默认值"（D10）。 */
      readonly idGiven: boolean;
      readonly nameGiven: boolean;
      readonly out: string | undefined;
      readonly inheritsVisual: string;
      readonly noLlm: boolean;
      readonly force: boolean;
    } & Common)
  | ({ readonly kind: "undo"; readonly path: string } & Common)
  | ({
      readonly kind: "serve";
      readonly path: string;
      readonly port: number;
      readonly allowHosts: readonly string[] | undefined;
      /** 显式 `--app-dir` 的绝对路径；未给就是 `undefined`（让 core 走 M2.1 的 200 兜底）。 */
      readonly appDir: string | undefined;
      /** 用户是否显式给了 `--app-dir`：`run.ts` 据此决定"目录不存在就 exit 2"。 */
      readonly appDirGiven: boolean;
    } & Common);

export type ParsedArgs =
  | { readonly ok: true; readonly intent: Intent }
  | {
      readonly ok: false;
      readonly message: string;
      readonly topic: CommandName | undefined;
    };

export const failure = (message: string, topic: CommandName | undefined): ParsedArgs => ({
  ok: false,
  message,
  topic,
});

export const unusedFlag = (raw: Raw, allowed: readonly string[]): string | undefined => {
  for (const name of raw.values.keys()) {
    if (!allowed.includes(name)) return name;
  }
  for (const name of raw.switches) {
    if (!allowed.includes(name)) return name;
  }
  return undefined;
};

export const commonOf = (raw: Raw, cwd: string): Common => ({
  json: raw.switches.has("--json"),
  workspace: resolve(cwd, raw.values.get("--workspace") ?? cwd),
});

/** 路径一律先按 cwd 解成绝对路径；写命令到 workspace 的相对换算在 `run.ts`（那里能取真实路径）。 */
export const absoluteOf = (file: string, cwd: string): string => resolve(cwd, file);
