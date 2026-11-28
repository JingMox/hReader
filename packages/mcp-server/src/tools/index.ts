// This layer: the registry of the eight tools (name → input schema → core primitive call); each tool lives in its own file.
// The three groups only exist to keep each function short enough to read at a glance: read/write (see the state + start a doc), change (write + resolve annotations), undo.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { applyStyleCall, applyStyleShape } from "./apply-style";
import { createDocCall, createDocShape } from "./create-doc";
import { createFromTemplateCall, createFromTemplateShape } from "./create-from-template";
import { getMetaCall, getMetaShape, setMetaCall, setMetaShape } from "./doc-meta";
import { getTemplateCall, getTemplateShape } from "./get-template";
import { importDocCall, importDocShape } from "./import-doc";
import { listAnnotationsCall, listAnnotationsShape } from "./list-annotations";
import { listTemplatesCall, listTemplatesShape } from "./list-templates";
import { outlineCall, outlineShape } from "./outline";
import { patchNodeCall, patchNodeShape } from "./patch-node";
import { readNodeCall, readNodeShape } from "./read-node";
import { resolveAnnotationCall, resolveAnnotationShape } from "./resolve-annotation";
import { saveTemplateCall, saveTemplateShape } from "./save-template";
import { searchCall, searchShape } from "./search";
import { undoCall, undoShape } from "./undo";

export const registerTools = (server: McpServer): void => {
  registerReadingTools(server);
  registerEditingTools(server);
  registerTemplateTools(server);
  registerUndoTool(server);
};

const registerReadingTools = (server: McpServer): void => {
  server.registerTool(
    "hr_outline",
    {
      title: "读文档大纲",
      description:
        "写稿前先看结构：返回标题层级、每节字数与未处理的批注。不知道文档里有什么、或要挑一个节点改时先调它",
      inputSchema: outlineShape,
    },
    outlineCall,
  );
  server.registerTool(
    "hr_read_node",
    {
      title: "读单个节点",
      description:
        "按 `hr_outline` 给的 nodeId 取那一块的真实 HTML（含批注）。要改某段正文前先用它看清现状，别凭大纲猜",
      inputSchema: readNodeShape,
    },
    readNodeCall,
  );
  server.registerTool(
    "hr_create_doc",
    {
      title: "新建文档",
      description:
        "在给定路径新建文档并返回阅读视图。不给 kind 是最小合法文档（`<article>` + `<h1>` + `<section>`）；给 kind（note/report/minutes/brief/slides）则按形态起稿。要凭空开一篇新稿时用它",
      inputSchema: createDocShape,
    },
    createDocCall,
  );
  server.registerTool(
    "hr_import_doc",
    {
      title: "导入外来 HTML",
      description:
        "把外来 HTML（网页另存、带脚本的演示稿）转成托管文档并落盘：剥脚本/事件/内联样式，按标题分节并补齐 data-hr-id。想让一份外来文档能被按块编辑、批注、换主题时用它；返回的 report 说明哪些内容被丢弃及原因",
      inputSchema: importDocShape,
    },
    importDocCall,
  );
  server.registerTool(
    "hr_search",
    {
      title: "全文检索整个库",
      description:
        "在整个工作区里全文检索：覆盖每篇文档的标题/层级/正文及其批注（note + 摘录），返回 {results: [{path, title, kind, annotationId, score, snippet, highlights}], total, truncated, diagnostics}。想不起来文档叫什么、或要按内容找文档与批注时用它",
      inputSchema: searchShape,
    },
    searchCall,
  );
};

