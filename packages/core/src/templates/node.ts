// This layer: templates' default deps (node fs + real HOME); same contract as `style/node.ts`.

import { homedir } from "node:os";

import { nodePatchDeps } from "../io/node-fs";
import type { TemplateDeps } from "./contracts";

/** The user-tier template root is `<homedir()>/.hreader/templates`; tests inject a temp home and never touch the real HOME. */
export const nodeTemplateDeps = (): TemplateDeps => ({
  ...nodePatchDeps,
  home: homedir(),
});
