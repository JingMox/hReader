// This layer: 三级来源解析（builtin < user < workspace）+ list/read 公开编排。
// 不回落原则：同 id 取最高优先级，高优先级损坏照样占坑——宁可报错也不静默换皮，
// 行为可预测比"勉强能用"重要（低优先级那份在 diagnostics 里也有记录）。

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

/** `.hreader` 与 io/paths.ts 的 STORE_DIR 同值：模板根是 `<home|workspace>/.hreader/templates`。 */
const HREADER_DIR = ".hreader";

const userRootOf = (deps: TemplateDeps): string => join(deps.home, HREADER_DIR, TEMPLATES_DIRNAME);
const workspaceRootOf = (roots: TemplateRoots): string =>
  join(roots.workspace, HREADER_DIR, TEMPLATES_DIRNAME);

/** 一次解析的结果：扫过的模板，或它失败的错误（损坏照样占坑 = 不回落）。 */
type Candidate =
  | { readonly kind: "ok"; readonly shape: LoadedShape }
  | { readonly kind: "broken"; readonly error: HrError };

/** list/read/create 共用的已解析模板：builtin 是内存成员，fs 是已验证路径。 */
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

/** fs 成员的读取统一收口：walk 之后仍读不动的（竞态/编码）都按"模板损坏"报。 */
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

/** fs 一侧的候选判定与扫描；非候选（缺失/常规文件）返回 `undefined` = 这一级没有这个 id。 */
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
    // ENOENT = 竞态下目录被撤走，视同没有；其余失败按"损坏候选"报——赢了坑就得看得见坑。
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
 * 同 id 的胜出者：workspace > user > builtin，**只看有没有这个目录，不管它坏没坏**。
 * 高优先级的坑被占了就不许回落——否则用户排查"我改了为什么不生效"时毫无线索。
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

/** `readTemplate` 与 `createFromTemplate` 共用的"拿全文"：连资源成员的 `source`/`size` 一起带。 */
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
 * 合并清单：按 builtin → user → workspace 顺序逐个候选判定，后者覆盖前者；
 * 每一步的损坏都进 diagnostics——包括"赢了但坏了的"与"被遮住的"。
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
