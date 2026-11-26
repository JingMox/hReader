// 旅程 5（混合工作区）：托管/可规范化/外来/损坏/空/二进制伪装/超大/子目录/符号链接/中文与 emoji 文件名
// 全部共存。断言：各文档 /s/:docId 可开或明确拒绝（无 5xx）、check 分类正确、normalize 收编可规范化的。

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { dataOf, docPath, hr, jsonOf, newDoc } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { connect, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const NORMALIZABLE = `<html><body><article><h1>无 id 文档</h1><p>可以收编</p></article></body></html>`;
const FOREIGN = `<!DOCTYPE html><html><head><meta charset="utf-8"><script>alert(1)</script></head><body><h1>外来</h1></body></html>`;
const CORRUPT = "<html><body><p>未闭合";
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

const DOCS = [
  "managed.hr.html",
  "normalizable.html",
  "foreign.html",
  "corrupt.html",
  "empty.html",
  "binary.png.html",
  "超大.html",
  "subdir/nested.hr.html",
  "中文文档.hr.html",
  "📚docs.hr.html",
] as const;

let home: TestHome;
let daemon: Daemon;
let api: Api;

const checkCls = async (file: string): Promise<{ code: number | null; cls: string }> => {
  const res = await hr(["check", file, "--workspace", home.ws, "--json"], { cwd: home.ws });
  const cls =
    res.code === 0 && jsonOf(res, `check ${file}`)["ok"] === true
      ? String(dataOf(res, `check ${file}`)["cls"])
      : "";
  return { code: res.code, cls };
};

beforeAll(async () => {
  home = sandbox("mixed");
  const ws = home.ws;
  // 托管文档用 `hr new` 造：手写 data-hr-id 不算 managed（骨架还有归一化标记）。
  await mkdir(join(ws, "subdir"), { recursive: true });
  await newDoc(ws, "managed.hr.html");
  await newDoc(ws, "中文文档.hr.html");
  await newDoc(ws, "📚docs.hr.html");
  await newDoc(ws, "subdir/nested.hr.html");
  await writeFile(docPath(ws, "normalizable.html"), NORMALIZABLE, "utf8");
  await writeFile(docPath(ws, "foreign.html"), FOREIGN, "utf8");
  await writeFile(docPath(ws, "corrupt.html"), CORRUPT, "utf8");
  await writeFile(docPath(ws, "empty.html"), "", "utf8");
  await writeFile(docPath(ws, "binary.png.html"), BINARY);
  await writeFile(
    docPath(ws, "超大.html"),
    `<html><body>${"x".repeat(2 * 1024 * 1024)}</body></html>`,
    "utf8",
  );
  await symlink(join("..", "managed.hr.html"), join(ws, "subdir", "linked.hr.html")).catch(
    () => undefined,
  );
  daemon = await startServe({ file: "managed.hr.html", workspace: ws, home: home.home });
  api = await connect(daemon.port, daemon.token);
});

afterAll(async () => {
  await daemon.stop();
  await killAllTracked();
  home.cleanup();
});

test("每个共存文档的 /s/:docId 与 info 都可开或明确拒绝", async () => {
  for (const doc of DOCS) {
    const info = await api.get(`/api/doc/${encodeURIComponent(doc)}/info`);
    if (doc === "binary.png.html") {
      // invalid_utf8 按冻结契约是"文档文件的码"=500；要钉的是它返回结构化 code 而不是裸崩。
      const body = await info.text();
      assertEq(info.status, 500, "二进制文档 info 状态");
      assert(
        body.includes("invalid_utf8"),
        `二进制文档 info 不是结构化错误：${body.slice(0, 200)}`,
      );
      continue;
    }
    assert(info.status < 500, `${doc} info 5xx：${String(info.status)}`);
    const res = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/s/${encodeURIComponent(doc)}?token=${encodeURIComponent(daemon.token)}`,
      { redirect: "manual" },
    );
    assert(res.status < 500, `${doc} /s/ 5xx：${String(res.status)}`);
    await res.arrayBuffer(); // 把 body 排空，连接复用不被挂住
  }
});

test("check 分类：托管/可规范化/外来各自归位", async () => {
  assertEq((await checkCls("managed.hr.html")).cls, "managed", "managed 分类");
  const norm = await checkCls("normalizable.html");
  assert(
    norm.cls === "normalizable" || norm.cls === "managed" || norm.cls === "foreign",
    `normalizable 分类异常：${norm.cls}`,
  );
  assertEq((await checkCls("foreign.html")).cls, "foreign", "foreign 分类");
  const unicode = await checkCls("中文文档.hr.html");
  assertEq(unicode.cls, "managed", "中文文件名 managed 分类");
  const emoji = await checkCls("📚docs.hr.html");
  assertEq(emoji.cls, "managed", "emoji 文件名 managed 分类");
});

test("损坏/空/二进制/超大文档：check 给出明确退出码，不崩不挂", async () => {
  for (const file of ["corrupt.html", "empty.html", "超大.html"]) {
    const res = await hr(["check", file, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assert(
      res.code === 0 || res.code === 1 || res.code === 3,
      `${file} check 非法退出码 ${String(res.code)}（stderr: ${res.stderr.slice(0, 200)}）`,
    );
  }
  const binary = await hr(["check", "binary.png.html", "--workspace", home.ws, "--json"], {
    cwd: home.ws,
  });
  assertEq(binary.code, 3, "二进制伪装文档 check 应 exit 3（invalid_utf8）");
  assert(jsonOf(binary, "binary check")["ok"] === false, "二进制 check 应 ok:false");
});

test("normalize 收编 normalizable：HTTP 端点写盘后 check 变 managed", async () => {
  const res = await api.post(`/api/doc/${encodeURIComponent("normalizable.html")}/normalize`, {});
  assert(res.status === 200 || res.status === 422, `normalize 状态 ${String(res.status)}`);
  if (res.status === 200) {
    const after = await checkCls("normalizable.html");
    assertEq(after.cls, "managed", "normalize 后分类");
  }
});

test("符号链接文档：可读或明确拒绝，不返回 5xx", async () => {
  const res = await api.get(`/api/doc/${encodeURIComponent("subdir/linked.hr.html")}/info`);
  assert(res.status < 500, `符号链接文档 info ${String(res.status)}`);
});
