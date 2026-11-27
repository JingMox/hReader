// This layer owns the sidecar-annotation HTTP surface: `/api/doc/<docId>/sidecar`
// (merged meta+sidecar read) and the five write commands. Auth layering is the
// same as every other doc route; HTML bytes are never touched by a sidecar write;
// a successful write broadcasts `doc.annotations`, a failed one broadcasts nothing.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serializeSidecarFile, type SidecarAnnotation } from "../../src/annotations";
import { bodyTextOf } from "../../src/annotations/body-text";
import { parseHtml } from "../../src/html/parse";
import { sha1Of } from "../io/harness";
import {
  cookieOf,
  defaultSeed,
  httpCall,
  jsonBodyOf,
  openSse,
  withServer,
  type HttpResponse,
  type TestServer,
} from "./harness";
import { withPost } from "./wire";

// defaultSeed's DOC is managed: <article data-hr-id="hr-a"> with three id'd blocks,
// body text is a CJK title plus two run-together blocks.
const NORMALIZABLE =
  "<!doctype html><html><body><article><p>可归一文本</p></article></body></html>";
const FOREIGN =
  "<!doctype html><html><body><div><p>foreign text</p><p>again</p></div></body></html>";

const classSeed = (workspace: string): void => {
  defaultSeed(workspace);
  writeFileSync(join(workspace, "normal.html"), NORMALIZABLE, "utf8");
  writeFileSync(join(workspace, "foreign.html"), FOREIGN, "utf8");
};

interface ClassCase {
  readonly docId: string;
  readonly exact: string;
  readonly selector: string;
}

/** Every op × every doc class: the cases differ only in doc, anchor and selector. */
const CLASSES: readonly ClassCase[] = [
  {
    docId: "doc.html",
    exact: "正文一",
    selector: "body > article:nth-of-type(1) > p:nth-of-type(1)",
  },
  {
    docId: "normal.html",
    exact: "可归一文本",
    selector: "body > article:nth-of-type(1) > p:nth-of-type(1)",
  },
  {
    docId: "foreign.html",
    exact: "foreign text",
    selector: "body > div:nth-of-type(1) > p:nth-of-type(1)",
  },
];

const sidecarPathOf = (ctx: TestServer, docId: string): string =>
  join(ctx.workspace, ".hreader", "annotations", `${sha1Of(docId)}.json`);

const seedRecords = (
  ctx: TestServer,
  docId: string,
  records: readonly SidecarAnnotation[],
): void => {
  mkdirSync(join(ctx.workspace, ".hreader", "annotations"), { recursive: true });
  writeFileSync(sidecarPathOf(ctx, docId), serializeSidecarFile(docId, records), "utf8");
};

const record = (patch: Partial<SidecarAnnotation> = {}): SidecarAnnotation => ({
  id: "an-00000000",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "x", prefix: "", suffix: "", start: 0 },
  note: "n",
  status: "pending",
  createdAt: "t",
  author: "user",
  replies: [],
  ...patch,
});

/** A record minus the listed keys — for seeded records that must carry no locating info. */
const withoutKeys = (source: SidecarAnnotation, keys: readonly string[]): SidecarAnnotation => {
  const copy = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(copy).filter(([key]) => !keys.includes(key)),
  ) as unknown as SidecarAnnotation;
};

