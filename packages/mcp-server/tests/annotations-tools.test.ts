// This layer: the agent-facing annotation surface —
// `hr_outline`'s additive sidecar block, `hr_resolve_annotation`'s meta→sidecar fallback, and the
// `hr_list_annotations` merged listing. The outline pin is a byte-differential: a doc without a
// sidecar store must serialize exactly as `buildOutline(parseHtml(text))` did before this feature.

import { createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  buildOutline,
  parseHtml,
  serializeSidecarFile,
  type SidecarAnnotation,
} from "@hreader/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  isRecord,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";
const extraDirs: string[] = [];

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-ann-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
  await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name, arguments: args });
  await session.close();
  return result;
};

const outlineOf = (filePath: string) => call("hr_outline", { filePath });
const resolveOf = (args: Record<string, unknown>) => call("hr_resolve_annotation", args);
const listOf = (args: Record<string, unknown>) => call("hr_list_annotations", args);

const storeNameOf = (file: string): string =>
  `${createHash("sha1").update(file, "utf8").digest("hex")}.json`;

/** A valid sidecar record set against `file`, written where `annotationFileOf` looks for it. */
const seedStore = async (
  file: string,
  annotations: readonly SidecarAnnotation[],
): Promise<void> => {
  const dir = join(workspace, ".hreader", "annotations");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, storeNameOf(file)), serializeSidecarFile(file, annotations), "utf8");
};

const writeRaw = async (name: string, content: string): Promise<void> => {
  await writeFile(join(workspace, name), content, "utf8");
};

const sidecarRecord = (patch: Partial<SidecarAnnotation> = {}): SidecarAnnotation => ({
  id: "an-side",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
  note: "侧车批注",
  status: "pending",
  createdAt: "2026-11-27T00:00:00.000Z",
  author: "user",
  replies: [],
  ...patch,
});

const FOREIGN_DOC = "<html><body><p>正文</p></body></html>";

const entriesOf = (payload: Record<string, unknown>): readonly Record<string, unknown>[] => {
  const value = payload["annotations"];
  return Array.isArray(value) ? value.filter(isRecord) : [];
};

describe("hr_outline · byte-identical without a sidecar store", () => {
  it("should serialize a managed doc exactly as buildOutline did before the feature", async () => {
    await writeRaw("doc.html", ANNOTATED_DOC);
    const result = await outlineOf("doc.html");

    expect(isErrorResultOf(result)).toBe(false);
    // The whole text block is the differential: the pre-feature tool printed `asJson(buildOutline(...))`.
    expect(textOf(result)).toBe(JSON.stringify(buildOutline(parseHtml(ANNOTATED_DOC)), null, 2));
    expect(payloadOf(result)["sidecarAnnotations"]).toBeUndefined();
    expect(payloadOf(result)["sidecarDiagnostics"]).toBeUndefined();
  });

  it("should serialize a foreign doc identically too", async () => {
    await writeRaw("foreign.html", FOREIGN_DOC);
    const result = await outlineOf("foreign.html");

    expect(textOf(result)).toBe(JSON.stringify(buildOutline(parseHtml(FOREIGN_DOC)), null, 2));
  });
});

describe("hr_outline · sidecar block", () => {
  it("should include pending sidecar annotations of a foreign doc, tagged sidecar with relocation", async () => {
    await writeRaw("foreign.html", FOREIGN_DOC);
    await seedStore("foreign.html", [sidecarRecord()]);

    const payload = payloadOf(await outlineOf("foreign.html"));
    const block = payload["sidecarAnnotations"];
    expect(Array.isArray(block) && block.length === 1).toBe(true);
    const entry = Array.isArray(block) && isRecord(block[0]) ? block[0] : {};
    expect(entry["id"]).toBe("an-side");
    expect(entry["note"]).toBe("侧车批注");
    expect(entry["source"]).toBe("sidecar");
    expect(entry["status"]).toBe("pending");
    const relocation = isRecord(entry["relocation"]) ? entry["relocation"] : {};
    expect(relocation["ok"]).toBe(true);
  });

  it("should keep resolved sidecar entries out of the block", async () => {
    await writeRaw("foreign.html", FOREIGN_DOC);
    await seedStore("foreign.html", [sidecarRecord({ status: "resolved" })]);

    const payload = payloadOf(await outlineOf("foreign.html"));
    expect(payload["sidecarAnnotations"]).toBeUndefined();
  });

  it("should ignore a sidecar entry whose id hr-meta already has, and say so in diagnostics", async () => {
    await writeRaw("doc.html", ANNOTATED_DOC);
    await seedStore("doc.html", [sidecarRecord({ id: "ann-01", selector: "body > p" })]);

    const payload = payloadOf(await outlineOf("doc.html"));
    expect(payload["sidecarAnnotations"]).toBeUndefined();
    const diagnostics = payload["sidecarDiagnostics"];
    expect(
      Array.isArray(diagnostics) && diagnostics.some((line) => String(line).includes("ann-01")),
    ).toBe(true);
  });

  it("should report an unreadable store directory as an error, not swallow it", async () => {
    // `.hreader` as a regular file: reading `<file>` succeeds, then the sidecar stat dies ENOTDIR.
    await writeRaw("foreign.html", FOREIGN_DOC);
    await writeRaw(".hreader", "not a directory");

    const result = await outlineOf("foreign.html");
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("io_failure");
  });
});

