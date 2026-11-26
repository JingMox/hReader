// 这层管：把 core 编译出的语言规约织进宿主 system prompt，并暴露 `hreader` 服务（host-only）。

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

/** section 名：`SystemPrompt.section` 拒绝同名重复注册，故它同时是本插件唯一的注册标识。 */
export const SECTION_NAME = "hreader";

/**
 * `order` 取 100 的理由：`SECTION_ORDERS`（`@deepseek-ai/dsh-system-prompt@0.2.2-rc.1`）里
 * `HARNESS_IDENTITY = -1000`、`DEPLOYMENT_PERSONA_PREFIX = 0`、`PLAN_POLICY = 500`、
 * 工具指引 1000–3100。语言规约是 persona 级指令，必须排在 persona 之后、policy 与工具指引之前。
 */
export const SECTION_ORDER = 100;

/** 插件在 `cordis.patch.yml` 那一行里的 `config`。 */
export interface BundleConfig {
  /**
   * hreader 工作区根（`<workspace>/styles/`、`~/.hreader/styles` 的解析根）。
   * 宿主不向插件暴露工作区：`Context` 上只有模块解析用的 `baseUrl`，没有 cwd/workspace 字段，
   * 故缺省取宿主进程 cwd 并在 stderr 说一声；相对路径按 cwd 解析（见 `workspaceOf`）。
   */
  readonly workspace?: string;
  /** 语言风格 id；缺省用 `DEFAULT_STYLE_ID`。 */
  readonly styleId?: string;
}

/**
 * `apply` 真正用到的宿主能力（真 `Context` 满足它，见 `tests/types.test-d.ts`）：
 * 只写这三个方法，假宿主因此不必伪造整个 `Context`——本仓禁 `as`。
 */
export interface HostContext {
  readonly systemPrompt: { section(section: HreaderPromptSection): () => void };
  provide(name: string, value: unknown): () => void;
  effect(execute: () => () => void, label?: string): () => Promise<void>;
}

/** 同一个 ctx 上已注册的清理器：重复 `apply` 先撤旧的，保证宿主里始终只有一个 section。 */
const registered = new WeakMap<HostContext, () => Promise<void>>();

/**
 * 运行期的值类型名。`typeof null` 是 `"object"`，报 null 时单用它不够可操作，故先补一个 `null`。
 * 形参是 `unknown`：调用处传入的字段在类型上是 `string`，只有这里把它当运行期值看。
 */
const kindOf = (value: unknown): string => (value === null ? "null" : typeof value);

/**
 * 工作区四步：缺省取 cwd 并 WARNING（用户有权知道 prompt 是按哪个目录的风格渲染的）、
 * 原始串含 `..` 段直接拒（见下）、相对路径按 cwd 解析成绝对路径、给了但不存在的路径 fail-fast
 * （拼错的路径比 cwd 兜底更危险）。
 */
const workspaceOf = (config: BundleConfig): string => {
  const configured = config.workspace;
  if (configured === undefined) {
    const cwd = process.cwd();
    process.stderr.write(`[hreader] config.workspace 未配置，使用宿主进程 cwd=${cwd}\n`);
    return cwd;
  }

  // `config` 来自 (`cordis.patch.yml` 的) YAML：`workspace: 123` 是现实的手写错误，直接 `split`
  // 只会抛 `TypeError: configured.split is not a function`（看不出是哪个字段、怎么改）。
  // 类型上这里已窄成 `string`，这条分支只为运行期形状而存在，故用 `kindOf` 判值不判型。
  if (typeof configured !== "string") {
    const kind = kindOf(configured);
    throw new HrError(
      "invalid_input",
      `config.workspace 必须是字符串路径，收到 ${kind}：${String(configured)}` +
        '（写成 "/Users/me/project" 这样的字符串；不写这个字段则回落到宿主进程 cwd 并打 WARNING）',
    );
  }

  // `resolve` 会把 `..` 静默吃掉（`<repo>/../..` 变成仓库的父目录），`<workspace>/.hreader/style.yaml`
  // 就跟着换人。不给静默重写的机会，直接报错让调用方自己给对路。
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
 * 先列可用清单再判 `styleId`，而不是让 `loadStyle` 直接抛：`packages/core/src/style/load.ts:55`
 * 的报错文案不列可用 id，用户拿到 `unknown style "x"` 后无处可查。
 */
const availableIdsOf = async (deps: StyleDeps): Promise<string[]> => {
  const discovered = await discoverStyles(deps);
  // 同一 id 可能既是内置又是项目风格（项目文件就是拿来覆盖内置的），错误清单里只许出现一次。
  // `Set` 保留首次出现的顺序：内置在前、项目/用户在后，清单顺序因此是确定的。
  return [
    ...new Set([
      ...BUILTIN_STYLES.map((style) => style.id),
      ...discovered.styles.map((style) => style.id),
    ]),
  ];
};

/**
 * 内置 `styles/` 的位置：`build` 把它拷到 `dist/styles`（主题 CSS 不打包，只能随本包发），
 * 所以装了 dist 的宿主读自己那一份；源码直跑（`vitest` 不经 dist）没有拷贝，回落仓库根 `styles/`，
 * 两份内容同源。这里不直接用 `nodeStyleDeps().stylesRoot`：那个值指向仓库布局（见
 * `packages/core/src/style/node.ts:14`），装进 profile 后路径会落到使用者目录树。
 * `moduleUrl` 形参只为测试注入 `file://` 基址：生产调用不传，缺省即 `import.meta.url`。
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
 * 两段式（先解析 style 名，再 `loadStyle` 读文件 + 校验），不合成一步：
 * 合成后无法区分"名字不认识"与"装了的风格文件坏了"——两者会落到同一个错误。
 */
const promptOf = async (deps: StyleDeps, styleId: string): Promise<string> => {
  const ids = await availableIdsOf(deps);
  if (!ids.includes(styleId)) {
    // 文案必须列出可用 id：拼错的 styleId 若退默认风格，作者永远发现不了（取 fail-fast）。
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
 * 插件入口。`section` 的 `text` 与 CLI（`hr style --tone`）、MCP（`use-hreader-style`）
 * 同一份编译器：本包不拼接任何文案，只转发 `compileTone` 的输出。
 */
export const apply = async (ctx: HostContext, config: BundleConfig): Promise<void> => {
  const workspace = workspaceOf(config);
  const styleId = config.styleId ?? DEFAULT_STYLE_ID;
  const prompt = await promptOf(depsOf(workspace), styleId);

  // 先跑完 `promptOf` 再撤旧的：注册失败（style 解析抛错）不该把已经挂好的 section 拆掉，
  // 宿主侧的 section 是独立资源，不随本插件的这次 `apply` 成功与否消失。
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

/** 声明依赖：`systemPrompt` 服务不在时宿主要等它，否则 `apply` 会读到 undefined。 */
export const inject = ["systemPrompt"];
