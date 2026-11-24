// 这层管：本插件对宿主的类型契约（事件 + 服务）。只有编译器能验证它，所以单独一文件。
//
// 本文件**不**从 `@hreader/core` 取类型：core 在 package.json 里只是 `workspace:*` 的 devDependency，
// 一旦进了 `dist/events.d.ts`，装到 profile 的人就会 tsc 报 `Cannot find module '@hreader/core'`。
// 同理不从 `@deepseek-ai/*` 取类型（它们不在 `dependencies`，声明文件里一个裸 `import type` 就足以让
// 只装了本包的使用方报 TS2307）。对外形状一律本地镜像 + 测试盯着漂移；唯一的例外是
// 下面那行 `import type {}` 空种子（不绑名字、会被 tsc 从 d.ts 擦掉，理由见原处）。

/**
 * `PatchAction` 的形状镜像：字段与取值逐字对齐 `packages/core/src/ops/patchNode/constants.ts:3`。
 */
export type HreaderPatchAction = "replace" | "insert_before" | "insert_after" | "append" | "delete";

/**
 * `PatchRequest` 的形状镜像（结构相同、字段与可选性逐字对齐）：
 * 源定义在 `packages/core/src/ops/patchNode/constants.ts:5`。漂移由两条断言合起来抓：
 * 字段与可选性靠 `tests/drift.test-d.ts` 的双向子类型，**多出可选字段**靠
 * `tests/shape-no-extra-keys.test-d.ts` 的 `keyof` 差集（可选增量对双向可赋值不可见）。
 */
export interface HreaderPatchRequestShape {
  /** 目标的 `data-hr-id`；`"root"` 指最外层 `<article>` 自身（保留其属性）。 */
  readonly targetId: string;
  readonly action: HreaderPatchAction;
  /** replace / insert_before / insert_after / append 必填；delete 必须不传。 */
  readonly html?: string;
}

/**
 * `hreader/patch-request` 的载荷：宿主把一条 patch 请求交给 hreader 的补丁引擎。
 * 模块名必须是 `@deepseek-ai/cordis`（dsh 实际解析的那条发布线，不是 `cordis`）——
 * 写成 `cordis` 不会报错，只会让整个 `Events` 合并静默失效。
 */
export interface HreaderPatchRequest {
  /**
   * hreader 工作区根。落在它之内由消费方的写侧保证：
   * 词法 + realpath 两道校验在 `packages/core/src/io/paths.ts:73-79`（`resolveTarget`），
   * 落盘前的父目录复核在 `packages/core/src/io/atomic.ts`。本包只读风格文件、不写盘。
   */
  readonly workspace: string;
  readonly request: HreaderPatchRequestShape;
}

/** `ctx.provide('hreader', …)` 暴露给其他插件的只读面。 */
export interface HreaderService {
  readonly styleId: string;
  /** 已编译的语言规约全文（`compileTone` 的输出，逐字节）。 */
  readonly prompt: string;
}

/**
 * `ctx.systemPrompt.section()` 的入参形状镜像：结构相同，字段与官方 `PromptSection`
 * （`@deepseek-ai/dsh-system-prompt@0.2.2-rc.1` 的 `lib/types/index.d.ts:47`）逐字对齐。
 * 不用官方类型是因为它会把裸依赖带进 `dist/events.d.ts`（见文件头）。漂移由
 * `tests/drift.test-d.ts` 盯：官方改了 `name`/`order`/`text` 的类型，那条赋值立刻红。
 */
export interface HreaderPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

/**
 * `import type {}` 不是残余：下面那条 `declare module "@deepseek-ai/cordis"` 只是合并声明，
 * **自己不去载入** cordis 的增强链（`lib/types/events.d.ts`、`fiber.d.ts`、`reflect.d.ts` 各自
 * `declare module './context.ts'`）。缺这一行时本包看到的 `Context` 只剩基础面（`emit`/`provide`/
 * `effect` 全无），`tests/types.test-d.ts` 直接 TS2349/TS2339 红。空绑定会被 tsc 从
 * `dist/events.d.ts` 里整个擦掉，所以使用方侧仍是零裸依赖（`tests/dist.test.ts` 盯着）。
 */
import type {} from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    hreader: HreaderService;
  }

  interface Events {
    "hreader/patch-request"(payload: HreaderPatchRequest): void;
  }
}
