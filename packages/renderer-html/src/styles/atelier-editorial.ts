// 这层管：视觉主题的元数据（id / body 类名 / 展示名）；不装 CSS、不读盘。

/**
 * 主题 CSS 的单一真源永远是盘上的 `styles/<id>/theme.css`（由 core 的 `loadThemeCss` 读并过
 * `assertThemeSafe`）。这里重复存一份 CSS 就会立刻产生第二份真源，换机器换字节、与"主题只增不改"的约定漂移。
 */
export interface VisualTheme {
  readonly id: string;
  /** 产物 `<body>` 的类名；约定 `visual-<id>`，供主题 CSS 按主题分叉用。 */
  readonly bodyClass: string;
  readonly label: string;
}

/** 打印层认得的主题：`--visual` 入参经它翻成 `<body class>`。 */
export const THEMES: Readonly<Record<string, VisualTheme>> = {
  "atelier-editorial": {
    id: "atelier-editorial",
    bodyClass: "visual-atelier-editorial",
    label: "Atelier 编辑体",
  },
  "deck-noir": {
    id: "deck-noir",
    bodyClass: "visual-deck-noir",
    label: "Deck Noir 暗夜演示",
  },
};
