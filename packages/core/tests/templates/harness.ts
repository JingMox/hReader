// 这层管：模板测试的公共装置（假 HOME/工作区/模板根、种子模板文件、TemplateDeps 装配）；不含断言。

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

/** 合法 manifest 的最小形状；每个字段都能用 overrides 打掉。 */
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

/** 一条干净的 html 模板：manifest（id 自动取目录名）+ entry +（可选）style/guide/assets。 */
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
