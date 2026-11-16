// 这层管：`events.ts` 里那几份"形状镜像"与上游真类型不许漂。
// 本包不能从 `@hreader/core` 取类型（它是 `workspace:*` 的 devDependency，进了 dist 声明文件
// 就是 "Cannot find module '@hreader/core'"），也不能从 `@deepseek-ai/*` 取（同理，且它们是
// `devDependencies`）——所以只能自述形状；代价是**必须**有断言盯着它。
// `tsc` 跑它、vitest 不跑（不是 `*.test.ts`），也不会进 `dist/`（build 只编 `src/`）。

import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";
import type { PatchRequest as CorePatchRequest } from "@hreader/core";

import type {
  HreaderPatchAction,
  HreaderPatchRequestShape,
  HreaderPromptSection,
} from "../src/events";

/** 双向子类型：只有两边互相可赋值（= 结构等价）才是 `true`。 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** 单向子类型：镜像必须是上游的**可赋值**子集（`apply` 就是把它交给宿主的）。 */
type Assignable<A, B> = [A] extends [B] ? true : false;

/** core 改了 `PatchRequest` 的任一字段/可选性，这里的 `true` 就装不进 `false`（TS2322）。 */
export const requestShapeIsMutual: Mutual<HreaderPatchRequestShape, CorePatchRequest> = true;

/** `action` 的取值集合同样钉死：core 加/删一种 action，这里红。 */
export const actionIsMutual: Mutual<HreaderPatchAction, CorePatchRequest["action"]> = true;

/** 官方 `PromptSection` 改了 `name`/`order`/`text` 的类型，这里红（`order: string` 就是红的）。 */
export const promptSectionIsAccepted: Assignable<HreaderPromptSection, PromptSection> = true;

/**
 * 反向不能断言"互相可赋值"：官方 `text` 还允许 `(context) => string`、另有可选 `interpolate`
 * （`lib/types/index.d.ts:47-62`），镜像故意只覆盖"静态文本"那半边。反向的风险是"镜像多出键"
 * ——那由 `MIRROR_KEYS` 差集抓。
 */
type ExtraPromptSectionKeys = Exclude<keyof HreaderPromptSection, keyof PromptSection>;
export const promptSectionHasNoExtraKeys: [ExtraPromptSectionKeys] extends [never] ? true : false =
  true;
