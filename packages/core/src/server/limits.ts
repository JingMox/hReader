// 这层管：成帧上限与三档超时的取值；计时本身交给 Node（`headersTimeout`/`requestTimeout`/`keepAliveTimeout`）。

import type { ServerOptions, Timeouts } from "./contracts";

/** 头块上限 16 KiB；体上限在 `body.ts`（1 MiB），总体由 `requestTimeout` 兜住。 */
export const MAX_HEADER_BYTES = 16 * 1024;

const DEFAULT_TIMEOUTS: Timeouts = { headersMs: 10_000, bodyMs: 10_000, idleMs: 30_000 };

export const timeoutsOf = (options: ServerOptions): Timeouts => ({
  headersMs: options.timeouts?.headersMs ?? DEFAULT_TIMEOUTS.headersMs,
  bodyMs: options.timeouts?.bodyMs ?? DEFAULT_TIMEOUTS.bodyMs,
  idleMs: options.timeouts?.idleMs ?? DEFAULT_TIMEOUTS.idleMs,
});
