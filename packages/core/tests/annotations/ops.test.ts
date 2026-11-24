// 这层管：`ops/annotation-ops.ts` + `ops/revert-op.ts` 的落盘编排（AC2.1/AC2.3/AC2.5）。
// 全部走真盘：篇幅断言用 sha256，不靠"看起来没变"。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readAnnotations } from "../../src/annotations";
import { patchFile } from "../../src/io";
import { nodePatchDeps } from "../../src/io/node-fs";
import {
  addAnnotation,
  listAnnotations,
  reopenAnnotation,
  resolveAnnotation,
} from "../../src/ops/annotation-ops";
import { revertLast } from "../../src/ops/revert-op";
import {
  codeOfAsync,
  fixedClock,
  historyNamesOf,
  readBytesAt,
  readTextAt,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "../io/harness";

const FILE = "doc.html";
const META = '<script id="hr-meta" type="application/json">{"version":1,"annotations":[]}</script>';
const DOC = [
  "<!doctype html>",
  '<html><body><article data-hr-id="hr-a"><p data-hr-id="hr-b">正文一</p></article>',
  META,
  "</body></html>",
].join("\r\n");

const ANCHOR = { exact: "正文一", prefix: "", suffix: "", start: 0 };
// 快照名按时间戳排序：注入时钟必须比真实时钟"更新"，否则 undo 会挑到旧快照（见报告待裁定）。
const AT = Date.now() + 60_000;
const AT_ISO = new Date(AT).toISOString();

const depsAt = () => ({ ...nodePatchDeps, ...fixedClock(AT) });

const seed = async (dir: string, html: string = DOC): Promise<string> => {
  const path = join(dir, FILE);
  await writeTextAt(path, html);
  return path;
};

const withoutMeta = (html: string): string =>
  html.replace(/<script id="hr-meta"[^>]*>[\s\S]*?<\/script>\r?\n?/u, "");

const addInput = (patch: Record<string, unknown> = {}) => ({
  workspace: "",
  file: FILE,
  nodeId: "hr-b",
  anchor: ANCHOR,
  note: "第一条",
  ...patch,
});

const addOne = async (dir: string): Promise<string> => {
  await seed(dir);
  const added = await addAnnotation(addInput({ workspace: dir }), depsAt());
  return added.annotation.id;
};

describe("addAnnotation · 正文包络（AC2.5）", () => {
  it("should keep every body byte and add exactly one meta entry", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const before = await readBytesAt(path);
      const result = await addAnnotation(addInput({ workspace: dir }), depsAt());
      const after = await readBytesAt(path);
      const parsed = readAnnotations(after.toString("utf8"));

      expect(withoutMeta(after.toString("utf8"))).toBe(withoutMeta(before.toString("utf8")));
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.annotations[0]).toMatchObject({
        nodeId: "hr-b",
        note: "第一条",
        status: "pending",
        createdAt: AT_ISO,
      });
      expect(result.revision).toBe(sha256Of(after).slice(0, 16));
      expect(await historyNamesOf(dir, FILE)).toHaveLength(1);
    });
  });

  it("should insert a meta script without touching the body when the file has none", async () => {
    await withWorkspace(async (dir) => {
      const html = '<html><body><p data-hr-id="hr-b">正文一</p></body></html>';
      const path = await seed(dir, html);

      await addAnnotation(addInput({ workspace: dir }), depsAt());

      const after = await readTextAt(path);
      expect(withoutMeta(after)).toBe(html);
      expect(readAnnotations(after).annotations).toHaveLength(1);
    });
  });
});

describe("addAnnotation · 重复提交与拒绝", () => {
  it("should give a repeated submit a second id instead of swallowing it", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const first = await addAnnotation(addInput({ workspace: dir }), depsAt());
      const second = await addAnnotation(addInput({ workspace: dir }), depsAt());

      // 裁定 #5：同位置同句也必须是两条（重复提交不能被吞）。
      expect(second.annotation.id).not.toBe(first.annotation.id);
      const listed = await listAnnotations({ workspace: dir, file: FILE }, depsAt());
      expect(listed.annotations.map((item) => item.id)).toEqual([
        first.annotation.id,
        second.annotation.id,
      ]);
      expect((await readTextAt(path)).match(/"note":"第一条"/gu)).toHaveLength(2);
    });
  });

  it.each([
    ["empty nodeId", { nodeId: "" }],
    ["empty exact", { anchor: { ...ANCHOR, exact: "" } }],
    ["note over 2000", { note: "n".repeat(2001) }],
  ])("should reject %s with invalid_payload and no write", async (_label, patch) => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const before = await readBytesAt(path);
      const code = await codeOfAsync(() =>
        addAnnotation(addInput({ workspace: dir, ...patch }), depsAt()),
      );

      expect(code).toBe("invalid_payload");
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(before));
      expect(await historyNamesOf(dir, FILE)).toEqual([]);
    });
  });
});

