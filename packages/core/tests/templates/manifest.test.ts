// This layer: strict template.json validation (zod strict: unknown keys/proto-pollution keys/type
// errors/missing fields/member-path lexical gates) and dir-level verification (id≠dir name, missing
// or dir-pointing members, capacity gate). Every broken form lands as invalid_template.

import { describe, expect, it } from "vitest";

import type { HrError } from "../../src/hr-error";
import { readTemplate, listTemplates } from "../../src/templates";
import { TEMPLATE_MAX_FILES } from "../../src/templates/contracts";
import { codeOfAsync, systemError } from "../io/harness";
import {
  depsAt,
  fakeFs,
  HOME,
  htmlTemplate,
  manifestText,
  rootsOf,
  seedDirs,
  USER_TEMPLATES,
  WS,
} from "./harness";

const errorOf = async (run: () => Promise<unknown>): Promise<HrError> => {
  try {
    await run();
  } catch (error: unknown) {
    return error as HrError;
  }
  throw new Error("expected a throw but none happened");
};

/** Reads a template from the user tier: seeded dir names are all `my-tpl`. */
const readOf = async (files: Record<string, string>) => {
  const fake = fakeFs(files);
  seedDirs(fake, HOME, `${HOME}/.hreader`, USER_TEMPLATES, `${USER_TEMPLATES}/my-tpl`, WS);
  return readTemplate("my-tpl", rootsOf(), depsAt(fake));
};

describe("manifest · JSON shape", () => {
  it("should reject non-JSON, arrays and scalars", async () => {
    for (const manifest of ["{oops", "[1,2]", '"x"', "42"]) {
      expect(
        await codeOfAsync(() => readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest }))),
      ).toBe("invalid_template");
    }
  });

  it("should reject a missing template.json distinctly from unreadable ones", async () => {
    const fake = fakeFs({ [`${USER_TEMPLATES}/my-tpl/index.html`]: "<html></html>" });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/my-tpl`, WS);

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("template.json");
  });

  it("should report a manifest that cannot be read at all", async () => {
    const fake = fakeFs(htmlTemplate(`${USER_TEMPLATES}/my-tpl`));
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/my-tpl`, WS);
    fake.fail("readFile", systemError("EPERM"), (path: string) => path.endsWith("template.json"));

    expect(await codeOfAsync(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)))).toBe(
      "invalid_template",
    );
  });
});

describe("manifest · field validation", () => {
  it("should reject missing required fields with a field path", async () => {
    const manifest = manifestText({ name: undefined });
    const error = await errorOf(() =>
      readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest })),
    );

    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain(".name");
  });

  it("should reject wrong field types", async () => {
    for (const manifest of [
      manifestText({ version: 2 }),
      manifestText({ version: "1" }),
      manifestText({ format: "mystery" }),
      manifestText({ tags: "not-array" }),
      manifestText({ description: 3 }),
      manifestText({ name: "   " }),
      manifestText({ entry: 7 }),
    ]) {
      expect(
        await codeOfAsync(() => readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest }))),
      ).toBe("invalid_template");
    }
  });

  it("should name array indices in nested type errors", async () => {
    const manifest = manifestText({ tags: ["ok", 5] });
    const error = await errorOf(() =>
      readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest })),
    );

    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("[1]");
  });

  it("should list legal keys when unknown keys appear", async () => {
    const manifest = manifestText({ surprise: true });
    const error = await errorOf(() =>
      readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest })),
    );

    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("surprise");
    expect(error.message).toContain("entry");
  });

  it("should refuse prototype-pollution keys outright", async () => {
    for (const raw of [
      '{"__proto__":{"x":1},"id":"my-tpl","name":"n","description":"d","version":1,"format":"html"}',
      '{"constructor":{},"id":"my-tpl","name":"n","description":"d","version":1,"format":"html"}',
    ]) {
      expect(
        await codeOfAsync(() =>
          readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest: raw })),
        ),
      ).toBe("invalid_template");
    }
  });
});

