// This layer: `ops/doc-meta-ops.ts` — getDocMeta/setDocMeta merge semantics, tag/URL
// normalization boundaries, first-write provenance, the changed:false no-write rule, the
// path-keyed limitation, case-folded spellings, and 8-process tag-add concurrency.
// The doc's bytes are asserted by sha256: meta ops must never touch them.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type DocMetaCreator, type DocMetaPatch } from "../../src/docmeta";
import { metaPathOf, readDocMetaAt } from "../../src/io/doc-meta-store";
import { nodePatchDeps } from "../../src/io/node-fs";
import { getDocMeta, setDocMeta } from "../../src/ops/doc-meta-ops";
import {
  codeOfAsync,
  depsOf,
  existsAt,
  fakeFs,
  fixedClock,
  realDirOf,
  readTextAt,
  recordingSleep,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "../io/harness";
import { fieldOf, spawnFixture } from "../io/spawn";

const FILE = "doc.html";
const DOC = "<html><body><p>x</p></body></html>";
const DOC_SHA = sha256Of(new TextEncoder().encode(DOC));

const AT = Date.now() + 60_000;
const AT_ISO = new Date(AT).toISOString();

const depsAt = () => ({ ...nodePatchDeps, ...fixedClock(AT) });

const seed = async (dir: string, file = FILE, html = DOC): Promise<string> => {
  const path = join(dir, file);
  await writeTextAt(path, html);
  return path;
};

const tableAt = async (dir: string): Promise<string> =>
  metaPathOf(join(await realDirOf(dir), ".hreader"));

const storedRecord = async (dir: string, rel = FILE) => {
  const file = await readDocMetaAt(await tableAt(dir), nodePatchDeps);
  return file.docs[rel];
};

const setTags = (dir: string, patch: DocMetaPatch, by: DocMetaCreator = "user") =>
  setDocMeta({ workspace: dir, file: FILE, patch, by }, depsAt());

const isCaseInsensitiveFs = async (dir: string): Promise<boolean> => {
  await writeFile(join(dir, "hr-case-probe"), "x");
  return await existsAt(join(dir, "HR-CASE-PROBE"));
};

describe("getDocMeta · reads", () => {
  it("should answer an all-empty record for a doc with no metadata", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const got = await getDocMeta({ workspace: dir, file: FILE }, depsAt());

      expect(got.meta).toEqual({ tags: [] });
      expect(got.diagnostics).toEqual([]);
      expect(await existsAt(await tableAt(dir))).toBe(false);
    });
  });

  it("should report a missing document through the resolve gate", async () => {
    await withWorkspace(async (dir) => {
      expect(await codeOfAsync(() => getDocMeta({ workspace: dir, file: FILE }, depsAt()))).toBe(
        "not_a_file",
      );
    });
  });

  it("should refuse a target outside the workspace and under .hreader", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      // `.hreader/**` must exist before the realpath-domain gate can weigh in.
      await mkdir(join(dir, ".hreader", "x"), { recursive: true });
      await writeTextAt(join(dir, ".hreader", "x", "a.html"), DOC);
      expect(
        await codeOfAsync(() => getDocMeta({ workspace: dir, file: "../x.html" }, depsAt())),
      ).toBe("path_outside_workspace");
      expect(
        await codeOfAsync(() =>
          getDocMeta({ workspace: dir, file: ".hreader/x/a.html" }, depsAt()),
        ),
      ).toBe("path_outside_workspace");
    });
  });
});

