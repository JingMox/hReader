// Drift pins: the extension's copy of core protocol knowledge (endpoint table, event names, patch
// actions, error codes) is checked item by item against the **source text** of `packages/core/src`.
// A rename or an add/remove on either side turns this red.
// Every pin carries a nonzero lower bound: extracting the set can come back empty when the extension
// builds paths via template strings, and `every()` on a vacuous set must not stay green.

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

/** Extracts the string value of `export const NAME = '...'` / `"..."` (both quote styles; quotes inside the value are not matched). */
const coreStringConstOf = (source: string, name: string): string | undefined =>
  (new RegExp(`export const ${name} = '([^']*)';`).exec(source) ??
    new RegExp(`export const ${name} = "([^"]*)";`).exec(source))?.[1]?.replace(/\\n/g, "\n");

const quotedOf = (text: string): readonly string[] =>
  [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");

/** Segment lists like `["api","doc",DOC_PARAM,"model"]` in `routes.ts`, where placeholders are constant names. */
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

describe("endpoint table ↔ routes.ts", () => {
  it("should parse a nonzero number of routes out of core, each carrying auth (the bound stops vacuous truth)", async () => {
    const source = await coreFileOf("server/routes.ts");
    const routes = await coreRoutesOf();
    expect(routes.length).toBeGreaterThanOrEqual(15);
    // The parsed count must equal the number of `route(` occurrences in the source: with only a lower bound,
    // a route whose kind/auth moved to a constant or wrapped line would silently drop out of the extracted set
    // while the bound stayed green. No exact 17 either — a new route must not false-red.
    expect((source.match(/(?:^|\s)route\(/g) ?? []).length).toBe(routes.length);
    expect(routes.every((route) => AUTH_KINDS.has(route.auth))).toBe(true);
    expect(routes.map(routeKeyOf)).toContain("GET api/events cookie");
  });

  it("should find every endpoint the extension uses verbatim in core's route table (method + segments + auth)", async () => {
    const keys = new Set((await coreRoutesOf()).map(routeKeyOf));
    const endpoints: readonly (readonly [string, Endpoint])[] = Object.entries(ENDPOINTS);
    expect(endpoints.length).toBeGreaterThanOrEqual(5);
    for (const [name, endpoint] of endpoints) {
      expect(keys, `端点 ${name} 在 core 里不存在`).toContain(routeKeyOf(endpoint));
    }
  });

  it("should collect a nonempty set of path segments and match core's placeholder convention", () => {
    const segments = new Set(
      Object.values(ENDPOINTS).flatMap((endpoint: Endpoint) => endpoint.segments),
    );
    expect(segments.size).toBeGreaterThanOrEqual(6);
    expect(segments).toContain("api");
    expect(segments).toContain(":docId");
    expect(segments).toContain("events");
  });
});

describe("frame literals ↔ event-ring.ts", () => {
  const frameNames = ["READY_FRAME", "KEEP_ALIVE_FRAME"] as const;

  it("should extract exactly 2 frame literals from core (the bound catches an empty regex) and behave correctly on the real values", async () => {
    const source = await coreFileOf("server/event-ring.ts");
    const frames = frameNames.map((name) => ({ name, literal: coreStringConstOf(source, name) }));
    expect(frames.filter((frame) => frame.literal !== undefined)).toHaveLength(2);
    const ready = frames[0]?.literal ?? "";
    const keepAlive = frames[1]?.literal ?? "";
    // `retry:` in the `ready` frame is the extension's reconnect cadence (drift turns this red; the extension's own copy is not compared against itself).
    expect(ready).toContain(`retry: ${String(RECONNECT_MS)}`);
    // Comment/heartbeat frames must not emit: feed the real literals to the decoder and watch what comes out.
    const decoder = createSseDecoder();
    expect(decoder.push(new TextEncoder().encode(keepAlive))).toEqual([]);
    expect(decoder.push(new TextEncoder().encode(ready))).toEqual([
      { id: "0", data: '{"type":"ready"}' },
    ]);
  });
});

describe("event names ↔ publish() literals", () => {
  it("should parse a nonzero number of published event names from core, including doc.changed", async () => {
    const names = await eventNamesOf();
    expect(names.size).toBeGreaterThanOrEqual(4);
    expect(names).toContain("doc.changed");
  });

  it("should find every business type the extension subscribes to among core's publish literals", async () => {
    const names = await eventNamesOf();
    expect(BUSINESS_EVENT_TYPES.size).toBeGreaterThanOrEqual(4);
    for (const type of BUSINESS_EVENT_TYPES) {
      expect(names, `事件 ${type} 在 core 里没有发布点`).toContain(type);
    }
  });
});

describe("patch actions ↔ PatchAction", () => {
  it("should match the five actions of `ops/patch-node/constants.ts`'s union type verbatim", async () => {
    const source = await coreFileOf("ops/patch-node/constants.ts");
    const union = /export type PatchAction =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const actions = quotedOf(union);
    expect(actions.length).toBeGreaterThanOrEqual(5);
    expect([...PATCH_ACTIONS].sort()).toEqual([...actions].sort());
  });
});

describe("error codes ↔ HrErrorCode", () => {
  it("should cover every error code in core and contain no code core lacks", async () => {
    const source = await coreFileOf("hr-error.ts");
    const union = /export type HrErrorCode =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const codes = quotedOf(union);
    expect(codes.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(ERROR_TEXTS).sort()).toEqual([...codes].sort());
  });
});

describe("directory-scan sentinel", () => {
  /** The extension reading a directory itself = core's theme-discovery rule written a third time. */
  const SCANNERS = ["readdir", "readdirSync", "opendir"];

  it("should not scan directories in the extension source; style ids come only via `GET /api/theme` (the endpoint-table entry)", async () => {
    const source = await readFile(new URL("../pi-hreader.ts", import.meta.url), "utf8");
    expect(source.length).toBeGreaterThan(1000);
    for (const scanner of SCANNERS) {
      expect(source, `扩展里出现了目录扫描：${scanner}`).not.toContain(scanner);
    }
    // The endpoint table is the only place holding path literals (and the drift pins target it), so this checks the value it builds.
    expect(pathOf(ENDPOINTS.themes)).toBe("/api/theme");
    expect(pathOf(ENDPOINTS.style)).toBe("/api/style");
    const routes = await coreFileOf("server/routes.ts");
    expect(routes).toContain('["api", "theme"], "none"');
    expect(routes).toContain('["api", "style"], "cookie+csrf"');
  });
});
