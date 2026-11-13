// 这层管：core 的内部相对导入不带扩展名（vitest 会推断，Node ESM 不推断）——补 `.ts` 与 `/index.ts`。
// 只对相对说明符降级；其它说明符失败时原样再抛一次，让真实解析错误冒出来。

import type { ResolveFnOutput, ResolveHookContext } from "node:module";

type NextResolve = (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput;

const attempt = (
  nextResolve: NextResolve,
  specifier: string,
  context: ResolveHookContext,
): ResolveFnOutput | undefined => {
  try {
    return nextResolve(specifier, context);
  } catch {
    return undefined;
  }
};

export const resolveFallback = (
  specifier: string,
  context: ResolveHookContext,
  nextResolve: NextResolve,
): ResolveFnOutput => {
  const direct = attempt(nextResolve, specifier, context);
  if (direct !== undefined) return direct;
  if (!specifier.startsWith(".")) return nextResolve(specifier, context);
  const asTs = attempt(nextResolve, `${specifier}.ts`, context);
  return asTs ?? nextResolve(`${specifier}/index.ts`, context);
};
