// 这层管：`test:e2e` 要不要跳过、为什么、以及那行提示的文本；不探测 fs、不退出进程。

export type ChromeEnv = Readonly<Record<string, string | undefined>>;

const SKIP_ENV = "HREADER_SKIP_CHROME";
const CHROME_VAR = "CHROME_BIN";

/**
 * `null` = 可以真跑。三态：显式跳过 / 没有可用的 Chrome / 正常。
 * 探测 Chrome 存在与否是调用方的事（脚本有 fs，这层没有），结果经 `CHROME_BIN` 传进来：
 * 空串与缺席同义，都表示"探测过了，没有"。
 */
export const skipReasonOf = (env: ChromeEnv): string | null => {
  if (env[SKIP_ENV] === "1") return `${SKIP_ENV}=1（显式跳过）`;
  const chrome = env[CHROME_VAR];
  if (chrome === undefined || chrome === "") return "找不到 Chrome（设 CHROME_BIN 指向可执行文件）";
  return null;
};

/** 跳过必须以非 0 信息出门：静默跳过等于假装跑过（§13），所以这行不许省掉原因。 */
export const skipLineOf = (reason: string): string => `SKIPPED: ${reason}\n`;
