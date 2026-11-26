// 这层管：漂移钉子——扩展里那份 core 协议知识（端点表、事件名、patch 动作、错误码）
// 逐项对回 `packages/core/src` 的**源文件文本**。任一侧改名/增删 → 这里红。
// 每个钉子都带非零下界：扩展侧用模板字符串拼路径时提取集可能为空，`every()` 真空为真必须被下界挡住。

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  BUSINESS_EVENT_TYPES,
  createSseDecoder,
  ENDPOINTS,
  ERROR_TEXTS,
  PATCH_ACTIONS,
  pathOf,
  RECONNECT_MS,
  type Endpoint,
} from "../pi-hreader.ts";

const coreFileOf = async (relative: string): Promise<string> =>
  readFile(new URL(`../../core/src/${relative}`, import.meta.url), "utf8");

/** 取 `export const NAME = '...'` / `"..."` 的字符串值（两种引号都用，值里的引号不参与匹配）。 */
const coreStringConstOf = (source: string, name: string): string | undefined =>
  (new RegExp(`export const ${name} = '([^']*)';`).exec(source) ??
    new RegExp(`export const ${name} = "([^"]*)";`).exec(source))?.[1]?.replace(/\\n/g, "\n");

const quotedOf = (text: string): readonly string[] =>
  [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");

/** `routes.ts` 里 `["api","doc",DOC_PARAM,"model"]` 这样的段列表，占位符是常量名。 */
const constantOf = (source: string, name: string): string | undefined =>
  new RegExp(`const ${name} = "(:[^"]+)";`).exec(source)?.[1];

const segmentsOf = (list: string, source: string): readonly string[] =>
  list
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => {
      const literal = /^"([^"]*)"$/.exec(token);
      return literal?.[1] ?? constantOf(source, token) ?? token;
    });

const routeKeyOf = (route: ParsedRoute): string =>
  `${route.method} ${route.segments.join("/")} ${route.auth}`;

interface ParsedRoute {
  readonly method: string;
  readonly segments: readonly string[];
  readonly auth: string;
}

const AUTH_KINDS: ReadonlySet<string> = new Set(["none", "cookie", "token", "cookie+csrf"]);

const coreRoutesOf = async (): Promise<readonly ParsedRoute[]> => {
  const source = await coreFileOf("server/routes.ts");
  const pattern = /route\(\s*"(GET|POST)",\s*\[([^\]]*)\],\s*"([^"]+)",\s*"([^"]+)",?\s*\)/g;
  return [...source.matchAll(pattern)].map((match) => ({
    method: match[1] ?? "",
    segments: segmentsOf(match[2] ?? "", source),
    auth: match[3] ?? "",
  }));
};

