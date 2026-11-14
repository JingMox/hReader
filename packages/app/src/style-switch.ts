// 这层管：0-token 主题切换——只替换 `<style id="hr-theme">` 的文本，不动页面、不丢滚动位置。
// 纯逻辑 + 注入口，因此「同一主题重复选不重写」「失败保留旧 CSS」都能不进浏览器断言。

export type ThemeOutcome =
  | { readonly status: "applied"; readonly id: string }
  | { readonly status: "unchanged"; readonly id: string }
  | { readonly status: "failed"; readonly id: string; readonly message: string };

interface StyleSwitchDeps {
  /** `GET /api/theme/<id>` 的文本（失败必须 reject）。 */
  readonly loadCss: (id: string) => Promise<string>;
  /** 写 `<style id="hr-theme">.textContent`；真实实现由 `dom.ts` 提供。 */
  readonly applyCss: (css: string) => void;
}

export interface StyleSwitch {
  /** 幂等：`id === current` 时不发请求、不写 DOM，直接 `unchanged`。 */
  readonly select: (id: string, current: string) => Promise<ThemeOutcome>;
}

export const createStyleSwitch = (deps: StyleSwitchDeps): StyleSwitch => {
  let applied = "";

  const select = async (id: string, current: string): Promise<ThemeOutcome> => {
    if (id === current || id === applied) return { status: "unchanged", id };
    try {
      const css = await deps.loadCss(id);
      deps.applyCss(css);
      applied = id;
      return { status: "applied", id };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", id, message };
    }
  };

  return { select };
};
