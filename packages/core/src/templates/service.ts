// This layer: three-tier source resolution (builtin < user < workspace) + the public list/read orchestration.
// No-fallback principle: same id → highest priority wins, and a broken winner still occupies the slot —
// better to error than to silently swap skins. Predictable behavior beats "sort of works"
// (the shadowed lower-priority copy is also recorded in diagnostics).

import { join } from "node:path";

import { HrError } from "../hr-error";
import { decodeUtf8 } from "../io/bytes";
import { codeOf } from "../io/errors";
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from "./builtin";
import {
  TEMPLATES_DIRNAME,
  TEMPLATE_ID,
  type LoadedTemplate,
  type TemplateDeps,
  type TemplateDiagnostic,
  type TemplateList,
  type TemplateManifest,
  type TemplateRoots,
  type TemplateSource,
  type TemplateSummary,
} from "./contracts";
import {
  inspectTemplateDir,
  isTemplateCandidate,
  listTemplateDirs,
  type ScannedMember,
  type ScannedTemplate,
} from "./inspect";

/** `.hreader` matches io/paths.ts's STORE_DIR: template roots are `<home|workspace>/.hreader/templates`. */
const HREADER_DIR = ".hreader";

const userRootOf = (deps: TemplateDeps): string => join(deps.home, HREADER_DIR, TEMPLATES_DIRNAME);
const workspaceRootOf = (roots: TemplateRoots): string =>
  join(roots.workspace, HREADER_DIR, TEMPLATES_DIRNAME);

/** One resolution result: a scanned template, or the error it failed with (a broken one still occupies the slot = no fallback). */
type Candidate =
  | { readonly kind: "ok"; readonly shape: LoadedShape }
  | { readonly kind: "broken"; readonly error: HrError };

/** The resolved template shared by list/read/create: builtin members are in-memory, fs members are verified paths. */
interface LoadedShape {
  readonly manifest: TemplateManifest;
  readonly entry: () => Promise<string>;
  readonly style?: () => Promise<string>;
  readonly guide?: () => Promise<string>;
  readonly assets: readonly ScannedMember[];
}

const eager = (text: string) => (): Promise<string> => Promise.resolve(text);

const builtinShape = (template: BuiltinTemplate): LoadedShape => ({
  manifest: template.manifest,
  entry: eager(template.entry),
  style: eager(template.style),
  guide: eager(template.guide),
  assets: [],
});

const summaryOf = (manifest: TemplateManifest, source: TemplateSource): TemplateSummary => ({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  format: manifest.format,
  tags: manifest.tags,
  source,
});

/** Single funnel for fs member reads: anything still unreadable after the walk (races/encoding) is reported as "template broken". */
const memberTextOf =
  (fsApi: TemplateDeps["fs"], dir: string) =>
  async (member: ScannedMember): Promise<string> => {
    try {
      return decodeUtf8(await fsApi.readFile(member.source), member.source);
    } catch (error: unknown) {
      throw new HrError("invalid_template", `无法读取模板成员：${member.rel}（${dir}）`, {
        cause: error,
      });
    }
  };

const lazyMember = (
  member: ScannedMember | undefined,
  textOf: (member: ScannedMember) => Promise<string>,
): (() => Promise<string>) | undefined =>
  member === undefined ? undefined : (): Promise<string> => textOf(member);

const scannedShape = (scan: ScannedTemplate, fsApi: TemplateDeps["fs"]): LoadedShape => {
  const textOf = memberTextOf(fsApi, scan.dir);
  const style = lazyMember(scan.style, textOf);
  const guide = lazyMember(scan.guide, textOf);
  return {
    manifest: scan.manifest,
    entry: () => textOf(scan.entry),
    ...(style === undefined ? {} : { style }),
    ...(guide === undefined ? {} : { guide }),
    assets: scan.assets,
  };
};

/** fs-side candidate check and scan; a non-candidate (missing/regular file) returns `undefined` = this tier does not have the id. */
const fsCandidate = async (
  dir: string,
  name: string,
  deps: TemplateDeps,
): Promise<Candidate | undefined> => {
  try {
    if (!(await isTemplateCandidate(dir, deps.fs))) return undefined;
    return {
      kind: "ok",
      shape: scannedShape(await inspectTemplateDir(dir, name, deps.fs), deps.fs),
    };
  } catch (error: unknown) {
    // ENOENT = the dir was removed mid-race, treated as absent; other failures are reported as broken candidates — a won slot must be a visible slot.
    if (codeOf(error) === "ENOENT") return undefined;
    return {
      kind: "broken",
      error:
        error instanceof HrError
          ? error
          : new HrError("invalid_template", `无法检查模板目录：${dir}`, { cause: error }),
    };
  }
};

