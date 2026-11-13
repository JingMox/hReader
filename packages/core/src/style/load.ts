// 这层管：风格解析与发现（显式路径 > 项目 > 用户 > 内置，同 id 整份替换）；不编译、不改 HTML。

import { dirname, join } from "node:path";

import { HrError } from "../hr-error";
import type {
  LoadedStyle,
  LoadStyleInput,
  StyleDeps,
  StyleDiagnostic,
  StyleDiscovery,
  StyleSource,
  StyleSpec,
} from "./contracts";
import { assertStyleId } from "./id";
import { DEFAULT_STYLE_ID, findBuiltinStyle } from "./presets";
import {
  existsOf,
  listDirsOrEmpty,
  projectStylePath,
  readOptionalText,
  STYLE_FILE,
  THEME_FILE,
  userStyleDir,
  userStylesRoot,
} from "./resource";
import { parseStyleText } from "./spec";
import { messageOf } from "./text";
import { resolveThemePath } from "./theme";

/** 风格文件自己的目录里若有 `theme.css` 就用它，否则回落到 `inherits_visual`（裁定 #3）。 */
const themePathOf = async (
  spec: StyleSpec,
  ownDir: string | undefined,
  deps: StyleDeps,
): Promise<string> => {
  if (ownDir !== undefined && (await existsOf(join(ownDir, THEME_FILE), deps))) {
    return join(ownDir, THEME_FILE);
  }
  return resolveThemePath(spec.inheritsVisual, deps);
};

const loadFrom = async (
  path: string,
  deps: StyleDeps,
  source: StyleSource,
): Promise<LoadedStyle | undefined> => {
  const text = await readOptionalText(path, deps);
  if (text === undefined) return undefined;
  const spec = parseStyleText(text, path);
  return { spec, source, themePath: await themePathOf(spec, dirname(path), deps) };
};

const unknownStyleOf = (id: string): HrError =>
  new HrError("unknown_style", `四个来源都找不到风格：${id}（显式路径/项目/用户/内置）`);

const explicitStyleOf = async (
  path: string,
  id: string | undefined,
  deps: StyleDeps,
): Promise<LoadedStyle> => {
  const found = await loadFrom(path, deps, "explicit");
  if (found === undefined) throw new HrError("not_a_file", `显式风格文件不存在：${path}`);
  if (id !== undefined && id !== found.spec.id) {
    throw new HrError(
      "invalid_style",
      `显式路径里的 id（${found.spec.id}）与请求的 id（${id}）不一致`,
    );
  }
  return found;
};

/** 项目级文件只覆盖"同 id"的那一刻：它的 id 赢了也不该顶掉用户要的另一个风格。 */
const projectStyleOf = async (id: string, deps: StyleDeps): Promise<LoadedStyle | undefined> => {
  const found = await loadFrom(projectStylePath(deps), deps, "project");
  return found?.spec.id === id ? found : undefined;
};

const userStyleOf = async (id: string, deps: StyleDeps): Promise<LoadedStyle | undefined> => {
  const found = await loadFrom(join(userStyleDir(id, deps), STYLE_FILE), deps, "user");
  if (found !== undefined && found.spec.id !== id) {
    throw new HrError("invalid_style", `目录名 ${id} 与文件里的 id ${found.spec.id} 不一致`);
  }
  return found;
};

/**
 * 唯一解析链：`loadStyle`（语言维度）与 `applyStyle`（视觉维度）都必须走这里，
 * 否则"能加载的风格"与"能换肤的风格"会分叉（G2 P1-3 / R4）。
 */
export const resolveStyle = async (
  input: LoadStyleInput,
  deps: StyleDeps,
): Promise<LoadedStyle> => {
  const { path } = input;
  if (path !== undefined) return explicitStyleOf(path, input.id, deps);
  const id = input.id ?? DEFAULT_STYLE_ID;
  assertStyleId(id);
  const project = await projectStyleOf(id, deps);
  if (project !== undefined) return project;
  const user = await userStyleOf(id, deps);
  if (user !== undefined) return user;
  const builtin = findBuiltinStyle(id);
  if (builtin === undefined) throw unknownStyleOf(id);
  return {
    spec: builtin,
    source: "builtin",
    themePath: await resolveThemePath(builtin.inheritsVisual, deps),
  };
};

/** 风格加载的公开入口（行为同 `resolveStyle`，签名独立以免两个名字指向同一个值）。 */
export const loadStyle = (input: LoadStyleInput, deps: StyleDeps): Promise<LoadedStyle> =>
  resolveStyle(input, deps);

interface DiscoveryState {
  readonly styles: StyleSpec[];
  readonly diagnostics: StyleDiagnostic[];
}

/** 坏一个不许毁掉全部：每个文件独立成诊断（AC6.6）。 */
const collectFrom = async (path: string, deps: StyleDeps, state: DiscoveryState): Promise<void> => {
  try {
    const text = await readOptionalText(path, deps);
    if (text === undefined) return;
    state.styles.push(parseStyleText(text, path));
  } catch (error: unknown) {
    state.diagnostics.push({ path, reason: messageOf(error) });
  }
};

export const discoverStyles = async (deps: StyleDeps): Promise<StyleDiscovery> => {
  const state: DiscoveryState = { styles: [], diagnostics: [] };
  await collectFrom(projectStylePath(deps), deps, state);
  const root = userStylesRoot(deps);
  const names = [...(await listDirsOrEmpty(root, deps))].sort();
  for (const name of names) {
    await collectFrom(join(root, name, STYLE_FILE), deps, state);
  }
  return { styles: state.styles, diagnostics: state.diagnostics };
};
