// This layer: shared types and validation helpers for argv parsing; no concrete commands.

import { resolve } from "node:path";
import type { AnnotationStatusFilter, DocKind, PatchAction } from "@hreader/core";

import type { CommandName } from "../usage";
import type { Raw } from "./raw";

export type HtmlSource =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };

/** `--strict` failure threshold: `error` = fail only on error-level diagnostics (default for a bare `--strict`); `warning` = fail on any diagnostic. */
export type StrictLevel = "error" | "warning";

export type StyleMode =
  | { readonly kind: "visual"; readonly id: string }
  | { readonly kind: "tone"; readonly id: string }
  | { readonly kind: "lint" };

interface Common {
  readonly json: boolean;
  readonly workspace: string;
}

/** `--home` overrides the user tier's parent dir (`<home>/.hreader/`); `undefined` = `HREADER_HOME` / `homedir()`. */
interface Home {
  readonly home: string | undefined;
}

export type Intent =
  | { readonly kind: "help"; readonly topic: CommandName | undefined }
  | ({ readonly kind: "outline"; readonly path: string } & Common)
  | ({
      readonly kind: "normalize";
      readonly path: string;
      /** Default `false`: do not write; just hand the normalized result to the caller. */
      readonly write: boolean;
    } & Common)
  | ({
      readonly kind: "read";
      readonly path: string;
      readonly target: string;
      readonly maxBytes: number | undefined;
    } & Common)
  | ({
      readonly kind: "patch";
      readonly path: string;
      readonly nodeId: string;
      readonly action: PatchAction;
      readonly html: HtmlSource | undefined;
    } & Common)
  | ({
      readonly kind: "style";
      readonly path: string;
      readonly mode: StyleMode;
      /** Only `--lint` mode carries this; `--strict` in other modes is rejected at the intent layer. */
      readonly strict: StrictLevel | undefined;
    } & Common)
  | ({
      readonly kind: "styleExtract";
      /** Corpus files (absolute paths); order follows argv order — the stats layer is order-insensitive but the report must reproduce it. */
      readonly files: readonly string[];
      readonly id: string;
      readonly name: string;
      /** Whether the id fell back to a filename slug: `run.ts` uses this to note "default used" on stderr. */
      readonly idGiven: boolean;
      readonly nameGiven: boolean;
      readonly out: string | undefined;
      readonly inheritsVisual: string;
      readonly noLlm: boolean;
      /** `--model` / `--base-url`: explicit overrides of the env defaults; `undefined` = not given, left to `llm/session`. */
      readonly model: string | undefined;
      readonly baseUrl: string | undefined;
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "export";
      readonly path: string;
      readonly visual: string;
      /** Where the print sheet lands (absolute path); `undefined` = print to stdout. */
      readonly out: string | undefined;
      /** Whether to overwrite an existing `--out` (default refuses with `file_exists`). */
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "pdf";
      readonly path: string;
      /** Kept verbatim: validity is judged at the command layer (illegal value is `invalid_input` exit 1, not usage error exit 2). */
      readonly pageSize: string;
      readonly timeoutMs: number;
      /** Outline defaults on (bare `--outline` means on); `--no-outline` sets false. */
      readonly outline: boolean;
      /** Both outline flags given: the usage layer can only tell "was it given"; exclusivity is a semantic error (the command layer reports `invalid_input`). */
      readonly outlineConflict: boolean;
      /** `undefined` = use the document's embedded `#hr-theme`; the command layer falls back to the default theme when the document has none. */
      readonly visual: string | undefined;
      /** `--out` required (the written file is this command's only product). */
      readonly out: string;
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "png";
      readonly path: string;
      /** All three sizes stay verbatim strings: validity is judged at the command layer (`invalid_input` exit 1). */
      readonly width: string;
      readonly scale: string;
      /** CSS-pixel cap: overflow is clipped (not scaled) and `clipped` is set in the result. */
      readonly maxHeight: string;
      /** Whether the user explicitly passed `--max-height`: without it the default must not feed the worst-case area preflight. */
      readonly maxHeightExplicit: boolean;
      /** The outline flag as given (`--outline`/`--no-outline`): PNG has no outline, so the command layer reports `invalid_input` from this. */
      readonly outlineFlag: string | undefined;
      readonly timeoutMs: number;
      /** `undefined` = use the document's embedded `#hr-theme`; the command layer falls back to the default theme when the document has none. */
      readonly visual: string | undefined;
      readonly out: string;
      readonly force: boolean;
    } & Common)
  | ({ readonly kind: "undo"; readonly path: string } & Common)
  | ({
      readonly kind: "check";
      readonly path: string;
      /** Without `--strict`, keep the existing "exit 0 even with findings" behavior. */
      readonly strict: StrictLevel | undefined;
    } & Common)
  | ({
      readonly kind: "new";
      readonly path: string;
      readonly docKind: DocKind;
      readonly title: string;
      readonly visual: string;
      /** Whether to overwrite an existing `<file>` (default refuses with `file_exists`). */
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "import";
      /** Foreign HTML source file (absolute path). */
      readonly path: string;
      /** Stays `undefined` without `--kind`: the default shape is core's call; this layer invents no default. */
      readonly docKind: DocKind | undefined;
      readonly title: string | undefined;
      /** Destination (absolute path): the intent layer already substituted `<name>.hr.html` when `--out` was not given. */
      readonly out: string;
      readonly force: boolean;
    } & Common)
  | ({
      readonly kind: "serve";
      readonly path: string;
      readonly port: number;
      readonly allowHosts: readonly string[] | undefined;
      /** Absolute path of an explicit `--app-dir`; `undefined` when not given (core provides the fallback). */
      readonly appDir: string | undefined;
      /** Whether the user explicitly gave `--app-dir`: `run.ts` uses this to decide "missing directory -> exit 2". */
      readonly appDirGiven: boolean;
      /** Absolute path of `--home`; `undefined` = use `homedir()` (default behavior unchanged). */
      readonly home: string | undefined;
      /** `--exit-with-parent`: exit when the parent (shell) disappears; default false so a user-started daemon is unaffected. */
      readonly exitWithParent: boolean;
    } & Common)
  | ({ readonly kind: "templateList" } & Home & Common)
  | ({
      readonly kind: "templateShow";
      readonly id: string;
    } & Home &
      Common)
  | ({
      readonly kind: "templateNew";
      readonly path: string;
      readonly template: string;
      /** `undefined` keeps the template's own title (`hr template new` invents no filename default). */
      readonly title: string | undefined;
    } & Home &
      Common)
  | ({
      readonly kind: "templateSave";
      readonly path: string;
      readonly id: string;
      readonly global: boolean;
      readonly name: string | undefined;
      readonly description: string | undefined;
    } & Home &
      Common)
  | ({
      readonly kind: "annotationsList";
      readonly path: string;
      /** Absent `--status` normalizes to `all` here — the command layer never sees "not given". */
      readonly status: AnnotationStatusFilter;
    } & Common)
  | ({
      readonly kind: "annotationsMigrate";
      readonly path: string;
    } & Common);

