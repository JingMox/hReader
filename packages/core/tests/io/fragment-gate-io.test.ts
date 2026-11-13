// 这层管：片段被拒时"文件一个字节都没动"的证明（真实 fs），错误码与报文都断。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile } from "../../src/io";
import { ARTICLE_DOC, DOC_FILE } from "./fixtures";
import { REJECTED_FRAGMENTS } from "./fragments";
import {
  codeOfAsync,
  namesInOrEmpty,
  readBytesAt,
  realDirOf,
  sha1Of,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "./harness";

const deps = nodePatchDeps;

describe("片段校验失败 · 不落盘", () => {
  it.each(REJECTED_FRAGMENTS)(
    "should keep the file byte-identical after rejecting $code",
    async ({ fragment, code }) => {
      await withWorkspace(async (dir) => {
        const file = join(dir, DOC_FILE);
        await writeTextAt(file, ARTICLE_DOC);
        const before = sha256Of(await readBytesAt(file));
        const actual = await codeOfAsync(() =>
          patchFile(
            {
              workspace: dir,
              file: DOC_FILE,
              request: { targetId: "p1", action: "replace", html: fragment },
            },
            deps,
          ),
        );
        const storeDir = join(await realDirOf(dir), ".hreader");

        expect(actual).toBe(code);
        expect(sha256Of(await readBytesAt(file))).toBe(before);
        expect(await namesInOrEmpty(join(storeDir, "history", sha1Of(DOC_FILE)))).toEqual([]);
        expect(await namesInOrEmpty(join(storeDir, "locks"))).toEqual([]);
      });
    },
  );
});

describe("片段校验失败 · 不落盘（续）", () => {
  it("should reject a forbidden fragment on every action, not just replace", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, ARTICLE_DOC);
      const before = sha256Of(await readBytesAt(file));
      for (const action of ["append", "insert_after", "replace"] as const) {
        const code = await codeOfAsync(() =>
          patchFile(
            {
              workspace: dir,
              file: DOC_FILE,
              request: { targetId: "p1", action, html: "<script>x</script>" },
            },
            deps,
          ),
        );
        expect(code).toBe("forbidden_content");
      }
      expect(sha256Of(await readBytesAt(file))).toBe(before);
    });
  });
});
