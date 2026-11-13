// 这层管：测试用的 HTML 语料（完整文档 + 真实结构文章）；不含断言、不碰 fs。

/** 完整文档：realpath/原子写/undo 都要按真实文件形态跑，片段形态另有用例覆盖。 */
export const ARTICLE_DOC = [
  '<!DOCTYPE html><html lang="zh-CN"><head>',
  '<meta charset="utf-8">',
  "<title>M1.5 夹具</title>",
  "</head><body>",
  '<article data-hr-id="root" class="post" data-site="hr">',
  '<h2 data-hr-id="h1">标题</h2>',
  '<section data-hr-id="box"><p data-hr-id="p0">零</p></section>',
  '<p data-hr-id="p1" class="lead">第一段</p>',
  '<p data-hr-id="p2">第二段</p>',
  "</article>",
  "</body></html>",
].join("\n");

/** 仿真实文章：组件 div、header、多段；`readNode` 的既有夹具形态。 */
export const CORPUS_DOC = [
  '<article data-hr-id="root" class="post" data-site="hr">',
  '<header data-hr-id="head"><h1 data-hr-id="title">标题</h1></header>',
  '<div data-hr-component="callout-insight" data-hr-id="insight"><p data-hr-id="i1">洞察</p></div>',
  '<p data-hr-id="p1" class="lead">第一段</p>',
  '<p data-hr-id="p2">第二段</p>',
  "</article>",
].join("\n");

/** 目标相对 workspace：所有 io 用例用同一个入口名，方便断言 history/锁的键。 */
export const DOC_FILE = "post.html";
