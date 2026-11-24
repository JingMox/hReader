// 这层管：选择器属性值转义（`dom.ts` 的宿主实现与 `widgets/**` 共用——depcruise 不允许
// widget 反向依赖宿主层，所以这条纯函数单独成文件，谁都能拿）。

/** 属性值里的 `"` / `\` / `]` 必须转义，否则 id 能提前闭合选择器。 */
export const escapeAttr = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("]", "\\]");
