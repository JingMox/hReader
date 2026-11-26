// This layer covers core's fallback that appends `.ts` / `/index.ts` to internal relative imports; no subprocess (direct calls, fake nextResolve).

import type { ResolveFnOutput, ResolveHookContext } from "node:module";

import { describe, expect, it, vi } from "vitest";

import { resolveFallback } from "../src/resolve-hook";

const CONTEXT = {
  conditions: ["node", "import"],
  importAttributes: {},
  parentURL: "file:///repo/packages/cli/src/main.ts",
} satisfies ResolveHookContext;

const outputOf = (url: string): ResolveFnOutput => ({ url });

const errOf = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const MISSING = (specifier: string): Error =>
  errOf("ERR_MODULE_NOT_FOUND", `Cannot find module '${specifier}'`);

describe("resolveFallback · passthrough", () => {
  it("should return the first successful resolution untouched", () => {
    const nextResolve = vi.fn(() => outputOf("file:///repo/a.js"));

    const result = resolveFallback("./a.js", CONTEXT, nextResolve);

    expect(result).toEqual(outputOf("file:///repo/a.js"));
    expect(nextResolve).toHaveBeenCalledTimes(1);
    expect(nextResolve).toHaveBeenCalledWith("./a.js", CONTEXT);
  });

  it("should retry a bare specifier as-is so the real error surfaces", () => {
    const nextResolve = vi
      .fn<(specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput>()
      .mockImplementationOnce(() => {
        throw MISSING("hreader");
      })
      .mockImplementationOnce(() => {
        throw errOf("ERR_PACKAGE_PATH_NOT_EXPORTED", "no export");
      });

    expect(() => resolveFallback("hreader", CONTEXT, nextResolve)).toThrow("no export");
    expect(nextResolve).toHaveBeenLastCalledWith("hreader", CONTEXT);
  });
});

describe("resolveFallback · appending an extension", () => {
  it("should retry with `.ts` when the bare relative path is missing", () => {
    const nextResolve = vi
      .fn<(specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput>()
      .mockImplementationOnce((specifier: string) => {
        throw MISSING(specifier);
      })
      .mockImplementationOnce(() => outputOf("file:///repo/core/src/a.ts"));

    const result = resolveFallback("./a", CONTEXT, nextResolve);

    expect(result).toEqual(outputOf("file:///repo/core/src/a.ts"));
    expect(nextResolve.mock.calls.map(([specifier]) => specifier)).toEqual(["./a", "./a.ts"]);
  });

  it("should fall back to `/index.ts` when both earlier attempts fail", () => {
    const nextResolve = vi
      .fn<(specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput>()
      .mockImplementationOnce((specifier: string) => {
        throw MISSING(specifier);
      })
      .mockImplementationOnce((specifier: string) => {
        throw MISSING(specifier);
      })
      .mockImplementationOnce(() => outputOf("file:///repo/core/src/dir/index.ts"));

    const result = resolveFallback("./dir", CONTEXT, nextResolve);

    expect(result).toEqual(outputOf("file:///repo/core/src/dir/index.ts"));
    expect(nextResolve.mock.calls.map(([specifier]) => specifier)).toEqual([
      "./dir",
      "./dir.ts",
      "./dir/index.ts",
    ]);
  });
});

describe("resolveFallback · all three attempts fail", () => {
  it("should rethrow the LAST error when all three attempts fail", () => {
    const last = errOf("ERR_MODULE_NOT_FOUND", "Cannot find module './gone/index.ts'");
    const nextResolve = vi
      .fn<(specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput>()
      .mockImplementationOnce(() => {
        throw MISSING("./gone");
      })
      .mockImplementationOnce(() => {
        throw MISSING("./gone.ts");
      })
      .mockImplementationOnce(() => {
        throw last;
      });

    expect(() => resolveFallback("./gone", CONTEXT, nextResolve)).toThrow(last);
    expect(nextResolve).toHaveBeenCalledTimes(3);
  });
});
