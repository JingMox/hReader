// 这层管：右栏（M2.2 只有占位文案，**不伪造批注数据**，AC2.5）。面板开关只切 class。

import type { Host } from "../dom.ts";
import type { ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

export const mountSidenotes = (host: Host, parent: string): Widget => {
  host.text(`${parent} #hr-notes-title`, COPY.sidenotes);
  host.text(`${parent} #hr-notes-body`, COPY.sidenotesEmpty);

  const update = (next: ReaderState): void => {
    host.cls(`${parent} #hr-notes`, "sidenotes--open", next.panel === "sidenote");
    host.attr(`${parent} #hr-notes`, "data-active-id", next.sidenoteId);
  };

  return { update };
};
