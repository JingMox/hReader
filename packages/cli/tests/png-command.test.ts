// 这层管：`pngCommand` 的进程内行为（键集 / IHDR 校验 / 落盘 / 失败零残留）；渲染由假 render 注入，不起 Chrome。
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import type { LongImage } from "../src/chrome/types";
import { pngCommand, type PngCommandInput } from "../src/commands/png";
import { pngOf } from "./chrome-helpers";
import { fieldOf, keysOf, withTempDir } from "./harness";

const DOC = "<html><body><article><h1>标题</h1><p>正文</p></article></body></html>";

const withRealDir = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    await run(realpathSync(raw));
  });

const withDocOf = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withRealDir(async (dir) => {
    writeFileSync(join(dir, "doc.html"), DOC);
    await run(dir);
  });

const imageOf = (width = 2400, height = 1800, clipped = false): LongImage => ({
  bytes: pngOf(width, height),
  width,
  height,
  clipped,
});

const defaultsOf = (dir: string): PngCommandInput => ({
  path: join(dir, "doc.html"),
  width: "1200",
  scale: "2",
  maxHeight: "20000",
  maxHeightExplicit: false,
  outlineFlag: undefined,
  timeoutMs: 60_000,
  out: join(dir, "out.png"),
  force: false,
  workspace: dir,
  json: false,
  warn: () => undefined,
  render: () => Promise.resolve(imageOf()),
});

const inputOf = (dir: string, overrides: Partial<PngCommandInput> = {}): PngCommandInput => ({
  ...defaultsOf(dir),
  ...overrides,
});

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

const dataFieldOf = (text: string): ((key: string) => unknown) => {
  const envelope: unknown = JSON.parse(text);
  const data = fieldOf(envelope, "data");
  return (key) => fieldOf(data, key);
};

const ihdrOf = (bytes: Uint8Array): { width: number; height: number; depth: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), depth: view.getUint8(24) };
};

describe("pngCommand · --json 键集", () => {
  it("只含 png/bytes/width/height/clipped/out 六个键", async () => {
    await withDocOf(async (dir) => {
      const envelope: unknown = JSON.parse(await pngCommand(inputOf(dir, { json: true })));
      expect(keysOf(envelope)).toEqual(["ok", "data"]);
      expect(keysOf(fieldOf(envelope, "data"))).toEqual([
        "png",
        "bytes",
        "width",
        "height",
        "clipped",
        "out",
      ]);
    });
  });

  it("落盘字节的 IHDR 与报出的宽高一致", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.png");
      const field = dataFieldOf(await pngCommand(inputOf(dir, { json: true, out })));
      expect(field("bytes")).toBe(statSync(out).size);
      expect(field("out")).toBe(out);
      expect(Buffer.from(String(field("png")), "base64")).toEqual(readFileSync(out));
      expect(ihdrOf(readFileSync(out))).toEqual({ width: 2400, height: 1800, depth: 8 });
    });
  });
});

describe("pngCommand · clipped 三态与人读行", () => {
  it.each([
    [false, "2400×1800"],
    [true, "2400×1800, clipped"],
  ] as const)("clipped=%s 的人读行", async (clipped, expected) => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.png");
      const text = await pngCommand(
        inputOf(dir, { out, render: () => Promise.resolve(imageOf(2400, 1800, clipped)) }),
      );
      expect(text).toBe(`exported ${out} (${String(statSync(out).size)} bytes, ${expected})\n`);
    });
  });

  it("--json 的 clipped 原样透传", async () => {
    await withDocOf(async (dir) => {
      const text = await pngCommand(
        inputOf(dir, { json: true, render: () => Promise.resolve(imageOf(2400, 18_000, true)) }),
      );
      const field = dataFieldOf(text);
      expect([field("clipped"), field("width"), field("height")]).toEqual([true, 2400, 18_000]);
    });
  });
});

describe("pngCommand · 渲染入参", () => {
  it("把 --width/--scale/--max-height/--timeout 与打印稿 HTML 一起交给渲染层", async () => {
    await withDocOf(async (dir) => {
      const seen: { html: string; width: number; scale: number; maxHeight: number; s: number }[] =
        [];
      await pngCommand(
        inputOf(dir, {
          width: "640",
          scale: "3",
          maxHeight: "5000",
          timeoutMs: 1500,
          render: (input) => {
            seen.push({
              html: input.html,
              width: input.width,
              scale: input.scale,
              maxHeight: input.maxHeight,
              s: input.timeoutMs,
            });
            return Promise.resolve(imageOf(1920, 3000));
          },
        }),
      );
      expect(seen[0]).toMatchObject({ width: 640, scale: 3, maxHeight: 5000, s: 1500 });
      expect(seen[0]?.html).toContain("标题");
    });
  });
});

