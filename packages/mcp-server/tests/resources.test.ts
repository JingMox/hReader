// This layer: Resources (`hreader://styles/{id}`) and the Prompt (`use-hreader-style`) —
// what is listed, what a read returns, and whether an unknown id is an error.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STYLE_URI_PREFIX } from "../src/resources";
import { sessionOf } from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-res-"));
  process.chdir(workspace);
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("resources/list", () => {
  it("should list every builtin style under the style uri prefix", async () => {
    const session = await sessionOf();
    const { resources } = await session.client.listResources();
    await session.close();

    const uris = resources.map((one) => one.uri);
    expect(uris).toContain(`${STYLE_URI_PREFIX}atelier-editorial`);
    expect(uris).toContain(`${STYLE_URI_PREFIX}feynman-tech`);
    expect(uris.every((uri) => uri.startsWith(STYLE_URI_PREFIX))).toBe(true);
  });
});

describe("resources/read", () => {
  it("should return the style yaml with the yaml mime type", async () => {
    const session = await sessionOf();
    const result = await session.client.readResource({
      uri: `${STYLE_URI_PREFIX}atelier-editorial`,
    });
    await session.close();

    const [first] = result.contents;
    const text = first !== undefined && "text" in first ? first.text : "";
    expect(first?.mimeType).toBe("application/yaml");
    expect(text).toContain("atelier-editorial");
  });

  it("should refuse a uri outside both known prefixes", async () => {
    const session = await sessionOf();
    await expect(session.client.readResource({ uri: "hreader://elsewhere/thing" })).rejects.toThrow(
      /未知资源/u,
    );
    await session.close();
  });

  it("should turn an unknown style id into an error instead of empty text", async () => {
    const session = await sessionOf();
    await expect(
      session.client.readResource({ uri: `${STYLE_URI_PREFIX}no-such-style` }),
    ).rejects.toThrow();
    await session.close();
  });
});

describe("prompts", () => {
  it("should expose use-hreader-style with a toneId argument", async () => {
    const session = await sessionOf();
    const { prompts } = await session.client.listPrompts();
    await session.close();

    const prompt = prompts.find((one) => one.name === "use-hreader-style");
    expect(prompt).toBeDefined();
    expect(prompt?.arguments?.map((one) => one.name)).toContain("toneId");
  });

  it("should return the compiled tone spec as a user message", async () => {
    const session = await sessionOf();
    const result = await session.client.getPrompt({
      name: "use-hreader-style",
      arguments: { toneId: "feynman-tech" },
    });
    await session.close();

    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.role).toBe("user");
    const content = result.messages[0]?.content;
    expect(content?.type).toBe("text");
    expect(content?.type === "text" ? content.text.length : 0).toBeGreaterThan(0);
  });

  it("should reject an unknown toneId", async () => {
    const session = await sessionOf();
    await expect(
      session.client.getPrompt({
        name: "use-hreader-style",
        arguments: { toneId: "no-such-tone" },
      }),
    ).rejects.toThrow();
    await session.close();
  });
});