describe("setDocMeta · merge semantics", () => {
  it("should create a record with first-write provenance from the injected clock", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setDocMeta(
        { workspace: dir, file: FILE, patch: { addTags: ["维修"] }, by: "agent" },
        depsAt(),
      );

      expect(written.changed).toBe(true);
      expect(written.meta).toEqual({
        tags: ["维修"],
        createdBy: "agent",
        savedAt: AT_ISO,
      });
      expect(await storedRecord(dir)).toEqual(written.meta);
      expect(sha256Of(new TextEncoder().encode(await readTextAt(join(dir, FILE))))).toBe(DOC_SHA);
    });
  });

  it("should keep first-write provenance on later updates", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      await setTags(dir, { addTags: ["一"] }, "user");
      const again = { ...nodePatchDeps, ...fixedClock(AT + 5_000) };
      const written = await setDocMeta(
        { workspace: dir, file: FILE, patch: { addTags: ["二"] }, by: "agent" },
        again,
      );

      expect(written.meta.createdBy).toBe("user");
      expect(written.meta.savedAt).toBe(AT_ISO);
      expect(written.meta.tags).toEqual(["一", "二"]);
    });
  });

  it("should replace the tag list wholesale under tags, deduped case-insensitively keeping first spelling", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, {
        tags: ["Apple", "apple ", " 香蕉 ", "BANANA", "banana"],
      });

      expect(written.meta.tags).toEqual(["Apple", "香蕉", "BANANA"]);
    });
  });

  it("should append addTags skipping case-folded duplicates, then removeTags case-insensitively", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      await setTags(dir, { tags: ["Alpha", "beta"] });
      const written = await setTags(dir, {
        addTags: ["ALPHA", "gamma", "Beta", "delta"],
        removeTags: ["BETA", "delta"],
      });

      expect(written.meta.tags).toEqual(["Alpha", "gamma"]);
    });
  });

  it("should let addTags fold against tags applied in the same patch", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, {
        tags: ["only"],
        addTags: ["only", "extra"],
      });

      expect(written.meta.tags).toEqual(["only", "extra"]);
    });
  });

  it("should set, keep, replace and clear sourceUrl", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const set = await setTags(dir, { sourceUrl: "https://example.com/a b" });
      expect(set.meta.sourceUrl).toBe("https://example.com/a%20b");

      const kept = await setTags(dir, { addTags: ["x"] });
      expect(kept.meta.sourceUrl).toBe("https://example.com/a%20b");

      const replaced = await setTags(dir, { sourceUrl: "http://a.test" });
      expect(replaced.meta.sourceUrl).toBe("http://a.test/");

      const cleared = await setTags(dir, { sourceUrl: null });
      expect(cleared.meta.sourceUrl).toBeUndefined();
      expect(cleared.meta.tags).toEqual(["x"]);
    });
  });

  it("should report changed:false and write nothing for an empty patch", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, {});

      expect(written).toMatchObject({ changed: false, meta: { tags: [] } });
      expect(await existsAt(await tableAt(dir))).toBe(false);
    });
  });

  it("should report changed:false and write nothing for an identical patch", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      await setTags(dir, { addTags: ["x"], sourceUrl: "https://a.test" });
      const before = await readTextAt(await tableAt(dir));

      const written = await setTags(dir, { addTags: ["x"], sourceUrl: "https://a.test/" });

      expect(written.changed).toBe(false);
      expect(await readTextAt(await tableAt(dir))).toBe(before);
    });
  });

  it("should report changed:false for removeTags on a doc that has no record", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, { removeTags: ["x"] });

      expect(written.changed).toBe(false);
      expect(await storedRecord(dir)).toBeUndefined();
      expect(await existsAt(await tableAt(dir))).toBe(false);
    });
  });
});

describe("setDocMeta · tag normalization and limits", () => {
  it.each([
    ["trims whitespace", ["  标签  "], ["标签"]],
    ["normalizes NFC", ["e\u0301"], ["é"]],
    ["keeps emoji and CJK", ["🚀 发射", "手册"], ["🚀 发射", "手册"]],
    ["keeps inner spaces", ["machine learning"], ["machine learning"]],
  ])("should accept %s", async (_label, tags, expected) => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, { tags });
      expect(written.meta.tags).toEqual(expected);
    });
  });

  it.each<[string, readonly unknown[]]>([
    ["whitespace-only", ["   "]],
    ["empty string", [""]],
    ["one tag over the 64-code-point cap", ["x".repeat(65)]],
    ["a non-string item", [42]],
  ])("should refuse %s with invalid_payload", async (_label, tags) => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      // `as` on purpose: the non-string case feeds a type violation through the ts boundary.
      expect(
        await codeOfAsync(() => setTags(dir, { tags: tags as readonly string[] })),
      ).toBe("invalid_payload");
    });
  });

  it("should accept a 64-code-point tag", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, { tags: ["x".repeat(64)] });
      expect(written.meta.tags[0]).toHaveLength(64);
    });
  });

  it("should accept exactly 32 tags and refuse the 33rd", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const ok = await setTags(dir, {
        tags: Array.from({ length: 32 }, (_u, i) => `t${String(i)}`),
      });
      expect(ok.meta.tags).toHaveLength(32);

      expect(await codeOfAsync(() => setTags(dir, { addTags: ["t32"] }))).toBe("invalid_payload");
      expect(
        await codeOfAsync(() =>
          setTags(dir, { tags: Array.from({ length: 33 }, (_u, i) => `t${String(i)}`) }),
        ),
      ).toBe("invalid_payload");
      // The refused write leaves the stored list untouched.
      expect((await storedRecord(dir))?.tags).toHaveLength(32);
    });
  });
});

