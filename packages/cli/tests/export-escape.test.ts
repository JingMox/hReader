// 这层管：`hr export --out` 的越界判定（四种逃逸形状 + "不落盘" + 已存在目标仍报 3）；不起 Chrome。

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { ARTICLE } from "./export-print-fixtures";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

/**
 * 越界落点必须**唯一**：`$TMPDIR/escape.html` 是几个测试文件共用的固定名，
 * 谁真写出去一次就会把别人"应不存在"的用例带红。用例自己也不留脏文件。
 */
const escapeNameOf = (stem: string): string =>
  `hr-escape-${stem}-${String(process.pid)}-${String(Date.now())}.html`;

const runOutOf = (dir: string, out: string, extra: readonly string[] = []) =>
  runCli(["export", "doc.html", "--out", out, "--json", ...extra, "--workspace", dir], {
    cwd: dir,
  });

/** 两件事一起断：退出码/错误码对了，且**一个字节都没落盘**。 */
const expectEscapedOf = (
  result: { readonly code: number | null; readonly stdout: string },
  target: string,
): void => {
  expect(result.code).toBe(3);
  expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
  expect(existsSync(target)).toBe(false);
  expect(() => readFileSync(target)).toThrow(/ENOENT/u);
};

/** workspace 外的兄弟目录：越界落点都放这儿，用完连目录一起删。 */
const withSibling = async (run: (sibling: string) => Promise<void>): Promise<void> => {
  const sibling = mkdtempSync(join(tmpdir(), "hr-escape-sib-"));
  try {
    await run(sibling);
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
};

const seed = (dir: string): void => {
  writeFileSync(join(dir, "doc.html"), ARTICLE);
};

/**
 * `isInside` 用路径段边界，`startsWith` 用字符前缀：只有"兄弟目录共享前缀"（`w` vs `w-evil`）
 * 能把两者分开。`..` 已经被 Node 归一，前缀比较在那些输入上与 `isInside` 等价。
 */
const withPrefixPair = async (
  run: (workspace: string, evil: string) => Promise<void>,
): Promise<void> => {
  const base = mkdtempSync(join(tmpdir(), "hr-escape-prefix-"));
  try {
    const workspace = join(base, "w");
    const evil = join(base, "w-evil");
    mkdirSync(workspace);
    mkdirSync(evil);
    writeFileSync(join(workspace, "doc.html"), ARTICLE);
    await run(workspace, evil);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

describe("hr export · --out 相对逃逸", () => {
  it("should refuse `../x.html` and never create it", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const name = escapeNameOf("rel");
      try {
        expectEscapedOf(await runOutOf(dir, `../${name}`), join(dir, "..", name));
      } finally {
        rmSync(join(dir, "..", name), { force: true });
      }
    });
  });

  // 目标**先存在**：越界判定必须抢在 `file_exists`（exit 1）前面，否则错误码与退出码都是错的。
  it("should still say path_outside_workspace when the outside target exists", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const name = escapeNameOf("exists");
      const target = join(dir, "..", name);
      writeFileSync(target, "旧");
      try {
        const result = await runOutOf(dir, `../${name}`);
        expect(result.code).toBe(3);
        expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
        // 没被覆盖：越界判定没走成"允许写"，也没把外面那份当成自家目标。
        expect(readFileSync(target, "utf8")).toBe("旧");
      } finally {
        rmSync(target, { force: true });
      }
    });
  });
});

describe("hr export · --out 绝对路径", () => {
  it("should refuse an absolute --out outside the default workspace", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const target = join(tmpdir(), escapeNameOf("abs"));
      try {
        // 不传 `--workspace`：默认取 cwd，`$TMPDIR` 下另一个临时目录仍在它外面。
        expectEscapedOf(await runOutOf(dir, target), target);
      } finally {
        rmSync(target, { force: true });
      }
    });
  });
});

describe("hr export · --out 遍历归一", () => {
  it("should refuse `dir/../sibling/x.html`", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await withSibling(async (sibling) => {
        const name = escapeNameOf("traverse");
        const result = await runOutOf(dir, `../${basename(sibling)}/${name}`);
        expectEscapedOf(result, join(sibling, name));
      });
    });
  });

  // 判定看的是归一后的落点，不是字符串前缀：`..` 又走回来就该放行。
  it("should allow escaping and coming back into the workspace", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await withSibling(async (sibling) => {
        const back = `../${basename(sibling)}/../${basename(dir)}/back.html`;
        expect((await runOutOf(dir, back)).code).toBe(0);
        expect(existsSync(join(dir, "back.html"))).toBe(true);
      });
    });
  });
});

describe("hr export · --out 共享前缀兄弟目录", () => {
  it("should refuse `<base>/w-evil/x.html` and leave the existing file untouched", async () => {
    await withPrefixPair(async (workspace, evil) => {
      const target = join(evil, "x.html");
      writeFileSync(target, "旧");
      const result = await runOutOf(workspace, join(evil, "x.html"));
      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
      // 未被探、未被覆写：共享前缀不能让越界判定把外面那份当成自家目标。
      expect(readFileSync(target, "utf8")).toBe("旧");
    });
  });

  it("should refuse the same prefix sibling even when the target does not exist", async () => {
    await withPrefixPair(async (workspace, evil) => {
      const target = join(evil, "new.html");
      expectEscapedOf(await runOutOf(workspace, target), target);
      expect(readdirSync(evil)).toEqual([]);
    });
  });
});

describe("hr export · --out 符号链接", () => {
  it("should refuse a workspace-internal symlink that points outside", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await withSibling(async (outside) => {
        symlinkSync(outside, join(dir, "link"));
        const result = await runOutOf(dir, "link/x.html");
        expect(result.code).toBe(3);
        expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
        expect(readdirSync(outside)).toEqual([]);
      });
    });
  });
});
