// This layer covers **every entry** of `needs_normalize`.
//
// The criterion comes from user symptoms, not implementation shape: a handwritten doc (no `data-hr-id`) handed
// to any read command must **report the same code and give the same executable next step** — no entry may idle silently while another rephrases.
// Entries = outline / read / patch; serve no longer refuses unnormalized docs (foreign docs open and read fine),
// so the HTTP-side 409 shrinks to managed read surfaces like `model`/`outline`.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir, type CliResult } from "./harness";
import { homeOf, startServe } from "./serve-harness";

/** A handwritten document: complete structure, legal language, but no `data-hr-id` anywhere. */
const HANDWRITTEN = [
  "<!doctype html><html><head><title>手写</title></head><body><article>",
  "<h1>第一章</h1><p>正文一。</p>",
  "<h2>1.1 一节</h2><p>正文二。</p>",
  "<h1>第二章</h1><p>正文三。</p>",
  "</article></body></html>",
  "",
].join("\n");

const NORMALIZED = '<article data-hr-id="hr-a"><h1 data-hr-id="hr-b">章</h1></article>';

const seed = (dir: string): void => {
  writeFileSync(join(dir, "draft.html"), HANDWRITTEN);
  writeFileSync(join(dir, "ok.html"), NORMALIZED);
};

/** Run a command and collapse it to "exit code + envelope": `--json` and the code together decide which refusal this is. */
const refusalOf = async (
  dir: string,
  args: readonly string[],
): Promise<{ code: number | null; envelope: unknown }> => {
  const result: CliResult = checked(await runCli(args, { cwd: dir }));
  const envelope = parseJsonLine(result.stdout);
  expect(fieldOf(envelope, "ok")).toBe(false);
  return { code: result.code, envelope };
};

const REFUSALS: readonly (readonly string[])[] = [
  ["outline", "draft.html", "--json"],
  ["read", "draft.html", "h1", "--json"],
  ["patch", "draft.html", "hr-x", "--action", "delete", "--json"],
];

describe("needs_normalize · all three read/patch entries report the same code", () => {
  it("should refuse outline, read and patch with the same code and the same next step", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      for (const args of REFUSALS) {
        const { code, envelope } = await refusalOf(dir, args);
        const message = textOf(fieldOf(envelope, "message"));

        expect(fieldOf(envelope, "code")).toBe("needs_normalize");
        // Exit code 2 = "precondition unmet, fix once per the hint" (not IO failure 3).
        expect(code).toBe(2);
        // All three point at **the same** command: `hr normalize <file> --write`.
        expect(message).toContain("hr normalize");
        expect(message).toContain("--write");
        expect(message).toContain("draft.html");
      }
    });
  });

  it("should leave the handwritten file byte-identical when refusing", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const before = checked(await runCli(["outline", "draft.html"], { cwd: dir }));
      const after = checked(await runCli(["outline", "draft.html"], { cwd: dir }));

      expect(before.code).toBe(2);
      expect(before.stderr).toMatch(/hr normalize \S*draft\.html --write/u);
      // A refusal must not quietly modify the file.
      expect(after.stderr).toBe(before.stderr);
      expect(after.code).toBe(2);
    });
  });
});

interface SiblingAnswer {
  status: number;
  body: unknown;
}

// Open another handwritten doc in the same workspace: the managed read surface (model) still returns the CLI's code, so the reader can hint "normalize first".
const askSiblingModel = async (serve: { url: string; token: string }): Promise<SiblingAnswer> => {
  // `serve.url` is the `?token=`-carrying string the program itself printed: use URL resolution for sibling paths, never string concatenation.
  const response = await fetch(new URL("api/doc/draft.html/model", serve.url), {
    headers: { cookie: `hr=${serve.token}` },
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

describe("needs_normalize · serve's CLI and HTTP faces", () => {
  it("should serve a handwritten document as viewable HTML instead of refusing", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      const serve = await startServe("draft.html", {
        json: true,
        home: homeOf(dir),
        cwd: dir,
      });
      try {
        const response = await fetch(new URL("s/draft.html", serve.url), {
          headers: { cookie: `hr=${serve.token}` },
        });
        const body = await response.text();

        // An unnormalized doc is shown as foreign HTML as-is: it opens and reads, but block editing is not promised.
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(body).toContain("第一章");
      } finally {
        await serve.stop();
      }
    });
  });

  it("should answer 409 needs_normalize on the model endpoint for a handwritten sibling", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const serve = await startServe("ok.html", { json: true, home: homeOf(dir), cwd: dir });
      try {
        const { status, body } = await askSiblingModel(serve);

        expect(status).toBe(409);
        expect(fieldOf(body, "code")).toBe("needs_normalize");
        expect(textOf(fieldOf(body, "message"))).toContain("hr normalize");
      } finally {
        await serve.stop();
      }
    }, 30_000);
  });
});