describe("setDocMeta · sourceUrl validation", () => {
  it.each([
    ["https", "https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["http", "http://example.com", "http://example.com/"],
    ["port + path", "https://example.com:8443/x", "https://example.com:8443/x"],
  ])("should accept %s URLs and store the canonical href", async (_l, input, expected) => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, { sourceUrl: input });
      expect(written.meta.sourceUrl).toBe(expected);
    });
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<h1>x</h1>"],
    ["file:", "file:///etc/passwd"],
    ["relative", "/docs/a.html"],
    ["scheme-relative", "//example.com/x"],
    ["embedded credentials", "https://user:pass@example.com/"],
    ["userinfo without password", "https://user@example.com/"],
    ["over 2048 code points", `https://example.com/${"p".repeat(2048)}`],
  ])("should refuse %s with invalid_payload", async (_label, url) => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      expect(await codeOfAsync(() => setTags(dir, { sourceUrl: url }))).toBe("invalid_payload");
      expect(await storedRecord(dir)).toBeUndefined();
    });
  });

  it("should refuse a non-string sourceUrl past the ts boundary", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      // Ops get real input from untyped layers too — a number must fail, not crash.
      expect(
        await codeOfAsync(() =>
          setTags(dir, { sourceUrl: 42 as unknown as string }),
        ),
      ).toBe("invalid_payload");
      expect(await storedRecord(dir)).toBeUndefined();
    });
  });

  it("should accept a URL exactly at 2048 code points", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const url = `https://example.com/${"p".repeat(2048 - "https://example.com/".length)}`;
      expect(Array.from(url).length).toBe(2048);
      const written = await setTags(dir, { sourceUrl: url });
      expect(written.meta.sourceUrl).toBe(url);
    });
  });
});

describe("setDocMeta · createdBy gate", () => {
  it.each(["user", "agent", "clipper"] as const)("should accept by:%s", async (by) => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const written = await setTags(dir, { addTags: ["x"] }, by);
      expect(written.meta.createdBy).toBe(by);
    });
  });

  it("should refuse an unknown createdBy with invalid_payload", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const code = await codeOfAsync(() =>
        setDocMeta(
          {
            workspace: dir,
            file: FILE,
            patch: { addTags: ["x"] },
            by: "robot" as DocMetaCreator,
          },
          depsAt(),
        ),
      );
      expect(code).toBe("invalid_payload");
    });
  });
});

