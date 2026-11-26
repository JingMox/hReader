// 这层管：服务端装配（监听 / 计划式分发 / SSE 接入 / daemon.json 生命周期）；运行期状态在 `runtime.ts`。

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { PatchDeps } from "../io/ports";
import type { StyleDeps } from "../style";
import { COOKIE_NAME, hostAllowed, originAllowed } from "./auth";
import { HttpFault } from "./http-io";
import type { Reply, ServerOptions } from "./contracts";
import { ensureNoDaemon } from "./daemon-guard";
import { removeDaemonOf, writeDaemonOf, type DaemonInfo } from "./daemon";
import { healthzReply } from "./handlers";
import { bindErrorOf, ipv6Occupied, listen } from "./listen";
import { authOf, errorReply, headerOf, jsonOf, methodNotAllowed, sendResult } from "./http-io";
import { MAX_HEADER_BYTES, timeoutsOf } from "./limits";
import { createServerHub, type Hub } from "./hub";
import { decodeParams, matchRoute, type Route } from "./routes";
import { createRuntime, type Runtime } from "./runtime";
import { homeUnauthorizedReply } from "./static";
import type { WatchFn } from "./watcher";

export interface ServerDeps {
  readonly patch: PatchDeps;
  readonly style: StyleDeps;
  /** 去抖 / 回声窗口 / uptime 都用它，便于测试注入假时钟。 */
  readonly now: () => number;
  readonly watch?: WatchFn;
}

export interface RunningServer {
  readonly port: number;
  readonly token: string;
  readonly info: DaemonInfo;
  readonly close: () => Promise<void>;
}

const TOKEN_BYTES = 24;
const COOKIE_MAX_AGE_S = 86_400;

const cookieOfToken = (token: string): string =>
  `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(COOKIE_MAX_AGE_S)}`;

/** 一次请求的结论：先算成计划，再执行；分支因此不散落在 socket 写入里。 */
type Plan =
  | { readonly kind: "reply"; readonly reply: Reply }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "events"; readonly lastEventId: string | undefined }
  | {
      readonly kind: "dispatch";
      readonly route: Route;
      readonly params: Readonly<Record<string, string>>;
    };

interface ServeEnv {
  readonly token: string;
  readonly port: () => number;
  readonly hub: Hub;
  readonly runtime: Runtime;
  readonly docId: string;
  readonly startedAt: number;
  readonly now: () => number;
  readonly allowHosts: readonly string[] | undefined;
}

/** Host/Origin 先判：token 进了 cookie 之后，剩下的攻击面是"让浏览器把我们的域名解析到攻击者的 IP"。 */
const hostCount = (req: IncomingMessage): number => {
  const headers = req.rawHeaders;
  let count = 0;
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === "host") count += 1;
  }
  return count;
};

const gateOf = (env: ServeEnv, req: IncomingMessage, nullOriginOk: boolean): Reply | undefined => {
  // 重复 Host（RFC 7230 §5.4 要求 400）：Node 只保留第一个，`req.headers` 看不出重复，只能数原文。
  if (hostCount(req) > 1) {
    return jsonOf(400, { code: "invalid_request", message: "重复的 Host 头" });
  }
  const port = env.port();
  const origin = headerOf(req, "origin");
  // `Origin: null` is only tolerated on the capability route: sandboxed pages
  // send it on CORS-mode subresource requests (fonts, module scripts, fetch).
  // Every other route keeps rejecting it — the cap itself is the credential.
  const originOk =
    originAllowed(origin, port, env.allowHosts) ||
    (nullOriginOk && origin?.trim().toLowerCase() === "null");
  const hostOk = hostAllowed(headerOf(req, "host"), port, env.allowHosts) && originOk;
  return hostOk ? undefined : jsonOf(403, { code: "forbidden_origin" });
};

/** 不碰构建产物、也不碰文档的唯一一页：`/healthz`；其余交给 `planOf`/`runtime`。 */
const pageOf = (env: ServeEnv, route: Route): Reply | undefined =>
  route.kind === "healthz" ? healthzReply(env.now() - env.startedAt) : undefined;

const planOf = (env: ServeEnv, req: IncomingMessage, url: URL): Plan => {
  const lookup = matchRoute(String(req.method), url.pathname);
  const gate = gateOf(env, req, lookup.kind === "route" && lookup.route.auth === "capability");
  if (gate !== undefined) return { kind: "reply", reply: gate };
  if (lookup.kind === "none") return { kind: "reply", reply: jsonOf(404, { code: "not_found" }) };
  if (lookup.kind === "method") return { kind: "reply", reply: methodNotAllowed(lookup.allowed) };
  const auth = authOf(lookup.route, req, url, env.token);
  // 首页的 401 用页面说人话：用户是把 `hr serve` 打印的地址弄丢了，不是在用 curl 调 API。
  if (auth.denied !== undefined)
    return {
      kind: "reply",
      reply: lookup.route.kind === "home" ? homeUnauthorizedReply() : auth.denied,
    };
  if (auth.redirect !== undefined) return { kind: "redirect", location: auth.redirect };
  const page = pageOf(env, lookup.route);
  if (page !== undefined) return { kind: "reply", reply: page };
  if (lookup.route.kind === "events")
    return { kind: "events", lastEventId: headerOf(req, "last-event-id") };
  const decoded = decodeParams(lookup.params);
  if (!decoded.ok) return { kind: "reply", reply: jsonOf(400, { code: "invalid_request" }) };
  return { kind: "dispatch", route: lookup.route, params: decoded.params };
};

