// Weaves core's compiled language spec into the host system prompt and exposes the `hreader` service (host-only).

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import {
  BUILTIN_STYLES,
  compileTone,
  DEFAULT_STYLE_ID,
  discoverStyles,
  HrError,
  loadStyle,
  nodeStyleDeps,
} from "@hreader/core";
import type { StyleDeps } from "@hreader/core";

import type { HreaderPromptSection, HreaderService } from "./events";

export type { HreaderPatchRequest, HreaderPromptSection, HreaderService } from "./events";

/** Section name: `SystemPrompt.section` refuses duplicate names, so it is also this plugin's only registration identity. */
export const SECTION_NAME = "hreader";

/**
 * Why `order` is 100: in `SECTION_ORDERS` (`@deepseek-ai/dsh-system-prompt@0.2.2-rc.1`),
 * `HARNESS_IDENTITY = -1000`, `DEPLOYMENT_PERSONA_PREFIX = 0`, `PLAN_POLICY = 500`,
 * tool guidance 1000–3100. The language spec is persona-level instruction, so it must sit after
 * persona and before policy and tool guidance.
 */
export const SECTION_ORDER = 100;

/** The plugin's `config` from its line in `cordis.patch.yml`. */
export interface BundleConfig {
  /**
   * hreader workspace root (the resolution root for `<workspace>/styles/` and `~/.hreader/styles`).
   * The host does not expose its workspace to plugins: `Context` only carries the `baseUrl` used for
   * module resolution, no cwd/workspace field — so the default is the host process cwd with a stderr
   * note; relative paths resolve against cwd (see `workspaceOf`).
   */
  readonly workspace?: string;
  /** Language style id; defaults to `DEFAULT_STYLE_ID`. */
  readonly styleId?: string;
}

/**
 * The host capabilities `apply` actually uses (the real `Context` satisfies it, see
 * `tests/types.test-d.ts`): declaring only these three methods keeps the fake host from having to
 * fabricate the whole `Context` — this repo bans `as`.
 */
export interface HostContext {
  readonly systemPrompt: { section(section: HreaderPromptSection): () => void };
  provide(name: string, value: unknown): () => void;
  effect(execute: () => () => void, label?: string): () => Promise<void>;
}

/** Disposers already registered on a ctx: a repeat `apply` tears down the old one so the host always holds exactly one section. */
const registered = new WeakMap<HostContext, () => Promise<void>>();

/**
 * Runtime value-kind name. `typeof null` is `"object"`, which alone is not actionable when reporting
 * null, so `null` is special-cased. The parameter is `unknown`: call sites pass fields typed `string`,
 * and only here is the value inspected at runtime.
 */
const kindOf = (value: unknown): string => (value === null ? "null" : typeof value);

/**
 * Four workspace steps: default to cwd plus a WARNING (users deserve to know which directory's style
 * the prompt renders with), reject raw strings containing a `..` segment (see below), resolve relative
 * paths against cwd, and fail-fast on a given-but-missing path (a mistyped path is more dangerous than
 * the cwd fallback).
 */
const workspaceOf = (config: BundleConfig): string => {
  const configured = config.workspace;
  if (configured === undefined) {
    const cwd = process.cwd();
    process.stderr.write(`[hreader] config.workspace 未配置，使用宿主进程 cwd=${cwd}\n`);
    return cwd;
  }

  // `config` comes from (`cordis.patch.yml`'s) YAML: `workspace: 123` is a realistic hand-edit, and a
  // bare `split` would only throw `TypeError: configured.split is not a function` (which field? how to
  // fix?). The type has already narrowed to `string` here; this branch exists only for runtime shape,
  // so it judges values with `kindOf`, not types.
  if (typeof configured !== "string") {
    const kind = kindOf(configured);
    throw new HrError(
      "invalid_input",
      `config.workspace 必须是字符串路径，收到 ${kind}：${String(configured)}` +
        '（写成 "/Users/me/project" 这样的字符串；不写这个字段则回落到宿主进程 cwd 并打 WARNING）',
    );
  }

  // `resolve` silently swallows `..` (`<repo>/../..` becomes the repo's parent), and then
  // `<workspace>/.hreader/style.yaml` follows suit. Rather than allow a silent rewrite, error out and
  // let the caller hand in the right path.
  if (configured.split(/[\\/]/u).includes("..")) {
    throw new HrError(
      "invalid_input",
      `config.workspace 不能含 ".." 段，请给绝对路径：${configured}`,
    );
  }

  const workspace = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  if (configured.trim() === "" || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new HrError(
      "invalid_input",
      `config.workspace 指向的目录不存在或不是目录：${workspace}` +
        "（相对路径按宿主进程 cwd 解析；不写这个字段则回落到 cwd 并打 WARNING）",
    );
  }
  return workspace;
};