describe("setDocMeta · path-keyed records", () => {
  it("should key the record by the exact workspace-relative path", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, "报告 一.html");
      await setDocMeta(
        { workspace: dir, file: "报告 一.html", patch: { addTags: ["中文"] }, by: "user" },
        depsAt(),
      );

      const file = await readDocMetaAt(await tableAt(dir), nodePatchDeps);
      expect(Object.keys(file.docs)).toEqual(["报告 一.html"]);
    });
  });

  it("should lose the metadata after a rename (documented limitation)", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      await setTags(dir, { addTags: ["孤儿"] });
      await writeFile(join(dir, "moved.html"), DOC);

      const moved = await getDocMeta({ workspace: dir, file: "moved.html" }, depsAt());
      expect(moved.meta).toEqual({ tags: [] });
      expect((await storedRecord(dir, FILE))?.tags).toEqual(["孤儿"]);
    });
  });

  it("should resolve case-only spellings however the filesystem folds case", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, "Doc.html");
      await seed(dir, "doc.html");

      await setDocMeta(
        { workspace: dir, file: "Doc.html", patch: { addTags: ["大写"] }, by: "user" },
        depsAt(),
      );
      await setDocMeta(
        { workspace: dir, file: "doc.html", patch: { addTags: ["小写"] }, by: "user" },
        depsAt(),
      );

      const file = await readDocMetaAt(await tableAt(dir), nodePatchDeps);
      if (await isCaseInsensitiveFs(dir)) {
        // APFS-style folding: both spellings land on the canonical "Doc.html" key.
        expect(Object.keys(file.docs)).toEqual(["Doc.html"]);
        expect(file.docs["Doc.html"]?.tags).toEqual(["大写", "小写"]);
        const got = await getDocMeta({ workspace: dir, file: "doc.html" }, depsAt());
        expect(got.meta.tags).toEqual(["大写", "小写"]);
      } else {
        expect(Object.keys(file.docs).sort()).toEqual(["Doc.html", "doc.html"]);
        expect(file.docs["Doc.html"]?.tags).toEqual(["大写"]);
        expect(file.docs["doc.html"]?.tags).toEqual(["小写"]);
      }
    });
  });

  it("should keep case-only spellings in separate records when realpath does not fold", async () => {
    const fs = fakeFs({ "/ws/Doc.html": DOC, "/ws/doc.html": DOC });
    const deps = depsOf(fs.port, fixedClock(AT).clock, recordingSleep().sleep);

    await setDocMeta(
      { workspace: "/ws", file: "Doc.html", patch: { addTags: ["大写"] }, by: "user" },
      deps,
    );
    await setDocMeta(
      { workspace: "/ws", file: "doc.html", patch: { addTags: ["小写"] }, by: "user" },
      deps,
    );

    const file = JSON.parse(fs.textAt("/ws/.hreader/meta.json")) as {
      docs: Record<string, { tags: string[] }>;
    };
    expect(file.docs["Doc.html"]?.tags).toEqual(["大写"]);
    expect(file.docs["doc.html"]?.tags).toEqual(["小写"]);
  });

  it("should share one record when the fs folds spellings to the same file", async () => {
    const fs = fakeFs({ "/ws/Doc.html": DOC });
    fs.state.links.set("/ws/doc.html", "/ws/Doc.html");
    const deps = depsOf(fs.port, fixedClock(AT).clock, recordingSleep().sleep);

    await setDocMeta(
      { workspace: "/ws", file: "Doc.html", patch: { addTags: ["大写"] }, by: "user" },
      deps,
    );
    await setDocMeta(
      { workspace: "/ws", file: "doc.html", patch: { addTags: ["小写"] }, by: "user" },
      deps,
    );

    const file = JSON.parse(fs.textAt("/ws/.hreader/meta.json")) as {
      docs: Record<string, { tags: string[] }>;
    };
    expect(Object.keys(file.docs)).toEqual(["Doc.html"]);
    expect(file.docs["Doc.html"]?.tags).toEqual(["大写", "小写"]);
  });
});

describe("setDocMeta · corruption and IO failures", () => {
  it("should back the corrupt table aside and still land the write", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const storeDir = join(await realDirOf(dir), ".hreader");
      await mkdir(storeDir, { recursive: true });
      await writeTextAt(await tableAt(dir), "{corrupt bytes");

      const written = await setTags(dir, { addTags: ["新"] });

      expect(written.changed).toBe(true);
      expect(written.diagnostics).toEqual(["doc_meta_corrupt:not_object"]);
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(storeDir);
      expect(names.filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
      expect((await storedRecord(dir))?.tags).toEqual(["新"]);
    });
  });
});

describe("doc-meta concurrency: eight child processes tag the same document", () => {
  it("should land every tag exactly once with none lost", { timeout: 60_000 }, async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const workers = Array.from({ length: 8 }, (_u, index) =>
        spawnFixture("meta-worker.mjs", [dir, FILE, `w${String(index)}`, "4", "20000"]),
      );
      for (const worker of workers) await worker.next();
      for (const worker of workers) worker.go();
      const reports = await Promise.all(workers.map((worker) => worker.next()));
      const codes = await Promise.all(workers.map((worker) => worker.exit));

      expect(codes.map((info) => info.code)).toEqual(Array.from({ length: 8 }, () => 0));
      for (const report of reports) expect(fieldOf(report, "ok")).toBe(true);

      const file = await readDocMetaAt(await tableAt(dir), nodePatchDeps);
      const tags = file.docs[FILE]?.tags ?? [];
      expect(tags).toHaveLength(32);
      expect(new Set(tags).size).toBe(32);
      for (let worker = 0; worker < 8; worker += 1) {
        for (let tag = 0; tag < 4; tag += 1) {
          expect(tags).toContain(`w${String(worker)}-${String(tag)}`);
        }
      }
      expect(sha256Of(new TextEncoder().encode(await readTextAt(join(dir, FILE))))).toBe(DOC_SHA);
    });
  });
});
