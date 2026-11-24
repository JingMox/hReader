// G3 补齐：M2.3 新增 ops 的几个**可达**未覆盖分支。
// 每条都走真盘 + 真 deps（不 mock），断言"code + 文件字节"两件事。
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeAnchor } from "../../src/annotations/model";
import { nodePatchDeps } from "../../src/io/node-fs";
import { addAnnotation, resolveAnnotation } from "../../src/ops/annotation-ops";
import { revertLast } from "../../src/ops/revert-op";
import {
  codeOfAsync,
  fixedClock,
  readBytesAt,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "../io/harness";

const FILE = "doc.html";
const META = '<script id="hr-meta" type="application/json">{"version":1,"annotations":[]}</script>';
const DOC = [
  "<!doctype html>",
  '<html><body><article data-hr-id="hr-a"><p data-hr-id="hr-b">正文一</p><p data-hr-id="hr-c">正文二</p></article>',
  META,
  "</body></html>",
].join("\n");

const AT = Date.now() + 60_000;
const depsAt = () => ({ ...nodePatchDeps, ...fixedClock(AT) });

const ANCHOR = { exact: "正文一", prefix: "", suffix: "", start: 0 };

const seed = async (dir: string): Promise<string> => {
  const path = join(dir, FILE);
  await writeTextAt(path, DOC);
  return path;
};

const input = (patch: Readonly<Record<string, unknown>> = {}) => ({
  workspace: "",
  file: FILE,
  nodeId: "hr-b",
  anchor: ANCHOR,
  note: "第一条",
  ...patch,
});

describe("normalizeAnchor · 形状拒绝", () => {
  it("should return undefined when exact is not a string", () => {
    // `stringOf` 只认字符串：数字/对象/null 都不是"作者写短了"，而是**输入形状错**。
    expect(normalizeAnchor({ exact: 42 })).toBeUndefined();
    expect(normalizeAnchor({ exact: null })).toBeUndefined();
    expect(normalizeAnchor({ exact: { text: "x" } })).toBeUndefined();
  });

  it("should return undefined when the record has no exact at all", () => {
    expect(normalizeAnchor({ prefix: "a" })).toBeUndefined();
  });
});

describe("addAnnotation · anchor 不是对象", () => {
  it("should reject a string anchor with invalid_payload and keep the bytes", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir);
      const before = sha256Of(await readBytesAt(path));

      const code = await codeOfAsync(() =>
        addAnnotation(input({ workspace: dir, anchor: "e30=" }), depsAt()),
      );

      expect(code).toBe("invalid_payload");
      expect(sha256Of(await readBytesAt(path))).toBe(before);
    });
  });
});

describe("resolveAnnotation · 多条批注里只动目标那条", () => {
  it("should leave the other annotations byte-identical", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const first = await addAnnotation(input({ workspace: dir }), depsAt());
      const second = await addAnnotation(
        input({
          workspace: dir,
          nodeId: "hr-c",
          anchor: { exact: "正文二", prefix: "", suffix: "", start: 0 },
          note: "第二条",
        }),
        depsAt(),
      );

      const result = await resolveAnnotation(
        { workspace: dir, file: FILE, id: second.annotation.id },
        depsAt(),
      );

      expect(result.changed).toBe(true);
      expect(result.annotation.id).toBe(second.annotation.id);
      expect(result.annotation.status).toBe("resolved");
      // 第一条必须原样保留（不是"整体重写后碰巧一样"）：id/note/anchor 逐字段比对。
      const text = (await readBytesAt(join(dir, FILE))).toString("utf8");
      const meta = text.slice(text.indexOf(META.slice(0, 24)));
      expect(meta).toContain(`"id":"${first.annotation.id}"`);
      expect(meta).toContain('"note":"第一条"');
      expect(meta).toContain('"status":"pending"');
    });
  });
});

describe("revertLast · 非 undo 错误原样抛出", () => {
  it("should rethrow a path error untouched instead of masking it as nothing_to_undo", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);

      const code = await codeOfAsync(() =>
        revertLast({ workspace: dir, file: "../escape.html" }, nodePatchDeps),
      );

      expect(code).toBe("path_outside_workspace");
    });
  });
});
