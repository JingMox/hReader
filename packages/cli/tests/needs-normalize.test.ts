// 这层管：`needs_normalize` 的**所有入口**。
//
// 判据来自用户症状，不是实现形状：手写文档（无 `data-hr-id`）交给任何一条读命令，
// 都必须**报同一个码、给同一句可执行的下一步**，不许一个入口静默空转、另一个换一句措辞。
// 入口 = outline / read / patch；serve 另有一条 HTTP 侧（409）。

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir, type CliResult } from "./harness";
import { homeOf, startServe } from "./serve-harness";

/** 手写文档：结构完整、语言合法，唯独没有任何 `data-hr-id`。 */
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

/** 跑一条命令并收敛成"退出码 + 信封"：`--json` 与码要一起看才判得出是哪种拒绝。 */
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

describe("needs_normalize · 三条读改入口报同一个码", () => {
  it("should refuse outline, read and patch with the same code and the same next step", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      for (const args of REFUSALS) {
        const { code, envelope } = await refusalOf(dir, args);
        const message = textOf(fieldOf(envelope, "message"));

        expect(fieldOf(envelope, "code")).toBe("needs_normalize");
        // 退出码 2 = "前置条件不满足，按提示改一次即可"（不是 IO 失败 3）。
        expect(code).toBe(2);
        // 三条都指向**同一条**命令：`hr normalize <file> --write`。
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
      // 拒绝时不许顺手把文件改了。
      expect(after.stderr).toBe(before.stderr);
      expect(after.code).toBe(2);
    });
  });
});

interface SiblingAnswer {
  status: number;
  body: unknown;
}

// 同一 workspace 下再点开一份手写文档：HTTP 侧必须与 CLI 同码，页面才能显示"先 normalize"。
const askSibling = async (serve: { url: string; token: string }): Promise<SiblingAnswer> => {
  // `serve.url` 是程序自己印的带 `?token=` 的那串：用 URL 解析拼兄弟路径，不能字符串直接接。
  const response = await fetch(new URL("s/draft.html", serve.url), {
    headers: { cookie: `hr=${serve.token}` },
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

describe("needs_normalize · serve 的 CLI 与 HTTP 两面", () => {
  it("should refuse to serve a handwritten document, naming the command to run", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      const result = checked(
        await runCli(["serve", "draft.html", "--port", "0", "--home", homeOf(dir), "--json"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(2);
      const envelope = parseJsonLine(result.stdout);
      expect(fieldOf(envelope, "code")).toBe("needs_normalize");
      // `--json` 只有一条通道：可粘贴的命令与文件名都在 message 里，stderr 留空。
      expect(fieldOf(envelope, "message")).toMatch(/hr normalize \S*draft\.html --write/u);
      expect(result.stderr).toBe("");
      // 不许把内部函数名丢给用户（原始症状）。
      expect(fieldOf(envelope, "message")).not.toContain("injectNodeIds");
    });
  });

  it("should answer 409 needs_normalize when the reader asks for a handwritten sibling", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const serve = await startServe("ok.html", { json: true, home: homeOf(dir), cwd: dir });
      try {
        const { status, body } = await askSibling(serve);

        expect(status).toBe(409);
        expect(fieldOf(body, "code")).toBe("needs_normalize");
        expect(textOf(fieldOf(body, "message"))).toContain("hr normalize");
      } finally {
        await serve.stop();
      }
    }, 30_000);
  });
});
