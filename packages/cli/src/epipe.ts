// 这层管：stdout/stderr 下游提前关闭（`| head -1`）时的死法；只挂 `'error'` 监听，不管输出内容。

/** `process.stdout`/`stderr` 上需要的最小面：`on("error", …)`。测试用一个真 EventEmitter 即可满足。 */
interface ErrorStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Node 对 `process.stdout` 不吞 EPIPE：消费者提前关读端时，`'error'` 没人接就成未捕获异常
 * （exit 1 + 满屏栈）。EPIPE 不是产品失败——下游自己走了，按已定的退出码静默收场；
 * 非 EPIPE 仍照原样抛，不替运行时发明第三种死法。
 */
export const epipeGuard = (stream: ErrorStream): void => {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    // 非 EPIPE 照原样抛，不替运行时发明第三种死法。
    if (error.code !== "EPIPE") throw error;
    process.exit(process.exitCode ?? 0);
  });
};
