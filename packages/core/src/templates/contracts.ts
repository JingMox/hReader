// This layer: template model vocabulary (manifest, sources, result and diagnostic types, capacity limits);
// pure data types and constants, no logic, no IO.

import type { PatchDeps } from "../io/ports";

/** The legal template id shape: kebab-case. It is joined into disk paths, so anything containing `..`/`/`/`\`/NUL/uppercase/overlength fails. */
export const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Capacity gate for a single template dir (against zip-bomb-level abuse); builtins satisfy it by construction. */
export const TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;
export const TEMPLATE_MAX_FILES = 1000;

/** The manifest filename and the three member defaults (effective when the manifest omits the field). */
export const MANIFEST_FILE = "template.json";
export const DEFAULT_ENTRY = "index.html";
export const DEFAULT_STYLE = "style.css";
export const DEFAULT_GUIDE = "guide.md";
export const ASSETS_DIR = "assets";

/** Where template dirs sit under the three-tier roots: `<home>/.hreader/templates` and `<workspace>/.hreader/templates`. */
export const TEMPLATES_DIRNAME = "templates";

export type TemplateSource = "builtin" | "user" | "workspace";

export type TemplateFormat = "html" | "managed";

/**
 * The parsed shape of `template.json`: keys identical to the file (no snake_case — the manifest is JSON anyway).
 * `entry`/`style`/`guide` keep the **author-written value** (`undefined` when absent); effective paths come from
 * the default constants on each field, so "explicitly written but missing on disk" stays distinguishable from "not written, use the default".
 */
export interface TemplateManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: 1;
  readonly format: TemplateFormat;
  readonly entry?: string;
  readonly style?: string;
  readonly guide?: string;
  readonly tags: readonly string[];
}

export interface TemplateRoots {
  /** Workspace root: workspace-tier templates live under `<workspace>/.hreader/templates`. */
  readonly workspace: string;
}

/** Same contract as `StyleDeps.home`: user-tier templates live under `<home>/.hreader/templates`; tests inject a temp dir. */
export interface TemplateDeps extends PatchDeps {
  readonly home: string;
}

/** One `listTemplates` entry: manifest summary + source. */
export interface TemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly format: TemplateFormat;
  readonly tags: readonly string[];
  readonly source: TemplateSource;
}

/** A skipped broken template: when `id` cannot be recovered, the dir name is recorded instead. */
export interface TemplateDiagnostic {
  readonly id: string;
  readonly source: TemplateSource;
  readonly message: string;
}

export interface TemplateList {
  readonly templates: readonly TemplateSummary[];
  /** One entry per broken template (including ones shadowed by a same-id higher-priority template): one bad apple must not sink the whole list. */
  readonly diagnostics: readonly TemplateDiagnostic[];
}

/** `readTemplate`'s full payload: manifest + the three member texts + the asset list (relative to the template root, `assets/`-prefixed). */
export interface LoadedTemplate {
  readonly manifest: TemplateManifest;
  readonly source: TemplateSource;
  readonly entry: string;
  readonly style?: string;
  readonly guide?: string;
  readonly assets: readonly string[];
}

export interface CreateFromTemplateInput {
  readonly id: string;
  /** Workspace-relative target path (same contract as `resolveTarget`'s `file`); `file_exists` when it already exists. */
  readonly target: string;
  /** Plain-text title: written into `<title>` and the first `<h1>`; when omitted the template's own title is kept. */
  readonly title?: string;
}

export interface CreateFromTemplateResult {
  /** Forward-slash landing path relative to the real workspace root. */
  readonly path: string;
  readonly bytes: number;
  /** Asset files actually written (forward-slash paths relative to the workspace). */
  readonly assets: readonly string[];
}

/** `saveTemplate`'s input: save the page plus its `<stem>_files/` dir as `<root>/<id>/`; `style`/`guide` override extraction. */
export interface SaveTemplateInput {
  readonly file: string;
  readonly id: string;
  readonly global?: boolean;
  readonly name?: string;
  readonly description?: string;
  readonly style?: string;
  readonly guide?: string;
}

/** `saveTemplate`'s result: template id, the on-disk dir, detected format, the tier it landed in and the copied assets. */
export interface SavedTemplate {
  readonly id: string;
  readonly dir: string;
  readonly format: TemplateFormat;
  readonly scope: "workspace" | "user";
  readonly assets: readonly string[];
}
