// 这层管：文档模型的类型与词表（内联元素、标题层级、article 标签）；不含逻辑、不碰 IO。

/** 模型节点是纯数据：可 `structuredClone`，无类实例、无 getter、无循环。 */
export interface DocumentModel {
  readonly id: string;
  readonly tag: string;
  readonly component?: string;
  /** 本节点自身的可见文本：直接文本 + 内联后代，空白归一；不含块级后代的文本。 */
  readonly text: string;
  /** 块级后代（M1.1 注入清单），文档顺序。 */
  readonly children: readonly DocumentModel[];
}

export const ARTICLE_TAG = "article";

/** 渲染上是换行：模型里必须当词边界，否则 `a<br>b` 会粘成 `ab`。 */
export const BR_TAG = "br";

/** h1 在 `<article>` 内是规范形态，不诊断；跳级判定只看相邻标题的层级数字差 >1。 */
export const HEADING_LEVELS: Readonly<Record<string, number>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};
