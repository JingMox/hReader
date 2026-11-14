// 这层管：从页面注入点取 docId（`data-doc-id` 优先，其次 `?doc=`）；不碰 DOM 之外的全局。

export interface DocIdSource {
  readonly attr: string | null;
  readonly href: string;
}

export const docIdOf = (source: DocIdSource): string => {
  if (source.attr !== null && source.attr !== "") return source.attr;
  const fromUrl = new URL(source.href).searchParams.get("doc");
  return fromUrl ?? "";
};
