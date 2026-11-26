// 这层管：底部状态条（连接状态 / 版本 / 沉浸入口 / 快捷键提示）。只写文本与事件，不做判断以外的逻辑。

import type { Host } from "../dom.ts";
import type { ConnState, ReaderIntent, ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

const CONN_TEXT: Readonly<Record<ConnState, string>> = {
  connecting: COPY.statusConnecting,
  live: COPY.statusLive,
  reconnecting: COPY.statusReconnecting,
  offline: COPY.statusOffline,
};

/** `onIntent` 缺省 = 沉浸按钮只画不接线（测试桩）；接线路径永远给 dispatch。 */
export const mountStatusbar = (
  host: Host,
  parent: string,
  onIntent?: (intent: ReaderIntent) => void,
): Widget => {
  host.text(`${parent} #hr-version`, COPY.version);
  host.text(`${parent} #hr-shortcuts`, COPY.shortcuts);
  host.text(`${parent} #hr-immersive-btn`, COPY.immersive);
  host.attr(`${parent} #hr-immersive-btn`, "title", COPY.immersiveHint);
  host.on(`${parent} #hr-immersive-btn`, "click", () => {
    onIntent?.({ kind: "immersiveToggled" });
  });

  let conn: ConnState | undefined = undefined;
  const update = (next: ReaderState): void => {
    if (next.conn !== conn) {
      host.text(`${parent} #hr-conn`, CONN_TEXT[next.conn]);
      host.attr(`${parent} #hr-conn`, "data-conn", next.conn);
      conn = next.conn;
    }
    host.attr(`${parent} #hr-statusbar`, "data-doc", next.docId);
  };

  return { update };
};
