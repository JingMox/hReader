// This layer: `ops/sidecar-ops.ts` — the five write ops and the merged read across all three
// document classes, on a real disk. The doc's bytes are asserted by sha256: sidecar ops must
// never touch them.

import { chmod, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readAnnotations } from "../../src/annotations";
import { NOTE_LIMIT } from "../../src/annotations/model";
import {
  replyIdOf,
  serializeSidecarFile,
  type SidecarAnnotation,
} from "../../src/annotations/sidecar-model";
import { nodePatchDeps } from "../../src/io/node-fs";
import {
  addSidecarAnnotation,
  deleteSidecarAnnotation,
  listDocAnnotations,
  reopenSidecarAnnotation,
  replySidecarAnnotation,
  resolveSidecarAnnotation,
} from "../../src/ops/sidecar-ops";
import { addAnnotation } from "../../src/ops/annotation-ops";
import {
  codeOfAsync,
  depsOf,
  existsAt,
  fakeFs,
  fixedClock,
  mkdirAt,
  realDirOf,
  readBytesAt,
  readTextAt,
  recordingSleep,
  sha1Of,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "../io/harness";

const FILE = "doc.html";
const META = '<script id="hr-meta" type="application/json">{"version":1,"annotations":[]}</script>';
const MANAGED = [
  "<!doctype html>",
  '<html><body><article data-hr-id="hr-a"><p data-hr-id="hr-b">正文一</p><p data-hr-id="hr-c">正文二</p></article>',
  META,
  "</body></html>",
].join("\n");
const NORMALIZABLE = "<html><body><article><p>可归一文本</p></article></body></html>";
const FOREIGN = "<html><body><div><p>foreign text</p><p>again</p></div></body></html>";

const ANCHOR = { exact: "正文一", prefix: "", suffix: "", start: 0 };
const AT = Date.now() + 60_000;
const AT_ISO = new Date(AT).toISOString();

const depsAt = () => ({ ...nodePatchDeps, ...fixedClock(AT) });

const seed = async (dir: string, html = MANAGED, file = FILE): Promise<string> => {
  const path = join(dir, file);
  await writeTextAt(path, html);
  return path;
};

const sidecarDirAt = async (dir: string): Promise<string> =>
  join(await realDirOf(dir), ".hreader", "annotations");

const sidecarPathAt = async (dir: string, relFile = FILE): Promise<string> =>
  join(await sidecarDirAt(dir), `${sha1Of(relFile)}.json`);

const seedSidecar = async (
  dir: string,
  relFile: string,
  annotations: readonly SidecarAnnotation[],
): Promise<void> => {
  await mkdirAt(await sidecarDirAt(dir));
  await writeTextAt(await sidecarPathAt(dir, relFile), serializeSidecarFile(relFile, annotations));
};

const record = (patch: Partial<SidecarAnnotation> = {}): SidecarAnnotation => ({
  id: "an-00000000",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "x", prefix: "", suffix: "", start: 0 },
  note: "n",
  status: "pending",
  createdAt: "t",
  author: "user",
  replies: [],
  ...patch,
});

const addInput = (patch: Record<string, unknown> = {}) => ({
  workspace: "",
  file: FILE,
  selector: "body > article:nth-of-type(1) > p:nth-of-type(1)",
  anchor: ANCHOR,
  note: "第一条",
  ...patch,
});

