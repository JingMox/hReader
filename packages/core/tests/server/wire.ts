// 这层管：手写 HTTP 原文的拼装（避免每个用例里散落超长模板串，也统一 Host 头）。

export interface RawRequest {
  readonly method: string;
  readonly path: string;
  readonly host?: string;
  readonly version?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export const rawRequest = (port: number, request: RawRequest): string => {
  const version = request.version ?? "HTTP/1.1";
  const host = request.host ?? `127.0.0.1:${String(port)}`;
  const lines = [`${request.method} ${request.path} ${version}`];
  if (host !== "") lines.push(`Host: ${host}`);
  for (const [key, value] of Object.entries(request.headers ?? {})) lines.push(`${key}: ${value}`);
  const body = request.body ?? "";
  if (body !== "" || request.method === "POST")
    lines.push(`Content-Length: ${String(body.length)}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
};

export const withCookie = (token: string): Readonly<Record<string, string>> => ({
  Cookie: `hr=${token}`,
});

export const withPost = (
  token: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  ...withCookie(token),
  "X-HR-CSRF": "1",
  "Content-Type": "application/json",
  ...extra,
});
