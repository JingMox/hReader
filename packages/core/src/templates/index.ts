// 这层管：templates 子模块门面（公开 API + 类型 + 默认依赖）；不承载实现。

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
export { listTemplates, readTemplate } from "./service";
export { nodeTemplateDeps } from "./node";