export type ParsedArgs =
  | { readonly ok: true; readonly intent: Intent }
  | {
      readonly ok: false;
      readonly message: string;
      readonly topic: CommandName | undefined;
    };

export const failure = (message: string, topic: CommandName | undefined): ParsedArgs => ({
  ok: false,
  message,
  topic,
});

export const unusedFlag = (raw: Raw, allowed: readonly string[]): string | undefined => {
  for (const name of raw.values.keys()) {
    if (!allowed.includes(name)) return name;
  }
  for (const name of raw.switches) {
    if (!allowed.includes(name)) return name;
  }
  return undefined;
};

export const commonOf = (raw: Raw, cwd: string): Common => ({
  json: raw.switches.has("--json"),
  workspace: resolve(cwd, raw.values.get("--workspace") ?? cwd),
});

/** Same resolution rule as `--workspace`: a relative `--home` resolves against cwd; existence is checked later (run.ts → UsageError exit 2). */
export const homeOf = (raw: Raw, cwd: string): Home => {
  const given = raw.values.get("--home");
  return { home: given === undefined ? undefined : resolve(cwd, given) };
};

/** Paths are always resolved to absolute against cwd first; converting write targets to workspace-relative happens in `run.ts` (which can realpath). */
export const absoluteOf = (file: string, cwd: string): string => resolve(cwd, file);

/**
 * Two-way `--strict` normalization: a bare flag (switches) is `error`, `=error|warning` (values) maps by value;
 * anything else returns `"invalid"`, and the caller turns it into the "unknown --X" usage error.
 */
export const strictOf = (raw: Raw): StrictLevel | undefined | "invalid" => {
  const given = raw.values.get("--strict");
  if (given !== undefined) {
    return given === "error" || given === "warning" ? given : "invalid";
  }
  return raw.switches.has("--strict") ? "error" : undefined;
};

/** Parses a closed-range integer option; returns `undefined` when absent and `"invalid"` when malformed or out of range. */
export const intInRange = (
  raw: Raw,
  flag: string,
  min: number,
  max: number,
): number | undefined | "invalid" => {
  const value = raw.values.get(flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : "invalid";
};
