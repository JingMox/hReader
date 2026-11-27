// This layer: `hr_list_templates` (three-tier merged list + per-template diagnostics); no arguments.

import { listTemplates } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { guarded, okResult } from "../errors";
import { templateDepsOf } from "./template-deps";

export const listTemplatesShape = {};

export const listTemplatesCall = (): Promise<CallToolResult> =>
  guarded("hr_list_templates", async () =>
    okResult(await listTemplates({ workspace: process.cwd() }, templateDepsOf())),
  );
