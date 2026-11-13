// 这层管：原始字节级别的"等到条件成立"交换——有界轮询，条件满足立刻返回，超时才失败。

import type { Socket } from "node:net";
import { connect } from "node:net";

interface Drive {
  readonly chunks: Buffer[];
  readonly until: (raw: string) => boolean;
  readonly settle: (ok: boolean, seen: string, reason?: string) => void;
}

/** 把一块数据推进累积器：条件成立就结算成功。 */
const onChunk = (drive: Drive, chunk: Buffer): void => {
  drive.chunks.push(chunk);
  const seen = Buffer.concat(drive.chunks).toString("latin1");
  if (drive.until(seen)) drive.settle(true, seen);
};

/** 连接收尾：条件成立算成功，否则带原文失败。 */
const onEnd = (drive: Drive): void => {
  const seen = Buffer.concat(drive.chunks).toString("latin1");
  if (drive.until(seen)) drive.settle(true, seen);
  else drive.settle(false, seen, "连接结束但条件未成立");
};

/** 挂监听 + 超时：这是唯一"等时间"的地方，而且只在条件始终不成立时触发。 */
const drive = (socket: Socket, state: Drive, timeoutMs: number): void => {
  const raw = (): string => Buffer.concat(state.chunks).toString("latin1");
  setTimeout(() => {
    state.settle(false, raw(), `等待条件超时（${String(timeoutMs)}ms）`);
  }, timeoutMs);
  socket.on("data", (chunk: Buffer) => {
    onChunk(state, chunk);
  });
  socket.on("end", () => {
    onEnd(state);
  });
  socket.on("error", (error) => {
    state.settle(false, raw(), `socket 错误：${error.message}`);
  });
};

export const rawExchangeUntil = (
  port: number,
  text: string,
  until: (raw: string) => boolean,
  timeoutMs = 2000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (ok: boolean, seen: string, reason?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (ok) resolve(seen);
      else
        reject(
          new Error(
            `${reason ?? "未知失败"}；已收到 ${String(seen.length)} 字节：${seen.slice(0, 200)}`,
          ),
        );
    };
    drive(socket, { chunks, until, settle }, timeoutMs);
    socket.on("connect", () => socket.write(text, "latin1"));
  });