const eventNamesOf = async (): Promise<ReadonlySet<string>> => {
  const files = ["server/runtime.ts", "server/server.ts", "server/hub.ts"];
  const texts = await Promise.all(files.map((file) => coreFileOf(file)));
  const names = texts.flatMap((text) =>
    [...text.matchAll(/publish\(\s*"([a-zA-Z.]+)"/g)].map((match) => match[1] ?? ""),
  );
  return new Set(names);
};

describe("端点表 ↔ routes.ts", () => {
  it("core 的路由表解析出非零条，且每条都带 auth（下界挡住真空为真）", async () => {
    const source = await coreFileOf("server/routes.ts");
    const routes = await coreRoutesOf();
    expect(routes.length).toBeGreaterThanOrEqual(15);
    // 解析出的条数必须等于源文件里 `route(` 的出现次数：只卡下界时，core 把某条的 kind/auth 换成
    // 常量或换行写法，那条就会静默退出提取集而下界仍然绿。不卡精确值 17——新增路由不该假红。
    expect((source.match(/(?:^|\s)route\(/g) ?? []).length).toBe(routes.length);
    expect(routes.every((route) => AUTH_KINDS.has(route.auth))).toBe(true);
    expect(routes.map(routeKeyOf)).toContain("GET api/events cookie");
  });

  it("扩展用的每个端点都能在 core 的路由表里逐字找到（方法 + 段 + auth）", async () => {
    const keys = new Set((await coreRoutesOf()).map(routeKeyOf));
    const endpoints: readonly (readonly [string, Endpoint])[] = Object.entries(ENDPOINTS);
    expect(endpoints.length).toBeGreaterThanOrEqual(5);
    for (const [name, endpoint] of endpoints) {
      expect(keys, `端点 ${name} 在 core 里不存在`).toContain(routeKeyOf(endpoint));
    }
  });

  it("扩展侧拼路径用到的段集合非空，且占位符写法与 core 一致", () => {
    const segments = new Set(
      Object.values(ENDPOINTS).flatMap((endpoint: Endpoint) => endpoint.segments),
    );
    expect(segments.size).toBeGreaterThanOrEqual(6);
    expect(segments).toContain("api");
    expect(segments).toContain(":docId");
    expect(segments).toContain("events");
  });
});

describe("帧字面量 ↔ event-ring.ts", () => {
  const frameNames = ["READY_FRAME", "KEEP_ALIVE_FRAME"] as const;

  it("core 的两个帧字面量提取到恰好 2 条（下界防正则抓空），且扩展对真值的行为正确", async () => {
    const source = await coreFileOf("server/event-ring.ts");
    const frames = frameNames.map((name) => ({ name, literal: coreStringConstOf(source, name) }));
    expect(frames.filter((frame) => frame.literal !== undefined)).toHaveLength(2);
    const ready = frames[0]?.literal ?? "";
    const keepAlive = frames[1]?.literal ?? "";
    // `ready` 帧里的 `retry:` 就是扩展的重连节奏（漂了这里就红，不靠扩展自己的副本自比）。
    expect(ready).toContain(`retry: ${String(RECONNECT_MS)}`);
    // 注释/心跳帧必须不出帧：往解码器里嚼真字面量，看它吐什么。
    const decoder = createSseDecoder();
    expect(decoder.push(new TextEncoder().encode(keepAlive))).toEqual([]);
    expect(decoder.push(new TextEncoder().encode(ready))).toEqual([
      { id: "0", data: '{"type":"ready"}' },
    ]);
  });
});

describe("事件名 ↔ publish() 字面量", () => {
  it("core 发布的事件名解析出非零个，且包含 doc.changed", async () => {
    const names = await eventNamesOf();
    expect(names.size).toBeGreaterThanOrEqual(4);
    expect(names).toContain("doc.changed");
  });

  it("扩展订阅的每个业务类型都在 core 的 publish 字面量里", async () => {
    const names = await eventNamesOf();
    expect(BUSINESS_EVENT_TYPES.size).toBeGreaterThanOrEqual(4);
    for (const type of BUSINESS_EVENT_TYPES) {
      expect(names, `事件 ${type} 在 core 里没有发布点`).toContain(type);
    }
  });
});

describe("patch 动作 ↔ PatchAction", () => {
  it("五个动作与 `ops/patch-node/constants.ts` 的联合类型逐字相同", async () => {
    const source = await coreFileOf("ops/patch-node/constants.ts");
    const union = /export type PatchAction =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const actions = quotedOf(union);
    expect(actions.length).toBeGreaterThanOrEqual(5);
    expect([...PATCH_ACTIONS].sort()).toEqual([...actions].sort());
  });
});

describe("错误码 ↔ HrErrorCode", () => {
  it("码表覆盖 core 的每个错误码，且不含 core 里没有的码", async () => {
    const source = await coreFileOf("hr-error.ts");
    const union = /export type HrErrorCode =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const codes = quotedOf(union);
    expect(codes.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(ERROR_TEXTS).sort()).toEqual([...codes].sort());
  });
});

describe("目录扫描哨兵", () => {
  /** 扩展自己读目录 = 把 core 的主题发现规则又写了一遍（第三份拼写）。 */
  const SCANNERS = ["readdir", "readdirSync", "opendir"];

  it("扩展源码不读目录，风格 id 只经 `GET /api/theme`（端点表里的那一条）", async () => {
    const source = await readFile(new URL("../pi-hreader.ts", import.meta.url), "utf8");
    expect(source.length).toBeGreaterThan(1000);
    for (const scanner of SCANNERS) {
      expect(source, `扩展里出现了目录扫描：${scanner}`).not.toContain(scanner);
    }
    // 路径字面量只有端点表一处（漂移钉子钉的也是它），所以这里查的是端点表拼出来的值。
    expect(pathOf(ENDPOINTS.themes)).toBe("/api/theme");
    expect(pathOf(ENDPOINTS.style)).toBe("/api/style");
    const routes = await coreFileOf("server/routes.ts");
    expect(routes).toContain('["api", "theme"], "none"');
    expect(routes).toContain('["api", "style"], "cookie+csrf"');
  });
});
