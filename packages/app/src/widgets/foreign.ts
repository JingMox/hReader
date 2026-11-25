// 这层管：外来 / 未规范化文档的 iframe 承载与信任横幅。
// 外来内容只走 `<iframe src="/s/<docId>">`——绝不进 innerHTML：正文不落在阅读器 DOM 里，
// 块级 diff、批注、演示模式也就天然够不到它。

import type { Host } from "../dom.ts";
import { COPY } from "./copy.ts";

/** 外来文档的脚本信任档：off = 脚本不跑；local = 脚本可跑但无网络（服务端 CSP 收口）。 */
export type TrustLevel = "off" | "local";

export interface ForeignInput {
  readonly cls: "foreign" | "normalizable";
  readonly trust: TrustLevel;
  readonly scripts: boolean;
}

export interface ForeignDeps {
  readonly host: Host;
  readonly parent: string;
  readonly docId: string;
  readonly info: ForeignInput;
  /** `POST /trust` 的封装；resolve 的值为服务端确认的档位（写路径失败必须 reject）。 */
  readonly setTrust: (level: TrustLevel) => Promise<TrustLevel>;
  /** `POST /normalize` + 成功后的重进 managed；失败必须 reject（widget 只负责把错误挂上横幅）。 */
  readonly normalize: () => Promise<void>;
}

export interface ForeignHandle {
  /** `doc.changed` 到达时重载 iframe（src 换参数，不做 diff——外来文档没有块）。 */
  readonly refresh: (revision?: string) => void;
  readonly destroy: () => void;
}

/**
 * 安全不变量（勿放宽）：
 * - `allow-scripts` 与 `allow-same-origin` 永远互斥——两者同给，外来文档就能读同源
 *   cookie/存储并借我们的源发请求，沙箱形同虚设；
 * - 永不出现 `allow-popups` / `allow-modals` / `allow-top-navigation` / `allow-forms`。
 * off 档给空串（全限制）：脚本不跑，但页面自己的 CSS 与布局保留。
 */
const sandboxOf = (trust: TrustLevel): string => (trust === "local" ? "allow-scripts" : "");

export const mountForeign = (deps: ForeignDeps): ForeignHandle => {
  const { host, parent } = deps;
  // 大写选择器名：静态接线测试只认字面量/全大写常量，小写局部变量会被判成"无写点"。
  const BANNER = `${parent} #hr-foreign`;
  const TEXT = `${parent} #hr-foreign-text`;
  const ACTION = `${parent} #hr-foreign-action`;
  const ERROR = `${parent} #hr-foreign-error`;
  const FRAME = `${parent} #hr-foreign-frame`;

  let trust = deps.info.trust;
  let loads = 0;
  /** 写请求在途时动作位不再接受点击：normalize/trust 串行化，重进路径因此最多跑一次。 */
  let pending = false;
  /** destroy 后落地的写请求续跑一律丢弃：横幅已归还，复活它会污染下一个文档的壳。 */
  let dead = false;

  const srcOf = (tag: string | undefined): string => {
    const base = `/s/${encodeURIComponent(deps.docId)}`;
    return tag === undefined ? base : `${base}?r=${encodeURIComponent(tag)}`;
  };

  const bannerTextOf = (): string => {
    if (deps.info.cls === "normalizable") return COPY.normalizableBanner;
    const parts: string[] = [COPY.foreignReadonly, COPY.foreignNoEdit];
    if (trust === "local") parts.push(COPY.foreignScriptsOn);
    else if (deps.info.scripts) parts.push(COPY.foreignScriptsOff);
    return parts.join(" · ");
  };

  /** 只有一个动作位：normalizable 给"规范化"，foreign 按信任档给"允许/禁用"。 */
  const actionLabelOf = (): string | undefined => {
    if (deps.info.cls === "normalizable") return COPY.normalizableAction;
    if (trust === "local") return COPY.foreignDisallow;
    return deps.info.scripts ? COPY.foreignAllow : undefined;
  };

  const paint = (): void => {
    host.attr(BANNER, "hidden", undefined);
    host.text(TEXT, bannerTextOf());
    const label = actionLabelOf();
    host.attr(ACTION, "hidden", label === undefined ? "" : undefined);
    if (label !== undefined) host.text(ACTION, label);
    host.attr(FRAME, "sandbox", sandboxOf(trust));
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

  const runAction = (): void => {
    if (pending) return;
    pending = true;
    host.text(ERROR, "");
    const settle = (): void => {
      pending = false;
    };
    if (deps.info.cls === "normalizable") {
      void deps.normalize().then(settle, (cause: unknown) => {
        settle();
        if (dead) return;
        reportError(cause);
      });
      return;
    }
    const next: TrustLevel = trust === "local" ? "off" : "local";
    void deps.setTrust(next).then(
      (applied) => {
        settle();
        if (dead) return;
        trust = applied;
        paint();
        refresh();
      },
      (cause: unknown) => {
        settle();
        if (dead) return;
        reportError(cause);
      },
    );
  };

  // `data-hr-doc` 是模式的唯一开关：侧栏/控制条/演示壳的隐藏与 iframe 撑满全在样式层。
  host.attr(parent, "data-hr-doc", "framed");
  host.attr(FRAME, "title", COPY.foreignFrameTitle);
  // 外来页面拿不到引用来源：referrer 会泄露内网路径/会话参数给被嵌文档。
  host.attr(FRAME, "referrerpolicy", "no-referrer");
  host.attr(FRAME, "src", srcOf(undefined));
  host.attr(FRAME, "hidden", undefined);
  paint();
  const offAction = host.on(ACTION, "click", runAction);

  return {
    refresh,
    destroy: () => {
      dead = true;
      offAction();
      host.attr(parent, "data-hr-doc", undefined);
      host.attr(BANNER, "hidden", "");
      host.attr(FRAME, "hidden", "");
      // about:blank 而不是摘掉 src：allow-scripts 档里的脚本只换源才真停。
      host.attr(FRAME, "src", "about:blank");
    },
  };
};
