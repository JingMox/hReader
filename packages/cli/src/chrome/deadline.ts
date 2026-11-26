// This layer: the render deadline (timeout -> `render_timeout`) and its cancellation handle; no processes, no sockets.
import { HrError } from "@hreader/core";

export const deadlineOf = (
  timeoutMs: number,
): { readonly expired: Promise<never>; cancel(): void } => {
  // `cancel` uses an AbortController rather than a closure-held timer: otherwise a placeholder would sit in a `let` that nobody ever calls.
  const abort = new AbortController();
  const expired = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      reject(
        new HrError("render_timeout", `渲染超时（${String(seconds)}s）：Chrome 未在期限内完成`),
      );
    }, timeoutMs);
    timer.unref();
    abort.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
      },
      { once: true },
    );
  });
  return {
    expired,
    cancel: () => {
      abort.abort();
    },
  };
};
