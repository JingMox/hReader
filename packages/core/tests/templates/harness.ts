// This layer: shared fixtures for template tests (fake HOME/workspace/template roots, seeded template files, TemplateDeps assembly); contains no assertions.

import type { TemplateDeps } from "../../src/templates/contracts";
import { depsOf, fakeFs, fixedClock, recordingSleep, type FakeFs } from "../io/harness";

export const HOME = "/home/u";
export const WS = "/ws";
export const USER_TEMPLATES = `${HOME}/.hreader/templates`;
export const WS_TEMPLATES = `${WS}/.hreader/templates`;

export const rootsOf = (workspace = WS): { readonly workspace: string } => ({ workspace });

export const depsAt = (fake: FakeFs, home = HOME): TemplateDeps => {
  const clock = fixedClock(0);
  return { ...depsOf(fake.port, clock.clock, recordingSleep(clock).sleep), home };
};

/** The minimal legal manifest shape; every field can be knocked out via overrides. */
export const manifestText = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "my-tpl",
    name: "My Template",
    description: "fixture",
    version: 1,
    format: "html",
    ...overrides,
  });

export const seedDirs = (fake: FakeFs, ...dirs: readonly string[]): void => {
  for (const dir of dirs) fake.state.dirs.add(dir);
};

/** A clean html template: manifest (id auto-derived from the dir name) + entry + optional style/guide/assets. */
export const htmlTemplate = (
  dir: string,
  options: {
    readonly manifest?: string;
    readonly entry?: string;
    readonly style?: string;
    readonly guide?: string;
    readonly assets?: Record<string, string>;
  } = {},
): Record<string, string> => ({
  [`${dir}/template.json`]:
    options.manifest ?? manifestText({ id: dir.slice(dir.lastIndexOf("/") + 1) }),
  [`${dir}/index.html`]:
    options.entry ??
    `<!doctype html>\n<html><head><title>T</title></head><body><h1>T</h1></body></html>\n`,
  ...(options.style === undefined ? {} : { [`${dir}/style.css`]: options.style }),
  ...(options.guide === undefined ? {} : { [`${dir}/guide.md`]: options.guide }),
  ...Object.fromEntries(
    Object.entries(options.assets ?? {}).map(([name, text]) => [`${dir}/assets/${name}`, text]),
  ),
});

export { fakeFs };
export type { FakeFs } from "../io/harness";
