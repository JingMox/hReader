// 这层管：渲染期限（超时 → `render_timeout`）与它的取消口；不碰进程、不碰 socket。
import { HrError } from "@hreader/core";

export const deadlineOf = (
  timeoutMs: number,
): { readonly expired: Promise<never>; cancel(): void } => {
  // `cancel` 走 AbortController 而不是闭包里的 timer：否则要先塞一个占位函数进 `let`，那行永远没人调用。
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
