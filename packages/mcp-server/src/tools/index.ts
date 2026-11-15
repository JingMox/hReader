// 这层管：六个工具的注册表（名字 → 入参 schema → core 原语调用）；工具实现各自一个文件。
// 拆成两组只是为了让每个函数短到能一眼读完：读写（看清现状 + 开篇）与改动（落盘 + 结批注）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { applyStyleCall, applyStyleShape } from "./applyStyle";
import { createDocCall, createDocShape } from "./createDoc";
import { outlineCall, outlineShape } from "./outline";
import { patchNodeCall, patchNodeShape } from "./patchNode";
import { readNodeCall, readNodeShape } from "./readNode";
import { resolveAnnotationCall, resolveAnnotationShape } from "./resolveAnnotation";

export const registerTools = (server: McpServer): void => {
  registerReadingTools(server);
  registerEditingTools(server);
};

const registerReadingTools = (server: McpServer): void => {
  server.registerTool(
    "hr_outline",
    {
      title: "读文档大纲",
      description:
        "写稿前先看结构：返回标题层级、每节字数与未处理的 `pending_ai` 批注。不知道文档里有什么、或要挑一个节点改时先调它",
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
        "在给定路径新建一份最小合法文档（`<article>` + `<h1>` + `<section>`）并返回阅读视图。要凭空开一篇新稿时用它",
      inputSchema: createDocShape,
    },
    createDocCall,
  );
};

const registerEditingTools = (server: McpServer): void => {
  server.registerTool(
    "hr_patch_node",
    {
      title: "改一个节点",
      description:
        "对某个节点做 replace/insert_before/insert_after/append/delete。要动正文时用它，别整篇重写；写盘走原子替换并留 undo 快照",
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
    "hr_resolve_annotation",
    {
      title: "结掉一条批注",
      description:
        "把某条 `pending_ai` 批注标成 resolved（可附一句话说明）。真正改完正文之后再调它，否则清单里会显示已处理但正文没变",
      inputSchema: resolveAnnotationShape,
    },
    resolveAnnotationCall,
  );
};
