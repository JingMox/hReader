// 这层管：外来文档批注模式——横幅开关（mint token → sandbox 先于 src）、
// 选区消息 → 浮层、保存 → POST sidecar、`open`/SSE → 高亮重推。
// 安全不变量：消息只在 source === frame.contentWindow 且 origin === "null" 且
// 通过 parseFrameMessage 严格校验后才处理；其余一律静默丢弃（无网络、无 UI）。

import {
  NOTE_LIMIT,
  parseFrameMessage,
  placementOf,
  type SidecarPaint,
  type WireAnchor,
} from "../annotate-proto.ts";
import type { Host } from "../dom.ts";
import { COPY } from "./copy.ts";

/** `POST /annotate`、`GET/POST /sidecar` 的封装（main.ts 用 io.post/io.json 实现）。 */
export interface AnnotateIo {
  readonly mint: () => Promise<string>;
  readonly list: () => Promise<readonly SidecarPaint[]>;
  readonly add: (body: {
    readonly anchor: WireAnchor;
    readonly selector?: string;
    readonly note: string;
  }) => Promise<void>;
}

/** 浏览器 `message` 事件的最小面（source/origin/data 三项之外不读）。 */
export interface IncomingMessage {
  readonly source?: unknown;
  readonly origin?: string;
  readonly data?: unknown;
}

/** 真 DOM 由 main.ts 注入：contentWindow/getBoundingClientRect 不经 Host（它们不是写点）。 */
export interface AnnotateEnv {
  readonly onMessage: (handler: (message: IncomingMessage) => void) => () => void;
  readonly frameWindow: () => unknown;
  readonly postToFrame: (message: Readonly<Record<string, unknown>>) => void;
  readonly frameRect: () =>
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  readonly viewport: () => { readonly width: number; readonly height: number };
}

/** foreign.ts 提供：sandbox 属性写点与带记账的 frame 导航。 */
export interface AnnotateFrame {
  readonly setSandbox: (value: string) => void;
  readonly navigate: (src: string) => void;
}

export interface AnnotateDeps {
  readonly host: Host;
  readonly parent: string;
  readonly io: AnnotateIo;
  readonly env: AnnotateEnv;
  readonly frame: AnnotateFrame;
  /** 退出批注模式后恢复的 sandbox（权限推导值）。 */
  readonly sandboxOff: () => string;
  /** 退出批注模式后恢复的普通 frame URL。 */
  readonly docSrc: () => string;
  /** mint/list/add 失败 → 横幅错误位（foreign 的 reportError）。 */
  readonly onError: (cause: unknown) => void;
}

interface AnnotateHandle {
  readonly isActive: () => boolean;
  /** foreign 重画横幅时顺带：按钮可见性（仅 foreign）+ active 态。 */
  readonly repaint: (cls: "foreign" | "normalizable") => void;
  /** `doc.changed`：批注模式下重铸 token 重载；mint 失败退出模式并报错。 */
  readonly refresh: () => void;
  /** `doc.annotations`（SSE，本 doc）：重拉列表重推高亮。 */
  readonly annotationsChanged: () => void;
  readonly destroy: () => void;
}

type Mode = "edit" | "view" | "hint";