describe("manifest · lexical gates for id and member paths", () => {
  it("should reject illegal template ids", async () => {
    for (const id of ["UPPER", "a/b", "a\\b", "..", "a b", "x".repeat(80), "-lead"]) {
      const manifest = manifestText({ id });
      expect(
        await codeOfAsync(() => readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest }))),
      ).toBe("invalid_template");
    }
  });

  it("should reject member paths escaping the template dir", async () => {
    for (const field of ["entry", "style", "guide"]) {
      for (const bad of ["../x", "/abs/x", "a\\b", "a//b", ".", "./x", "a/../b"]) {
        const manifest = manifestText({ [field]: bad });
        expect(
          await codeOfAsync(() => readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest }))),
        ).toBe("invalid_template");
      }
    }
  });

  it("should reject a NUL byte inside a member path", async () => {
    const manifest = manifestText({ style: "a\0b.css" });
    expect(
      await codeOfAsync(() => readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest }))),
    ).toBe("invalid_template");
  });
});

describe("dir verification · id and member existence", () => {
  it("should reject manifest id that disagrees with the directory name", async () => {
    const manifest = manifestText({ id: "other-tpl" });
    const error = await errorOf(() =>
      readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest })),
    );

    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("other-tpl");
  });

  it("should reject a missing default entry", async () => {
    const fake = fakeFs({
      [`${USER_TEMPLATES}/my-tpl/template.json`]: manifestText({ id: "my-tpl" }),
    });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/my-tpl`, WS);

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("index.html");
  });

  it("should reject an authored style that does not exist", async () => {
    const manifest = manifestText({ id: "my-tpl", style: "nope.css" });
    const error = await errorOf(() =>
      readOf(htmlTemplate(`${USER_TEMPLATES}/my-tpl`, { manifest })),
    );

    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("nope.css");
  });

  it("should reject an entry that points at a directory", async () => {
    const fake = fakeFs({
      [`${USER_TEMPLATES}/my-tpl/template.json`]: manifestText({ id: "my-tpl", entry: "sub" }),
    });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/my-tpl`, `${USER_TEMPLATES}/my-tpl/sub`, WS);

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("目录");
  });

  it("should reject an illegal directory name before even reading it", async () => {
    const fake = fakeFs({
      [`${USER_TEMPLATES}/Bad Name/template.json`]: manifestText({ id: "Bad Name" }),
    });
    seedDirs(fake, USER_TEMPLATES, `${USER_TEMPLATES}/Bad Name`, WS);

    const list = await listTemplates(rootsOf(), depsAt(fake));
    expect(list.templates).toHaveLength(6);
    expect(list.diagnostics.some((diag) => diag.id === "Bad Name")).toBe(true);
  });
});

describe("dir verification · capacity gate", () => {
  it("should reject a template over the file-count cap", async () => {
    const files: Record<string, string> = {
      ...htmlTemplate(`${USER_TEMPLATES}/my-tpl`),
    };
    for (let index = 0; index <= TEMPLATE_MAX_FILES; index += 1) {
      files[`${USER_TEMPLATES}/my-tpl/assets/f${String(index)}.txt`] = "x";
    }
    const fake = fakeFs(files);
    seedDirs(
      fake,
      USER_TEMPLATES,
      `${USER_TEMPLATES}/my-tpl`,
      `${USER_TEMPLATES}/my-tpl/assets`,
      WS,
    );

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("容量上限");
  });

  it("should reject a template over the byte cap", async () => {
    const fake = fakeFs(
      htmlTemplate(`${USER_TEMPLATES}/my-tpl`, {
        assets: { "big.bin": "x".repeat(21 * 1024 * 1024) },
      }),
    );
    seedDirs(
      fake,
      USER_TEMPLATES,
      `${USER_TEMPLATES}/my-tpl`,
      `${USER_TEMPLATES}/my-tpl/assets`,
      WS,
    );

    const error = await errorOf(() => readTemplate("my-tpl", rootsOf(), depsAt(fake)));
    expect(error.code).toBe("invalid_template");
    expect(error.message).toContain("容量上限");
  });
});
