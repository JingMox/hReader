// 这层管：真 Chrome 的长图验收——`--scale` 与 `--max-height` 的口径只在真浏览器里成立。
// 走真 CLI（不 import 渲染器）：要证的正是"仓内各层接起来还能出图"。不进 `test:unit`，跳过判据在调用方。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 从 `--json` 信封里按键取值，避免在脚本里写 `as` 断言。 */
const fieldOf = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

interface Pixels {
  readonly width: number;
  readonly height: number;
}

interface LongImage extends Pixels {
  /** 磁盘上那个 PNG：宽高一律自己从字节里读，不借 CLI 的自报值。 */
  readonly path: string;
  readonly clipped: boolean;
}

/** PNG 签名 8 字节 + IHDR 长/类型 8 字节：宽高在 byte 16–23（大端）。 */
const IHDR_WIDTH_AT = 16;
const IHDR_HEIGHT_AT = 20;

const ihdrOf = (path: string): Pixels => {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(IHDR_WIDTH_AT), height: bytes.readUInt32BE(IHDR_HEIGHT_AT) };
};

const pixelsLineOf = (pixels: Pixels): string => `${String(pixels.width)}×${String(pixels.height)}`;

/** 第二双眼睛：`sips` 是系统解码器，倍率没乘对的产物在这里也会露形。无 `sips`（Linux）时为 `null`。 */
const sipsPixelsOf = (path: string): Pixels | null => {
  try {
    const text = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 60_000,
    });
    const width = /pixelWidth:\s*(\d+)/u.exec(text)?.[1];
    const height = /pixelHeight:\s*(\d+)/u.exec(text)?.[1];
    return width === undefined || height === undefined
      ? null
      : { width: Number(width), height: Number(height) };
  } catch {
    return null;
  }
};

/** `--json` 回包 → 盘上图：宽高是 CLI 自报值，它俩与 IHDR 同不同由 e2e 再断一次。 */
const imageOf = (path: string, stdout: string): LongImage => {
  const data = fieldOf(JSON.parse(stdout), "data");
  const width = fieldOf(data, "width");
  const height = fieldOf(data, "height");
  const clipped = fieldOf(data, "clipped");
  if (typeof width !== "number" || typeof height !== "number" || typeof clipped !== "boolean") {
    throw new Error(`png 的 --json 回包缺宽高/clipped：${stdout.slice(0, 200)}`);
  }
  return { path, width, height, clipped };
};

/**
 * 长图走真 CLI：`--json` 才给 `clipped`，像素以盘上 IHDR 为准；夹具稿与 PDF 那半共用 `source.html`。
 */
const longImageOf = (input: {
  readonly cliMain: string;
  readonly chrome: string;
  readonly dir: string;
  readonly name: string;
  readonly flags: readonly string[];
}): LongImage => {
  const path = join(input.dir, `${input.name}.png`);
  const stdout = execFileSync(
    process.execPath,
    [
      input.cliMain,
      "png",
      "source.html",
      "--out",
      path,
      "--workspace",
      input.dir,
      "--json",
      ...input.flags,
    ],
    {
      cwd: input.dir,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 120_000,
      // `--json` 把整张图的 base64 也交回来：默认 1MB 的 maxBuffer 会在长图上半路 ENOBUFS。
      maxBuffer: 256 * 1024 * 1024,
      // 走 CLI 就要由 CLI 的探测口找 Chrome：`CHROME_BIN` 是脚本自己的跳过判据，不是 CLI 的。
      env: { ...process.env, HREADER_CHROME: input.chrome },
    },
  );
  return imageOf(path, stdout);
};

/** 失败要能自判：CLI 的 stderr 里是带错误码的 envelope，只截头几行，别把整段栈贴进结果。 */
const failureTextOf = (error: unknown): string => {
  const stderr = fieldOf(error, "stderr");
  const message = error instanceof Error ? error.message : String(error);
  return typeof stderr === "string"
    ? `${message}｜stderr: ${stderr.trim().split(/\r?\n/u).slice(0, 3).join(" ")}`
    : message;
};

interface Shots {
  readonly long: LongImage;
  readonly single: LongImage;
  readonly clipped: LongImage;
}

/** 同一篇稿子出三档：`--scale 1` 那档是倍率的对照组（两档只差倍率，其余输入逐字节相同）。 */
const shotsOf = (input: {
  readonly cliMain: string;
  readonly chrome: string;
  readonly dir: string;
}): Shots => ({
  long: longImageOf({ ...input, name: "long", flags: ["--width", "1200", "--scale", "2"] }),
  single: longImageOf({ ...input, name: "single", flags: ["--width", "1200", "--scale", "1"] }),
  clipped: longImageOf({
    ...input,
    name: "clipped",
    flags: ["--width", "1200", "--scale", "2", "--max-height", "2000"],
  }),
});

type Check = (ok: boolean, name: string) => void;

const scaleChecksOf = (check: Check, long: Pixels, single: Pixels): void => {
  check(long.width === 2400, `长图宽不是 2400（IHDR ${pixelsLineOf(long)}）`);
  check(long.height > 4000, `长图不比裁剪高更长（IHDR ${pixelsLineOf(long)}），长图退化成了首屏`);
  // 高若不是严格两倍，就是某个轴没乘 `--scale`：半分辨率的图出得来，只有像素数是证据。
  check(
    long.height === 2 * single.height,
    `--scale 2 的高不是 --scale 1 的两倍（${pixelsLineOf(long)} vs ${pixelsLineOf(single)}）`,
  );
};

/** `--json` 自报的宽高必须与盘上 IHDR 同值：两个真源不一致时，人读行与下游会各说各话。 */
const reportChecksOf = (check: Check, image: LongImage): void => {
  const pixels = ihdrOf(image.path);
  check(
    image.width === pixels.width && image.height === pixels.height,
    `${image.path} 自报 ${String(image.width)}×${String(image.height)} 与 IHDR ${pixelsLineOf(pixels)} 不一致`,
  );
};

export interface LongCheck {
  /** OK 行用的一段；失败时为空。 */
  readonly note: string;
  readonly failures: readonly string[];
}

export const longCheckOf = (input: {
  readonly cliMain: string;
  readonly chrome: string;
  readonly dir: string;
}): LongCheck => {
  const failures: string[] = [];
  const check: Check = (ok, name) => {
    if (!ok) failures.push(name);
  };
  try {
    const shots = shotsOf(input);
    const long = ihdrOf(shots.long.path);
    const clipped = ihdrOf(shots.clipped.path);
    scaleChecksOf(check, long, ihdrOf(shots.single.path));
    check(
      clipped.width === 2400 && clipped.height === 4000,
      `--max-height 2000 没裁成 2400×4000（IHDR ${pixelsLineOf(clipped)}）`,
    );
    check(!shots.long.clipped, "默认 --max-height 20000 被误报 clipped");
    check(shots.clipped.clipped, "--max-height 2000 时 --json 的 clipped 不是 true");
    reportChecksOf(check, shots.long);
    reportChecksOf(check, shots.clipped);
    const sips = sipsPixelsOf(shots.long.path);
    check(
      sips === null || (sips.width === long.width && sips.height === long.height),
      `sips 与 IHDR 不一致（${sips === null ? "无 sips" : pixelsLineOf(sips)} vs ${pixelsLineOf(long)}）`,
    );
    return { note: `长图 ${pixelsLineOf(long)}、裁剪 ${pixelsLineOf(clipped)}`, failures };
  } catch (error) {
    return { note: "", failures: [`长图没出成：${failureTextOf(error)}`] };
  }
};