describe("addSidecarAnnotation · the three document classes", () => {
  it.each([
    ["managed", MANAGED],
    ["normalizable", NORMALIZABLE],
    ["foreign", FOREIGN],
  ])("should store an annotation on a %s doc without touching its bytes", async (_cls, html) => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir, html);
      const before = await readBytesAt(path);

      const added = await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());

      expect(added.annotation).toMatchObject({
        selector: "body > article:nth-of-type(1) > p:nth-of-type(1)",
        note: "第一条",
        status: "pending",
        createdAt: AT_ISO,
        author: "user",
        replies: [],
      });
      expect(added.annotation.nodeId).toBeUndefined();
      expect("nodeId" in added.annotation).toBe(false);
      expect(added.changed).toBe(true);
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(before));
      const stored = JSON.parse(await readTextAt(await sidecarPathAt(dir))) as {
        path: string;
        annotations: { selector: string }[];
      };
      expect(stored.path).toBe(FILE);
      expect(stored.annotations[0]?.selector).toBe(
        "body > article:nth-of-type(1) > p:nth-of-type(1)",
      );
    });
  });

  it("should store a nodeId-only annotation without a selector", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const added = await addSidecarAnnotation(
        addInput({ workspace: dir, nodeId: "hr-b", selector: undefined }),
        depsAt(),
      );

      expect(added.annotation.nodeId).toBe("hr-b");
      expect(added.annotation.selector).toBeUndefined();
      expect("selector" in added.annotation).toBe(false);
      const stored = JSON.parse(await readTextAt(await sidecarPathAt(dir))) as {
        annotations: { nodeId: string; selector?: string }[];
      };
      expect(stored.annotations[0]?.nodeId).toBe("hr-b");
      expect(stored.annotations[0]?.selector).toBeUndefined();
    });
  });

  it("should keep a nodeId when the caller provides both locating infos", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const added = await addSidecarAnnotation(
        addInput({ workspace: dir, nodeId: "hr-b" }),
        depsAt(),
      );

      expect(added.annotation.nodeId).toBe("hr-b");
      expect(added.annotation.selector).toBe("body > article:nth-of-type(1) > p:nth-of-type(1)");
    });
  });

  it("should give a repeated submit a second id instead of swallowing it", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const first = await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());
      const second = await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());

      expect(second.annotation.id).not.toBe(first.annotation.id);
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());
      expect(listed.annotations).toHaveLength(2);
    });
  });
});

describe("addSidecarAnnotation · refusals", () => {
  it.each([
    ["no locating info", { selector: undefined }],
    ["an empty nodeId", { nodeId: "" }],
    ["an empty selector", { selector: "" }],
    ["an empty exact", { anchor: { ...ANCHOR, exact: "" } }],
    ["a non-object anchor", { anchor: "x" }],
    ["a note over the limit", { note: "n".repeat(2_001) }],
    ["an unknown author", { author: "robot" }],
  ])("should reject %s with invalid_payload and write nothing", async (_label, patch) => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const code = await codeOfAsync(() =>
        addSidecarAnnotation(addInput({ workspace: dir, ...patch }), depsAt()),
      );

      expect(code).toBe("invalid_payload");
      expect(await readTextAt(join(dir, FILE))).toBe(MANAGED);
      const names = await namesAt(dir);
      expect(names).toEqual([]);
    });
  });

  it("should accept an agent author and keep the default as user", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const agent = await addSidecarAnnotation(
        addInput({ workspace: dir, author: "agent", note: "agent note" }),
        depsAt(),
      );
      const user = await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());
      const explicit = await addSidecarAnnotation(
        addInput({ workspace: dir, author: "user", note: "explicit user" }),
        depsAt(),
      );

      expect(agent.annotation.author).toBe("agent");
      expect(user.annotation.author).toBe("user");
      expect(explicit.annotation.author).toBe("user");
    });
  });

  it("should accept a note at exactly the limit", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const added = await addSidecarAnnotation(
        addInput({ workspace: dir, note: "n".repeat(NOTE_LIMIT) }),
        depsAt(),
      );

      expect(added.annotation.note).toHaveLength(NOTE_LIMIT);
    });
  });

  it("should name the failing part in every refusal message", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const id = (await addSidecarAnnotation(addInput({ workspace: dir }), depsAt())).annotation.id;

      await expect(
        addSidecarAnnotation(addInput({ workspace: dir, selector: undefined }), depsAt()),
      ).rejects.toThrow("nodeId 与 selector 至少给一个");
      await expect(
        addSidecarAnnotation(addInput({ workspace: dir, nodeId: "" }), depsAt()),
      ).rejects.toThrow("nodeId 不能为空");
      await expect(
        addSidecarAnnotation(addInput({ workspace: dir, selector: "" }), depsAt()),
      ).rejects.toThrow("selector 不能为空");
      await expect(
        addSidecarAnnotation(
          addInput({ workspace: dir, anchor: { ...ANCHOR, exact: "" } }),
          depsAt(),
        ),
      ).rejects.toThrow("anchor.exact 不能为空");
      await expect(
        addSidecarAnnotation(addInput({ workspace: dir, anchor: "x" }), depsAt()),
      ).rejects.toThrow("anchor.exact 缺失");
      await expect(
        addSidecarAnnotation(addInput({ workspace: dir, note: "n".repeat(2_001) }), depsAt()),
      ).rejects.toThrow(`note 超过 ${String(NOTE_LIMIT)} 字符`);
      await expect(
        addSidecarAnnotation(addInput({ workspace: dir, author: "robot" }), depsAt()),
      ).rejects.toThrow("author 只接受 user/agent");
      await expect(
        resolveSidecarAnnotation({ workspace: dir, file: FILE, id: "an-x" }, depsAt()),
      ).rejects.toThrow("批注不存在：an-x");
      await expect(
        replySidecarAnnotation({ workspace: dir, file: FILE, id: "an-x", note: "r" }, depsAt()),
      ).rejects.toThrow("批注不存在：an-x");
      await expect(
        deleteSidecarAnnotation({ workspace: dir, file: FILE, id: "an-x" }, depsAt()),
      ).rejects.toThrow("批注不存在：an-x");
      await expect(
        replySidecarAnnotation(
          { workspace: dir, file: FILE, id, note: "n".repeat(2_001) },
          depsAt(),
        ),
      ).rejects.toThrow(`note 超过 ${String(NOTE_LIMIT)} 字符`);
    });
  });

  it("should refuse the annotation over the store cap", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const full = Array.from({ length: 10_000 }, (_u, index) =>
        record({ id: `an-${String(index)}` }),
      );
      await seedSidecar(dir, FILE, full);

      const code = await codeOfAsync(() =>
        addSidecarAnnotation(addInput({ workspace: dir }), depsAt()),
      );

      expect(code).toBe("invalid_payload");
      await expect(addSidecarAnnotation(addInput({ workspace: dir }), depsAt())).rejects.toThrow(
        `批注数超过 ${String(10_000)} 上限`,
      );
    });
  });
});

