// This layer: `hr annotations <list|migrate>` — the merged meta+sidecar view of one document,
// plus the one-way hr-meta → sidecar migration; argument shapes are settled in args/, exit codes
// come from core's HrError codes.
// Diagnostics land in the envelope under --json and on stderr (via `warn`) in human mode —
// same convention as `hr template list`: a dirty store never sinks the whole command.

import {
  listDocAnnotations,
  migrateMetaAnnotations,
  nodePatchDeps,
  type AnnotationStatusFilter,
} from "@hreader/core";

import {
  dataAnnotationsList,
  dataAnnotationsMigrate,
  humanAnnotationsList,
  humanAnnotationsMigrate,
  jsonOk,
  term,
} from "../output";

export interface AnnotationsListInput {
  /** Workspace-relative document path (the dispatch layer already converted). */
  readonly path: string;
  readonly workspace: string;
  readonly status: AnnotationStatusFilter;
  readonly json: boolean;
  /** stderr route for store diagnostics — the dispatch layer always wires it up. */
  readonly warn: (message: string) => void;
  /** Path printed in the receipt (user's view). */
  readonly displayPath: string;
}

export const annotationsListCommand = async (input: AnnotationsListInput): Promise<string> => {
  const result = await listDocAnnotations(
    { workspace: input.workspace, file: input.path },
    nodePatchDeps,
  );
  for (const line of result.diagnostics) input.warn(term(`warning: ${line}\n`));
  const annotations = result.annotations.filter(
    (entry) => input.status === "all" || entry.annotation.status === input.status,
  );
  return input.json
    ? jsonOk(dataAnnotationsList(input.path, annotations, result.diagnostics))
    : humanAnnotationsList(annotations, input.displayPath);
};

export interface AnnotationsMigrateInput {
  readonly path: string;
  readonly workspace: string;
  readonly json: boolean;
  readonly warn: (message: string) => void;
  readonly displayPath: string;
}

export const annotationsMigrateCommand = async (
  input: AnnotationsMigrateInput,
): Promise<string> => {
  const result = await migrateMetaAnnotations(
    { workspace: input.workspace, file: input.path },
    nodePatchDeps,
  );
  for (const line of result.diagnostics) input.warn(term(`warning: ${line}\n`));
  return input.json
    ? jsonOk(dataAnnotationsMigrate(result, input.path))
    : humanAnnotationsMigrate(result, input.displayPath);
};
