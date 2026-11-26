// Compile-time evidence: `tsc` runs it, vitest does not (it is not an executable test).
// Negatives use `@ts-expect-error`: once the contract is right, `tsc` reports "unused directive",
// so this file going red is equivalent to a broken `declare module` merge target or payload type.

import type { Context } from "@deepseek-ai/cordis";

import type { HostContext } from "../src/index";

declare const ctx: Context;
declare function acceptsHostContext(host: HostContext): void;

// Positive 1: the real `Context` satisfies `apply`'s parameter (the host passes ctx straight in).
acceptsHostContext(ctx);

// Positive 2: a legal payload (`html` absent when `action: "delete"`).
ctx.emit("hreader/patch-request", {
  workspace: "/tmp/workspace",
  request: { targetId: "root", action: "delete" },
});

// @ts-expect-error missing payload: `Events['hreader/patch-request']` requires exactly one argument.
ctx.emit("hreader/patch-request");

// @ts-expect-error wrong payload type: `PatchAction` has no "move".
ctx.emit("hreader/patch-request", {
  workspace: "/tmp/workspace",
  request: { targetId: "root", action: "move" },
});
