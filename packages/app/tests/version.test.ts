// The status bar must show the version from `packages/app/package.json` — the single
// source of truth — never a hardcoded literal that goes stale across releases.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { versionTextOf } from "../src/version.ts";
import { mountStatusbar } from "../src/widgets/statusbar.ts";
import { createFakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
) as { readonly version: string };

describe("statusbar · version", () => {
  it("should write the package.json version into #hr-version", () => {
    const fake = createFakeHost();
    mountStatusbar(fake.host, ROOT);
    const written = fake.calls.find(
      (call) => call.op === "text" && call.args[0] === `${ROOT} #hr-version`,
    );
    expect(written?.args[1]).toBe(`v${version}`);
  });
});

describe("versionTextOf · manifest guard", () => {
  it("should prefix a string version with v", () => {
    expect(versionTextOf({ version: "0.0.1" })).toBe("v0.0.1");
  });

  it("should throw when the manifest has no string version", () => {
    expect(() => versionTextOf({})).toThrow('package.json must declare a string "version"');
    expect(() => versionTextOf({ version: 1 })).toThrow(
      'package.json must declare a string "version"',
    );
    expect(() => versionTextOf(null)).toThrow('package.json must declare a string "version"');
  });
});
