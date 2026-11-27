// This layer: the templates submodule facade (public API + types + default deps); carries no implementation.

export { TEMPLATE_ID, TEMPLATE_MAX_BYTES, TEMPLATE_MAX_FILES } from "./contracts";
export type {
  CreateFromTemplateInput,
  CreateFromTemplateResult,
  LoadedTemplate,
  TemplateDeps,
  TemplateDiagnostic,
  TemplateFormat,
  TemplateList,
  TemplateManifest,
  TemplateRoots,
  TemplateSource,
  TemplateSummary,
} from "./contracts";
export { createFromTemplate } from "./create";
export { listTemplates, readTemplate } from "./service";
export { nodeTemplateDeps } from "./node";
