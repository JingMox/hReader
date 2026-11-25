// 这层管：路径逃逸的四类入口（词法 `..`、绝对路径、符号链接文件/目录、`.hreader`）与不落盘证明。

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";

import { nodePatchDeps, patchFile } from "../../src/io";
import { HrError } from "../../src/hr-error";
import { resolveTarget } from "../../src/io/paths";
import { ARTICLE_DOC, DOC_FILE } from "./fixtures";
import {
  codeOfAsync,
  existsAt,
  historyDirAt,
  mkdirAt,
  namesInOrEmpty,
  readBytesAt,
  sha1Of,
  sha256Of,
  symlinkAt,
  withWorkspace,
  writeTextAt,
} from "./harness";

const deps = nodePatchDeps;

const attempt = (dir: string, file: string): Promise<string> =>
  codeOfAsync(() =>
    patchFile(
      { workspace: dir, file, request: { targetId: "p1", action: "replace", html: "<p>x</p>" } },
      deps,
    ),
  );

const withOutsideDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "hr-outside-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("路径逃逸 · 词法与绝对路径", () => {
  it("should reject ../ and never create the target", async () => {
    await withWorkspace(async (dir) => {
      const name = `escape-${sha1Of(dir).slice(0, 8)}.html`;
      expect(await attempt(dir, `../${name}`)).toBe("path_outside_workspace");
      expect(await existsAt(join(dir, "..", name))).toBe(false);
      expect(await existsAt(join(dir, ".hreader"))).toBe(false);
    });
  });

  it("should reject an absolute path even when it points inside the workspace", async () => {
    await withWorkspace(async (dir) => {
      expect(await attempt(dir, join(dir, "abs.html"))).toBe("path_outside_workspace");
      expect(await existsAt(join(dir, "abs.html"))).toBe(false);
    });
  });

  it("should reject the workspace itself and its store directory", async () => {
    await withWorkspace(async (dir) => {
      await mkdirAt(join(dir, ".hreader"));
      await writeTextAt(join(dir, ".hreader", "pwn.html"), ARTICLE_DOC);
      expect(await attempt(dir, ".")).toBe("path_outside_workspace");
      expect(await attempt(dir, ".hreader/pwn.html")).toBe("path_outside_workspace");
      expect(await existsAt(join(dir, ".hreader", "history"))).toBe(false);
    });
  });
});

describe("路径逃逸 · 符号链接", () => {
  it("should reject a file link that resolves outside and leave it byte-identical", async () => {
    await withOutsideDir(async (outside) => {
      const secret = join(outside, "secret.html");
      await writeTextAt(secret, ARTICLE_DOC);
      const before = sha256Of(await readBytesAt(secret));
      await withWorkspace(async (dir) => {
        await symlinkAt(secret, join(dir, "link.html"));
        expect(await attempt(dir, "link.html")).toBe("path_outside_workspace");
        expect(sha256Of(await readBytesAt(secret))).toBe(before);
        expect(await existsAt(join(dir, ".hreader"))).toBe(false);
      });
    });
  });

  it("should reject a directory link that resolves outside", async () => {
    await withOutsideDir(async (outside) => {
      const doc = join(outside, DOC_FILE);
      await writeTextAt(doc, ARTICLE_DOC);
      const before = sha256Of(await readBytesAt(doc));
      await withWorkspace(async (dir) => {
        await symlinkAt(outside, join(dir, "out"));
        expect(await attempt(dir, `out/${DOC_FILE}`)).toBe("path_outside_workspace");
        expect(sha256Of(await readBytesAt(doc))).toBe(before);
      });
    });
  });
});

describe("路径逃逸 · 符号链接（续）", () => {
  it("should accept an inside link and key history by the real relative path", async () => {
    await withWorkspace(async (dir) => {
      await mkdirAt(join(dir, "sub"));
      await writeTextAt(join(dir, "sub", DOC_FILE), ARTICLE_DOC);
      await symlinkAt(join(dir, "sub", DOC_FILE), join(dir, "link.html"));
      const result = await patchFile(
        {
          workspace: dir,
          file: "link.html",
          // 行内片段才能落在 <p> 里（append 的容器就是目标自己）；这条用例只关心符号链接下历史键名。
          request: { targetId: "p1", action: "append", html: "<b>加</b>" },
        },
        deps,
      );

      expect(result.changed).toBe(true);
      const names = await namesInOrEmpty(await historyDirAt(dir, "sub/post.html"));
      expect(names).toHaveLength(1);
    });
  });
});