/**
 * List the available ids before judging `styleId` instead of letting `loadStyle` throw directly:
 * the message from `packages/core/src/style/load.ts:55` does not list ids, leaving a user holding
 * `unknown style "x"` with nowhere to look.
 */
const availableIdsOf = async (deps: StyleDeps): Promise<string[]> => {
  const discovered = await discoverStyles(deps);
  // One id can be both builtin and project style (project files exist to override builtins), and the
  // error list must show it once. `Set` keeps first-seen order: builtins first, then project/user —
  // so the list order is deterministic.
  return [
    ...new Set([
      ...BUILTIN_STYLES.map((style) => style.id),
      ...discovered.styles.map((style) => style.id),
    ]),
  ];
};

/**
 * Where the builtin `styles/` lives: `build` copies it to `dist/styles` (theme CSS is not bundled and
 * ships only with this package), so a host running off dist reads its own copy; running from source
 * (`vitest`, no dist) has no copy and falls back to the repo-root `styles/` — same content both ways.
 * `nodeStyleDeps().stylesRoot` is not used directly here: that value points at the repo layout (see
 * `packages/core/src/style/node.ts:14`) and would resolve inside the user's tree once installed in a
 * profile. The `moduleUrl` parameter only lets tests inject a `file://` base; production calls omit
 * it, defaulting to `import.meta.url`.
 */
export const stylesRootOf = (moduleUrl: URL | string = import.meta.url): string => {
  const bundled = fileURLToPath(new URL("./styles/", moduleUrl));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../../../styles/", moduleUrl));
};

const depsOf = (workspace: string): StyleDeps => ({
  ...nodeStyleDeps(workspace),
  stylesRoot: stylesRootOf(),
});

/**
 * Two stages (resolve the style name, then `loadStyle` reads + validates), not fused into one:
 * fused, "name not recognized" and "installed style file is broken" collapse into the same error.
 */
const promptOf = async (deps: StyleDeps, styleId: string): Promise<string> => {
  const ids = await availableIdsOf(deps);
  if (!ids.includes(styleId)) {
    // The message must list available ids: a mistyped styleId that fell back to the default style would never be noticed (hence fail-fast).
    throw new HrError(
      "unknown_style",
      `未知 styleId：${styleId}；已查内置预设、${deps.projectRoot} 的项目风格、~/.hreader/styles；` +
        `当前可用：${ids.join("、")}`,
    );
  }
  const loaded = await loadStyle({ id: styleId }, deps);
  return compileTone(loaded.spec);
};

/**
 * Plugin entry. The section's `text` shares one compiler with the CLI (`hr style --tone`) and the MCP
 * (`use-hreader-style`): this package assembles no copy of its own, it only forwards `compileTone`'s
 * output.
 */
export const apply = async (ctx: HostContext, config: BundleConfig): Promise<void> => {
  const workspace = workspaceOf(config);
  const styleId = config.styleId ?? DEFAULT_STYLE_ID;
  const prompt = await promptOf(depsOf(workspace), styleId);

  // Run `promptOf` before tearing down the old one: a failed registration (style resolution throwing)
  // must not demolish the section already in place — the host-side section is an independent resource
  // and does not live or die with this `apply` call.
  await registered.get(ctx)?.();
  const dispose = ctx.effect(() => {
    const service: HreaderService = { styleId, prompt };
    const disposeSection = ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: prompt,
    });
    const disposeService = ctx.provide("hreader", service);
    return () => {
      disposeSection();
      disposeService();
    };
  }, SECTION_NAME);
  registered.set(ctx, dispose);
};

/** Declared dependency: the host waits for the `systemPrompt` service, otherwise `apply` reads undefined. */
export const inject = ["systemPrompt"];
