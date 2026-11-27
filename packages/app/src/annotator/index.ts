// Bundle entry: capture the environment, run the engine, post hello once. The
// IIFE build leaks no globals; in a non-window context (tests) import stays inert.

import { captureEnv } from "./caps.ts";
import { runAnnotator } from "./run.ts";

declare const window: unknown;

export const bootstrap = (win: unknown): void => {
  runAnnotator(captureEnv(win));
};

if (typeof window !== "undefined") bootstrap(window);
