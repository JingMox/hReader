// 这层管：底部状态条（连接状态 / 版本 / 快捷键提示）。只写文本，不做判断以外的逻辑。

import type { Host } from "../dom.ts";
import type { ConnState, ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

const CONN_TEXT: Readonly<Record<ConnState, string>> = {
  connecting: COPY.statusConnecting,
  live: COPY.statusLive,
  reconnecting: COPY.statusReconnecting,
  offline: COPY.statusOffline,
};

export const mountStatusbar = (host: Host, parent: string): Widget => {
  host.text(`${parent} #hr-version`, COPY.version);
  host.text(`${parent} #hr-shortcuts`, COPY.shortcuts);

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
