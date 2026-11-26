// This layer covers `hr pdf` outline semantics (default on / reported value / exclusivity); the render layer is a fake injected render, no Chrome.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { pdfCommand, type PdfCommandInput, type RenderPdf } from "../src/commands/pdf";
import { pdfOf } from "./chrome-helpers";
import {
  bytesOf,
  OUTLINE_COUNT_LIE,
  pagesOf,
  pdfWithBookmarksOf,
  withOutlinesOf,
} from "./helpers/pdf-fixtures";
import { fieldOf, withTempDir } from "./harness";

/** The printout's heading count (4) and the artifact's bookmark count deliberately differ: the reported value may only come from the artifact. */
const HEADINGS =
  "<html><body><article><h1>一</h1><p>x</p><h2>二</h2><h5>五</h5>" +
  "<h6>六</h6></article></body></html>";

const PLAIN = "<html><body><article><p>只有正文</p></article></body></html>";

interface Overrides {
  readonly outline?: boolean;
  readonly outlineConflict?: boolean;
  readonly out?: string;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly render?: RenderPdf;
}

const inputOf = (dir: string, overrides: Overrides = {}): PdfCommandInput => ({
  path: join(dir, "doc.html"),
  pageSize: "a4",
  timeoutMs: 60_000,
  outline: true,
  outlineConflict: false,
  visual: "atelier-editorial",
  out: join(dir, "out.pdf"),
  force: false,
  workspace: dir,
  json: false,
  warn: () => undefined,
  render: (input) => Promise.resolve({ bytes: pdfWithBookmarksOf(input.outline ? 2 : 0) }),
  ...overrides,
});

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("expected an HrError to be thrown");
};

/** Read one key out of `--json`'s `data`: the key set itself is pinned by `pdf-command.test.ts`. */
const fieldOfDataOf = (text: string): ((key: string) => unknown) => {
  const data = fieldOf(JSON.parse(text), "data");
  return (key) => fieldOf(data, key);
};

const withDocOf = async (html: string, run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    writeFileSync(join(dir, "doc.html"), html);
    await run(dir);
  });

const outlineOf = async (html: string, overrides: Overrides = {}): Promise<unknown> => {
  let seen: unknown;
  await withDocOf(html, async (dir) => {
    const text = await pdfCommand(inputOf(dir, { ...overrides, json: true }));
    seen = fieldOfDataOf(text)("outline");
  });
  return seen;
};

describe("pdfCommand · reported outline value", () => {
  it("should report outline as the artifact's outline entry count (not the printout's heading count)", async () => {
    const render = (): Promise<{ bytes: Uint8Array }> =>
      Promise.resolve({ bytes: pdfWithBookmarksOf(3) });
    expect(await outlineOf(HEADINGS, { render })).toBe(3);
  });

  it('should report outline as the number 0 (key kept, not null / "0") when the artifact has no /Outlines', async () => {
    expect(
      await outlineOf(HEADINGS, {
        render: () => Promise.resolve({ bytes: pdfWithBookmarksOf(0) }),
      }),
    ).toStrictEqual(0);
  });

  it("should report render_empty and write nothing when the artifact's outline structure contradicts itself", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      // `/Count 3` but really 2 entries: the `bookmarkCountOf` cross-check does the catching, not anything in the command layer.
      const bytes = bytesOf(withOutlinesOf(pagesOf(1)) + OUTLINE_COUNT_LIE);
      const error = await failureOf(
        pdfCommand(inputOf(dir, { out, render: () => Promise.resolve({ bytes }) })),
      );
      expect(error.code).toBe("render_empty");
      expect(existsSync(out)).toBe(false);
    }));
});

describe("pdfCommand · the outline switch reaches the render layer", () => {
  const seenOf = async (outline: boolean): Promise<boolean[]> => {
    const seen: boolean[] = [];
    await withDocOf(HEADINGS, async (dir) => {
      await pdfCommand(
        inputOf(dir, {
          outline,
          render: (input) => {
            seen.push(input.outline);
            return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
          },
        }),
      );
    });
    return seen;
  };

  it("should pass outline: true to the render layer by default", async () => {
    expect(await seenOf(true)).toEqual([true]);
  });

  it("should pass false to the render layer and report outline 0 with --no-outline", async () => {
    expect(await seenOf(false)).toEqual([false]);
    expect(await outlineOf(HEADINGS, { outline: false })).toStrictEqual(0);
  });

  it("should overwrite an existing file and still report outline 0 with --no-outline --force", async () => {
    await withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      writeFileSync(out, "old");
      const text = await pdfCommand(inputOf(dir, { out, force: true, outline: false, json: true }));
      expect(readFileSync(out, "latin1")).toContain("%PDF-");
      expect(fieldOfDataOf(text)("outline")).toStrictEqual(0);
    });
  });
});

describe("pdfCommand · flag exclusivity", () => {
  it("should report invalid_input for --outline with --no-outline, without rendering or writing", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      const error = await failureOf(
        pdfCommand(
          inputOf(dir, {
            outlineConflict: true,
            // Really rendering would end in this error: move the exclusivity check after rendering and this line goes red differently.
            render: () =>
              Promise.reject(new Error("--outline and --no-outline cannot be used together")),
          }),
        ),
      );
      // Only the error code is pinned (exit 1 is decided by the "code → table" layer), not the human copy.
      expect(error.code).toBe("invalid_input");
      expect(existsSync(out)).toBe(false);
    }));
});

describe("pdfCommand · reported values only come from the artifact", () => {
  it("should still report the artifact count for a `PLAIN` doc paired with a bookmarked artifact (the printout plays no part)", async () => {
    expect(await outlineOf(PLAIN)).toBe(2);
  });
});

describe("pdfCommand · human line", () => {
  it("should print `<path> (N 页, M 条书签)` where M equals `--json.outline`", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      const human = await pdfCommand(inputOf(dir, { out, force: true }));
      const json = await pdfCommand(inputOf(dir, { out, force: true, json: true }));
      expect(human).toBe(`${out} (1 页, 2 条书签)\n`);
      expect(fieldOfDataOf(json)("outline")).toBe(2);
    }));

  it("should still print `0 条书签` in the human line with --no-outline (M is not omitted)", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      expect(await pdfCommand(inputOf(dir, { out, outline: false }))).toBe(
        `${out} (1 页, 0 条书签)\n`,
      );
    }));
});
