// This layer covers `thumbCommand`'s boundary semantics on an injected fake
// `ThumbRender` (never a browser): the TTY rule, `--out` write rules shared
// with `hr png` (inside-workspace / parent-dir / file_exists), the binary
// stdout path, the `--json` shapes, and the content hash handed to render.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { thumbCommand, type ThumbInput } from "../src/commands/thumb";
import { pngOf } from "./chrome-png";

// realpathSync: the atomic-write boundary check compares realpaths — on macOS tmpdir() is /var → /private/var.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-thumb-cmd-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DOC =
  '<!doctype html><html><body><article data-hr-id="hr-a"><p>正文</p></article></body></html>';

const seed = (name: string, html = DOC): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

const PNG = pngOf(600, 400);

interface Call {
  readonly path: string;
  readonly hash: string;
}

interface CommandFixture {
  readonly input: ThumbInput;
  readonly calls: Call[];
  readonly binary: Uint8Array[];
}

const fixtureOf = (overrides: Partial<ThumbInput> = {}): CommandFixture => {
  const calls: Call[] = [];
  const binary: Uint8Array[] = [];
  return {
    calls,
    binary,
    input: {
      path: join(dir, "doc.html"),
      out: undefined,
      force: false,
      workspace: dir,
      json: false,
      isStdoutTty: false,
      stdoutBytes: (bytes) => {
        binary.push(bytes);
      },
      render: async (request) => {
        calls.push(request);
        return await Promise.resolve(PNG);
      },
      ...overrides,
    },
  };
};

describe("thumbCommand · the TTY rule", () => {
  it("should refuse binary stdout on a terminal before rendering", async () => {
    const { input, calls } = fixtureOf({ isStdoutTty: true });
    await expect(thumbCommand(input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(thumbCommand(fixtureOf({ isStdoutTty: true }).input)).rejects.toThrow("--out");
    expect(calls).toEqual([]);
  });

  it("should still allow a --json answer on a terminal (the line is text, not binary)", async () => {
    const { input } = fixtureOf({ isStdoutTty: true, json: true });
    seed("tty-json.html");
    const text = await thumbCommand({ ...input, path: join(dir, "tty-json.html") });
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({ ok: true });
  });
});

describe("thumbCommand · stdout", () => {
  it("should write the PNG bytes to stdout untouched when stdout is a pipe", async () => {
    const doc = seed("pipe.html");
    const { input, binary, calls } = fixtureOf();
    const text = await thumbCommand({ ...input, path: doc });

    expect(text).toBe("");
    expect(binary).toHaveLength(1);
    expect(binary[0]).toEqual(PNG);
    // The renderer must get the document's real content hash — the cache key.
    const expected = createHash("sha256").update(readFileSync(doc)).digest("hex");
    expect(calls[0]?.hash).toBe(expected);
  });

  it("should answer a --json line with the base64 png and a null out on stdout mode", async () => {
    const doc = seed("json-pipe.html");
    const { input, binary } = fixtureOf({ json: true });
    const text = await thumbCommand({ ...input, path: doc });

    expect(binary).toEqual([]);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      ok: true,
      data: {
        png: Buffer.from(PNG).toString("base64"),
        bytes: PNG.length,
        width: 600,
        height: 400,
        out: null,
      },
    });
  });
});

describe("thumbCommand · --out", () => {
  it("should write the PNG to --out and return the human receipt", async () => {
    const doc = seed("out.html");
    mkdirSync(join(dir, "shots"));
    const out = join(dir, "shots", "a.png");
    const { input, binary } = fixtureOf({ out, displayOut: "shots/a.png" });
    const text = await thumbCommand({ ...input, path: doc });

    expect(readFileSync(out)).toEqual(Buffer.from(PNG));
    expect(text).toContain("exported shots/a.png");
    expect(text).toContain("600×400");
    expect(binary).toEqual([]);
  });

  it("should answer a --json receipt naming the --out path it wrote", async () => {
    const doc = seed("out-json.html");
    const out = join(dir, "out-json.png");
    const { input, binary } = fixtureOf({ out, displayOut: "out-json.png", json: true });
    const text = await thumbCommand({ ...input, path: doc });

    expect(readFileSync(out)).toEqual(Buffer.from(PNG));
    expect(binary).toEqual([]);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      ok: true,
      data: {
        png: Buffer.from(PNG).toString("base64"),
        bytes: PNG.length,
        width: 600,
        height: 400,
        out,
      },
    });
  });

  it("should refuse an existing --out without --force and overwrite with it", async () => {
    const doc = seed("exists.html");
    const out = join(dir, "exists.png");
    writeFileSync(out, "old");
    const { input } = fixtureOf({ out });

    await expect(thumbCommand({ ...input, path: doc })).rejects.toMatchObject({
      code: "file_exists",
    });
    expect(readFileSync(out).toString()).toBe("old");

    await thumbCommand({ ...input, force: true, path: doc });
    expect(readFileSync(out)).toEqual(Buffer.from(PNG));
  });

  it("should refuse an --out outside the workspace", async () => {
    const doc = seed("inside.html");
    const { input } = fixtureOf({ out: join(dir, "..", "escape.png") });
    await expect(thumbCommand({ ...input, path: doc })).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
  });
});

describe("thumbCommand · failures", () => {
  it("should propagate a render failure and leave no --out file", async () => {
    const doc = seed("renderfail.html");
    const out = join(dir, "renderfail.png");
    const { input } = fixtureOf({
      out,
      render: () => Promise.reject(new HrError("render_empty", "空")),
    });
    await expect(thumbCommand({ ...input, path: doc })).rejects.toMatchObject({
      code: "render_empty",
    });
    expect(existsSync(out)).toBe(false);
  });

  it("should reject a non-PNG render product before writing", async () => {
    const doc = seed("notpng.html");
    const out = join(dir, "notpng.png");
    const { input } = fixtureOf({ out, render: () => Promise.resolve(Buffer.from("GIF89a")) });
    await expect(thumbCommand({ ...input, path: doc })).rejects.toMatchObject({
      code: "render_empty",
    });
    expect(existsSync(out)).toBe(false);
  });

  it("should report a missing document as not_a_file", async () => {
    const { input } = fixtureOf();
    await expect(thumbCommand({ ...input, path: join(dir, "nope.html") })).rejects.toMatchObject({
      code: "not_a_file",
    });
  });
});