/**
 * The winner among same-id candidates: workspace > user > builtin, **judged on whether the dir exists,
 * not on whether it is healthy**. A slot taken by a higher tier may not be fallen back from —
 * otherwise the user debugging "why didn't my change take effect" has no clues.
 */
const winnerOf = async (
  id: string,
  roots: TemplateRoots,
  deps: TemplateDeps,
): Promise<{ readonly source: TemplateSource; readonly candidate: Candidate } | undefined> => {
  const tiers: readonly { source: "user" | "workspace"; root: string }[] = [
    { source: "workspace", root: workspaceRootOf(roots) },
    { source: "user", root: userRootOf(deps) },
  ];
  for (const tier of tiers) {
    const candidate = await fsCandidate(join(tier.root, id), id, deps);
    if (candidate !== undefined) return { source: tier.source, candidate };
  }
  const builtin = BUILTIN_TEMPLATES.find((template) => template.manifest.id === id);
  return builtin === undefined
    ? undefined
    : { source: "builtin", candidate: { kind: "ok", shape: builtinShape(builtin) } };
};

const unknownTemplate = (id: string, reason = "找不到该模板"): HrError =>
  new HrError("unknown_template", `${reason}：${id}`);

const materialize = async (shape: LoadedShape, source: TemplateSource): Promise<LoadedTemplate> => {
  const entry = await shape.entry();
  const style = shape.style === undefined ? undefined : await shape.style();
  const guide = shape.guide === undefined ? undefined : await shape.guide();
  return {
    manifest: shape.manifest,
    source,
    entry,
    ...(style === undefined ? {} : { style }),
    ...(guide === undefined ? {} : { guide }),
    assets: shape.assets.map((asset) => asset.rel),
  };
};

/** The "full text fetch" shared by `readTemplate` and `createFromTemplate`: carries each asset member's `source`/`size` along. */
export const loadTemplate = async (
  id: string,
  roots: TemplateRoots,
  deps: TemplateDeps,
): Promise<{ readonly template: LoadedTemplate; readonly members: readonly ScannedMember[] }> => {
  if (!TEMPLATE_ID.test(id))
    throw unknownTemplate(id, `模板 id 不合法（须匹配 ${TEMPLATE_ID.source}）`);
  const winner = await winnerOf(id, roots, deps);
  if (winner === undefined) throw unknownTemplate(id);
  if (winner.candidate.kind === "broken") throw winner.candidate.error;
  const loaded = await materialize(winner.candidate.shape, winner.source);
  return { template: loaded, members: winner.candidate.shape.assets };
};

export const readTemplate = async (
  id: string,
  roots: TemplateRoots,
  deps: TemplateDeps,
): Promise<LoadedTemplate> => (await loadTemplate(id, roots, deps)).template;

/**
 * The merged list: candidates are checked one by one in builtin → user → workspace order, later tiers
 * shadow earlier ones; every breakage lands in diagnostics — both "won but broken" and "shadowed" ones.
 */
export const listTemplates = async (
  roots: TemplateRoots,
  deps: TemplateDeps,
): Promise<TemplateList> => {
  const effective = new Map<string, { source: TemplateSource; candidate: Candidate }>();
  const diagnostics: TemplateDiagnostic[] = [];
  for (const template of BUILTIN_TEMPLATES) {
    effective.set(template.manifest.id, {
      source: "builtin",
      candidate: { kind: "ok", shape: builtinShape(template) },
    });
  }
  const tiers: readonly { source: "user" | "workspace"; root: string }[] = [
    { source: "user", root: userRootOf(deps) },
    { source: "workspace", root: workspaceRootOf(roots) },
  ];
  for (const tier of tiers) {
    for (const name of await listTemplateDirs(tier.root, deps.fs)) {
      const candidate = await fsCandidate(join(tier.root, name), name, deps);
      if (candidate === undefined) continue;
      effective.set(name, { source: tier.source, candidate });
      if (candidate.kind === "broken") {
        diagnostics.push({ id: name, source: tier.source, message: candidate.error.message });
      }
    }
  }
  const templates = [...effective.values()]
    .flatMap((entry) =>
      entry.candidate.kind === "broken"
        ? []
        : [summaryOf(entry.candidate.shape.manifest, entry.source)],
    )
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  return { templates, diagnostics };
};
