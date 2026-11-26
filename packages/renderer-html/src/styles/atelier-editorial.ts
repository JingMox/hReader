// Metadata of the visual themes (id / body class / display name); holds no CSS and reads no disk.

/**
 * The single source of truth for theme CSS is always the on-disk `styles/<id>/theme.css` (read by core's `loadThemeCss`
 * and checked by `assertThemeSafe`). Duplicating the CSS here would instantly create a second source of truth — bytes
 * that drift across machines and away from the "themes only grow, never change" rule.
 */
export interface VisualTheme {
  readonly id: string;
  /** Class name on the product `<body>`; conventionally `visual-<id>`, letting theme CSS branch per theme. */
  readonly bodyClass: string;
  readonly label: string;
}

/** Themes the print layer knows: the `--visual` argument is translated through this table into a `<body class>`. */
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
