// This layer: `hr template <list|show|new|save>` — three-tier template listing/inspection plus
// create-from / save-as flows; argument shapes are settled in args/, exit codes come from core's HrError codes.

import { join } from "node:path";

import {
  createFromTemplate,
  listTemplates,
  nodeTemplateDeps,
  readTemplate,
  saveTemplate,
  type TemplateDeps,
} from "@hreader/core";

import {
  dataTemplateList,
  dataTemplateNew,
  dataTemplateSave,
  dataTemplateShow,
  displayedPathOf,
  humanTemplateList,
  humanTemplateNew,
  humanTemplateSave,
  humanTemplateShow,
  jsonOk,
  term,
} from "../output";

const encoder = new TextEncoder();

/** The default home already honors `HREADER_HOME` — run.ts resolves it once; `--home` arrives here as an explicit override. */
const depsOf = (home: string): TemplateDeps => ({ ...nodeTemplateDeps(), home });

export interface TemplateListInput {
  readonly workspace: string;
  readonly home: string;
  readonly json: boolean;
  /** stderr route for per-template diagnostics (broken/shadowed entries never sink the list). */
  readonly warn: (message: string) => void;
}

export const templateListCommand = async (input: TemplateListInput): Promise<string> => {
  const result = await listTemplates({ workspace: input.workspace }, depsOf(input.home));
  for (const diagnostic of result.diagnostics) {
    input.warn(
      term(
        `warning: ${diagnostic.source} 层模板 ${diagnostic.id} 已跳过 — ${diagnostic.message}\n`,
      ),
    );
  }
  return input.json ? jsonOk(dataTemplateList(result)) : humanTemplateList(result.templates);
};

export interface TemplateShowInput {
  readonly id: string;
  readonly workspace: string;
  readonly home: string;
  readonly json: boolean;
}

export const templateShowCommand = async (input: TemplateShowInput): Promise<string> => {
  const loaded = await readTemplate(input.id, { workspace: input.workspace }, depsOf(input.home));
  const sizes = {
    entry: encoder.encode(loaded.entry).byteLength,
    ...(loaded.style === undefined ? {} : { style: encoder.encode(loaded.style).byteLength }),
    ...(loaded.guide === undefined ? {} : { guide: encoder.encode(loaded.guide).byteLength }),
  };
  return input.json ? jsonOk(dataTemplateShow(loaded)) : humanTemplateShow(loaded, sizes);
};

export interface TemplateNewInput {
  /** Workspace-relative landing path (the dispatch layer already converted). */
  readonly file: string;
  readonly template: string;
  readonly title: string | undefined;
  readonly workspace: string;
  readonly home: string;
  readonly json: boolean;
  /** Path printed in the receipt (user's view); falls back to the workspace-relative path. */
  readonly displayPath?: string | undefined;
}

export const templateNewCommand = async (input: TemplateNewInput): Promise<string> => {
  const result = await createFromTemplate(
    {
      id: input.template,
      target: input.file,
      ...(input.title === undefined ? {} : { title: input.title }),
    },
    { workspace: input.workspace },
    depsOf(input.home),
  );
  const report = {
    path: join(input.workspace, result.path),
    template: input.template,
    title: input.title ?? null,
    bytes: result.bytes,
    assets: result.assets,
  };
  return input.json
    ? jsonOk(dataTemplateNew(report))
    : humanTemplateNew(report, input.displayPath ?? result.path);
};

export interface TemplateSaveInput {
  /** Workspace-relative source page (the dispatch layer already converted). */
  readonly file: string;
  readonly id: string;
  readonly global: boolean;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly workspace: string;
  readonly home: string;
  readonly json: boolean;
  /** The user's cwd: the receipt prints the template dir from the user's view. */
  readonly cwd: string;
}

export const templateSaveCommand = async (input: TemplateSaveInput): Promise<string> => {
  const saved = await saveTemplate(
    {
      file: input.file,
      id: input.id,
      global: input.global,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    { workspace: input.workspace },
    depsOf(input.home),
  );
  return input.json
    ? jsonOk(dataTemplateSave(saved))
    : humanTemplateSave(saved, displayedPathOf(saved.dir, input.cwd));
};
