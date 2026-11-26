// This layer: the MCP-UI view resource (`ui://hreader/view/{docId}`) — "readable even with no daemon",
// plus the banner pointing at the daemon's real port while it runs (Marco 4: the view only references the port, it does not manage the process).

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { docIdOf } from "../src/ui";
import { sessionOf, type Session } from "./harness";

const VIEW_URI_PREFIX = "ui://hreader/view/";

const viewUriOf = (relativePath: string): string => `${VIEW_URI_PREFIX}${docIdOf(relativePath)}`;

/** Resource content holds only `text`: not the same shape as a tool result's `content[]`. */
const textOfResource = (contents: readonly unknown[]): string => {
  const [first] = contents;
  return typeof first === "object" &&
    first !== null &&
    "text" in first &&
    typeof first.text === "string"
    ? first.text
    : "";
};

/** `homedir()` reads `HOME`: point it at a temp directory so tests never collide with the dev machine's real `~/.hreader/daemon.json`. */
const withHome = async (home: string, body: () => Promise<void>): Promise<void> => {
  const original = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    await body();
  } finally {
    if (original === undefined) delete process.env["HOME"];
    else process.env["HOME"] = original;
  }
};

const viewTextIn = async (session: Session, relativePath: string): Promise<string> => {
  const result = await session.client.readResource({ uri: viewUriOf(relativePath) });
  return textOfResource(result.contents);
};

const sessionViewTextOf = async (relativePath: string): Promise<string> => {
  const session = await sessionOf();
  const text = await viewTextIn(session, relativePath);
  await session.close();
  return text;
};

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-ui-"));
  process.chdir(workspace);
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("ui://hreader/view", () => {
  it("should serve the document even when no daemon is running", async () => {
    await writeFile(join(workspace, "doc.html"), "<article><p>正文</p></article>", "utf8");
    await mkdir(join(workspace, "home"), { recursive: true });

    await withHome(join(workspace, "home"), async () => {
      const session = await sessionOf();
      const result = await session.client.readResource({ uri: viewUriOf("doc.html") });
      await session.close();

      expect(result.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(textOfResource(result.contents)).toContain("<p>正文</p>");
      expect(textOfResource(result.contents)).toContain("daemon 未启动");
    });
  });

  it("should point the banner at the port the daemon wrote down", async () => {
    await writeFile(join(workspace, "doc.html"), "<article></article>", "utf8");
    await mkdir(join(workspace, ".hreader"), { recursive: true });
    await writeFile(join(workspace, ".hreader", "daemon.json"), '{"port":7391}', "utf8");

    await withHome(workspace, async () => {
      expect(await sessionViewTextOf("doc.html")).toContain("http://127.0.0.1:7391/");
    });
  });
});

/** `resources/read` failures go through a JSON-RPC error: `code` is the spec code, `data.code` our fine code. */
const resourceErrorOf = async (uri: string): Promise<{ code: unknown; data: unknown }> => {
  const session = await sessionOf();
  const error: unknown = await session.client.readResource({ uri }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  await session.close();
  return {
    code: Reflect.get(Object(error), "code"),
    data: Reflect.get(Object(error), "data"),
  };
};

describe("ui://hreader/view · missing no longer fakes success", () => {
  it("should reject an unreadable document instead of returning a shell page", async () => {
    const { code, data } = await resourceErrorOf(viewUriOf("missing.html"));

    // What is pinned is established behavior: answering a "document unreadable" shell page is a fake success to the host.
    expect(code).toBe(-32002);
    expect(Reflect.get(Object(data), "code")).toBe("not_found");
  });

  it("should reject an empty docId", async () => {
    const { code, data } = await resourceErrorOf(VIEW_URI_PREFIX);

    expect(code).toBe(-32002);
    expect(Reflect.get(Object(data), "code")).toBe("not_found");
  });

  it("should reject a view that escapes the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "hreader-mcp-outside-"));
    await writeFile(join(outside, "secret.html"), "<p>外面</p>", "utf8");
    await symlink(join(outside, "secret.html"), join(workspace, "link.html"));

    const { code, data } = await resourceErrorOf(viewUriOf("link.html"));
    await rm(outside, { recursive: true, force: true });

    // The argument points wrong (docId escapes the workspace): `-32602`, fine code still `path_outside_workspace`.
    expect(code).toBe(-32602);
    expect(Reflect.get(Object(data), "code")).toBe("path_outside_workspace");
  });

  it("should reject a bad docId", async () => {
    const { code, data } = await resourceErrorOf(`${VIEW_URI_PREFIX}..`);

    expect(code).toBe(-32002);
    expect(Reflect.get(Object(data), "code")).toBe("not_found");
  });
});

describe("ui://hreader/view · daemon drop file", () => {
  it("should treat a daemon.json without a numeric port as no daemon", async () => {
    await writeFile(join(workspace, "doc.html"), "<article></article>", "utf8");
    await mkdir(join(workspace, ".hreader"), { recursive: true });
    const session = await sessionOf();

    await withHome(workspace, async () => {
      for (const body of ["42", '{"pid":1}', '{"port":"7391"}']) {
        await writeFile(join(workspace, ".hreader", "daemon.json"), body, "utf8");
        expect(await viewTextIn(session, "doc.html")).toContain("daemon 未启动");
      }
    });
    await session.close();
  });
});