describe("路径逃逸 · 不是普通文件", () => {
  it("should reject missing, empty-name, directory and dangling links", async () => {
    await withWorkspace(async (dir) => {
      await mkdirAt(join(dir, "folder.html"));
      await symlinkAt(join(dir, "gone.html"), join(dir, "dangling.html"));

      expect(await attempt(dir, "missing.html")).toBe("not_a_file");
      expect(await attempt(dir, "")).toBe("not_a_file");
      expect(await attempt(dir, "folder.html")).toBe("not_a_file");
      expect(await attempt(dir, "dangling.html")).toBe("not_a_file");
      expect(await existsAt(join(dir, "missing.html"))).toBe(false);
      expect(await existsAt(join(dir, ".hreader"))).toBe(false);
    });
  });

  it("should reject a relative workspace outright", async () => {
    expect(await attempt("relative/ws", "a.html")).toBe("invalid_input");
  });
});

describe("错误报文 · 可读性", () => {
  const errorOf = async (run: () => Promise<unknown>): Promise<HrError> => {
    try {
      await run();
    } catch (error: unknown) {
      if (error instanceof HrError) return error;
      throw error;
    }
    throw new Error("期望 HrError 但没有抛");
  };

  it("should name the workspace in a non-absolute-workspace rejection", async () => {
    const error = await errorOf(() =>
      resolveTarget({ workspace: "relative/ws", file: "a.html" }, deps.fs),
    );

    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("relative/ws");
  });

  it("should keep the file-facing rejections readable", async () => {
    await withWorkspace(async (dir) => {
      const empty = await errorOf(() => resolveTarget({ workspace: dir, file: "" }, deps.fs));
      expect(empty.code).toBe("not_a_file");
      expect(empty.message).toContain("file");

      const nul = await errorOf(() =>
        resolveTarget({ workspace: dir, file: "a\0b.html" }, deps.fs),
      );
      expect(nul.code).toBe("invalid_request");
      expect(nul.message).toContain("NUL");

      const abs = await errorOf(() =>
        resolveTarget({ workspace: dir, file: join(dir, "x.html") }, deps.fs),
      );
      expect(abs.code).toBe("path_outside_workspace");
      expect(abs.message).toContain("绝对路径");
    });
  });

  it("should carry the resolved path and workspace in a lexical escape rejection", async () => {
    await withWorkspace(async (dir) => {
      const error = await errorOf(() =>
        resolveTarget({ workspace: dir, file: "../out.html" }, deps.fs),
      );

      expect(error.code).toBe("path_outside_workspace");
      expect(error.message).toContain("workspace");
      expect(error.message).toContain("逃出");
    });
  });

  it("should name .hreader when the store directory is targeted", async () => {
    await withWorkspace(async (dir) => {
      await mkdirAt(join(dir, ".hreader"));
      await writeTextAt(join(dir, ".hreader", "x.html"), ARTICLE_DOC);

      const error = await errorOf(() =>
        resolveTarget({ workspace: dir, file: ".hreader/x.html" }, deps.fs),
      );

      expect(error.code).toBe("path_outside_workspace");
      expect(error.message).toContain(".hreader");
    });
  });

  it("should name the workspace boundary for a symlink escape", async () => {
    await withOutsideDir(async (outside) => {
      const secret = join(outside, "secret.html");
      await writeTextAt(secret, ARTICLE_DOC);
      await withWorkspace(async (dir) => {
        await symlinkAt(secret, join(dir, "link.html"));

        const error = await errorOf(() =>
          resolveTarget({ workspace: dir, file: "link.html" }, deps.fs),
        );

        expect(error.code).toBe("path_outside_workspace");
        expect(error.message).toContain("workspace");
      });
    });
  });

  it("should name the input when a directory is passed as file", async () => {
    await withWorkspace(async (dir) => {
      await mkdirAt(join(dir, "folder.html"));

      const error = await errorOf(() =>
        resolveTarget({ workspace: dir, file: "folder.html" }, deps.fs),
      );

      expect(error.code).toBe("not_a_file");
      expect(error.message).toContain("folder.html");
    });
  });
});