describe("pngCommand · 尺寸越界（exit 1）", () => {
  it.each([
    ["--width", "255", "256..4096"],
    ["--width", "4097", "256..4096"],
    ["--width", "12.5", "256..4096"],
    ["--scale", "0", "1..3"],
    ["--scale", "4", "1..3"],
    ["--max-height", "999", "1000..50000"],
    ["--max-height", "50001", "1000..50000"],
  ])("%s → invalid_input，且不渲染", async (flag, value, range) => {
    await withDocOf(async (dir) => {
      const overrides = {
        "--width": { width: value },
        "--scale": { scale: value },
        "--max-height": { maxHeight: value },
      }[flag];
      let rendered = false;
      const render = (): Promise<LongImage> => {
        rendered = true;
        return Promise.resolve(imageOf());
      };
      const error = await failureOf(pngCommand(inputOf(dir, { ...overrides, render })));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain(`${flag} 必须是 ${range} 的整数：${value}`);
      expect(rendered).toBe(false);
    });
  });
});

describe("pngCommand · 大纲旗标", () => {
  it.each(["--outline", "--no-outline"])(
    "%s 报 invalid_input（PNG 没有大纲），不渲染不落盘",
    (flag) =>
      withDocOf(async (dir) => {
        const out = join(dir, "out.png");
        const error = await failureOf(
          pngCommand(
            inputOf(dir, {
              out,
              outlineFlag: flag,
              // 真去渲染就会以别的错误码红掉：这行既是“不许渲染”，也保证落盘闸门没走到。
              render: () => Promise.reject(new Error("PNG 不该渲染")),
            }),
          ),
        );
        expect(error.code).toBe("invalid_input");
        expect(error.message).toContain(`hr png 不支持 ${flag}`);
        expect(existsSync(out)).toBe(false);
      }),
  );
});

describe("pngCommand · 产物校验", () => {
  it("空字节报 render_empty", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<LongImage> =>
        Promise.resolve({ bytes: new Uint8Array(), width: 0, height: 0, clipped: false });
      const error = await failureOf(pngCommand(inputOf(dir, { render })));
      expect(error.code).toBe("render_empty");
      expect(error.message).toContain("没有返回 PNG 字节");
    });
  });

  it("签名不对的字节报 render_empty", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<LongImage> =>
        Promise.resolve({ bytes: Buffer.from("GIF89a"), width: 1, height: 1, clipped: false });
      const error = await failureOf(pngCommand(inputOf(dir, { render })));
      expect(error.message).toContain("不是 PNG");
    });
  });

  it("只有签名没有 IHDR 时也拒收", async () => {
    await withDocOf(async (dir) => {
      const bytes = pngOf(1, 1).slice(0, 12);
      const render = (): Promise<LongImage> =>
        Promise.resolve({ bytes, width: 1, height: 1, clipped: false });
      const error = await failureOf(pngCommand(inputOf(dir, { render })));
      expect(error.message).toContain("缺 IHDR");
    });
  });
});

describe("pngCommand · 落盘闸门", () => {
  it("已存在的 --out 不给 --force 就拒写，且不白渲染一次", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.png");
      writeFileSync(out, "old");
      let rendered = false;
      const render = (): Promise<LongImage> => {
        rendered = true;
        return Promise.resolve(imageOf());
      };
      const error = await failureOf(pngCommand(inputOf(dir, { out, render })));
      expect(error.code).toBe("file_exists");
      expect(rendered).toBe(false);
      expect(readFileSync(out, "utf8")).toBe("old");
    });
  });

  it("--force 覆盖已有文件", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.png");
      writeFileSync(out, "old");
      await pngCommand(inputOf(dir, { out, force: true }));
      expect(ihdrOf(readFileSync(out)).width).toBe(2400);
    });
  });
});

describe("pngCommand · --out 越界", () => {
  it("--out 在 workspace 外时报 path_outside_workspace", async () => {
    await withRealDir(async (workspace) => {
      await withRealDir(async (other) => {
        writeFileSync(join(other, "doc.html"), DOC);
        const out = join(workspace, "o.png");
        const path = join(other, "doc.html");
        const error = await failureOf(pngCommand(inputOf(other, { path, out })));
        expect(error.code).toBe("path_outside_workspace");
        expect(existsSync(out)).toBe(false);
      });
    });
  });
});

describe("pngCommand · 失败零残留", () => {
  it("渲染失败时盘上零残留", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<LongImage> =>
        Promise.reject(new HrError("render_timeout", "渲染超时（1s）"));
      const error = await failureOf(pngCommand(inputOf(dir, { render })));
      expect(error.code).toBe("render_timeout");
      expect(readdirSync(dir).sort()).toEqual(["doc.html"]);
    });
  });
});
