// 这层管：端口这两件"不是本地状态"的事——绑失败怎么归属、端口上那个进程是不是我们。
// 不碰 daemon.json，也不决定"能不能起"：那两条都在 `server.ts` 的 `ensureNoDaemon`/`armOf`。
// 拆出来的理由：身份探测要发 HTTP（`get` + JSON 解析），留在装配文件里会把它撑成第二件事。

import { createServer, get, type Server } from "node:http";

import { HrError } from "../hr-error";
import type { DaemonInfo } from "./contracts";

/** 端口上那个东西到底是不是我们的：记录里的 pid 可能被无关进程复用，只能问它自己的 `/healthz`。 */
type PortOwner = "ours" | "other" | "unknown";

const IDENTITY_PROBE_MS = 500;
const HEALTH_PATH = "/healthz";
const IPV4 = "127.0.0.1";
const IPV6 = "::";

const pidOfHealth = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? Reflect.get(value, "pid") : undefined;
  } catch {
    return undefined; // 不是 JSON = 不是我们的 /healthz
  }
};

/** 拿到完整响应才能断言"不是你"；超时/连不上只算"不知道"，不能据此删记录。 */
export const ownerOfPort = (info: DaemonInfo): Promise<PortOwner> =>
  new Promise((resolve) => {
    const req = get(
      { host: IPV4, port: info.port, path: HEALTH_PATH, timeout: IDENTITY_PROBE_MS },
      (res) => {
        const chunks: string[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => chunks.push(chunk));
        res.on("end", () => {
          resolve(pidOfHealth(chunks.join("")) === info.pid ? "ours" : "other");
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve("unknown");
    });
    req.on("error", () => {
      resolve("unknown");
    });
  });

/** EADDRINUSE 归一成"这个端口被别的进程占着"（`port_in_use`，退出码 2），而不是 70：环境问题但要人换端口。 */
export const bindErrorOf = (port: number, error: unknown): unknown => {
  const code: unknown = Reflect.get(Object(error), "code");
  return code === "EADDRINUSE"
    ? new HrError(
        "port_in_use",
        `端口 ${String(port)} 已被别的进程占用：换一个 --port，或先停掉占用它的进程`,
      )
    : error;
};

export const listen = (server: Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, IPV4, () => {
      resolve();
    });
  });

/**
 * `::` 上是否已被占：只当**补充信息**用——判定"能不能起"只看 v4 真绑定。
 * 反向用探测结果判断会造出"明明能起却报占用"的假红，比漏报更坏。
 *
 * `ipv6Only: true` 是这条探测成立的前提：缺省的双栈 `::` 在 Linux 上会和本机刚绑上的
 * `127.0.0.1:<port>` 冲突，于是每次 `hr serve` 都报一行假占用。关掉双栈后只有**真·v6-only**
 * 监听才会 `EADDRINUSE`——代价是双栈 `::` 占用的场景探测不到（漏报），这正是本节开头说的取舍。
 */
export const ipv6Occupied = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: unknown) => {
      resolve(Reflect.get(Object(error), "code") === "EADDRINUSE");
    });
    probe.listen({ port, host: IPV6, ipv6Only: true }, () => {
      probe.close(() => {
        resolve(false);
      });
    });
  });