describe("addAnnotation · 超长即截断", () => {
  it("should clamp an over-long exact to 500 instead of rejecting", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const exact = "e".repeat(501);

      await addAnnotation(addInput({ workspace: dir, anchor: { ...ANCHOR, exact } }), depsAt());

      const [annotation] = readAnnotations(await readTextAt(path)).annotations;
      expect(annotation?.anchor.exact).toHaveLength(500);
      expect(await historyNamesOf(dir, FILE)).toHaveLength(1);
    });
  });
});

describe("resolve · 状态机", () => {
  it("should mark an annotation resolved with the injected timestamp", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);
      const result = await resolveAnnotation(
        { workspace: dir, file: FILE, id, resolutionNote: "已处理" },
        depsAt(),
      );
      const [annotation] = readAnnotations(await readTextAt(join(dir, FILE))).annotations;

      expect(annotation).toMatchObject({
        id,
        status: "resolved",
        resolvedAt: AT_ISO,
        resolutionNote: "已处理",
      });
      expect(result.changed).toBe(true);
    });
  });

  it("should report not_found for an unknown id and keep bytes intact", async () => {
    await withWorkspace(async (dir) => {
      await addOne(dir);
      const path = join(dir, FILE);
      const before = await readBytesAt(path);
      const code = await codeOfAsync(() =>
        resolveAnnotation({ workspace: dir, file: FILE, id: "an-deadbeef" }, depsAt()),
      );

      expect(code).toBe("not_found");
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(before));
    });
  });
});

describe("reopen / list", () => {
  it("should return a resolved annotation to pending", async () => {
    await withWorkspace(async (dir) => {
      const id = await addOne(dir);
      await resolveAnnotation({ workspace: dir, file: FILE, id }, depsAt());
      await reopenAnnotation({ workspace: dir, file: FILE, id }, depsAt());

      const [annotation] = readAnnotations(await readTextAt(join(dir, FILE))).annotations;
      expect(annotation?.status).toBe("pending");
      expect(annotation?.id).toBe(id);
    });
  });

  it("should list annotations and pass diagnostics through", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, DOC.replace('{"version":1', "{oops"));
      const listed = await listAnnotations({ workspace: dir, file: FILE }, nodePatchDeps);

      expect(listed.annotations).toEqual([]);
      expect(listed.diagnostics).toEqual(["hr-meta 不是合法 JSON 对象，按空批注处理"]);
    });
  });
});

describe("revertLast · 与 patch 共用一条快照链", () => {
  it("should restore the exact original bytes and then report nothing_to_undo", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const before = await readBytesAt(path);
      await addAnnotation(addInput({ workspace: dir }), depsAt());
      await revertLast({ workspace: dir, file: FILE }, nodePatchDeps);

      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(before));
      expect(await historyNamesOf(dir, FILE)).toEqual([]);
      const code = await codeOfAsync(() =>
        revertLast({ workspace: dir, file: FILE }, nodePatchDeps),
      );
      expect(code).toBe("nothing_to_undo");
    });
  });

  it("should undo the annotation first and the patch second", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const original = await readBytesAt(path);
      await patchFile(
        {
          workspace: dir,
          file: FILE,
          request: { targetId: "hr-a", action: "append", html: "<p>x</p>" },
        },
        nodePatchDeps,
      );
      const afterPatch = await readBytesAt(path);
      await addAnnotation(addInput({ workspace: dir }), depsAt());

      await revertLast({ workspace: dir, file: FILE }, nodePatchDeps);
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(afterPatch));
      await revertLast({ workspace: dir, file: FILE }, nodePatchDeps);
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(original));
    });
  });
});

describe("addAnnotation · anchor 结构缺失", () => {
  it("should reject an empty exact with invalid_payload and leave bytes alone", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const before = await readBytesAt(path);
      const code = await codeOfAsync(() =>
        addAnnotation(
          addInput({ workspace: dir, anchor: { exact: "", prefix: "", suffix: "", start: 0 } }),
          depsAt(),
        ),
      );

      expect(code).toBe("invalid_payload");
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(before));
    });
  });

  it("should not touch a snapshot when the annotation is rejected", async () => {
    await withWorkspace(async (dir) => {
      await codeOfAsync(() =>
        addAnnotation(addInput({ workspace: dir, note: "n".repeat(2001) }), depsAt()),
      );

      expect(await historyNamesOf(dir, FILE)).toEqual([]);
    });
  });
});