/** @internal 边界测试用：真实请求的 `req.url` 总有值，`undefined` 一支不可达。 */
export const baseUrlOf = (rawUrl: string | undefined, port: number): URL =>
  new URL(rawUrl ?? "/", `http://127.0.0.1:${String(port)}`);
const serve = async (env: ServeEnv, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = baseUrlOf(req.url, env.port());
  const plan = planOf(env, req, url);
  if (plan.kind === "reply") {
    sendResult(res, plan.reply);
    return;
  }
  if (plan.kind === "redirect") {
    res.writeHead(302, {
      location: plan.location,
      "set-cookie": cookieOfToken(env.token),
      "cache-control": "no-store",
    });
    res.end();
    return;
  }
  if (plan.kind === "events") {
    env.hub.addClient(res, plan.lastEventId);
    return;
  }
  sendResult(res, await env.runtime.dispatch(plan.route, plan.params, req));
};

/** 内部导出仅供边界测试（不进公共面）：daemon 只监听 TCP，`string` 一支只出现在 unix socket 上。
 * @internal */
export const portFrom = (address: AddressInfo | string | null, fallback: number): number =>
  address === null || typeof address === "string" ? fallback : address.port;

const boardOf = (
  options: ServerOptions,
  env: Omit<ServeEnv, "port">,
): { readonly server: Server; readonly port: () => number } => {
  // 三档全部交给 Node 内置计时器：头部/请求超限时它自己收尾（请求体超限回 408），空闲由 `keepAliveTimeout` 关。
  const timeouts = timeoutsOf(options);
  const server = createServer({
    headersTimeout: timeouts.headersMs,
    requestTimeout: timeouts.bodyMs,
    maxHeaderSize: MAX_HEADER_BYTES,
  });
  server.keepAliveTimeout = timeouts.idleMs;
  const port = (): number => portFrom(server.address(), options.port);
  server.on("request", (req, res) => {
    void serve({ ...env, port }, req, res).catch((error: unknown) => {
      const reply = errorReply(error);
      // 5xx 是服务端自己的故障：订阅者必须收到 `error` 事件，而不是流被静默掐断。
      if (reply.status >= 500) {
        env.hub.publish("error", {
          code: "io_failure",
          message: "服务端内部错误",
          status: reply.status,
        });
      }
      if (!res.headersSent) {
        sendResult(res, reply);
      } else res.end();
      // 408/413 之后 body 可能还没读完：不关连接等于把没读完的体留给下一个请求（走私面）。
      if (error instanceof HttpFault) req.destroy();
    });
  });
  return { server, port };
};

const shutdown = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

interface Parts {
  readonly runtime: Runtime;
  readonly hub: Hub;
  readonly server: Server;
}

/** 校验 + 监听是一组：任何一步失败都要把已建好的 hub/runtime/server 收干净。 */
const armOf = async (options: ServerOptions, deps: ServerDeps, parts: Parts): Promise<void> => {
  await ensureNoDaemon(options, deps);
  await parts.runtime.remember(options.docId);
  try {
    await listen(parts.server, options.port);
  } catch (error: unknown) {
    throw bindErrorOf(options.port, error);
  }
  // 真绑上了才探：探到占用只提示——v4 能用，但 IPv6 访问会被别的进程接走。
  if (options.port !== 0 && (await ipv6Occupied(options.port))) {
    options.diagnose?.(
      `注意：:: 上已有监听，经 IPv6 访问端口 ${String(options.port)} 的流量可能被别的进程接走`,
    );
  }
};

const closerOf =
  (options: ServerOptions, deps: ServerDeps, parts: Parts): RunningServer["close"] =>
  async () => {
    parts.runtime.close();
    parts.hub.close();
    parts.server.closeAllConnections();
    await shutdown(parts.server);
    await removeDaemonOf(options.home, process.pid, deps.patch);
  };

interface Assembled extends Parts {
  readonly token: string;
  readonly port: () => number;
}

const assemble = (options: ServerOptions, deps: ServerDeps): Assembled => {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const hub = createServerHub(options.diagnose);
  const runtime = createRuntime(
    {
      workspace: options.workspace,
      docId: options.docId,
      bodyMs: timeoutsOf(options).bodyMs,
      appDir: options.appDir ?? "",
      home: options.home,
    },
    {
      patch: deps.patch,
      style: deps.style,
      ...(deps.watch === undefined ? {} : { watch: deps.watch }),
    },
    hub,
  );
  const { server, port } = boardOf(options, {
    token,
    hub,
    runtime,
    docId: options.docId,
    startedAt: deps.now(),
    allowHosts: options.allowHosts,
    now: deps.now,
  });
  return { token, hub, runtime, server, port };
};

export const startServer = async (
  options: ServerOptions,
  deps: ServerDeps,
): Promise<RunningServer> => {
  const parts = assemble(options, deps);
  // 启动期任何一步失败都要把监听器/心跳/daemon.json 收干净，否则失败进程会挂住不退。
  try {
    await armOf(options, deps, parts);
    const info: DaemonInfo = {
      port: parts.port(),
      token: parts.token,
      pid: process.pid,
      workspace: options.workspace,
    };
    await writeDaemonOf(info, options.home, deps.patch);
    return { port: info.port, token: parts.token, info, close: closerOf(options, deps, parts) };
  } catch (error: unknown) {
    parts.runtime.close();
    parts.hub.close();
    parts.server.closeAllConnections();
    await shutdown(parts.server);
    throw error;
  }
};
