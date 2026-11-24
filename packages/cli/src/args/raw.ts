// 这层管：基于 node:util parseArgs 的 argv 词法扫描与参数表校验；不判断子命令语义、不碰 process。

import { parseArgs as parseNodeArgs, type ParseArgsOptionDescriptor } from "node:util";

export interface Raw {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly allowHosts: readonly string[];
  readonly positionals: readonly string[];
}

type Tokenized =
  { readonly ok: true; readonly raw: Raw } | { readonly ok: false; readonly message: string };

const OPTION_SPECS = {
  action: { type: "string" },
  "allow-host": { type: "string", multiple: true },
  "app-dir": { type: "string" },
  "base-url": { type: "string" },
  home: { type: "string" },
  html: { type: "string" },
  "html-file": { type: "string" },
  id: { type: "string" },
  "inherits-visual": { type: "string" },
  kind: { type: "string" },
  "max-bytes": { type: "string" },
  "max-height": { type: "string" },
  model: { type: "string" },
  name: { type: "string" },
  out: { type: "string" },
  "page-size": { type: "string" },
  scale: { type: "string" },
  port: { type: "string" },
  visual: { type: "string" },
  tone: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  width: { type: "string" },
  workspace: { type: "string" },
  "exit-with-parent": { type: "boolean" },
  force: { type: "boolean" },
  "html-stdin": { type: "boolean" },
  json: { type: "boolean" },
  lint: { type: "boolean" },
  "no-llm": { type: "boolean" },
  "no-outline": { type: "boolean" },
  outline: { type: "boolean" },
  help: { type: "boolean" },
  write: { type: "boolean" },
} satisfies Record<string, ParseArgsOptionDescriptor>;

const SPECS = new Map<string, ParseArgsOptionDescriptor>(Object.entries(OPTION_SPECS));

/**
 * 用 strict: false + tokens: true 让 node:util 处理 `--flag=val` 与 `--` 结束符，
 * 再由本函数统一给出中文错误并保留 `--html --help` / 负数参数等既有词法行为。
 */
export const tokenize = (argv: readonly string[]): Tokenized => {
  const { tokens, positionals } = parseNodeArgs({
    args: argv,
    options: OPTION_SPECS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const allowHosts: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const spec = SPECS.get(token.name);
    if (spec === undefined) {
      return { ok: false, message: `未知参数：${token.rawName}` };
    }
    const flag = `--${token.name}`;
    if (spec.type === "string") {
      if (token.value === undefined) {
        return { ok: false, message: `参数 ${token.rawName} 缺少取值` };
      }
      values.set(flag, token.value);
      if (token.name === "allow-host") allowHosts.push(token.value);
      continue;
    }
    if (token.value !== undefined) {
      return { ok: false, message: `参数 ${token.rawName} 不接受取值` };
    }
    switches.add(flag);
  }
  return { ok: true, raw: { values, switches, allowHosts, positionals } };
};

/** `--allow-host` 支持重复传参与逗号分隔：逐项切分、去空白、丢空项；全空视为未设置。 */
export const allowHostsOf = (raw: Raw): readonly string[] | undefined => {
  if (raw.allowHosts.length === 0) return undefined;
  const hosts = raw.allowHosts
    .flatMap((entry) => entry.split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return hosts.length > 0 ? hosts : undefined;
};