const postSidecar = async (
  ctx: TestServer,
  docId: string,
  tail = "",
  body: unknown = {},
): Promise<HttpResponse> =>
  httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${docId}/sidecar${tail}`,
    headers: withPost(ctx.token),
    body: JSON.stringify(body),
  });

const addBody = (
  exact: string,
  selector?: string,
  note = "批注",
): Readonly<Record<string, unknown>> => ({
  anchor: { exact, prefix: "", suffix: "", start: 0 },
  ...(selector === undefined ? {} : { selector }),
  note,
});

const getSidecar = async (ctx: TestServer, docId: string): Promise<HttpResponse> =>
  httpCall(ctx.port, {
    path: `/api/doc/${docId}/sidecar`,
    headers: { cookie: cookieOf(ctx.token) },
  });

interface WireRelocationOk {
  readonly ok: true;
  readonly start: number;
  readonly end: number;
  readonly via: string;
}

interface WireRelocationLost {
  readonly ok: false;
  readonly reason: string;
}

interface WireEntry {
  readonly id: string;
  readonly source: string;
  readonly relocation: WireRelocationOk | WireRelocationLost;
  readonly status: string;
  readonly replies: readonly unknown[];
  readonly resolutionNote?: string;
}

interface WireList {
  readonly annotations: readonly WireEntry[];
  readonly diagnostics: readonly string[];
}

const fileStateOf = (path: string): { readonly bytes: Buffer; readonly mtimeMs: number } => ({
  bytes: readFileSync(path),
  mtimeMs: statSync(path).mtimeMs,
});

const bodyTextAt = (path: string): string => bodyTextOf(parseHtml(readFileSync(path, "utf8")));

describe("sidecar routes · auth", () => {
  it("should answer 401 without a cookie on the merged read", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/api/doc/doc.html/sidecar" });

      expect(response.status).toBe(401);
      expect(response.body).toContain("unauthorized");
    }, classSeed);
  });

  it("should answer 401 without a cookie on a write", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/sidecar",
        headers: { "x-hr-csrf": "1", "content-type": "application/json" },
        body: JSON.stringify(addBody("正文一")),
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("unauthorized");
    }, classSeed);
  });

  it("should answer 403 without the CSRF header on every write", async () => {
    await withServer(async (ctx) => {
      const tails = [
        "",
        "/an-00000000/resolve",
        "/an-00000000/reopen",
        "/an-00000000/reply",
        "/an-00000000/delete",
      ];
      for (const tail of tails) {
        const response = await httpCall(ctx.port, {
          method: "POST",
          path: `/api/doc/doc.html/sidecar${tail}`,
          headers: { cookie: cookieOf(ctx.token), "content-type": "application/json" },
          body: "{}",
        });

        expect(response.status).toBe(403);
        expect(response.body).toContain("forbidden_origin");
      }
    }, classSeed);
  });

  it("should answer 403 for Origin: null — the null exception is /f/-only", async () => {
    await withServer(async (ctx) => {
      const read = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/sidecar",
        headers: { cookie: cookieOf(ctx.token), origin: "null" },
      });
      const write = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/sidecar",
        headers: { ...withPost(ctx.token), origin: "null" },
        body: JSON.stringify(addBody("正文一")),
      });

      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
    }, classSeed);
  });

  it("should answer 404 for an unknown document", async () => {
    await withServer(async (ctx) => {
      const read = await getSidecar(ctx, "missing.html");
      const write = await postSidecar(ctx, "missing.html", "", addBody("x"));
      const keyed = await postSidecar(ctx, "missing.html", "/an-00000000/resolve");

      expect(read.status).toBe(404);
      expect(read.body).toContain("not_a_file");
      expect(write.status).toBe(404);
      expect(write.body).toContain("not_a_file");
      expect(keyed.status).toBe(404);
      expect(keyed.body).toContain("not_a_file");
    }, classSeed);
  });

  it("should answer 404 for an unknown annotation id", async () => {
    await withServer(async (ctx) => {
      for (const op of ["resolve", "reopen", "delete"]) {
        const response = await postSidecar(ctx, "doc.html", `/an-deadbeef/${op}`);
        expect(response.status).toBe(404);
        expect(response.body).toContain("not_found");
      }
      const reply = await postSidecar(ctx, "doc.html", "/an-deadbeef/reply", { note: "hi" });
      expect(reply.status).toBe(404);
      expect(reply.body).toContain("not_found");
    }, classSeed);
  });
});

describe("sidecar routes · merged read", () => {
  it("should return an empty merged view on a fresh document", async () => {
    await withServer(async (ctx) => {
      const response = await getSidecar(ctx, "doc.html");

      expect(response.status).toBe(200);
      const body = jsonBodyOf(response) as WireList;
      expect(body.annotations).toEqual([]);
      expect(body.diagnostics).toEqual([]);
    }, classSeed);
  });

  it("should merge meta and sidecar entries with source tags and relocation", async () => {
    await withServer(async (ctx) => {
      // One meta entry via the existing route, one sidecar entry via the new one:
      // the merged view must show both with their respective sources.
      const meta = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/annotations",
        headers: withPost(ctx.token),
        body: JSON.stringify({
          nodeId: "hr-c",
          anchor: { exact: "正文一", prefix: "", suffix: "", start: 2 },
          note: "meta note",
        }),
      });
      expect(meta.status).toBe(201);
      const added = await postSidecar(ctx, "doc.html", "", addBody("正文一", CLASSES[0]?.selector));
      expect(added.status).toBe(201);

      const body = jsonBodyOf(await getSidecar(ctx, "doc.html")) as WireList;

      expect(body.annotations).toHaveLength(2);
      expect(body.annotations.map((entry) => entry.source)).toEqual(["meta", "sidecar"]);
      for (const entry of body.annotations) expect(entry.relocation.ok).toBe(true);
    }, classSeed);
  });
});

describe("sidecar routes · add basis", () => {
  it("should answer 400 invalid_payload when the add carries no selector at all", async () => {
    // The wire has no nodeId field, so an add with neither selector nor nodeId
    // has no position basis — the op's own check rejects it before a file lands.
    await withServer(async (ctx) => {
      const response = await postSidecar(ctx, "doc.html", "", {
        anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
        note: "n",
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
      expect(existsSync(sidecarPathOf(ctx, "doc.html"))).toBe(false);
    }, classSeed);
  });
});

describe("sidecar routes · docId in body", () => {
  it("should accept a docId that agrees with the path on every write", async () => {
    await withServer(async (ctx) => {
      const added = await postSidecar(ctx, "doc.html", "", {
        docId: "doc.html",
        ...addBody("正文一", CLASSES[0]?.selector),
      });
      expect(added.status).toBe(201);
      const id = (jsonBodyOf(added) as { id: string }).id;

      for (const op of ["resolve", "reopen", "delete"]) {
        const response = await postSidecar(ctx, "doc.html", `/${id}/${op}`, {
          docId: "doc.html",
        });
        expect(response.status).toBe(200);
      }
      const reply = await postSidecar(ctx, "doc.html", "", addBody("正文二", CLASSES[0]?.selector));
      const replyId = (jsonBodyOf(reply) as { id: string }).id;
      const replied = await postSidecar(ctx, "doc.html", `/${replyId}/reply`, {
        docId: "doc.html",
        note: "hi",
      });
      expect(replied.status).toBe(200);
    }, classSeed);
  });

  it("should answer 400 invalid_payload when body.docId disagrees with the path", async () => {
    await withServer(async (ctx) => {
      const response = await postSidecar(ctx, "doc.html", "", {
        docId: "other.html",
        ...addBody("正文一", CLASSES[0]?.selector),
      });
      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
      expect(existsSync(sidecarPathOf(ctx, "doc.html"))).toBe(false);
    }, classSeed);
  });

  it("should carry resolutionNote through resolve into the record and the merged list", async () => {
    await withServer(async (ctx) => {
      const added = await postSidecar(ctx, "doc.html", "", addBody("正文一", CLASSES[0]?.selector));
      const id = (jsonBodyOf(added) as { id: string }).id;

      const resolved = await postSidecar(ctx, "doc.html", `/${id}/resolve`, {
        resolutionNote: "完结",
      });
      expect(resolved.status).toBe(200);
      expect(jsonBodyOf(resolved)).toMatchObject({ resolutionNote: "完结" });

      const listed = jsonBodyOf(await getSidecar(ctx, "doc.html")) as WireList;
      expect(listed.annotations[0]).toMatchObject({ id, resolutionNote: "完结" });
    }, classSeed);
  });
});

describe("sidecar routes · ops by document class", () => {
  for (const klass of CLASSES) {
    it(`should run add → list → resolve → reply → reopen → delete on ${klass.docId} without touching the HTML`, async () => {
      await withServer(async (ctx) => {
        const file = join(ctx.workspace, klass.docId);
        const before = fileStateOf(file);
        const text = bodyTextAt(file);

        const added = await postSidecar(ctx, klass.docId, "", addBody(klass.exact, klass.selector));
        expect(added.status).toBe(201);
        const created = jsonBodyOf(added) as WireEntry & { readonly revision: string };
        expect(created.id).toMatch(/^an-/u);
        expect(created.source).toBe("sidecar");
        expect(created.relocation.ok).toBe(true);
        // Property: whenever relocation lands, its offsets index into bodyTextOf.
        if (created.relocation.ok) {
          expect(text.slice(created.relocation.start, created.relocation.end)).toBe(klass.exact);
        }

        const listed = jsonBodyOf(await getSidecar(ctx, klass.docId)) as WireList;
        expect(listed.annotations).toHaveLength(1);
        const entry = listed.annotations[0];
        expect(entry?.id).toBe(created.id);
        expect(entry?.relocation).toEqual(created.relocation);
        if (entry?.relocation.ok === true) {
          expect(text.slice(entry.relocation.start, entry.relocation.end)).toBe(klass.exact);
        }

        const resolved = await postSidecar(ctx, klass.docId, `/${created.id}/resolve`);
        expect(resolved.status).toBe(200);
        expect((jsonBodyOf(resolved) as WireEntry).status).toBe("resolved");

        const replied = await postSidecar(ctx, klass.docId, `/${created.id}/reply`, {
          note: "跟进",
        });
        expect(replied.status).toBe(200);
        const withReply = jsonBodyOf(replied) as WireEntry & {
          readonly reply: { readonly id: string; readonly note: string; readonly author: string };
        };
        expect(withReply.reply.id).toMatch(/^rp-/u);
        expect(withReply.reply.note).toBe("跟进");
        expect(withReply.reply.author).toBe("user");
        expect(withReply.replies).toHaveLength(1);

        const reopened = await postSidecar(ctx, klass.docId, `/${created.id}/reopen`);
        expect(reopened.status).toBe(200);
        expect((jsonBodyOf(reopened) as WireEntry).status).toBe("pending");

        const deleted = await postSidecar(ctx, klass.docId, `/${created.id}/delete`);
        expect(deleted.status).toBe(200);
        const after = jsonBodyOf(await getSidecar(ctx, klass.docId)) as WireList;
        expect(after.annotations).toEqual([]);

        // The HTML file is untouched after the whole op chain: same bytes, same mtime.
        const end = fileStateOf(file);
        expect(end.bytes.equals(before.bytes)).toBe(true);
        expect(end.mtimeMs).toBe(before.mtimeMs);
      }, classSeed);
    });
  }

  it("should relocate a seeded nodeId record through the fallback chain (D49)", async () => {
    await withServer(async (ctx) => {
      seedRecords(ctx, "doc.html", [
        // nodeId gone, selector still resolves → the selector level hits.
        record({
          id: "an-aaaaaaa1",
          nodeId: "hr-gone",
          selector: "body > article:nth-of-type(1) > p:nth-of-type(2)",
          anchor: { exact: "正文二", prefix: "", suffix: "", start: 5 },
        }),
        // nodeId gone, no selector → the body level hits.
        withoutKeys(
          record({
            id: "an-aaaaaaa2",
            nodeId: "hr-gone",
            anchor: { exact: "正文一", prefix: "", suffix: "", start: 2 },
          }),
          ["selector"],
        ),
        // nodeId + selector present but the quote is dead → the wire carries
        // `{ok:false, reason}` — a lost anchor is a value, never a delete.
        record({
          id: "an-aaaaaaa3",
          nodeId: "hr-b",
          selector: "body > article:nth-of-type(1) > h2:nth-of-type(1)",
          anchor: { exact: "不存在", prefix: "", suffix: "", start: 0 },
        }),
        // Neither locating info: the parser drops the record and the wire
        // surfaces the diagnostic (orphaned-on-record is unexpressible).
        withoutKeys(record({ id: "an-aaaaaaa4" }), ["selector"]),
      ]);

      const listed = jsonBodyOf(await getSidecar(ctx, "doc.html")) as WireList;
      const text = bodyTextAt(ctx.file);

      expect(listed.annotations).toHaveLength(3);
      const [bySelector, byBody, dead] = listed.annotations;
      // DOC's body text is the title plus two blocks, wrapped in real \r\n text
      // nodes from the template: the second block sits at [7,10), the first at [4,7).
      expect(bySelector?.relocation).toEqual({ ok: true, start: 7, end: 10, via: "selector" });
      expect(byBody?.relocation).toEqual({ ok: true, start: 4, end: 7, via: "body" });
      expect(dead?.relocation).toEqual({ ok: false, reason: "anchor_lost" });
      expect(listed.diagnostics).toEqual([expect.stringContaining("nodeId/selector")]);
      for (const entry of [bySelector, byBody]) {
        if (entry?.relocation.ok === true) {
          expect(text.slice(entry.relocation.start, entry.relocation.end)).toMatch(/^正文/u);
        }
      }
    }, classSeed);
  });
});

describe("sidecar routes · SSE", () => {
  it("should broadcast doc.annotations after each successful write and stay silent on failures", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      try {
        await sse.waitForEvent("ready");

        const added = await postSidecar(
          ctx,
          "doc.html",
          "",
          addBody("正文一", CLASSES[0]?.selector),
        );
        expect(added.status).toBe(201);
        const first = await sse.waitForEvent("doc.annotations");
        expect(first.data).toContain('"docId":"doc.html"');

        // Failed writes broadcast nothing: bad schema, bad id, bad doc.
        const failures = await Promise.all([
          postSidecar(ctx, "doc.html", "", { note: 1 }),
          postSidecar(ctx, "doc.html", "/an-deadbeef/resolve"),
          postSidecar(ctx, "missing.html", "", addBody("x")),
        ]);
        for (const failure of failures) expect(failure.status).toBeGreaterThanOrEqual(400);

        const created = jsonBodyOf(added) as WireEntry;
        const resolved = await postSidecar(ctx, "doc.html", `/${created.id}/resolve`);
        expect(resolved.status).toBe(200);

        // ready + two doc.annotations: .hreader writes never produce extra frames.
        await sse.waitFor(3);
        const events = sse.frames.filter((frame) => frame.event === "doc.annotations");
        expect(events).toHaveLength(2);
        // A sidecar write never fires doc.changed — the document bytes are untouched.
        expect(sse.frames.some((frame) => frame.event === "doc.changed")).toBe(false);
      } finally {
        sse.close();
      }
    }, classSeed);
  });
});

describe("sidecar routes · concurrency", () => {
  it("should land every one of N parallel adds exactly once", async () => {
    await withServer(async (ctx) => {
      const n = 8;
      const added = await Promise.all(
        Array.from({ length: n }, () =>
          postSidecar(ctx, "doc.html", "", addBody("正文一", CLASSES[0]?.selector)),
        ),
      );
      for (const response of added) expect(response.status).toBe(201);
      const ids = added.map((response) => (jsonBodyOf(response) as WireEntry).id);
      expect(new Set(ids).size).toBe(n);

      const listed = jsonBodyOf(await getSidecar(ctx, "doc.html")) as WireList;
      expect(listed.annotations).toHaveLength(n);
    }, classSeed);
  });
});
