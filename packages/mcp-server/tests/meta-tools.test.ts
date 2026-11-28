// This layer: `hr_get_meta` / `hr_set_meta` — the agent-facing metadata surface. Reads echo
// the shared table row with a stable null-filled shape; writes merge under the table lock,
// are recorded `createdBy: "agent"`, and every error still lands as a tool result with the
// core code in brackets.

import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-meta-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

const DOC = "<!doctype html><html><body><p>正文</p></body></html>";

const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name, arguments: args });
  await session.close();
  return result;
};

const getMeta = (filePath: string) => call("hr_get_meta", { filePath });
const setMeta = (args: Record<string, unknown>) => call("hr_set_meta", args);

const seedDoc = async (name = "doc.html"): Promise<void> => {
  await writeFile(join(workspace, name), DOC, "utf8");
};

describe("hr_get_meta", () => {
  it("should return a stable null-filled shape for a doc with no record", async () => {
    await seedDoc();
    const result = await getMeta("doc.html");

    expect(isErrorResultOf(result)).toBe(false);
    expect(payloadOf(result)).toEqual({
      file: "doc.html",
      tags: [],
      sourceUrl: null,
      createdBy: null,
      savedAt: null,
      diagnostics: [],
    });
  });

  it("should reject a missing document with not_found wording", async () => {
    const result = await getMeta("missing.html");
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("not_found");
  });

  it("should reject a path outside the workspace", async () => {
    const result = await getMeta("../elsewhere.html");
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
  });

  it("should refuse the ~ spelling instead of guessing the home dir", async () => {
    const result = await getMeta("~/doc.html");
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("invalid_input");
  });
});

describe("hr_set_meta", () => {
  it("should write tags recorded under the agent and return the settled record", async () => {
    await seedDoc();
    const result = await setMeta({
      filePath: "doc.html",
      tags: ["园艺", "  笔记  ", "园艹"],
    });

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload["file"]).toBe("doc.html");
    expect(payload["tags"]).toEqual(["园艺", "笔记", "园艹"]);
    expect(payload["createdBy"]).toBe("agent");
    expect(typeof payload["savedAt"]).toBe("string");
    expect(payload["changed"]).toBe(true);
    expect(payload["diagnostics"]).toEqual([]);
  });

  it("should merge addTags/removeTags/sourceUrl and keep first-write provenance", async () => {
    await seedDoc();
    const first = payloadOf(await setMeta({ filePath: "doc.html", tags: ["A", "b"] }));

    const merged = payloadOf(
      await setMeta({
        filePath: "doc.html",
        addTags: ["c", "a"],
        removeTags: ["B"],
        sourceUrl: "https://example.com/from",
      }),
    );
    expect(merged["tags"]).toEqual(["A", "c"]);
    expect(merged["sourceUrl"]).toBe("https://example.com/from");
    expect(merged["savedAt"]).toBe(first["savedAt"]);
    expect(merged["createdBy"]).toBe("agent");

    const cleared = payloadOf(await setMeta({ filePath: "doc.html", sourceUrl: null }));
    expect(cleared["sourceUrl"]).toBeNull();
  });

  it("should report changed:false when the patch reproduces the record", async () => {
    await seedDoc();
    await setMeta({ filePath: "doc.html", tags: ["x"] });
    const again = payloadOf(await setMeta({ filePath: "doc.html", tags: ["x"] }));
    expect(again["changed"]).toBe(false);
  });

  it("should echo nested file paths in POSIX form", async () => {
    await mkdir(join(workspace, "sub", "dir"), { recursive: true });
    await writeFile(join(workspace, "sub", "dir", "d.html"), DOC, "utf8");
    const payload = payloadOf(await setMeta({ filePath: "sub/dir/d.html", tags: ["t"] }));
    expect(payload["file"]).toBe(`sub${sep === "/" ? "/" : "/"}dir/d.html`);
  });

  it("should refuse semantic violations with core codes", async () => {
    await seedDoc();
    const badUrl = await setMeta({ filePath: "doc.html", sourceUrl: "file:///etc" });
    expect(isErrorResultOf(badUrl)).toBe(true);
    expect(codeOf(badUrl)).toBe("invalid_payload");

    const credentialed = await setMeta({
      filePath: "doc.html",
      sourceUrl: "https://user:pass@x.test",
    });
    expect(codeOf(credentialed)).toBe("invalid_payload");

    const tooMany = await setMeta({
      filePath: "doc.html",
      addTags: Array.from({ length: 33 }, (_u, index) => `t${String(index)}`),
    });
    expect(codeOf(tooMany)).toBe("invalid_payload");
  });
});

describe("meta tools · schema boundary", () => {
  it("should reject a missing filePath and wrong-typed fields before core runs", async () => {
    for (const [name, args] of [
      ["hr_get_meta", {}],
      ["hr_get_meta", { filePath: "" }],
      ["hr_get_meta", { filePath: 42 }],
      ["hr_set_meta", { filePath: "doc.html", tags: "x" }],
      ["hr_set_meta", { filePath: "doc.html", tags: [1] }],
      ["hr_set_meta", { filePath: "doc.html", sourceUrl: 42 }],
      ["hr_set_meta", { filePath: "doc.html", addTags: { 0: "x" } }],
      ["hr_set_meta", { filePath: "doc.html", bogus: 1 }],
    ] as const) {
      const result = await call(name, args);
      expect(isErrorResultOf(result)).toBe(true);
    }
  });
});

describe("meta tools · corrupt table", () => {
  it("should surface the corrupt diagnostic and heal on the next write", async () => {
    await seedDoc();
    await mkdir(join(workspace, ".hreader"), { recursive: true });
    await writeFile(join(workspace, ".hreader", "meta.json"), "{broken", "utf8");

    const read = payloadOf(await getMeta("doc.html"));
    expect(read["tags"]).toEqual([]);
    expect(read["diagnostics"]).toEqual(["doc_meta_corrupt:not_object"]);

    const written = payloadOf(await setMeta({ filePath: "doc.html", tags: ["healed"] }));
    expect(written["tags"]).toEqual(["healed"]);
    const again = payloadOf(await getMeta("doc.html"));
    expect(again["diagnostics"]).toEqual([]);
  });
});
