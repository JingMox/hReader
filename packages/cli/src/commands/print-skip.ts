// This layer: whether `test:e2e` skips, why, and the text of that notice line; no fs probing, no process exit.

export type ChromeEnv = Readonly<Record<string, string | undefined>>;

const SKIP_ENV = "HREADER_SKIP_CHROME";
const CHROME_VAR = "CHROME_BIN";

/**
 * `null` = run for real. Three states: explicitly skipped / no usable Chrome / normal.
 * Probing Chrome's existence is the caller's job (the script has fs, this layer does not); the result arrives
 * via `CHROME_BIN`: empty string and absent both mean "probed, nothing found".
 */
export const skipReasonOf = (env: ChromeEnv): string | null => {
  if (env[SKIP_ENV] === "1") return `${SKIP_ENV}=1（显式跳过）`;
  const chrome = env[CHROME_VAR];
  if (chrome === undefined || chrome === "") return "找不到 Chrome（设 CHROME_BIN 指向可执行文件）";
  return null;
};

/** A skip must leave with a non-zero signal: silently skipping looks like passing, so this line must state the reason. */
export const skipLineOf = (reason: string): string => `SKIPPED: ${reason}\n`;
