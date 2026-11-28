// This layer: `hr search <query>` — workspace-wide full-text search over docs and their
// annotations. Diagnostics land in the envelope under --json and on stderr (via `warn`)
// in human mode — same convention as `hr annotations list`.

import { nodePatchDeps, searchLibrary } from "@hreader/core";

import { dataSearch, humanSearch, jsonOk, term } from "../output";

export interface SearchCommandInput {
  readonly query: string;
  readonly limit: number | undefined;
  /** The dispatch layer already realpath'd it (missing workspace died at exit 2). */
  readonly workspace: string;
  readonly json: boolean;
  readonly warn: (message: string) => void;
}

export const searchCommand = async (input: SearchCommandInput): Promise<string> => {
  const result = await searchLibrary(
    {
      workspace: input.workspace,
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
    nodePatchDeps,
  );
  for (const line of result.diagnostics) input.warn(term(`warning: ${line}\n`));
  return input.json ? jsonOk(dataSearch(result)) : humanSearch(result);
};
