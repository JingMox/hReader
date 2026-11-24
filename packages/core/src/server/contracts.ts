// 这层管：服务端的裸类型（选项、daemon 记录、SSE 事件、HTTP 回复计划）；不含逻辑、不碰 IO。
// 变更留痕（C1，`L-05`）：diff 响应体删掉 `originNodeId` 与 `reason`——app 侧零读取，
// `degraded` + `degradedReason` 已把"降没降级、为什么"说完；见 `.workflow/cards/C1.md`。

import type { DiffResult } from "../annotations/diff";

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
  /** 打开的那篇文档（相对 workspace 的路径）：`/api/events` 的默认目标。 */
  readonly docId: string;
  /** 构建产物目录（`index.html` + `assets/`）：`GET /`、`GET /assets/*` 从这里读；缺省由 CLI 补 `packages/app/dist`。 */
  readonly appDir?: string;
  /** `--allow-host` 的整体替换值；缺省用回环两种写法（`127.0.0.1:<port>`/`localhost:<port>`）。 */
  readonly allowHosts?: readonly string[];
  /** 诊断出口（帧头被替换、内部错误细节）；缺省丢弃，`--debug` 时由 CLI 接到 stderr。 */
  readonly diagnose?: (message: string) => void;
  /** 头部/体/空闲三档超时；缺省 10 s / 10 s / 30 s。 */
  readonly timeouts?: Partial<Timeouts>;
}

export interface SseEvent {
  readonly id: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * `GET /api/doc/<docId>/notes/<anId>/diff` 的响应体（AC4.4）。
 * `nodeId` 是**当前文档**里那块的真实 id（重识别成功时与批注记录的旧 id 不同）。
 */
export interface AnnotationDiffBody {
  /** 供客户端据此丢弃过期 diff（响应可能比 `doc.changed` 先到）；**当前 app 尚未使用**。 */
  readonly revision: string;
  readonly nodeId: string;
  /** `chunks` 的可重建自证输入（起点）：core 侧测试用 `rebuild(chunks)` 与 `after` 交叉验证，`chunks` 才不是孤证。 */
  readonly before: string;
  /** `chunks` 的可重建自证输入（终点）：`before` + `chunks` 必须逐字复原它。 */
  readonly after: string;
  readonly chunks: DiffResult["chunks"];
  readonly degraded: boolean;
  readonly degradedReason?: string;
}

/** 处理器只产出数据，写 socket 与加安全头由 `server.ts` 统一做（处理器因此可单测）。 */
export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | string;
}