const namesAt = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(await sidecarDirAt(dir));
  } catch {
    return [];
  }
};

// Root ignores permission bits entirely, so chmod-based refusal tests can't run under it.
const isRoot = (): boolean => typeof process.geteuid === "function" && process.geteuid() === 0;

// Probe the temp dir once per test: on a case-insensitive filesystem the folded spelling
// of the probe exists right after writing it.
const isCaseInsensitiveFs = async (dir: string): Promise<boolean> => {
  await writeFile(join(dir, "hr-case-probe"), "x");
  return await existsAt(join(dir, "HR-CASE-PROBE"));
};

describe("resolve · reopen · delete · reply", () => {
  const addOne = async (dir: string): Promise<string> => {
    await seed(dir);
    const added = await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());
    return added.annotation.id;
  };

  it("should mark an annotation resolved with the injected timestamp", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);
      const resolved = await resolveSidecarAnnotation(
        { workspace: dir, file: FILE, id, resolutionNote: "已处理" },
        depsAt(),
      );

      expect(resolved.annotation).toMatchObject({
        id,
        status: "resolved",
        resolvedAt: AT_ISO,
        resolutionNote: "已处理",
      });
      expect(resolved.changed).toBe(true);
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());
      expect(listed.annotations[0]?.annotation.status).toBe("resolved");
    });
  });

  it("should resolve without a resolution note", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);
      const resolved = await resolveSidecarAnnotation({ workspace: dir, file: FILE, id }, depsAt());

      expect(resolved.annotation.status).toBe("resolved");
      expect(resolved.annotation.resolutionNote).toBeUndefined();
      expect("resolutionNote" in resolved.annotation).toBe(false);
    });
  });

  it("should return a resolved annotation to pending", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);
      await resolveSidecarAnnotation({ workspace: dir, file: FILE, id }, depsAt());
      const reopened = await reopenSidecarAnnotation({ workspace: dir, file: FILE, id }, depsAt());

      expect(reopened.annotation.status).toBe("pending");
      expect(reopened.annotation.resolvedAt).toBe(AT_ISO);
      expect(reopened.changed).toBe(true);
    });
  });

  it("should leave sibling annotations untouched when patching one by id", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const first = await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());
      const second = await addSidecarAnnotation(
        addInput({ workspace: dir, note: "第二条" }),
        depsAt(),
      );

      await resolveSidecarAnnotation(
        { workspace: dir, file: FILE, id: first.annotation.id },
        depsAt(),
      );
      await reopenSidecarAnnotation(
        { workspace: dir, file: FILE, id: first.annotation.id },
        depsAt(),
      );
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(listed.annotations.map((entry) => entry.annotation.status)).toEqual([
        "pending",
        "pending",
      ]);
      expect(listed.annotations[0]?.annotation.id).toBe(first.annotation.id);
      expect(listed.annotations[1]?.annotation.id).toBe(second.annotation.id);
    });
  });

  it("should report not_found for an unknown id on every id-keyed op", async () => {
    await withWorkspace(async (dir) => {
      await addOne(dir);

      for (const run of [
        () => resolveSidecarAnnotation({ workspace: dir, file: FILE, id: "an-x" }, depsAt()),
        () => reopenSidecarAnnotation({ workspace: dir, file: FILE, id: "an-x" }, depsAt()),
        () => deleteSidecarAnnotation({ workspace: dir, file: FILE, id: "an-x" }, depsAt()),
        () =>
          replySidecarAnnotation({ workspace: dir, file: FILE, id: "an-x", note: "r" }, depsAt()),
      ]) {
        expect(await codeOfAsync(run)).toBe("not_found");
      }
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());
      expect(listed.annotations).toHaveLength(1);
    });
  });

  it("should delete only the target annotation", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const first = await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());
      const second = await addSidecarAnnotation(
        addInput({ workspace: dir, note: "第二条" }),
        depsAt(),
      );

      const deleted = await deleteSidecarAnnotation(
        { workspace: dir, file: FILE, id: first.annotation.id },
        depsAt(),
      );

      expect(deleted.annotation.id).toBe(first.annotation.id);
      expect(deleted.changed).toBe(true);
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());
      expect(listed.annotations.map((entry) => entry.annotation.id)).toEqual([
        second.annotation.id,
      ]);
    });
  });

  it("should append a reply with a deterministic id and the injected timestamp", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);
      const result = await replySidecarAnnotation(
        { workspace: dir, file: FILE, id, note: "追问", author: "agent" },
        depsAt(),
      );

      expect(result.reply).toMatchObject({
        author: "agent",
        note: "追问",
        createdAt: AT_ISO,
      });
      expect(result.reply.id).toBe(
        replyIdOf({ annotationId: id, note: "追问", createdAt: AT_ISO, ordinal: 0 }),
      );
      expect(result.annotation.replies).toEqual([result.reply]);
      expect(result.changed).toBe(true);
    });
  });

  it("should reply to one annotation while leaving its sibling reply-free", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      await addSidecarAnnotation(addInput({ workspace: dir }), depsAt());
      const second = await addSidecarAnnotation(
        addInput({ workspace: dir, note: "第二条" }),
        depsAt(),
      );

      await replySidecarAnnotation(
        { workspace: dir, file: FILE, id: second.annotation.id, note: "回复二" },
        depsAt(),
      );
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(listed.annotations[0]?.annotation.replies).toEqual([]);
      expect(listed.annotations[1]?.annotation.replies).toHaveLength(1);
      expect(listed.annotations[1]?.annotation.replies[0]?.note).toBe("回复二");
    });
  });

  it("should accept a reply note at the limit and refuse one over", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);

      const atLimit = await replySidecarAnnotation(
        { workspace: dir, file: FILE, id, note: "r".repeat(NOTE_LIMIT) },
        depsAt(),
      );
      await expect(
        replySidecarAnnotation(
          { workspace: dir, file: FILE, id, note: "r".repeat(NOTE_LIMIT + 1) },
          depsAt(),
        ),
      ).rejects.toThrow(`note 超过 ${String(NOTE_LIMIT)} 字符`);

      expect(atLimit.reply.note).toHaveLength(NOTE_LIMIT);
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());
      expect(listed.annotations[0]?.annotation.replies).toHaveLength(1);
    });
  });

  it("should refuse a reply over the reply cap", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);
      const full = record({
        id,
        replies: Array.from({ length: 100 }, (_u, index) => ({
          id: `rp-${String(index)}`,
          author: "user",
          note: "r",
          createdAt: "t",
        })),
      });
      await seedSidecar(dir, FILE, [full]);

      await expect(
        replySidecarAnnotation({ workspace: dir, file: FILE, id, note: "r" }, depsAt()),
      ).rejects.toThrow(`回复数超过 ${String(100)} 上限`);
      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());
      expect(listed.annotations[0]?.annotation.replies).toHaveLength(100);
    });
  });
});

