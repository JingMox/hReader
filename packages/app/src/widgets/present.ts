// 这层管：演示模式（一节一屏 + 页内步进）。状态全部落成 data 属性——
// `data-hr-present`（根）、`data-hr-slide-state`（每页）、`data-hr-step-state`（页内元素），
// 出现动画与皮肤归主题 CSS，这里不画任何过渡；全屏 / hash / 滚动复位是仅有的副作用，全走注入的 shell。

import type { ElementLike, Host } from "../dom.ts";
import { escapeAttr } from "../escape-attr.ts";
import type { ReaderIntent, ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

/** 演示需要的浏览器环境：全屏、地址栏 hash。每项都可缺席——缺席的那一项退化为 no-op。 */
export interface PresentShell {
  readonly fullscreen?:
    | {
        readonly enter: () => void;
        readonly exit: () => void;
      }
    | undefined;
  readonly isFullscreen?: (() => boolean) | undefined;
  /** 原生全屏被 Esc 退掉而 `keydown` 没送达时，靠它退出演示（否则会卡在演示态）。 */
  readonly onFullscreenChange?: ((handler: () => void) => () => void) | undefined;
  /** `read()` 返回 `#` 之后的内容；`write("")` 清掉 hash。 */
  readonly hash?:
    | {
        readonly read: () => string;
        readonly write: (hash: string) => void;
      }
    | undefined;
}

interface PresentDeps {
  readonly host: Host;
  readonly parent: string;
  readonly shell: PresentShell;
  readonly onIntent: (intent: ReaderIntent) => void;
}

/** `update` 之外的第二个出口：dispatch **前**拦 `presentAdvanced`——页内还有步进就先放步进，不翻页。 */
export interface PresentWidget extends Widget {
  readonly before: (intent: ReaderIntent) => boolean;
}

/** hash 页码参数：`#p=3` 表示第 3 页（1 基，给人看的）。 */
const PAGE_HASH = "p=";

/** @internal 属性测试要直接打：任意字符串 → `undefined | 非负整数`，不许 NaN/负数。 */
export const pageOfHash = (hash: string): number | undefined => {
  for (const part of hash.split("&")) {
    if (!part.startsWith(PAGE_HASH)) continue;
    const page = Number.parseInt(part.slice(PAGE_HASH.length), 10);
    return Number.isNaN(page) || page < 1 ? undefined : page - 1;
  }
  return undefined;
};

/** 只重写 `p=` 这一段，其余 hash 参数原样保留（不跟现有/未来的 hash 用法打架）。
 *  @internal 属性测试要直接打：与 `pageOfHash` 的往返一致性。 */
export const hashOfPage = (hash: string, page: number | undefined): string => {
  const parts = hash.split("&").filter((part) => part !== "" && !part.startsWith(PAGE_HASH));
  if (page !== undefined) parts.unshift(`${PAGE_HASH}${String(page + 1)}`);
  return parts.join("&");
};

const slideStateOf = (index: number, page: number): string =>
  index < page ? "past" : index === page ? "current" : "future";

/** 最后一条已出现的是 `current`（主题只动画它），更早的是 `past`，未出现的是 `future`。 */
const stepStateOf = (index: number, revealed: number): string =>
  index >= revealed ? "future" : index === revealed - 1 ? "current" : "past";

const slideSelector = (parent: string, id: string): string =>
  `${parent} [data-hr-id="${escapeAttr(id)}"]`;

const applySteps = (steps: readonly ElementLike[], revealed: number): void => {
  steps.forEach((step, index) => {
    step.setAttribute("data-hr-step-state", stepStateOf(index, revealed));
  });
};

/** 根属性值 = 挂载出的 `<article>` 的 kind：读 DOM 不读原始 HTML——主题 CSS 选择器文本里
 *  就含 `data-hr-kind="slides"`，对整篇源码做字符串匹配会全员误判成 slides。 */
const kindOf = (host: Host, parent: string): "slides" | "document" =>
  host.all(`${parent} article[data-hr-kind="slides"]`).length > 0 ? "slides" : "document";

export const mountPresent = (deps: PresentDeps): PresentWidget => {
  const { host, parent, shell, onIntent } = deps;
  host.text(`${parent} #hr-present-btn`, COPY.present);
  host.text(`${parent} #hr-present-exit`, COPY.presentExit);
  host.on(`${parent} #hr-present-btn`, "click", () => {
    onIntent({ kind: "presentEntered" });
  });
  host.on(`${parent} #hr-present-exit`, "click", () => {
    onIntent({ kind: "presentExited" });
  });

  const readHash = (): string => shell.hash?.read() ?? "";
  const writeHash = (page: number | undefined): void => {
    shell.hash?.write(hashOfPage(readHash(), page));
  };

  // 以下全是"上一次渲染时"的镜像：`before` 在 dispatch 之前读它们，读到的恰好是当前状态。
  let active = false;
  let lastPage = 0;
  let lastPages: readonly string[] = [];
  let currentSteps: readonly ElementLike[] = [];
  let lastHtml = "";
  let inFullscreen = false;
  /** hash 续页只试一次：退出后残留/手改的 hash 不该再把用户弹回演示态。 */
  let resumed = false;
  let buttonShown: boolean | undefined;
  /** 每页已放出的步进条数（页码 → 条数）；回到旧页恢复它的进度。 */
  const stepsByPage = new Map<number, number>();
  /** 演示态碰过的全部步进元素（不止当前页）：退出时按这份清单清属性，不留跨页残迹。 */
  const touchedSteps = new Set<ElementLike>();

  shell.onFullscreenChange?.(() => {
    if (!inFullscreen || shell.isFullscreen?.() === true) return;
    inFullscreen = false;
    if (active) onIntent({ kind: "presentExited" });
  });

  const paintDom = (next: ReaderState): void => {
    const page = next.present.page;
    host.attr(parent, "data-hr-present", kindOf(host, parent));
    next.pages.forEach((id, index) => {
      host.attr(slideSelector(parent, id), "data-hr-slide-state", slideStateOf(index, page));
    });
    host.text(`${parent} #hr-present-pager`, `${String(page + 1)} / ${String(next.pages.length)}`);
    const id = next.pages[page];
    currentSteps = id === undefined ? [] : host.all(`${slideSelector(parent, id)} [data-hr-step]`);
    applySteps(currentSteps, stepsByPage.get(page) ?? 0);
    currentSteps.forEach((step) => touchedSteps.add(step));
    lastPages = next.pages;
    lastPage = page;
    writeHash(page);
  };

  const exitDom = (): void => {
    lastPages.forEach((id) => {
      host.attr(slideSelector(parent, id), "data-hr-slide-state", undefined);
    });
    touchedSteps.forEach((step) => {
      step.removeAttribute("data-hr-step-state");
    });
    touchedSteps.clear();
    currentSteps = [];
    stepsByPage.clear();
    host.attr(parent, "data-hr-present", undefined);
    host.text(`${parent} #hr-present-pager`, "");
    writeHash(undefined);
    if (inFullscreen) {
      inFullscreen = false;
      shell.fullscreen?.exit();
    }
    // 回到阅读态时落在刚讲完的那一页——attr 已摘掉，滚动的是普通文档。
    const id = lastPages[lastPage];
    if (id !== undefined) host.scrollTo(slideSelector(parent, id));
  };

  const update = (next: ReaderState): void => {
    // 页表没到不放按钮：此刻点击发的 presentEntered 会被 reduce 拒掉（pages 空），
    // 按钮等于死键——与 hash 续页等 `next.pages.length > 0` 是同一个闸。
    const canPresent = kindOf(host, parent) === "slides" && next.pages.length > 0;
    if (canPresent !== buttonShown) {
      buttonShown = canPresent;
      host.attr(`${parent} #hr-present-btn`, "hidden", canPresent ? undefined : "");
    }
    if (next.documentHtml !== lastHtml) {
      lastHtml = next.documentHtml;
      stepsByPage.clear();
    }
    if (!next.present.active) {
      if (active) {
        exitDom();
      } else if (!resumed) {
        const page = pageOfHash(readHash());
        if (page === undefined) {
          // hash 里没有合法页码：续页机会用掉，此后不再试。
          resumed = true;
        } else if (next.pages.length > 0) {
          // 页表到位才发意图：记账帧（pages 还没回来）先到是常态，
          // 那时发 `presentEntered` 只会被 reduce 拒掉，续页机会还被白白烧掉。
          resumed = true;
          onIntent({ kind: "presentEntered", page });
          return;
        }
      }
      active = false;
      return;
    }
    if (!active) {
      // 进入帧：hash 记的页跟将要画的页不一致就先跳页——重入的那帧负责绘制，避免闪一页错的。
      const page = pageOfHash(readHash());
      if (page !== undefined && page !== next.present.page) {
        onIntent({ kind: "presentMoved", page });
        return;
      }
      shell.fullscreen?.enter();
      inFullscreen = shell.fullscreen !== undefined;
    }
    paintDom(next);
    active = true;
  };

  const before = (intent: ReaderIntent): boolean => {
    if (intent.kind !== "presentAdvanced" || !active) return true;
    const revealed = stepsByPage.get(lastPage) ?? 0;
    if (revealed >= currentSteps.length) return true;
    stepsByPage.set(lastPage, revealed + 1);
    applySteps(currentSteps, revealed + 1);
    return false;
  };

  return { update, before };
};
