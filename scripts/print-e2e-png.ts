// Full-page-image acceptance in real Chrome — the `--scale`/`--max-height` semantics only hold in
// a real browser. Goes through the real CLI (no renderer import): what must be proven is exactly
// "the repo's layers still produce an image when wired together". Not part of `test:unit`; the
// skip decision lives at the call site.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads a key out of the `--json` envelope, avoiding `as` assertions in the script. */
const fieldOf = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

interface Pixels {
  readonly width: number;
  readonly height: number;
}

interface LongImage extends Pixels {
  /** The PNG on disk: width/height are read from bytes directly, never borrowed from the CLI's self-report. */
  readonly path: string;
  readonly clipped: boolean;
}

/** PNG signature 8 bytes + IHDR length/type 8 bytes: width/height live at bytes 16–23 (big-endian). */
const IHDR_WIDTH_AT = 16;
const IHDR_HEIGHT_AT = 20;

const ihdrOf = (path: string): Pixels => {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(IHDR_WIDTH_AT), height: bytes.readUInt32BE(IHDR_HEIGHT_AT) };
};

const pixelsLineOf = (pixels: Pixels): string => `${String(pixels.width)}×${String(pixels.height)}`;

/** A second pair of eyes: `sips` is the system decoder, and a wrongly-scaled artifact shows here too. `null` where `sips` is absent (Linux). */
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

/** `--json` reply → on-disk image: width/height are CLI self-reports; whether they match IHDR is decided once more in e2e. */
const imageOf = (path: string, stdout: string): LongImage => {
  const data = fieldOf(JSON.parse(stdout), "data");
  const width = fieldOf(data, "width");
  const height = fieldOf(data, "height");
  const clipped = fieldOf(data, "clipped");
  if (typeof width !== "number" || typeof height !== "number" || typeof clipped !== "boolean") {
    throw new Error(`png --json reply lacks width/height/clipped: ${stdout.slice(0, 200)}`);
  }
  return { path, width, height, clipped };
};

/**
 * Long image via the real CLI: only `--json` yields `clipped`; pixels are authoritative from the
 * on-disk IHDR. The fixture page shares `source.html` with the PDF half.
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
      // `--json` also returns the whole image's base64: the default 1MB maxBuffer would ENOBUFS
      // halfway through a long image.
      maxBuffer: 256 * 1024 * 1024,
      // Going through the CLI means finding Chrome via the CLI's probe: `CHROME_BIN` is the
      // script's own skip criterion, not the CLI's.
      env: { ...process.env, HREADER_CHROME: input.chrome },
    },
  );
  return imageOf(path, stdout);
};

/** A failure must self-diagnose: the CLI's stderr carries an envelope with the error code — take only its head, do not paste the whole stack into results. */
const failureTextOf = (error: unknown): string => {
  const stderr = fieldOf(error, "stderr");
  const message = error instanceof Error ? error.message : String(error);
  return typeof stderr === "string"
    ? `${message} | stderr: ${stderr.trim().split(/\r?\n/u).slice(0, 3).join(" ")}`
    : message;
};

interface Shots {
  readonly long: LongImage;
  readonly single: LongImage;
  readonly clipped: LongImage;
}

/** Three runs of one page: the `--scale 1` run is the scale control (the two runs differ only in scale, every other input byte-identical). */
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
  check(long.width === 2400, `long image width is not 2400 (IHDR ${pixelsLineOf(long)})`);
  check(
    long.height > 4000,
    `long image is no taller than the clip height (IHDR ${pixelsLineOf(long)}); it degenerated to the first screen`,
  );
  // If the height is not exactly double, some axis missed `--scale`: a half-resolution image still renders — only pixel counts prove it.
  check(
    long.height === 2 * single.height,
    `--scale 2 height is not 2x --scale 1 (${pixelsLineOf(long)} vs ${pixelsLineOf(single)})`,
  );
};

/** The `--json` self-reported width/height must equal the on-disk IHDR: when the two sources disagree, the human-readable line and downstream would tell different stories. */
const reportChecksOf = (check: Check, image: LongImage): void => {
  const pixels = ihdrOf(image.path);
  check(
    image.width === pixels.width && image.height === pixels.height,
    `${image.path} reports ${String(image.width)}×${String(image.height)}, which disagrees with IHDR ${pixelsLineOf(pixels)}`,
  );
};

export interface LongCheck {
  /** The segment used in the OK line; empty on failure. */
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
      `--max-height 2000 did not clip to 2400×4000 (IHDR ${pixelsLineOf(clipped)})`,
    );
    check(!shots.long.clipped, "default --max-height 20000 wrongly reports clipped");
    check(shots.clipped.clipped, "--json clipped is not true with --max-height 2000");
    reportChecksOf(check, shots.long);
    reportChecksOf(check, shots.clipped);
    const sips = sipsPixelsOf(shots.long.path);
    check(
      sips === null || (sips.width === long.width && sips.height === long.height),
      `sips disagrees with IHDR (${sips === null ? "no sips" : pixelsLineOf(sips)} vs ${pixelsLineOf(long)})`,
    );
    return { note: `long ${pixelsLineOf(long)}, clipped ${pixelsLineOf(clipped)}`, failures };
  } catch (error) {
    return { note: "", failures: [`long image not produced: ${failureTextOf(error)}`] };
  }
};
