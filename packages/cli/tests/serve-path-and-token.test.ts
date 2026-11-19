// 这层管：`hr serve` 印出来的那一行能不能直接用——文档路径要认得出来，地址要自带凭据、点开有正文。
//
// 起站点一律在进程内（`run()` 的 `stop` 句柄收尾），前台跑 `serve` 子进程会把整棵套件挂死。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run } from "../src/run";
import { fieldOf, parseJsonLine, withTempDir } from "./harness";
import { stopHandle } from "./serve-helpers";

const BODY = "下一季度只做三件事。";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="hr-c">' + BODY + "</p></article>",
  "</body></html>",
].join("\n");

interface Serving {
  readonly text: string;
  readonly code: number;
  readonly stop: () => void;
}

/** 起一个真站点并等它把首行印出来；调用方负责 `stop()`。 */
const serveOf = async (dir: string, extra: readonly string[] = []): Promise<Serving> => {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "d.html"), DOC);
  const out: string[] = [];
  const { stop, stopped } = stopHandle();
  const code = await run(["serve", "d.html", "--port", "0", "--home", home, ...extra], {
    cwd: dir,
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
    stop: stopped,
  });
  return { text: out.join(""), code, stop };
};

/** 人读行必须认得文档，且那串地址原样打开就有正文。 */
const expectHumanLine = async (dir: string): Promise<void> => {
  const served = await serveOf(dir);
  try {
    expect(served.code).toBe(0);
    // 人读行必须出现用户给的那个路径：`serving <dir> on …`（workspace 绝对路径）认不出是哪篇文档。
    expect(served.text).toMatch(
      /^serving d\.html on http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+ \(pid \d+\)\n$/u,
    );
    const url = /on (http:\/\/\S+)/u.exec(served.text)?.[1] ?? "";

    // 照用户的做法：把那串地址原样打开。首访用 token 换 cookie 并 302 回干净的 `/`。
    const first = await fetch(url, { redirect: "manual" });
    expect(first.status).toBe(302);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^hr=[\w-]+$/u);

    // 首页必须有正文：打开了却没内容是这条命令最伤人的失败方式。
    const page = await fetch(new URL("/", url), { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(BODY);
  } finally {
    served.stop();
  }
};

/** `--json` 地址自带凭据，且不夹 workspace 绝对路径。 */
const expectJsonUrl = async (dir: string): Promise<void> => {
  const served = await serveOf(dir, ["--json"]);
  try {
    expect(served.code).toBe(0);
    const envelope = parseJsonLine(served.text);
    const url = String(fieldOf(fieldOf(envelope, "data"), "url"));

    // 裸地址粘进浏览器就是 401：凭据必须在这一串里，让程序替人拼 token 只会拼错。
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
    expect(url).toContain(`:${String(fieldOf(fieldOf(envelope, "data"), "port"))}/`);
    // 地址里不能混进 workspace 绝对路径：它是给浏览器用的，路径段只该是 `/`。
    expect(url).not.toContain(dir);
  } finally {
    served.stop();
  }
};

describe("serve · 印出来的路径与凭据", () => {
  it("should name the document in the human line and serve its body behind that URL", async () => {
    await withTempDir(async (dir) => {
      await expectHumanLine(dir);
    }, 30_000);
  });

  it("should put the token in --json.data.url and keep the path relative", async () => {
    await withTempDir(async (dir) => {
      await expectJsonUrl(dir);
    }, 30_000);
  });
});
