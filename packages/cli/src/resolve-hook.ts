// This layer: core's internal relative imports carry no extension (vitest infers it, Node ESM does not) — fill in `.ts` and `/index.ts`.
// Only relative specifiers get the fallback; other specifier failures rethrow as-is so real resolution errors surface.

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