export const mountAnnotate = (deps: AnnotateDeps): AnnotateHandle => {
  const { host, parent, env } = deps;
  // 大写选择器名：静态接线测试只认字面量/全大写常量（与 foreign.ts 同约定）。
  const BTN = `${parent} #hr-annotate-btn`;
  const POP = `${parent} #hr-annotate-pop`;
  const DRAFT = `${parent} #hr-annotate-draft`;
  const SAVE = `${parent} #hr-annotate-save`;
  const CANCEL = `${parent} #hr-annotate-cancel`;
  const VIEW = `${parent} #hr-annotate-view`;
  const HINT = `${parent} #hr-annotate-hint`;

  let active = false;
  let pending = false;
  let dead = false;
  let mode: Mode = "edit";
  let draft = "";
  let draftFocused = false;
  let lastCls: "foreign" | "normalizable" = "foreign";
  let pendingSelection: { readonly anchor: WireAnchor; readonly selector?: string } | undefined;
  const annotations = new Map<string, SidecarPaint>();

  const hidePop = (): void => {
    host.attr(POP, "hidden", "");
  };

  const paintMode = (): void => {
    host.attr(DRAFT, "hidden", mode === "edit" ? undefined : "");
    host.attr(SAVE, "hidden", mode === "edit" ? undefined : "");
    host.attr(VIEW, "hidden", mode === "view" ? undefined : "");
    host.attr(HINT, "hidden", mode === "hint" ? undefined : "");
  };

  const paint = (): void => {
    host.attr(BTN, "hidden", lastCls === "foreign" ? undefined : "");
    host.text(BTN, COPY.annotate);
    host.attr(BTN, "data-on", active ? "true" : "false");
    host.attr(BTN, "aria-pressed", active ? "true" : "false");
    host.attr(BTN, "title", active ? COPY.annotateExit : COPY.annotateTitle);
    paintMode();
  };

  const showAt = (x: number, y: number): void => {
    host.attr(POP, "style", `left:${String(x)}px;top:${String(y)}px`);
    host.attr(POP, "hidden", undefined);
  };

  const showEdit = (rect: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  }): void => {
    const frame = env.frameRect() ?? { x: 0, y: 0, width: 0, height: 0 };
    const spot = placementOf({ x: frame.x, y: frame.y }, rect, env.viewport());
    mode = "edit";
    host.text(HINT, "");
    host.text(DRAFT, draft);
    paintMode();
    showAt(spot.x, spot.y);
  };

  const showView = (note: string): void => {
    const frame = env.frameRect() ?? { x: 0, y: 0, width: 0, height: 0 };
    const spot = placementOf(
      { x: frame.x, y: frame.y },
      { x: 16, y: 16, w: 0, h: 0 },
      env.viewport(),
    );
    mode = "view";
    host.text(VIEW, note);
    paintMode();
    showAt(spot.x, spot.y);
  };

  const showHint = (text: string): void => {
    const frame = env.frameRect() ?? { x: 0, y: 0, width: 0, height: 0 };
    const spot = placementOf(
      { x: frame.x, y: frame.y },
      { x: 16, y: 16, w: 0, h: 0 },
      env.viewport(),
    );
    mode = "hint";
    host.text(HINT, text);
    paintMode();
    showAt(spot.x, spot.y);
  };

  const postHighlights = (items: readonly SidecarPaint[]): void => {
    const out: { id: string; start: number; end: number; status: string }[] = [];
    for (const item of items) {
      if (!item.relocation.ok) continue;
      out.push({
        id: item.id,
        start: item.relocation.start,
        end: item.relocation.end,
        status: item.status,
      });
    }
    env.postToFrame({ type: "hr-annotator/highlights", version: 1, items: out });
  };

  const refreshHighlights = (): void => {
    void deps.io.list().then(
      (items) => {
        if (dead || !active) return;
        annotations.clear();
        for (const item of items) annotations.set(item.id, item);
        postHighlights(items);
      },
      (cause: unknown) => {
        if (dead) return;
        deps.onError(cause);
      },
    );
  };

  const enter = (): void => {
    pending = true;
    void deps.io.mint().then(
      (url) => {
        pending = false;
        if (dead) return;
        // sandbox 必须先于 src：导航提交时采样的就是这一刻的沙箱标志。
        deps.frame.setSandbox("allow-scripts");
        deps.frame.navigate(url);
        active = true;
        paint();
      },
      (cause: unknown) => {
        pending = false;
        if (dead) return;
        deps.onError(cause);
      },
    );
  };

  const exit = (): void => {
    active = false;
    pendingSelection = undefined;
    hidePop();
    deps.frame.setSandbox(deps.sandboxOff());
    deps.frame.navigate(deps.docSrc());
    paint();
  };

  const save = (): void => {
    if (pending || mode !== "edit" || pendingSelection === undefined) return;
    const note = draft.slice(0, NOTE_LIMIT);
    if (note.trim() === "") {
      mode = "hint";
      host.text(HINT, COPY.annotateEmpty);
      paintMode();
      return;
    }
    pending = true;
    const body: { anchor: WireAnchor; selector?: string; note: string } = {
      anchor: pendingSelection.anchor,
      note,
    };
    if (pendingSelection.selector !== undefined) body.selector = pendingSelection.selector;
    void deps.io.add(body).then(
      () => {
        pending = false;
        if (dead) return;
        pendingSelection = undefined;
        draft = "";
        hidePop();
        refreshHighlights();
      },
      (cause: unknown) => {
        pending = false;
        if (dead) return;
        deps.onError(cause);
      },
    );
  };

  const onMessage = (raw: IncomingMessage): void => {
    if (dead || !active) return;
    if (raw.source !== env.frameWindow()) return;
    if (raw.origin !== "null") return;
    const message = parseFrameMessage(raw.data);
    if (message === undefined) return;
    if (message.kind === "hello") {
      refreshHighlights();
      return;
    }
    if (message.kind === "selection") {
      pendingSelection =
        message.selector === undefined
          ? { anchor: message.anchor }
          : { anchor: message.anchor, selector: message.selector };
      draft = "";
      showEdit(message.rect);
      return;
    }
    if (message.kind === "cleared") {
      if (!draftFocused) {
        pendingSelection = undefined;
        hidePop();
      }
      return;
    }
    if (message.kind === "tooLong") {
      showHint(COPY.annotateTooLong);
      return;
    }
    const entry = annotations.get(message.id);
    if (entry !== undefined) showView(entry.note);
  };

  const offMessage = env.onMessage(onMessage);
  const offBtn = host.on(BTN, "click", () => {
    if (pending) return;
    if (active) exit();
    else enter();
  });
  const offSave = host.on(SAVE, "click", save);
  const offCancel = host.on(CANCEL, "click", () => {
    pendingSelection = undefined;
    draft = "";
    hidePop();
  });
  const offDraft = host.on(DRAFT, "input", (target) => {
    draft = (target.value ?? "").slice(0, NOTE_LIMIT);
  });
  const offFocus = host.on(DRAFT, "focus", () => {
    draftFocused = true;
  });
  const offBlur = host.on(DRAFT, "blur", () => {
    draftFocused = false;
  });
  const offKey = host.on(POP, "keydown", (target) => {
    if (target.key !== "Escape") return;
    pendingSelection = undefined;
    draft = "";
    hidePop();
  });

  return {
    isActive: () => active,
    repaint: (cls) => {
      lastCls = cls;
      paint();
    },
    refresh: () => {
      if (dead || !active) return;
      void deps.io.mint().then(
        (url) => {
          if (dead || !active) return;
          deps.frame.navigate(url);
        },
        (cause: unknown) => {
          if (dead) return;
          exit();
          deps.onError(cause);
        },
      );
    },
    annotationsChanged: () => {
      if (dead || !active) return;
      refreshHighlights();
    },
    destroy: () => {
      dead = true;
      offMessage();
      offBtn();
      offSave();
      offCancel();
      offDraft();
      offFocus();
      offBlur();
      offKey();
      hidePop();
      host.attr(BTN, "hidden", "");
    },
  };
};
