// 这层管：外来 / 未规范化文档的 iframe 承载、信任横幅与底栏权限开关。
// 外来内容只走 `<iframe src="/s/<docId>">`——绝不进 innerHTML：正文不落在阅读器 DOM 里，
// 块级 diff、批注、演示模式也就天然够不到它。

import type { Host } from "../dom.ts";
import { COPY } from "./copy.ts";

/** 服务端 `trust` 字段的旧式档位（兼容字段）：off = 脚本不生效；local = 脚本生效。 */
export type TrustLevel = "off" | "local";

/** 全局权限模式：allow/deny 时单文档记录被忽略（开关置灰），per-doc 时逐文档生效。 */
export type PermissionMode = "allow" | "deny" | "per-doc";

/** 生效值来源：doc = 单文档记录；global = 全局设置统一控制。 */
export type PermissionSource = "doc" | "global";

export interface DocPermissionModes {
  readonly scripts: PermissionMode;
  readonly network: PermissionMode;
}

/** `info.permissions` 与 `POST /permissions` 应答共用的生效视图（两维独立）。 */
export interface DocPermissions {
  readonly scripts: boolean;
  readonly network: boolean;
  readonly scriptsSource: PermissionSource;
  readonly networkSource: PermissionSource;
  readonly modes: DocPermissionModes;
}

/** `POST /api/doc/:docId/permissions` 请求体：两维独立，允许只写一维。 */
export interface PermissionPatch {
  readonly scripts?: boolean;
  readonly network?: boolean;
}

export interface ForeignInput {
  readonly cls: "foreign" | "normalizable";
  /** 文档是否含可执行内容（横幅文案提示用）；生效与否看 `permissions.scripts`。 */
  readonly scripts: boolean;
  /** 外来文档的生效权限视图；normalizable 没有（权限对它无意义）。 */
  readonly permissions?: DocPermissions;
}

/** 外来壳的主题下拉：`POST /api/style` 把 `<style id="hr-theme">` 写进外来文件本身。 */
export interface ForeignTheme {
  /** `GET /api/theme` 的清单，选项按服务端顺序画。 */
  readonly themes: readonly string[];
  /** 初始选中项：服务端默认名（文件里实际生效的主题服务端不回传，与 managed 的口径一致）。 */
  readonly current: string;
  /** 写盘封装；resolve 即服务端 200（写路径失败必须 reject，UI 才回滚）。 */
  readonly apply: (id: string) => Promise<void>;
}

export interface ForeignDeps {
  readonly host: Host;
  readonly parent: string;
  readonly docId: string;
  readonly info: ForeignInput;
  /** `POST /permissions` 的封装；resolve 的值为服务端确认的生效视图（写路径失败必须 reject）。 */
  readonly setPermissions: (patch: PermissionPatch) => Promise<DocPermissions>;
  /** `POST /normalize` + 成功后的重进 managed；失败必须 reject（widget 只负责把错误挂上横幅）。 */
  readonly normalize: () => Promise<void>;
  /** 主题下拉的接线；undefined = 控制条的主题位不接线（清单为空时也一样）。 */
  readonly theme: ForeignTheme | undefined;
}

export interface ForeignHandle {
  /** `doc.changed` 到达时重载 iframe（src 换参数，不做 diff——外来文档没有块）。 */
  readonly refresh: (revision?: string) => void;
  /**
   * 权限/分类可能在外部变了（写盘、全局设置变更）：以服务端 info 为准重画
   * 横幅、开关与 sandbox；sandbox/CSP 只在导航提交时采样，生效组合变了必须重载 iframe。
   */
  readonly syncInfo: (next: ForeignInput) => void;
  readonly destroy: () => void;
}