describe("listDocAnnotations · merged read", () => {
  it("should merge meta and sidecar entries in source order with relocation results", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const meta = await addAnnotation(
        { workspace: dir, file: FILE, nodeId: "hr-b", anchor: ANCHOR, note: "meta 批注" },
        depsAt(),
      );
      const side = await addSidecarAnnotation(
        addInput({ workspace: dir, note: "侧车批注" }),
        depsAt(),
      );

      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(listed.annotations.map((entry) => entry.source)).toEqual(["meta", "sidecar"]);
      expect(listed.annotations[0]?.annotation.id).toBe(meta.annotation.id);
      expect(listed.annotations[0]?.annotation.author).toBe("user");
      expect(listed.annotations[0]?.anchor).toEqual({ ok: true, start: 0, end: 3, via: "node" });
      expect(listed.annotations[1]?.annotation.id).toBe(side.annotation.id);
      expect(listed.diagnostics).toEqual([]);
      expect(readAnnotations(await readTextAt(join(dir, FILE))).annotations).toHaveLength(1);
    });
  });

  it("should let meta win on an id collision and add a diagnostic", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const meta = await addAnnotation(
        { workspace: dir, file: FILE, nodeId: "hr-b", anchor: ANCHOR, note: "meta 批注" },
        depsAt(),
      );
      await seedSidecar(dir, FILE, [record({ id: meta.annotation.id, note: "侧车同 id" })]);

      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(listed.annotations).toHaveLength(1);
      expect(listed.annotations[0]?.source).toBe("meta");
      expect(listed.diagnostics).toEqual([
        `批注 ${meta.annotation.id} 同时存在于 hr-meta 与侧车，以 hr-meta 为准，已忽略侧车条目`,
      ]);
    });
  });

  it("should surface meta and sidecar diagnostics together", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, MANAGED.replace('{"version":1', "{oops"));
      await mkdirAt(await sidecarDirAt(dir));
      await writeTextAt(await sidecarPathAt(dir), "{broken");

      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(listed.annotations).toEqual([]);
      expect(listed.diagnostics).toEqual([
        "hr-meta 不是合法 JSON 对象，按空批注处理",
        "侧车批注文件不是合法 JSON 对象，按空批注处理",
      ]);
    });
  });

  it("should locate sidecar entries on a foreign doc through selector and body fallback", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, FOREIGN);
      const hit = await addSidecarAnnotation(
        addInput({
          workspace: dir,
          selector: "body > div:nth-of-type(1) > p:nth-of-type(1)",
          anchor: { exact: "foreign", prefix: "", suffix: "", start: 0 },
        }),
        depsAt(),
      );
      await seedSidecar(dir, FILE, [
        record({
          id: "an-deadbeef",
          selector: "body > table:nth-of-type(9)",
          anchor: { exact: "again", prefix: "", suffix: "", start: 0 },
        }),
        {
          id: hit.annotation.id,
          selector: "body > div:nth-of-type(1) > p:nth-of-type(1)",
          anchor: { exact: "foreign", prefix: "", suffix: "", start: 0 },
          note: "hit",
          status: "pending",
          createdAt: "t",
          author: "user",
          replies: [],
        },
      ]);

      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(listed.annotations.map((entry) => entry.anchor.via)).toEqual(["body", "selector"]);
      expect(listed.annotations[0]?.anchor).toMatchObject({ ok: true, via: "body" });
      expect(listed.annotations[1]?.anchor).toMatchObject({ ok: true, via: "selector" });
    });
  });
});

