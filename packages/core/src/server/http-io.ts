// 这层管：HTTP 协议的读写细节（响应写入 / 请求体读取 / 鉴权与 CSRF 判定）；不含业务调用。

import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";

import { HrError, type HrErrorCode } from "../hr-error";
import { decodeUtf8, encodeUtf8 } from "../io/bytes";
import { COOKIE_NAME, CSRF_HEADER, cookieOf, csrfAllowed, tokenMatches } from "./auth";
import { MAX_BODY_BYTES, jsonBodyOf } from "./body";
import type { Reply } from "./contracts";
import type { Route } from "./routes";
import { isServerCode, statusOf } from "./status";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

/** 协议层错误：需要精确状态码（413/501），而 `HrError` 的码集已冻结、一个码只对应一个状态。 */
export class HttpFault extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpFault";
    this.status = status;
  }
}

const FIXED_MESSAGES: Partial<Record<HrErrorCode, string>> = {
  io_failure: "服务端暂时不可用",
  style_io_failure: "服务端暂时不可用",
  invalid_utf8: "文件不是合法的 UTF-8",
};

/** 响应体只放"人不该看到内部路径"的文案：绝对路径与 JSON 源片段一律抹掉，细节只进 `--debug` 的 stderr。 */
const publicMessageOf = (text: string): string => {
  const withoutPaths = text.replace(/\/(?:[\w.@%+-]+\/+)+[\w.@%+-]*/gu, "[路径已隐藏]");
  const withoutSource = withoutPaths.replace(/["'`][^"'"'`]{40,}["'`]/gu, "[内容已隐藏]");
  return withoutSource.length > 200 ? `${withoutSource.slice(0, 200)}…` : withoutSource;
};

export const sendResult = (res: ServerResponse, reply: Reply): void => {
  const body = typeof reply.body === "string" ? encodeUtf8(reply.body) : reply.body;
  res.writeHead(reply.status, { ...reply.headers, "content-length": String(body.length) });
  res.end(body);
};

export const errorReply = (error: unknown): Reply => {
  if (error instanceof HttpFault) {
    return {
      status: error.status,
      headers: JSON_HEADERS,
      body: JSON.stringify({ code: "invalid_request", message: publicMessageOf(error.message) }),
    };
  }
  if (error instanceof HrError && isServerCode(error.code)) {
    const fixed = FIXED_MESSAGES[error.code];
    return {
      status: statusOf(error.code),
      headers: JSON_HEADERS,
      body: JSON.stringify({ code: error.code, message: fixed ?? publicMessageOf(error.message) }),
    };
  }
  return {
    status: 500,
    headers: JSON_HEADERS,
    body: JSON.stringify({ code: "io_failure", message: "服务端内部错误" }),
  };
};

export const jsonOf = (status: number, value: unknown): Reply => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(value),
});

export const methodNotAllowed = (allowed: readonly string[]): Reply => ({
  status: 405,
  headers: { ...JSON_HEADERS, allow: allowed.join(", ") },
  body: JSON.stringify({ code: "invalid_request", message: `只接受 ${allowed.join(", ")}` }),
});

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export const contentTypeOf = (path: string): string =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** 应用页只允许同源脚本：`/assets/main.js` 不能被 `default-src 'none'` 连带禁掉。 */
export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";

const MAX_ASSET_PATH = 512;
/** 文件名单段上限（多数文件系统 255）：更长的段交给内核只会拿到 `ENAMETOOLONG`。 */
const MAX_SEGMENT_NAME = 255;

/** `/assets/<path>` 的解码后白名单：空段、`.`、`..`、反斜杠、NUL、超长一律拒（AC1.2）。 */
export const assetSegmentsOf = (rawPath: string): readonly string[] | undefined => {
  if (rawPath.length === 0 || rawPath.length > MAX_ASSET_PATH) return undefined;
  if (rawPath.includes("\0") || rawPath.includes("\\") || rawPath.startsWith("/")) return undefined;
  const segments = rawPath.split("/");
  const bad = segments.some(
    (part) => part === "" || part === "." || part === ".." || part.length > MAX_SEGMENT_NAME,
  );
  return bad ? undefined : segments;
};

export const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
};

/** 监听 `data` 而不是 `for await`：`IncomingMessage` 是 `any` 流，事件回调参数能拿到 `Buffer` 类型。 */
const chunksOf = (req: IncomingMessage, timeoutMs: number): Promise<readonly Uint8Array[]> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      reject(new HttpFault(408, "请求体读取超时"));
    }, timeoutMs);
    timer.unref();
    const settle = (action: () => void): void => {
      clearTimeout(timer);
      action();
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpFault(413, `请求体超过 ${String(MAX_BODY_BYTES)} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      settle(() => {
        resolve(chunks);
      });
    });
    req.on("aborted", () => {
      settle(() => {
        reject(new HttpFault(408, "连接在请求体读完前断开"));
      });
    });
    req.on("error", (error: Error) => {
      settle(() => {
        reject(error);
      });
    });
  });

const bodyTextOf = async (req: IncomingMessage, timeoutMs: number): Promise<string> => {
  const chunks = await chunksOf(req, timeoutMs);
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const bytes of chunks) {
    joined.set(bytes, offset);
    offset += bytes.length;
  }
  return decodeUtf8(joined, "请求体");
};

export const bodyRecordOf = async (
  req: IncomingMessage,
  timeoutMs = 10_000,
): Promise<Readonly<Record<string, unknown>>> => {
  const parsed = jsonBodyOf(await bodyTextOf(req, timeoutMs));
  if (!parsed.ok) throw new HrError("invalid_request", "请求体必须是 JSON 对象");
  return parsed.value;
};

interface AuthOutcome {
  readonly denied?: Reply;
  /** `Location` 的相对路径：带 `?t=` 的首次访问 302 到不带 token 的同名路径。 */
  readonly redirect?: string;
}

const unauthorized: AuthOutcome = { denied: jsonOf(401, { code: "unauthorized" }) };

export const authOf = (
  route: Route,
  req: IncomingMessage,
  url: URL,
  token: string,
): AuthOutcome => {
  if (route.auth === "none") return {};
  const cookieOk = tokenMatches(cookieOf(headerOf(req, "cookie"), COOKIE_NAME), token);
  if (route.auth === "token") {
    // 两个参数名都认：`?t=` 是桌面壳与旧链接的形状，`?token=` 是 `hr serve` 打印地址的形状。
    const query = url.searchParams.get("t") ?? url.searchParams.get("token");
    if (query !== null && tokenMatches(query, token)) return { redirect: url.pathname };
    return cookieOk ? {} : unauthorized;
  }
  if (!cookieOk) return unauthorized;
  if (route.auth === "cookie+csrf" && !csrfAllowed(headerOf(req, CSRF_HEADER))) {
    return { denied: jsonOf(403, { code: "forbidden_origin" }) };
  }
  return {};
};
