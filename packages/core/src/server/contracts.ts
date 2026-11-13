// 这层管：服务端的裸类型（选项、daemon 记录、SSE 事件、HTTP 回复计划）；不含逻辑、不碰 IO。

/** 三个超时都可通过 `timeouts` 覆盖（测试传 50 ms，不必真等 10 秒）。 */
export interface Timeouts {
  readonly headersMs: number;
  readonly bodyMs: number;
  readonly idleMs: number;
}

export interface ServerOptions {
  /** workspace 的真实路径：所有 docId 相对它解析，越界一律 403。 */
  readonly workspace: string;
  /** `0` 表示交给系统分配；`startServer` 返回真实端口。 */
  readonly port: number;
  /** `~/.hreader/daemon.json` 的父目录。 */
  readonly home: string;
  /** 打开的那篇文档（相对 workspace 的路径）：`/` 与 `/api/events` 的默认目标。 */
  readonly docId: string;
  /** `--allow-host` 的整体替换值；缺省用回环两种写法（`127.0.0.1:<port>`/`localhost:<port>`）。 */
  readonly allowHosts?: readonly string[];
  /** 诊断出口（帧头被替换、内部错误细节）；缺省丢弃，`--debug` 时由 CLI 接到 stderr。 */
  readonly diagnose?: (message: string) => void;
  /** 头部/体/空闲三档超时；缺省 10 s / 10 s / 30 s。 */
  readonly timeouts?: Partial<Timeouts>;
}

/** `daemon.json` 的形状：CLI 与浏览器都靠它拿端口与一次性 token。 */
export interface DaemonInfo {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly workspace: string;
}

export interface SseEvent {
  readonly id: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 处理器只产出数据，写 socket 与加安全头由 `server.ts` 统一做（处理器因此可单测）。 */
export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | string;
}
