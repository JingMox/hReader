// This layer covers `normalize` / `undo` orchestration and human receipts, plus `outline` diagnostics going
// through `warn`; real fs + real core, no subprocess.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { normalizeCommand } from "../src/commands/normalize";
import { outlineCommand } from "../src/commands/outline";
import { patchCommand } from "../src/commands/patch";
import { undoCommand } from "../src/commands/undo";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-cmd-norm-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DOC = [
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p></article>',
].join("\n");

const fileOf = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

const jsonOf = (text: string): unknown => JSON.parse(text.trim());

describe("undoCommand", () => {
  it("should print the human line after one patch and say nothing_to_undo the second time", async () => {
    fileOf("u1.html", DOC);
    await patchCommand({
      path: "u1.html",
      nodeId: "hr-c",
      action: "replace",
      html: "<p>改过的正文</p>",
      workspace: dir,
      json: false,
    });

    // `undo` speaks the same dialect as `patch`: the file is given as a workspace-relative path.
    const human = await undoCommand({ path: "u1.html", workspace: dir, json: false });
    expect(human).toMatch(/^undone .*u1\.html \(\d+ bytes, from /u);
    // One snapshot undoes once: the second run must say "nothing to undo", not fake success.
    await expect(
      undoCommand({ path: "u1.html", workspace: dir, json: false }),
    ).rejects.toMatchObject({
      code: "nothing_to_undo",
    });
  });
});

const DRAFT = "<article><h1>第一章</h1><p>正文。</p></article>";

describe("normalizeCommand · print only", () => {
  it("should print the normalized html itself when --write is not given", async () => {
    const path = fileOf("n1.html", DRAFT);
    const printed = await normalizeCommand({
      path: "n1.html",
      workspace: dir,
      write: false,
      json: false,
    });

    // `hr normalize a.html > b.html` must be byte-usable: stdout is the result, no extra newline appended.
    expect(printed).toContain('data-hr-id="');
    expect(printed).not.toMatch(/\n$/u);
    expect(readFileSync(path, "utf8")).toBe(DRAFT);
  });
});

describe("normalizeCommand · --write", () => {
  it("should report needsNormalize:false and the injected count on --write --json", async () => {
    const path = fileOf("n2.html", DRAFT);
    const parsed = jsonOf(
      await normalizeCommand({ path: "n2.html", workspace: dir, write: true, json: true }),
    );

    expect(parsed).toMatchObject({ ok: true, data: { needsNormalize: false } });
    expect(
      Number(Reflect.get(Object(Reflect.get(Object(parsed), "data")), "injected")),
    ).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toContain('data-hr-id="');
  });

  it("should say unchanged on the human --write line when the document is already normalized", async () => {
    fileOf("n3.html", DOC);
    const human = await normalizeCommand({
      path: "n3.html",
      workspace: dir,
      write: true,
      json: false,
    });

    expect(human).toMatch(/^unchanged .*n3\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
  });

  it("should say normalized with the injected count on the human --write line", async () => {
    fileOf("n4.html", DRAFT);
    const human = await normalizeCommand({
      path: "n4.html",
      workspace: dir,
      write: true,
      json: false,
    });

    // What the user cares about is "how many ids were injected": a bare "done" cannot tell whether the write was a no-op.
    expect(human).toMatch(/^normalized .*n4\.html \(\+[1-9]\d* ids, \d+ bytes\)\n$/u);
  });
});

describe("outlineCommand · diagnostic lines", () => {
  it("should hand each diagnostic to warn as one human line instead of swallowing it", async () => {
    // Hand-break `hr-meta`: the outline still comes out but must carry a parse diagnostic (visible in human mode, not only under --json).
    const path = fileOf(
      "o4.html",
      [
        "<!doctype html><html><head>",
        // The annotation block is hand-broken: the kind of diagnostic a user really hits (not a manufactured branch).
        '<script id="hr-meta">{不是 JSON}</script>',
        '</head><body><article data-hr-id="hr-a"><h1 data-hr-id="hr-b">一</h1>',
        '<p data-hr-id="hr-c">正文</p></article></body></html>',
      ].join("\n"),
    );
    const rows: string[] = [];

    const printed = await outlineCommand({ path, json: false, warn: (row) => rows.push(row) });

    expect(rows.length).toBeGreaterThan(0);
    // Pin the symptom "about bad meta": any unrelated diagnostic satisfies `[a-z_]+: .+`, which would lock nothing.
    expect(rows[0]).toMatch(/^(warning|error): .*hr-meta/u);
    // Diagnostics go through warn, not smoothed into stdout's body: stdout must remain a directly usable outline.
    expect(printed).not.toContain(rows[0]);
  });
});