const registerEditingTools = (server: McpServer): void => {
  server.registerTool(
    "hr_patch_node",
    {
      title: "改一个节点",
      description:
        "对某个节点做 replace/insert_before/insert_after/append/delete。要动正文时用它，别整篇重写；写盘走原子替换并留 undo 快照。返回里的 warnings 含排版约束问题（组件结构不对、内联 style），看到就再 patch 一次改掉",
      inputSchema: patchNodeShape,
    },
    patchNodeCall,
  );
  server.registerTool(
    "hr_apply_style",
    {
      title: "换视觉 / 取调性规约",
      description:
        "给 visualId 只换主题样式表（不动正文）；给 toneId 取回该风格完整的语言规约（不改文件）。要按某种语气写稿时先取规约",
      inputSchema: applyStyleShape,
    },
    applyStyleCall,
  );
  server.registerTool(
    "hr_list_annotations",
    {
      title: "列批注",
      description:
        "列批注：给 filePath 时返回该文档的合并视图（hr-meta + 侧车，各条带锚点定位结果）；省略时扫整个工作区（≤500 文档、≤1000 条，超出给 truncated）。找待处理批注、或盘点哪些文档还有批注时用它",
      inputSchema: listAnnotationsShape,
    },
    listAnnotationsCall,
  );
  server.registerTool(
    "hr_resolve_annotation",
    {
      title: "结掉一条批注",
      description:
        "把某条未处理的批注标成 resolved（可附一句话说明）。真正改完正文之后再调它，否则清单里会显示已处理但正文没变",
      inputSchema: resolveAnnotationShape,
    },
    resolveAnnotationCall,
  );
  server.registerTool(
    "hr_get_meta",
    {
      title: "读文档元数据",
      description:
        "读一篇文档的元数据：标签列表、来源 URL 与首次写入者/时间（存 <workspace>/.hreader/meta.json，按相对路径记档——改名会丢）。要找某篇文档的标签或来源时用它",
      inputSchema: getMetaShape,
    },
    getMetaCall,
  );
  server.registerTool(
    "hr_set_meta",
    {
      title: "写文档元数据",
      description:
        "合并写一篇文档的元数据：tags 整表替换 / addTags 追加 / removeTags 移除（均大小写不敏感去重，≤32 个 × 64 码点），sourceUrl 设置或传 null 清除（http/https ≤2048 码点）。只给定的字段才变；记录归 agent 名下",
      inputSchema: setMetaShape,
    },
    setMetaCall,
  );
};

/** Templates are their own group: list/inspect/create/save over the three-tier template roots. */
const registerTemplateTools = (server: McpServer): void => {
  server.registerTool(
    "hr_list_templates",
    {
      title: "列可用模板",
      description:
        "列出三层（内置 < 用户 < 工作区）合并后的可用模板：id、显示名、format、来源层与标签；损坏的模板在 diagnostics 里逐条说明，不拖垮整个列表",
      inputSchema: listTemplatesShape,
    },
    listTemplatesCall,
  );
  server.registerTool(
    "hr_get_template",
    {
      title: "读一个模板",
      description:
        "按 id 取模板的 manifest、entry/style/guide 全文（各字段超长截断并带标记）与资源清单。要复刻某个模板结构或改派生样式时先读它",
      inputSchema: getTemplateShape,
    },
    getTemplateCall,
  );
  server.registerTool(
    "hr_create_from_template",
    {
      title: "按模板起稿",
      description:
        '在给定路径按模板新建文档（缺省 blank-html）：主题内联进 `<style id="hr-theme">`，资源落到同名 <stem>_files/ 下；目标已存在时报 file_exists',
      inputSchema: createFromTemplateShape,
    },
    createFromTemplateCall,
  );
  server.registerTool(
    "hr_save_template",
    {
      title: "存页面为模板",
      description:
        '把工作区里的页面连同 <stem>_files/ 资源存成模板：`<style id="hr-theme">` 的内容进 style.css，entry 留空占位；`--global` 存用户层否则存工作区层；`style`/`guide` 可覆盖自动提取值；目标已存在时报 file_exists',
      inputSchema: saveTemplateShape,
    },
    saveTemplateCall,
  );
};

/** Undo is its own group: it changes "the last write" and shares the same snapshot chain as patch (`revertLast` is the only entry). */
const registerUndoTool = (server: McpServer): void => {
  server.registerTool(
    "hr_undo",
    {
      title: "撤销上一次写",
      description:
        "把最近一次写入**之前**的字节原样放回去（改错了用它，别再用 hr_patch_node 覆盖——覆盖会把写前字节彻底丢掉）；没有历史快照时返回 nothing_to_undo",
      inputSchema: undoShape,
    },
    undoCall,
  );
};