describe("workspace edges", () => {
  it("should refuse a path outside the workspace", async () => {
    await withWorkspace(async (dir) => {
      const code = await codeOfAsync(() =>
        addSidecarAnnotation(addInput({ workspace: dir, file: "../escape.html" }), depsAt()),
      );

      expect(code).toBe("path_outside_workspace");
    });
  });

  it("should follow a symlinked workspace and store under the real .hreader", async () => {
    await withWorkspace(async (dir) => {
      const real = join(dir, "real");
      const alias = join(dir, "alias");
      await mkdirAt(real);
      await symlink(real, alias);
      await seed(real);

      const added = await addSidecarAnnotation(addInput({ workspace: alias }), depsAt());

      expect(added.annotation.id).toMatch(/^an-/u);
      const stored = await readTextAt(await sidecarPathAt(real));
      expect(JSON.parse(stored)).toMatchObject({ path: FILE });
    });
  });

  // chmod bits don't stop root: EACCES is only raised for real users. The io_failure mapping
  // itself is covered deterministically by the injected-fs failure tests (fs.fail("mkdir")).
  it.skipIf(isRoot())("should fail the write when .hreader is read-only", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const storeRoot = join(await realDirOf(dir), ".hreader");
      await mkdirAt(storeRoot);
      await chmod(storeRoot, 0o555);
      try {
        const code = await codeOfAsync(() =>
          addSidecarAnnotation(addInput({ workspace: dir }), depsAt()),
        );
        expect(code).toBe("io_failure");
      } finally {
        await chmod(storeRoot, 0o755);
      }
    });
  });

  it("should fail when the annotations dir is a file", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const storeRoot = join(await realDirOf(dir), ".hreader");
      await mkdirAt(storeRoot);
      await writeFile(join(storeRoot, "annotations"), "not a dir");

      const code = await codeOfAsync(() =>
        addSidecarAnnotation(addInput({ workspace: dir }), depsAt()),
      );

      expect(code).toBe("io_failure");
    });
  });

  it("should report not_a_file when the doc is deleted before the op", async () => {
    await withWorkspace(async (dir) => {
      const code = await codeOfAsync(() =>
        listDocAnnotations({ workspace: dir, file: FILE }, depsAt()),
      );

      expect(code).toBe("not_a_file");
    });
  });

  it.each([
    ["spaces", "my doc.html"],
    ["quotes", 'it"s.html'],
    ["percent escape", "%2e%2e.html"],
    ["backslashes", "a\\b.html"],
    ["CJK", "报告.html"],
  ])("should key the store by the exact relative path for %s names", async (_l, file) => {
    await withWorkspace(async (dir) => {
      await seed(dir, FOREIGN, file);
      await addSidecarAnnotation(addInput({ workspace: dir, file }), depsAt());

      const stored = JSON.parse(await readTextAt(await sidecarPathAt(dir, file))) as {
        path: string;
      };
      expect(stored.path).toBe(file);
    });
  });

  it("should resolve case-only path spellings however the filesystem folds case", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, FOREIGN, "Doc.html");
      // On a case-insensitive filesystem this second write lands on the same file.
      await seed(dir, FOREIGN, "doc.html");

      await addSidecarAnnotation(
        addInput({ workspace: dir, file: "Doc.html", note: "大写" }),
        depsAt(),
      );
      await addSidecarAnnotation(
        addInput({ workspace: dir, file: "doc.html", note: "小写" }),
        depsAt(),
      );

      if (await isCaseInsensitiveFs(dir)) {
        // APFS-style folding: realpath canonicalizes "doc.html" to the on-disk spelling
        // "Doc.html", so both spellings share one canonical store.
        const stored = JSON.parse(await readTextAt(await sidecarPathAt(dir, "Doc.html"))) as {
          path: string;
          annotations: { note: string }[];
        };
        expect(stored.path).toBe("Doc.html");
        expect(stored.annotations.map((entry) => entry.note)).toEqual(["大写", "小写"]);
        expect(await namesAt(dir)).toEqual([`${sha1Of("Doc.html")}.json`]);
        const listed = await listDocAnnotations({ workspace: dir, file: "doc.html" }, depsAt());
        expect(listed.annotations).toHaveLength(2);
      } else {
        // ext4-style: the two spellings are distinct files with distinct stores, and a
        // read through one spelling never sees the other's annotations.
        const upper = JSON.parse(await readTextAt(await sidecarPathAt(dir, "Doc.html"))) as {
          path: string;
          annotations: { note: string }[];
        };
        const lower = JSON.parse(await readTextAt(await sidecarPathAt(dir, "doc.html"))) as {
          path: string;
          annotations: { note: string }[];
        };
        expect(upper.path).toBe("Doc.html");
        expect(lower.path).toBe("doc.html");
        expect(upper.annotations.map((entry) => entry.note)).toEqual(["大写"]);
        expect(lower.annotations.map((entry) => entry.note)).toEqual(["小写"]);
        expect((await namesAt(dir)).sort()).toEqual(
          [`${sha1Of("Doc.html")}.json`, `${sha1Of("doc.html")}.json`].sort(),
        );
        const listedLower = await listDocAnnotations(
          { workspace: dir, file: "doc.html" },
          depsAt(),
        );
        const listedUpper = await listDocAnnotations(
          { workspace: dir, file: "Doc.html" },
          depsAt(),
        );
        expect(listedLower.annotations.map((entry) => entry.annotation.note)).toEqual(["小写"]);
        expect(listedUpper.annotations.map((entry) => entry.annotation.note)).toEqual(["大写"]);
      }
    });
  });

  it("should keep case-only spellings in separate stores when realpath does not fold", async () => {
    // Deterministic coverage for the case-sensitive branch on every platform: the fake fs
    // resolves each spelling to itself, exactly like a case-sensitive real filesystem.
    const fs = fakeFs({ "/ws/Doc.html": FOREIGN, "/ws/doc.html": FOREIGN });
    const deps = depsOf(fs.port, fixedClock(AT).clock, recordingSleep().sleep);
    const pathOf = (file: string): string => `/ws/.hreader/annotations/${sha1Of(file)}.json`;

    await addSidecarAnnotation(
      addInput({ workspace: "/ws", file: "Doc.html", note: "大写" }),
      deps,
    );
    await addSidecarAnnotation(
      addInput({ workspace: "/ws", file: "doc.html", note: "小写" }),
      deps,
    );

    const upper = JSON.parse(fs.textAt(pathOf("Doc.html"))) as {
      path: string;
      annotations: { note: string }[];
    };
    const lower = JSON.parse(fs.textAt(pathOf("doc.html"))) as {
      path: string;
      annotations: { note: string }[];
    };
    expect(upper.path).toBe("Doc.html");
    expect(lower.path).toBe("doc.html");
    expect(upper.annotations.map((entry) => entry.note)).toEqual(["大写"]);
    expect(lower.annotations.map((entry) => entry.note)).toEqual(["小写"]);
    const listedLower = await listDocAnnotations({ workspace: "/ws", file: "doc.html" }, deps);
    const listedUpper = await listDocAnnotations({ workspace: "/ws", file: "Doc.html" }, deps);
    expect(listedLower.annotations.map((entry) => entry.annotation.note)).toEqual(["小写"]);
    expect(listedUpper.annotations.map((entry) => entry.annotation.note)).toEqual(["大写"]);
  });

  it("should share one canonical store when the fs folds spellings to the same file", async () => {
    // The fake fs simulates APFS-style canonicalization with a symlink: realpath("doc.html")
    // resolves to the on-disk spelling "Doc.html", so both spellings share one store.
    const fs = fakeFs({ "/ws/Doc.html": FOREIGN });
    fs.state.links.set("/ws/doc.html", "/ws/Doc.html");
    const deps = depsOf(fs.port, fixedClock(AT).clock, recordingSleep().sleep);
    const canonical = `/ws/.hreader/annotations/${sha1Of("Doc.html")}.json`;

    await addSidecarAnnotation(
      addInput({ workspace: "/ws", file: "Doc.html", note: "大写" }),
      deps,
    );
    await addSidecarAnnotation(
      addInput({ workspace: "/ws", file: "doc.html", note: "小写" }),
      deps,
    );

    const stored = JSON.parse(fs.textAt(canonical)) as {
      path: string;
      annotations: { note: string }[];
    };
    expect(stored.path).toBe("Doc.html");
    expect(stored.annotations.map((entry) => entry.note)).toEqual(["大写", "小写"]);
    const listed = await listDocAnnotations({ workspace: "/ws", file: "doc.html" }, deps);
    expect(listed.annotations).toHaveLength(2);
  });
});
