// 这层管：daemon 的 HTTP 客户端（token → cookie 引导、cookie+csrf 写命令、SSE 事件流）。
// 与阅读器前端同一条认证通道：先 `GET /?token=` 拿 cookie，写操作再带 `x-hr-csrf: 1`。

import { assert, parseJson } from "./check.ts";
import type { JsonObject } from "./cli.ts";

export interface Api {
  readonly port: number;
  readonly cookie: string;
  readonly get: (path: string) => Promise<Response>;
  readonly post: (path: string, body: JsonObject) => Promise<Response>;
  readonly getJson: (path: string) => Promise<JsonObject>;
  readonly postJson: (path: string, body: JsonObject) => Promise<JsonObject>;
  readonly openSse: () => Promise<SseStream>;
}

export interface SseEvent {
  readonly id: number | undefined;
  readonly type: string;
  readonly data: JsonObject;
}

export interface SseStream {
  /** 下一个 `type` 匹配的事件；超时回 undefined（调用方判，不 sleep 断言）。 */
  readonly next: (type: string, timeoutMs?: number) => Promise<SseEvent | undefined>;
  readonly close: () => void;
}

const baseOf = (port: number): string => `http://127.0.0.1:${String(port)}`;

/** `GET /?token=` → 302 + Set-Cookie；与浏览器首访同一条 bootstrap 路径。 */
export const connect = async (port: number, token: string): Promise<Api> => {
  const boot = await fetch(`${baseOf(port)}/?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
  assert(boot.status === 302, `bootstrap 期望 302，实际 ${String(boot.status)}`);
  const setCookie = boot.headers.get("set-cookie") ?? "";
  const pair = /(?:^|;\s*)hr=([^;]+)/u.exec(setCookie);
  assert(pair !== null, `bootstrap 没下发 hr cookie：${setCookie}`);
  const cookie = `hr=${pair[1] ?? ""}`;

  const get = (path: string): Promise<Response> =>
    fetch(`${baseOf(port)}${path}`, { headers: { cookie } });
  const post = (path: string, body: JsonObject): Promise<Response> =>
    fetch(`${baseOf(port)}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-hr-csrf": "1" },
      body: JSON.stringify(body),
    });
  const getJson = async (path: string): Promise<JsonObject> => {
    const res = await get(path);
    const body = parseJson(await res.text(), `GET ${path} 响应`);
    assert(typeof body === "object" && body !== null, `GET ${path} 响应不是对象`);
    return body as JsonObject;
  };
  const postJson = async (path: string, body: JsonObject): Promise<JsonObject> => {
    const res = await post(path, body);
    const parsed = parseJson(await res.text(), `POST ${path} 响应`);
    assert(typeof parsed === "object" && parsed !== null, `POST ${path} 响应不是对象`);
    return parsed as JsonObject;
  };

  const openSse = async (): Promise<SseStream> => {
    const res = await get("/api/events");
    assert(res.status === 200, `SSE 期望 200，实际 ${String(res.status)}`);
    assert(res.body !== null, "SSE 响应没有 body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const backlog: SseEvent[] = [];
    const waiters: {
      readonly type: string;
      readonly resolve: (event: SseEvent | undefined) => void;
      readonly timer: NodeJS.Timeout;
    }[] = [];
    const dispatch = (frame: string): void => {
      let id: number | undefined;
      let dataText = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) id = Number(line.slice(3).trim());
        if (line.startsWith("data:")) dataText += line.slice(5).trim();
      }
      if (dataText === "") return;
      const parsed = parseJson(dataText, "SSE data 帧");
      if (typeof parsed !== "object" || parsed === null) return;
      const type: unknown = Reflect.get(parsed, "type");
      const event: SseEvent = {
        id,
        type: typeof type === "string" ? type : "",
        data: parsed as JsonObject,
      };
      const index = waiters.findIndex((waiter) => waiter.type === event.type);
      if (index === -1) {
        backlog.push(event);
        return;
      }
      const waiter = waiters[index];
      waiters.splice(index, 1);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    };
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = (await reader.read()) as {
            done?: boolean;
            value?: Uint8Array;
          };
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const at = buffer.indexOf("\n\n");
            if (at === -1) break;
            dispatch(buffer.slice(0, at));
            buffer = buffer.slice(at + 2);
          }
        }
      } finally {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve(undefined);
        }
      }
    };
    void pump();
    return {
      next: (type, timeoutMs = 15_000) =>
        new Promise<SseEvent | undefined>((resolve) => {
          const hit = backlog.findIndex((event) => event.type === type);
          if (hit !== -1) {
            resolve(backlog.splice(hit, 1)[0]);
            return;
          }
          const waiter = {
            type,
            resolve,
            timer: setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index !== -1) waiters.splice(index, 1);
              resolve(undefined);
            }, timeoutMs),
          };
          waiters.push(waiter);
        }),
      close: () => {
        void reader.cancel();
      },
    };
  };

  return { port, cookie, get, post, getJson, postJson, openSse };
};

export const docApi = (docId: string): string => `/api/doc/${encodeURIComponent(docId)}`;
