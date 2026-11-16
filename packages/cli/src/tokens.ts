// 这层管：argv 的推进式扫描（flag 表 + 取值配对）；不判断语义、不碰 process。

export interface Raw {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

export type Tokenized =
  { readonly ok: true; readonly raw: Raw } | { readonly ok: false; readonly message: string };

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--action",
  "--allow-host",
  "--app-dir",
  "--base-url",
  "--html",
  "--html-file",
  "--id",
  "--inherits-visual",
  "--max-bytes",
  "--model",
  "--name",
  "--out",
  "--port",
  "--visual",
  "--tone",
  "--workspace",
]);

const SWITCH_FLAGS: ReadonlySet<string> = new Set([
  "--force",
  "--html-stdin",
  "--json",
  "--lint",
  "--no-llm",
  "--help",
]);

/** `--flag <value>` 用"待取值"状态配对，避免按下标取值的 `undefined` 分支。 */
export const tokenize = (argv: readonly string[]): Tokenized => {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  let pending: string | undefined;
  for (const token of argv) {
    if (pending !== undefined) {
      values.set(pending, token);
      pending = undefined;
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      pending = token;
      continue;
    }
    if (SWITCH_FLAGS.has(token)) {
      switches.add(token);
      continue;
    }
    if (token.startsWith("-")) {
      return { ok: false, message: `未知参数：${token}` };
    }
    positionals.push(token);
  }
  if (pending !== undefined) {
    return { ok: false, message: `参数 ${pending} 缺少取值` };
  }
  return { ok: true, raw: { values, switches, positionals } };
};

/** `--allow-host`：逗号分隔、去空白、丢空项；空列表视为未设置（`undefined`）。 */
export const allowHostsOf = (raw: Raw): readonly string[] | undefined => {
  const allowRaw = raw.values.get("--allow-host");
  if (allowRaw === undefined) return undefined;
  const hosts = allowRaw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return hosts.length > 0 ? hosts : undefined;
};
