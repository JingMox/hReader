// 这层管：反 DNS-rebinding/CSRF 与 token/cookie 的纯判定（Host/Origin/CSRF/cookie 解析）；不读请求。

import { timingSafeEqual } from "node:crypto";

import { encodeUtf8 } from "../io/bytes";

export const COOKIE_NAME = "hr";

export const CSRF_HEADER = "x-hr-csrf";

const loopbackHosts = (port: number): readonly string[] => [
  `127.0.0.1:${String(port)}`,
  `localhost:${String(port)}`,
];

/**
 * 原文比较，不做 `split(":")` 猜测：Host 必须**恰好**等于允许集合里的一项（含端口），
 * 因此 `localhost`（无端口）、`127.0.0.1`（无端口）、`a.127.0.0.1:6379` 全部拒绝。
 * 允许集合默认是回环两种写法；`--allow-host` 可以整体替换它。
 */
export const hostAllowed = (
  host: string | undefined,
  port: number,
  allowHosts?: readonly string[],
): boolean => {
  if (host === undefined) return false;
  const allowed =
    allowHosts === undefined || allowHosts.length === 0 ? loopbackHosts(port) : allowHosts;
  return allowed.includes(host.trim().toLowerCase());
};

export const defaultHostsOf = (port: number): readonly string[] => loopbackHosts(port);

/** 没有 `Origin` 的请求（`curl`、同源导航）放行；有就必须是本站回环源。 */
export const originAllowed = (origin: string | undefined, port: number): boolean => {
  if (origin === undefined) return true;
  const lowered = origin.trim().toLowerCase();
  return [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`].includes(lowered);
};

/** `Cookie` 头里第一个 `hr=` 值；同名的第二个不覆盖（服务端只发一个）。 */
export const cookieOf = (header: string | undefined, name: string): string | undefined => {
  if (header === undefined) return undefined;
  const prefix = `${name}=`;
  for (const part of header.split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return undefined;
};

/**
 * 定长比较：长度不同也要走一次 `timingSafeEqual`，否则"长度对不对"会从耗时里漏出去；
 * 长度不等时比较自身与自身，返回值恒为真，由下面的分支决定结果。
 */
export const tokenMatches = (given: string | undefined, expected: string): boolean => {
  if (given === undefined) return false;
  const left = encodeUtf8(given);
  const right = encodeUtf8(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
};

/** 自定义头带一个固定值就够了：跨站"简单请求"不允许加自定义头，值本身不是秘密。 */
export const csrfAllowed = (value: string | undefined): boolean => value === "1";
