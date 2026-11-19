// 这层管：启动前那道"上一份 daemon.json 还算不算数"的判定；不建服务、不绑端口（绑在 `listen` 与 `armOf`）。

import { HrError } from "../hr-error";
import type { PatchDeps } from "../io/ports";
import type { ServerOptions } from "./contracts";
import { daemonFileOf, portOpen, readDaemonOf, removeDaemonOf, staleDaemonOf } from "./daemon";
import { ownerOfPort } from "./listen";

const PORT_PROBE_MS = 300;

/**
 * 已有 daemon（pid 活着且端口上确实是它）就拒绝启动；pid 已死或端口上是别人（kill -9 留下的残尸、
 * pid 被复用、别的工具写的同名文件）只删记录、留一行日志，不阻断。
 */
export const ensureNoDaemon = async (
  options: ServerOptions,
  deps: { readonly patch: PatchDeps },
): Promise<void> => {
  const existing = await readDaemonOf(options.home, deps.patch);
  if (existing === undefined) return;
  if (staleDaemonOf(existing)) {
    await removeDaemonOf(options.home, existing.pid, deps.patch);
    options.diagnose?.(`清理陈旧 daemon.json：pid ${String(existing.pid)} 已不在`);
    return;
  }
  if (!(await portOpen(existing.port, PORT_PROBE_MS))) return;
  const owner = await ownerOfPort(existing);
  if (owner === "other") {
    await removeDaemonOf(options.home, existing.pid, deps.patch);
    options.diagnose?.(
      `daemon.json 记录的 127.0.0.1:${String(existing.port)} 上不是 hReader，已删掉这份陈旧记录`,
    );
    return;
  }
  // 探不到身份（超时 / 非 JSON / 连不上）不等于能证明“是我们的 daemon 还活着”：
  // 此时报 daemon_already_running 会让用户去 `kill` 一个不知是什么的进程。按“端口被占”报，可供的后手是 --port。
  if (owner === "unknown") {
    throw new HrError(
      "port_in_use",
      `127.0.0.1:${String(existing.port)} 已被占用，但无法确认是不是 hReader daemon（pid ${String(existing.pid)}）：换一个 --port，或先确认并停掉占用它的进程`,
    );
  }
  // 退出码 1：这条是运行时状态（旧的还活着），用户该做的是停掉它，不是改命令。
  throw new HrError(
    "daemon_already_running",
    `已有 daemon 在 127.0.0.1:${String(existing.port)} 运行（pid ${String(existing.pid)}）：先停掉它（kill ${String(existing.pid)}），或删掉 ${daemonFileOf(options.home)} 后重试`,
  );
};
