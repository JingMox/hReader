// This layer: `hr meta <file>` — read (no mutation flags) or merge-write the doc's row in
// the shared `.hreader/meta.json` table. Diagnostics land in the envelope under --json and
// on stderr in human mode — same convention as `hr search`/`hr annotations list`.

import { getDocMeta, nodePatchDeps, setDocMeta, type DocMetaRecord } from "@hreader/core";

import { dataMeta, humanMeta, jsonOk, term } from "../output";

export interface MetaCommandInput {
  /** Workspace-relative POSIX path (the dispatch layer already realpath'd both sides). */
  readonly path: string;
  readonly workspace: string;
  readonly tags: readonly string[];
  readonly untags: readonly string[];
  readonly sourceUrl: string | undefined;
  readonly clearSourceUrl: boolean;
  readonly json: boolean;
  readonly warn: (message: string) => void;
}

export const metaCommand = async (input: MetaCommandInput): Promise<string> => {
  const mutating =
    input.tags.length > 0 ||
    input.untags.length > 0 ||
    input.sourceUrl !== undefined ||
    input.clearSourceUrl;
  let meta: DocMetaRecord;
  let changed: boolean;
  let diagnostics: readonly string[];
  if (mutating) {
    const written = await setDocMeta(
      {
        workspace: input.workspace,
        file: input.path,
        patch: {
          ...(input.tags.length === 0 ? {} : { addTags: input.tags }),
          ...(input.untags.length === 0 ? {} : { removeTags: input.untags }),
          ...(input.clearSourceUrl
            ? { sourceUrl: null }
            : input.sourceUrl === undefined
              ? {}
              : { sourceUrl: input.sourceUrl }),
        },
        by: "user",
      },
      nodePatchDeps,
    );
    meta = written.meta;
    changed = written.changed;
    diagnostics = written.diagnostics;
  } else {
    const got = await getDocMeta({ workspace: input.workspace, file: input.path }, nodePatchDeps);
    meta = got.meta;
    changed = false;
    diagnostics = got.diagnostics;
  }
  for (const line of diagnostics) input.warn(term(`warning: ${line}\n`));
  const report = { path: input.path, meta, changed, diagnostics };
  return input.json ? jsonOk(dataMeta(report)) : humanMeta(report);
};
