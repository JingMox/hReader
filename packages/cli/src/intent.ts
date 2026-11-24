// 这层管：argv 解析的公共类型与四个小工具（失败信封 / 未用 flag / 公共字段 / 绝对路径）；不含具体命令。

import { resolve } from "node:path";
import type { DocKind, PatchAction } from "@hreader/core";

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
      readonly kind: "normalize";
      readonly path: string;
      /** 缺省 `false`：不写盘，只把规范化结果交给调用方。 */
      readonly write: boolean;
    } & Common)
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
      /** `--model` / `--base-url`：显式覆盖 env 的默认值；`undefined` = 没给，交给 `llm/session`。 */
      readonly model: string | undefined;
      readonly baseUrl: string | undefined;
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "export";
      readonly path: string;
      readonly visual: string;
      /** 打印稿落盘位置（绝对路径）；`undefined` = 打 stdout。 */
      readonly out: string | undefined;
      /** `--out` 已存在时是否覆盖（缺省 `file_exists`）。 */
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "pdf";
      readonly path: string;
      /** 原样保留：合法性在命令层判（非法值是 `invalid_input` exit 1，不是用法错误 exit 2）。 */
      readonly pageSize: string;
      readonly timeoutMs: number;
      /** 大纲默认开（`--outline` 缺省即开），`--no-outline` 置 false。 */
      readonly outline: boolean;
      /** 两个大纲旗标同传：用法层只分得清“给没给”，互斥是语义错误（命令层报 `invalid_input`）。 */
      readonly outlineConflict: boolean;
      /** `--out` 必填（写文件是这条命令的唯一产物）。 */
      readonly out: string;
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "png";
      readonly path: string;
      /** 三处尺寸都是原样字符串：合法性在命令层判（`invalid_input` exit 1）。 */
      readonly width: string;
      readonly scale: string;
      /** CSS 像素上限：超出先裁（不缩），并在结果里置 `clipped`。 */
      readonly maxHeight: string;
      /** 用户是否显式传了 `--max-height`：没传就不拿默认值做最坏面积预检。 */
      readonly maxHeightExplicit: boolean;
      /** 命中的大纲旗标原文（`--outline`/`--no-outline`）：PNG 没有大纲，命令层据此报 `invalid_input`。 */
      readonly outlineFlag: string | undefined;
      readonly timeoutMs: number;
      readonly out: string;
      readonly force: boolean;
    } & Common)
  | ({ readonly kind: "undo"; readonly path: string } & Common)
  | ({ readonly kind: "check"; readonly path: string } & Common)
  | ({
      readonly kind: "new";
      readonly path: string;
      readonly docKind: DocKind;
      readonly title: string;
      readonly visual: string;
      /** `<file>` 已存在时是否覆盖（缺省 `file_exists`）。 */
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "serve";
      readonly path: string;
      readonly port: number;
      readonly allowHosts: readonly string[] | undefined;
      /** 显式 `--app-dir` 的绝对路径；未给就是 `undefined`（让 core 走 M2.1 的 200 兜底）。 */
      readonly appDir: string | undefined;
      /** 用户是否显式给了 `--app-dir`：`run.ts` 据此决定"目录不存在就 exit 2"。 */
      readonly appDirGiven: boolean;
      /** `--home` 的绝对路径；`undefined` = 走 `homedir()`（默认行为不变）。 */
      readonly home: string | undefined;
      /** `--exit-with-parent`：父进程（壳）消失就自杀；默认 false，用户自己起的 daemon 行为不变。 */
      readonly exitWithParent: boolean;
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
