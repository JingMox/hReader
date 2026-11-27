// Sidecar annotation routes, verified end-to-end against a real `hr serve`
// daemon: add → list → resolve → reply → reopen → delete over the HTTP wire,
// with the `doc.annotations` SSE event observed after each successful write.
// Runs on a foreign doc — the sidecar store is doc-class agnostic, and the
// journey only needs the HTTP surface.

import { writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api, type SseStream } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const DOC = "sidecar-doc.html";
const BODY = `<!doctype html><html><body><div><p>first paragraph</p><p>second paragraph</p></div></body></html>`;

type JsonMap = Record<string, unknown>;

const annotationsOf = (body: JsonMap): readonly JsonMap[] =>
  (body["annotations"] as readonly JsonMap[] | undefined) ?? [];

describe("sidecar-annotations", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let sse: SseStream;

  beforeAll(async () => {
    home = sandbox("sidecar");
    await writeFile(docPath(home.ws, DOC), BODY, "utf8");
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    sse = await api.openSse();
    // The first frame is `ready`: drain it so later `next` calls see writes only.
    await sse.next("ready");
  });

  afterAll(async () => {
    sse.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("add → list → resolve → reply → reopen → delete, with SSE observed", async () => {
    // add: 201, flat entry shape with relocation + revision.
    const added = await api.postJson(`${docApi(DOC)}/sidecar`, {
      anchor: { exact: "second", prefix: "", suffix: "", start: 15 },
      selector: "body > div:nth-of-type(1) > p:nth-of-type(2)",
      note: "wire 批注",
    });
    const id = added["id"];
    assert(
      typeof id === "string" && id.startsWith("an-"),
      `add reply id: ${JSON.stringify(added)}`,
    );
    assertEq(added["source"], "sidecar", "add reply source");
    const relocation = added["relocation"] as JsonMap;
    assertEq(relocation["ok"], true, "add relocation ok");
    assert(typeof relocation["start"] === "number", "add relocation start is a number");
    const event = await sse.next("doc.annotations");
    assert(event !== undefined, "no doc.annotations after add");
    assertEq(event.data["docId"], DOC, "doc.annotations payload");

    // list: the entry shows up with the same relocation.
    const listed = await api.getJson(`${docApi(DOC)}/sidecar`);
    const entries = annotationsOf(listed);
    assertEq(entries.length, 1, "merged list after add");
    assertEq(entries[0]?.["id"], id, "listed id");
    assertEq(entries[0]?.["source"], "sidecar", "listed source");
    assert(
      JSON.stringify(entries[0]?.["relocation"]) === JSON.stringify(relocation),
      `listed relocation diverged: ${JSON.stringify(entries[0]?.["relocation"])}`,
    );

    // resolve: status flips, doc.annotations fires again.
    const resolved = await api.postJson(`${docApi(DOC)}/sidecar/${id}/resolve`, {});
    assertEq(resolved["status"], "resolved", "resolve status");
    assert((await sse.next("doc.annotations")) !== undefined, "no doc.annotations after resolve");

    // reply: the reply rides inside the annotation and as a reply field.
    const replied = await api.postJson(`${docApi(DOC)}/sidecar/${id}/reply`, { note: "跟进" });
    const replies = replied["replies"] as readonly JsonMap[] | undefined;
    assertEq(replies?.length, 1, "reply count");
    assertEq(replies?.[0]?.["note"], "跟进", "reply note");
    assertEq((replied["reply"] as JsonMap | undefined)?.["author"], "user", "reply author");
    assert((await sse.next("doc.annotations")) !== undefined, "no doc.annotations after reply");

    // reopen: back to pending.
    const reopened = await api.postJson(`${docApi(DOC)}/sidecar/${id}/reopen`, {});
    assertEq(reopened["status"], "pending", "reopen status");
    assert((await sse.next("doc.annotations")) !== undefined, "no doc.annotations after reopen");

    // delete: the merged view empties.
    const deleted = await api.postJson(`${docApi(DOC)}/sidecar/${id}/delete`, {});
    assertEq(deleted["id"], id, "delete reply id");
    assert((await sse.next("doc.annotations")) !== undefined, "no doc.annotations after delete");
    const after = await api.getJson(`${docApi(DOC)}/sidecar`);
    assertEq(annotationsOf(after).length, 0, "merged list after delete");
  });

  test("a failed write broadcasts nothing but the next success still lands", async () => {
    const bad = await api.post(`${docApi(DOC)}/sidecar/an-deadbeef/resolve`, {});
    assertEq(bad.status, 404, "resolve of unknown id");

    const added = await api.postJson(`${docApi(DOC)}/sidecar`, {
      anchor: { exact: "first", prefix: "", suffix: "", start: 0 },
      selector: "body > div:nth-of-type(1) > p:nth-of-type(1)",
      note: "second",
    });
    assert(typeof added["id"] === "string", `second add reply: ${JSON.stringify(added)}`);
    const event = await sse.next("doc.annotations");
    assert(event !== undefined, "no doc.annotations after the second add");
    assertEq(event.data["docId"], DOC, "doc.annotations payload");
  });
});
