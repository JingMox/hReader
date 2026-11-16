// 这层管：AC-2 的编译期证据——`tsc` 跑它，vitest 不跑（它不是可执行测试）。
// 负例用 `@ts-expect-error`：契约一旦写对，`tsc` 会反过来报“未使用的指令”，
// 所以本文件红了等价于 `declare module` 的合并目标或载荷类型坏了。

import type { Context } from "@deepseek-ai/cordis";

import type { HostContext } from "../src/index";

declare const ctx: Context;
declare function acceptsHostContext(host: HostContext): void;

// 正例 1：真 `Context` 能满足 `apply` 的入参（宿主把 ctx 直接传进来）。
acceptsHostContext(ctx);

// 正例 2：合法载荷（`action: "delete"` 时不传 `html`）。
ctx.emit("hreader/patch-request", {
  workspace: "/tmp/workspace",
  request: { targetId: "root", action: "delete" },
});

// @ts-expect-error 少传 payload：`Events['hreader/patch-request']` 要求恰好一个参数。
ctx.emit("hreader/patch-request");

// @ts-expect-error payload 类型错：`PatchAction` 里没有 "move"。
ctx.emit("hreader/patch-request", {
  workspace: "/tmp/workspace",
  request: { targetId: "root", action: "move" },
});