export const mountForeign = (deps: ForeignDeps): ForeignHandle => {
  const { host, parent } = deps;
  // 大写选择器名：静态接线测试只认字面量/全大写常量，小写局部变量会被判成"无写点"。
  const BANNER = `${parent} #hr-foreign`;
  const TEXT = `${parent} #hr-foreign-text`;
  const ACTION = `${parent} #hr-foreign-action`;
  const ERROR = `${parent} #hr-foreign-error`;
  const FRAME = `${parent} #hr-foreign-frame`;
  const THEME_LABEL = `${parent} #hr-theme-label`;
  const THEME_SELECT = `${parent} #hr-theme-select`;
  const PERMS = `${parent} #hr-perms`;
  const PERM_SCRIPTS = `${parent} #hr-perm-scripts`;
  const PERM_NETWORK = `${parent} #hr-perm-network`;

  // info 可变：`doc.changed`/`permissions.changed` 后 syncInfo 用服务端最新值整体换掉。
  let info = deps.info;
  let perms = info.permissions;
  let loads = 0;
  /** 写请求在途时动作位/开关不再接受点击：normalize/permissions 串行化。 */
  let pending = false;
  /** destroy 后落地的写请求续跑一律丢弃：横幅已归还，复活它会污染下一个文档的壳。 */
  let dead = false;

  const srcOf = (tag: string | undefined): string => {
    const base = `/s/${encodeURIComponent(deps.docId)}`;
    return tag === undefined ? base : `${base}?r=${encodeURIComponent(tag)}`;
  };

  /**
   * 安全不变量（勿放宽）：
   * - `allow-scripts` 与 `allow-same-origin` 永远互斥——两者同给，外来文档就能读同源
   *   cookie/存储并借我们的源发请求，沙箱形同虚设；
   * - 永不出现 `allow-popups` / `allow-modals` / `allow-top-navigation` / `allow-forms`。
   * 联网维度不进 sandbox：网络收口是服务端 CSP 的事，沙箱只管脚本能不能跑。
   */
  const sandboxOf = (): string => (perms?.scripts === true ? "allow-scripts" : "");

  const bannerTextOf = (): string => {
    if (info.cls === "normalizable") return COPY.normalizableBanner;
    const parts: string[] = [COPY.foreignReadonly, COPY.foreignNoEdit];
    if (perms?.scripts === true) parts.push(COPY.foreignScriptsOn);
    else if (info.scripts) parts.push(COPY.foreignScriptsOff);
    if (perms?.network === true) parts.push(COPY.foreignNetworkOn);
    return parts.join(" · ");
  };

  /** 只有一个动作位：normalizable 给"规范化"；foreign 的"允许脚本"在全局接管时让位给开关的置灰提示。 */
  const actionLabelOf = (): string | undefined => {
    if (info.cls === "normalizable") return COPY.normalizableAction;
    if (!info.scripts || perms?.modes.scripts !== "per-doc") {
      return undefined;
    }
    return perms.scripts ? COPY.foreignDisallow : COPY.foreignAllow;
  };

  const paintToggle = (
    selector: string,
    dim: "scripts" | "network",
    label: string,
  ): void => {
    if (perms === undefined) return;
    const on = perms[dim];
    const controlled = perms.modes[dim] !== "per-doc";
    host.text(selector, `${label}：${on ? "开" : "关"}`);
    host.attr(selector, "data-on", on ? "true" : "false");
    host.attr(selector, "aria-pressed", on ? "true" : "false");
    host.attr(selector, "disabled", controlled ? "" : undefined);
    host.attr(
      selector,
      "title",
      controlled ? COPY.permControlled : `为本文档${on ? "关闭" : "开启"}${label}`,
    );
  };

  const paint = (): void => {
    host.attr(BANNER, "hidden", undefined);
    host.text(TEXT, bannerTextOf());
    const label = actionLabelOf();
    host.attr(ACTION, "hidden", label === undefined ? "" : undefined);
    if (label !== undefined) host.text(ACTION, label);
    host.attr(FRAME, "sandbox", sandboxOf());
    // 底栏开关只对外来文档存在：normalizable/managed 没有可授权的维度。
    const granted = info.cls === "foreign" && perms !== undefined;
    host.attr(PERMS, "hidden", granted ? undefined : "");
    if (granted) {
      paintToggle(PERM_SCRIPTS, "scripts", COPY.permScripts);
      paintToggle(PERM_NETWORK, "network", COPY.permNetwork);
    }
  };

  const reportError = (cause: unknown): void => {
    // 失败时横幅必须在：normalize 的重进路径会先收起横幅，出错要把它再请回来。
    host.attr(BANNER, "hidden", undefined);
    host.text(ERROR, cause instanceof Error ? cause.message : String(cause));
  };

  const refresh = (revision?: string): void => {
    if (dead) return;
    // 事件带 revision 就用它做 cache-bust；没带才动用本地计数（计数只为兜底，不掺进正常路径）。
    const tag = revision ?? `n${String((loads += 1))}`;
    host.attr(FRAME, "src", srcOf(tag));
  };

  /** 生效组合变化判定：sandbox 与 CSP 都只在导航时采样，生效值变了不重载等于没变。 */
  const effectiveOf = (p: DocPermissions | undefined): string =>
    `${p?.scripts === true ? "1" : "0"}${p?.network === true ? "1" : "0"}`;

  const applyPerms = (next: DocPermissions): void => {
    const changed = effectiveOf(next) !== effectiveOf(perms);
    perms = next;
    paint();
    if (changed) refresh();
  };

  const writePerms = (patch: PermissionPatch): void => {
    pending = true;
    host.text(ERROR, "");
    void deps.setPermissions(patch).then(
      (next) => {
        pending = false;
        if (dead) return;
        applyPerms(next);
      },
      (cause: unknown) => {
        pending = false;
        if (dead) return;
        reportError(cause);
      },
    );
  };

  const runAction = (): void => {
    if (pending) return;
    host.text(ERROR, "");
    if (info.cls === "normalizable") {
      pending = true;
      void deps.normalize().then(
        () => {
          pending = false;
        },
        (cause: unknown) => {
          pending = false;
          if (dead) return;
          reportError(cause);
        },
      );
      return;
    }
    if (perms?.modes.scripts !== "per-doc") return;
    writePerms({ scripts: !perms.scripts });
  };

  const onToggle = (dim: "scripts" | "network") => (): void => {
    // disabled 是表现层；这里是逻辑层的同一道闸（置灰的来源可能被绕过，判断不能省）。
    if (pending || info.cls !== "foreign" || perms === undefined) return;
    if (perms.modes[dim] !== "per-doc") return;
    writePerms(dim === "scripts" ? { scripts: !perms.scripts } : { network: !perms.network });
  };

  // `data-hr-doc` 是模式的唯一开关：侧栏/演示壳的隐藏与 iframe 撑满全在样式层。
  host.attr(parent, "data-hr-doc", "framed");
  host.attr(FRAME, "title", COPY.foreignFrameTitle);
  // 外来页面拿不到引用来源：referrer 会泄露内网路径/会话参数给被嵌文档。
  host.attr(FRAME, "referrerpolicy", "no-referrer");
  // 外来页面自己调的 Fullscreen API：只放大 iframe 自身，与沙箱正交，不放宽任何 allow-*。
  host.attr(FRAME, "allow", "fullscreen");

  // 主题下拉：外来文档的"换主题"是把 `<style id="hr-theme">` 写进文件，
  // 写完重载 iframe 让新主题进文档；写盘失败把显示值回滚并把错误挂上横幅。
  const theme = deps.theme;
  let selected = theme?.current ?? "";
  const settleWrite = (): void => {
    pending = false;
  };
  const onTheme = (target: { readonly value?: string }): void => {
    const next = target.value;
    if (theme === undefined || next === undefined || next === "" || next === selected || pending) {
      if (theme !== undefined) host.attr(THEME_SELECT, "value", selected);
      return;
    }
    pending = true;
    host.text(ERROR, "");
    const previous = selected;
    selected = next;
    void theme.apply(next).then(
      () => {
        settleWrite();
        if (dead) return;
        refresh();
      },
      (cause: unknown) => {
        settleWrite();
        selected = previous;
        if (dead) return;
        host.attr(THEME_SELECT, "value", previous);
        reportError(cause);
      },
    );
  };

  // sandbox 必须先于第一次 src：导航提交时采样的就是这一刻的沙箱标志，
  // 先 src 后 sandbox 在 bfcache/元素复用路径上会把首轮变成无沙箱加载。
  paint();
  if (theme !== undefined) {
    host.text(THEME_LABEL, COPY.controlsTheme);
    host.children(
      THEME_SELECT,
      theme.themes.map((id) => ({
        tag: "option",
        // `selected` 内容属性才是真首选项：select 没有 value 内容属性，
        // 之后 attr("value") 只作假 host 可断言的同步写（与 managed 的 canvas 同约定）。
        attrs: { value: id, ...(id === selected ? { selected: "" } : {}) },
        text: id,
      })),
    );
    host.attr(THEME_SELECT, "value", selected);
  }
  host.attr(FRAME, "src", srcOf(undefined));
  host.attr(FRAME, "hidden", undefined);
  const offAction = host.on(ACTION, "click", runAction);
  const offScripts = host.on(PERM_SCRIPTS, "click", onToggle("scripts"));
  const offNetwork = host.on(PERM_NETWORK, "click", onToggle("network"));
  const offTheme = theme === undefined ? () => undefined : host.on(THEME_SELECT, "change", onTheme);

  return {
    refresh,
    syncInfo: (next: ForeignInput): void => {
      if (dead) return;
      const changed = effectiveOf(next.permissions) !== effectiveOf(perms);
      info = next;
      perms = next.permissions;
      paint();
      if (changed) refresh();
    },
    destroy: () => {
      dead = true;
      offAction();
      offScripts();
      offNetwork();
      offTheme();
      host.attr(parent, "data-hr-doc", undefined);
      host.attr(BANNER, "hidden", "");
      host.attr(PERMS, "hidden", "");
      host.attr(FRAME, "hidden", "");
      // about:blank 而不是摘掉 src：allow-scripts 档里的脚本只换源才真停。
      host.attr(FRAME, "src", "about:blank");
    },
  };
};