describe("hr_resolve_annotation", () => {
  it("should resolve a meta id as before and report source meta", async () => {
    await writeRaw("doc.html", ANNOTATED_DOC);
    const result = await resolveOf({ filePath: "doc.html", annotationId: "ann-01" });

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload["source"]).toBe("meta");
    const annotation = isRecord(payload["annotation"]) ? payload["annotation"] : {};
    expect(annotation["status"]).toBe("resolved");
  });

  it("should fall back to the sidecar store when meta has no such id", async () => {
    await writeRaw("doc.html", ANNOTATED_DOC);
    await seedStore("doc.html", [sidecarRecord({ id: "an-side" })]);

    const result = await resolveOf({
      filePath: "doc.html",
      annotationId: "an-side",
      resolutionNote: "按批注改过",
    });
    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload["source"]).toBe("sidecar");
    const annotation = isRecord(payload["annotation"]) ? payload["annotation"] : {};
    expect(annotation["status"]).toBe("resolved");
    expect(annotation["resolutionNote"]).toBe("按批注改过");
  });

  it("should keep the frozen not_found wording for an id in neither store", async () => {
    await writeRaw("doc.html", ANNOTATED_DOC);
    const result = await resolveOf({ filePath: "doc.html", annotationId: "nope" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("not_found");
    expect(textOf(result)).toContain("批注不存在：nope");
  });

  it("should not fall through to the sidecar store for a failure that is not not_found", async () => {
    // Undecodable bytes: the meta read dies `invalid_utf8` before id lookup — the fallback must not swallow it.
    await writeFile(
      join(workspace, "bad.html"),
      Buffer.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0xff, 0xfe]),
    );

    const result = await resolveOf({ filePath: "bad.html", annotationId: "ann-01" });
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("invalid_utf8");
  });
});

describe("hr_list_annotations · single file", () => {
  it("should merge meta and sidecar entries, meta winning an id collision", async () => {
    await writeRaw("doc.html", ANNOTATED_DOC);
    await seedStore("doc.html", [
      sidecarRecord({ id: "ann-01", note: "侧车副本" }),
      sidecarRecord({ id: "an-2", selector: "body > p" }),
    ]);

    const payload = payloadOf(await listOf({ filePath: "doc.html" }));
    expect(payload["docsScanned"]).toBe(1);
    expect(payload["truncated"]).toBe(false);
    const entries = entriesOf(payload);
    const byId = new Map(entries.map((entry) => [entry["id"], entry]));
    // Meta's ann-01 won the collision (its widened note is the meta comment, not 侧车副本).
    expect(byId.get("ann-01")?.["source"]).toBe("meta");
    expect(byId.get("an-2")?.["source"]).toBe("sidecar");
    expect(byId.get("an-2")?.["file"]).toBe("doc.html");
  });

  it("should honor the status filter", async () => {
    await writeRaw("doc.html", ANNOTATED_DOC);
    await seedStore("doc.html", [sidecarRecord({ id: "an-done", status: "resolved" })]);

    const resolved = payloadOf(await listOf({ filePath: "doc.html", status: "resolved" }));
    expect(entriesOf(resolved).map((entry) => entry["id"])).toEqual(["an-done"]);

    const pending = payloadOf(await listOf({ filePath: "doc.html", status: "pending" }));
    expect(entriesOf(pending).map((entry) => entry["id"])).toEqual(["ann-01"]);
  });

  it("should report a corrupt store in diagnostics, not as a crash", async () => {
    await writeRaw("doc.html", FOREIGN_DOC);
    const dir = join(workspace, ".hreader", "annotations");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, storeNameOf("doc.html")), "{{{", "utf8");

    const result = await listOf({ filePath: "doc.html" });
    expect(isErrorResultOf(result)).toBe(false);
    const diagnostics = payloadOf(result)["diagnostics"];
    expect(
      Array.isArray(diagnostics) && diagnostics.some((line) => String(line).includes("侧车")),
    ).toBe(true);
  });

  it("should translate a missing document to the frozen not_found wording", async () => {
    const result = await listOf({ filePath: "nope.html" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("not_found");
    expect(textOf(result)).toContain("nope.html");
  });

  it("should surface an unreadable store directory as an error", async () => {
    await writeRaw("foreign.html", FOREIGN_DOC);
    await writeRaw(".hreader", "not a directory");

    const result = await listOf({ filePath: "foreign.html" });
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("io_failure");
  });
});

describe("hr_list_annotations · workspace scan", () => {
  it("should find sidecar annotations across docs without a filePath", async () => {
    await writeRaw("a.html", FOREIGN_DOC);
    await writeRaw("b.html", ANNOTATED_DOC);
    await seedStore("a.html", [sidecarRecord({ id: "an-a" })]);

    const payload = payloadOf(await listOf({}));
    expect(payload["docsScanned"]).toBe(2);
    const files = entriesOf(payload).map((entry) => entry["file"]);
    expect(files).toContain("a.html");
    expect(files).toContain("b.html");
  });

  it("should diagnose a store record pointing at a missing doc without dropping the good ones", async () => {
    await writeRaw("a.html", FOREIGN_DOC);
    const dir = join(workspace, ".hreader", "annotations");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, storeNameOf("gone.html")),
      serializeSidecarFile("gone.html", [sidecarRecord()]),
      "utf8",
    );
    await seedStore("a.html", [sidecarRecord({ id: "an-ok" })]);

    const payload = payloadOf(await listOf({}));
    expect(entriesOf(payload).map((entry) => entry["id"])).toEqual(["an-ok"]);
    const diagnostics = payload["diagnostics"];
    expect(
      Array.isArray(diagnostics) && diagnostics.some((line) => String(line).includes("gone.html")),
    ).toBe(true);
  });

  it("should flag truncation when the workspace holds more docs than the scan cap", async () => {
    // The cap is core's WORKSPACE_SCAN_LIMITS.docs (500); seeding 501 docs is cheaper than faking fs.
    for (let index = 0; index < 501; index += 1) {
      await writeRaw(`d-${String(index)}.html`, FOREIGN_DOC);
    }
    const payload = payloadOf(await listOf({}));
    expect(payload["docsScanned"]).toBe(500);
    expect(payload["truncated"]).toBe(true);
  });
});

describe("hr_list_annotations · schema boundary", () => {
  it("should reject an empty filePath and an unknown status before any IO", async () => {
    const empty = await listOf({ filePath: "" });
    expect(isErrorResultOf(empty)).toBe(true);

    const bad = await listOf({ status: "wat" });
    expect(isErrorResultOf(bad)).toBe(true);
  });
});

// The path-error contract is frozen on main: `hr_resolve_annotation`'s `filePath` must reach
// core's lexical gate verbatim (code + text + JSON-RPC mapping — `path_outside_workspace` is
// -32602, never -32002), and `hr_outline`'s read gate must keep `目标不在工作区内：<input>` with
// the input echoed, never the resolved absolute path. `hr_list_annotations` is new and follows
// the read-side contract.
describe("path errors · frozen verdicts and wording", () => {
  const seedEscape = async (): Promise<void> => {
    const outside = join(workspace, "..", `escape-outside-${createHash("sha1").update(workspace).digest("hex").slice(0, 8)}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "hosts"), FOREIGN_DOC, "utf8");
    await symlink(outside, join(workspace, "escape"));
    extraDirs.push(outside);
  };

  // Expected texts are thunks: they must be computed after `beforeEach` chdir'd into the
  // workspace — `process.cwd()` is the realpath'd workspace, which is what core echoes.
  const escaped = (filePath: string): string =>
    `\`file\` 逃出了 workspace：${resolve(process.cwd(), filePath)}` +
    `（workspace 是 ${process.cwd()}；先 cd 到文档所在目录，或用 --workspace <dir>）`;

  const cases = [
    {
      name: "a relative path that escapes",
      filePath: "../missing.html",
      resolveText: () => escaped("../missing.html"),
      readText: "目标不在工作区内：../missing.html",
    },
    {
      name: "an absolute path that misses",
      filePath: "/definitely/not/here.html",
      resolveText: () => escaped("/definitely/not/here.html"),
      readText: "目标不在工作区内：/definitely/not/here.html",
    },
    {
      name: "a symlinked dir pointing out of bounds",
      filePath: "escape/hosts",
      resolveText: () => "真实路径落在 workspace 外：escape/hosts",
      readText: "目标不在工作区内：escape/hosts",
    },
    {
      name: "an absolute system path",
      filePath: "/etc/passwd",
      resolveText: () => escaped("/etc/passwd"),
      readText: "目标不在工作区内：/etc/passwd",
    },
  ] as const;

  it.each(cases)("hr_resolve_annotation · $name", async ({ filePath, resolveText }) => {
    await seedEscape();
    const result = await resolveOf({ filePath, annotationId: "ann-01" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
    expect(textOf(result)).toBe(`[path_outside_workspace] ${resolveText()}`);
  });

  it.each(cases)("hr_outline · $name", async ({ filePath, readText }) => {
    await seedEscape();
    const result = await outlineOf(filePath);

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
    expect(textOf(result)).toBe(`[path_outside_workspace] ${readText}`);
  });

  it.each(cases)("hr_list_annotations · $name", async ({ filePath, readText }) => {
    await seedEscape();
    const result = await listOf({ filePath });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
    expect(textOf(result)).toBe(`[path_outside_workspace] ${readText}`);
  });
});
