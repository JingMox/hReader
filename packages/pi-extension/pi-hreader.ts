// hReader's Pi extension: subscribes to the daemon's SSE events, pushes documents to the reader, and injects annotations into the session.
// Pi loads a **single module** as an extension (`~/.pi/agent/extensions/*/pi-hreader.ts` or `pi -e ./pi-hreader.ts`),
// so the whole implementation lives in this file: zero local relative imports, zero `@hreader/*`.
// This file is therefore a second spelling of core protocol knowledge (deliberate duplication), held in place
// by the drift pins in `tests/protocol-pins.test.ts` rather than shared code.
// The pure layer (frame parsing / path resolution / error texts / node slicing) comes first; side effects
// (file/network/timers) only enter through the injected `HreaderDeps`.
// Pi's types were **copied by hand** from `pi-coding-agent@1.5.2`'s d.ts (that dependency is not installed: its d.ts
// wants DOM and full `@types/node`, conflicting with this repo's `lib: ["ES2023"]` + `types: []` + `skipLibCheck: false`).
// The originals follow — if a type drifts, these are the sections to diff:
//   ExtensionUIContext（dist/core/extensions/types.d.ts:83-91）
//     confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
//     notify(message: string, type?: "info" | "warning" | "error"): void;
//   ExtensionContext（:233-241）
//     ui: ExtensionUIContext; mode: ExtensionMode; hasUI: boolean; cwd: string;
//   RegisteredCommand（:1214）
//     handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
//   ExtensionAPI（:1228、:1303、:1312）
//     sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
//       options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
//     sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { ... }): void;
//   ToolDefinition.execute（:519）
//     execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
//       onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Type, type Static, type TSchema } from "typebox";

const DAEMON_DIR = ".hreader";
const DAEMON_FILE = "daemon.json";
const DAEMON_MISSING_HINT = "hReader daemon 没在跑：先运行 `hr serve`（本扩展不会自己拉起进程）";
const USAGE_HINT = "用法：/hreader <path>——相对 daemon 的 workspace 或绝对路径";

/** Authentication (`packages/core/src/server/auth.ts:7`): the cookie name is fixed `hr`, its value the daemon token. */
const COOKIE_NAME = "hr";
/** CSRF header for write commands (`auth.ts:9`), with the literal value `"1"` (`auth.ts:68` `csrfAllowed = (value) => value === "1"`). */
const CSRF_HEADER = "x-hr-csrf";
const CSRF_VALUE = "1";
/** The `retry: 2000` core sends in the `ready` frame (`event-ring.ts:74`); the extension reconnects on the same cadence. */
export const RECONNECT_MS = 2000;
/** A giant newline-free error body must not accumulate all the way to `flush()`: over the limit, drop the frame and reconnect (`Last-Event-ID` in the ring covers it). */
const SSE_BUFFER_LIMIT = 1024 * 1024;
/** The "pending" annotation statuses (`packages/core/src/meta/constants.ts` `PENDING_ANNOTATION_STATUSES`): legacy `pending_ai` and the reader's `pending` coexist. */
const PENDING_ANNOTATION_STATUSES: ReadonlySet<string> = new Set(["pending_ai", "pending"]);
/** `doc.changed` payloads carry exactly these four business types (`runtime.ts:88/106/110/118/232`, `server.ts:159`). */
export const BUSINESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "doc.changed",
  "doc.error",
  "library.changed",
  "error",
]);

/** The five patch actions (`packages/core/src/ops/patch-node/constants.ts:3` `PatchAction`). */
export const PATCH_ACTIONS = [
  "replace",
  "insert_before",
  "insert_after",
  "append",
  "delete",
] as const;

/** Shape of `daemon.json`, isomorphic to `DaemonInfo` in `packages/core/src/server/contracts.ts`. */
export interface DaemonInfo {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly workspace: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const jsonOfText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** core never sends `event:` lines — the type lives inside the `data` JSON, so a frame without one is a bad frame. */
const eventOf = (envelope: SseEnvelope): HreaderEvent | undefined => {
  const value = jsonOfText(envelope.data);
  if (!isRecord(value) || typeof value["type"] !== "string") return undefined;
  return { type: value["type"], payload: value, id: envelope.id };
};

const daemonFieldsOf = (record: Readonly<Record<string, unknown>>): DaemonInfo | undefined => {
  const port = record["port"];
  const token = record["token"];
  const pid = record["pid"];
  const workspace = record["workspace"];
  if (!isPositiveInt(port) || !isPositiveInt(pid)) return undefined;
  if (!isNonEmptyString(token) || !isNonEmptyString(workspace)) return undefined;
  return { port, token, pid, workspace };
};

/** Wrong field types count as "no daemon": a corrupt file must not carry the extension into a half-state. */
export const parseDaemon = (text: string): DaemonInfo | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(value) ? daemonFieldsOf(value) : undefined;
};

export const daemonFileOf = (home: string): string => join(home, DAEMON_DIR, DAEMON_FILE);

/** Reads `daemon.json`: a missing file, bad JSON, or a permission problem all count as "daemon not running" (the hint's suggested command fixes all three). */
export const readDaemonOf = async (deps: HreaderDeps): Promise<DaemonInfo | undefined> => {
  try {
    return parseDaemon(new TextDecoder().decode(await deps.readFile(daemonFileOf(deps.home))));
  } catch {
    return undefined;
  }
};

export type DocIdResult =
  | { readonly ok: true; readonly docId: string }
  | { readonly ok: false; readonly reason: "outside_workspace" };

/**
 * docId = the target's path relative to the daemon workspace, `/`-separated (`GET /s/:docId` and `/api/doc/:docId/*`
 * both consume this shape). Relative input resolves against the workspace, not Pi's cwd; the workspace itself and
 * out-of-bounds paths are not documents.
 * A shared prefix is not a subdirectory: `relative`, not `startsWith` — `/tmp/wsfoo` is not inside `/tmp/ws`.
 */
export const docIdOf = (workspace: string, target: string): DocIdResult => {
  const root = resolve(workspace);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: "outside_workspace" };
  }
  // Normalize separators to `/`: on posix `split(sep)` is the identity, on Windows it replaces `\`.
  // The second half only holds on win32 — this path has **not been verified on Windows CI** (this repo is developed on darwin).
  return { ok: true, docId: rel.split(sep).join("/") };
};

/** `GET /s/:docId` authenticates by `token` (`routes.ts`), so the URL's `t` is the `daemon.json` token. */
export const readerUrlOf = (info: DaemonInfo, docId: string): string =>
  `${apiUrlOf(info, pathOf(ENDPOINTS.document, { docId }))}?t=${encodeURIComponent(info.token)}`;

/**
 * Every HTTP endpoint the extension uses, one per `route(...)` line in `packages/core/src/server/routes.ts`.
 * All URLs are built from this table (no second place holds path literals), so the drift pins cover real usage.
 */
export const ENDPOINTS = {
  events: { method: "GET", segments: ["api", "events"], auth: "cookie" },
  outline: { method: "GET", segments: ["api", "doc", ":docId", "outline"], auth: "cookie" },
  annotations: {
    method: "GET",
    segments: ["api", "doc", ":docId", "annotations"],
    auth: "cookie",
  },
  patch: { method: "POST", segments: ["api", "patch"], auth: "cookie+csrf" },
  // The **only** source of available visual ids (`static.ts:136` returns `{ themes, default }`).
  themes: { method: "GET", segments: ["api", "theme"], auth: "none" },
  style: { method: "POST", segments: ["api", "style"], auth: "cookie+csrf" },
  document: { method: "GET", segments: ["s", ":docId"], auth: "token" },
} as const satisfies Readonly<Record<string, Endpoint>>;

export interface Endpoint {
  readonly method: "GET" | "POST";
  /** Segments like `:docId` are placeholders; the rest are literals (the same convention `routes.ts` uses). */
  readonly segments: readonly string[];
  readonly auth: "none" | "cookie" | "token" | "cookie+csrf";
}

/** Placeholder segment values must be encoded: a `/` inside `:docId` can only appear as `%2F` (per the `routes.ts` comment). */
export const pathOf = (endpoint: Endpoint, params: Readonly<Record<string, string>> = {}): string =>
  `/${endpoint.segments
    .map((segment) =>
      segment.startsWith(":") ? encodeURIComponent(params[segment.slice(1)] ?? "") : segment,
    )
    .join("/")}`;

const apiUrlOf = (info: DaemonInfo, path: string): string =>
  `http://127.0.0.1:${String(info.port)}${path}`;

export interface SseEnvelope {
  /** Verbatim `id:` field. The `ready` frame's `id: 0` is not in the ring; whether it may serve as `Last-Event-ID` is the subscription layer's call. */
  readonly id?: string;
  /** Verbatim `data:` — multiple `data:` lines of one frame joined by `\n` (core only ever writes one). */
  readonly data: string;
}

export interface SseDecoder {
  /** Feeds a chunk and returns only the frames completed so far; a half frame stays in the decoder for the next chunk. */
  readonly push: (chunk: Uint8Array) => readonly SseEnvelope[];
  /** At end of stream, yields the final frame (missing its blank-line terminator); a stream truly cut mid-char/mid-line discards the remnant. */
  readonly flush: () => readonly SseEnvelope[];
  /** Buffer over the limit (the peer is not speaking SSE): frames were dropped and the caller should reconnect. */
  readonly overflowed: () => boolean;
}

interface DecodeState {
  readonly decoder: TextDecoder;
  readonly limit: number;
  buffer: string;
  data: readonly string[];
  id: string | undefined;
  overflow: boolean;
}

interface LineCut {
  readonly line: string;
  readonly rest: string;
}

/**
 * Cuts one line. SSE line terminators may be `\r\n` / `\n` / `\r`; a `\r` at a chunk's end might be the first half
 * of `\r\n`, so it must wait for the next chunk (`atEnd` treats it as a terminator) — the "split terminator" edge.
 */
const cutLine = (buffer: string, atEnd: boolean): LineCut | undefined => {
  const index = buffer.search(/[\r\n]/);
  if (index === -1) return atEnd && buffer !== "" ? { line: buffer, rest: "" } : undefined;
  if (buffer[index] === "\r" && index === buffer.length - 1 && !atEnd) return undefined;
  const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
  return { line: buffer.slice(0, index), rest: buffer.slice(index + width) };
};

const applyField = (state: DecodeState, line: string): void => {
  const colon = line.indexOf(":");
  const name = colon === -1 ? line : line.slice(0, colon);
  const raw = colon === -1 ? "" : line.slice(colon + 1);
  const value = raw.startsWith(" ") ? raw.slice(1) : raw;
  if (name === "data") state.data = [...state.data, value];
  if (name === "id") state.id = value;
};

/** End of a frame: no `data:` means a comment/heartbeat (`: keep-alive`, `: ready`) or a blank line — drop it. */
const envelopeOf = (state: DecodeState): SseEnvelope | undefined => {
  const { data, id } = state;
  state.data = [];
  state.id = undefined;
  if (data.length === 0) return undefined;
  const joined = data.join("\n");
  return id === undefined ? { data: joined } : { id, data: joined };
};

const dropBuffer = (state: DecodeState): void => {
  state.overflow = true;
  state.buffer = "";
  state.data = [];
  state.id = undefined;
};

const pump = (state: DecodeState, atEnd: boolean): readonly SseEnvelope[] => {
  const envelopes: SseEnvelope[] = [];
  let cut = cutLine(state.buffer, atEnd);
  while (cut !== undefined) {
    state.buffer = cut.rest;
    if (cut.line === "") {
      const envelope = envelopeOf(state);
      if (envelope !== undefined) envelopes.push(envelope);
    } else {
      applyField(state, cut.line);
    }
    cut = cutLine(state.buffer, atEnd);
  }
  if (state.buffer.length > state.limit) dropBuffer(state);
  return state.overflow ? [] : envelopes;
};

/**
 * Incremental SSE decoder: bytes decode only **across** chunks (`TextDecoder`'s streaming mode), or a multi-byte
 * UTF-8 char split by a chunk boundary would mojibake while per-chunk unit tests stayed green.
 */
export const createSseDecoder = (limit: number = SSE_BUFFER_LIMIT): SseDecoder => {
  const state: DecodeState = {
    decoder: new TextDecoder(),
    limit,
    buffer: "",
    data: [],
    id: undefined,
    overflow: false,
  };
  return {
    push: (chunk) => {
      if (state.overflow) return [];
      state.buffer += state.decoder.decode(chunk, { stream: true });
      return pump(state, false);
    },
    flush: () => {
      // Final decode without `stream: true`: a stream cut mid-char lands as U+FFFD, and the frame is then dropped wholesale.
      state.buffer += state.decoder.decode();
      const envelopes = pump(state, true);
      const last = envelopeOf(state);
      if (last === undefined) return envelopes;
      // Truncated streams are expected semantics: a frame salvaged from a half line that does not parse is dropped
      // **silently** — reporting it would flash a false "possible core protocol drift" alarm on every routine
      // disconnect; genuinely malformed mid-stream frames are still surfaced by `dispatchOf`.
      return eventOf(last) === undefined ? envelopes : [...envelopes, last];
    },
    overflowed: () => state.overflow,
  };
};

/**
 * The slice of Pi's extension context this extension actually uses (original signatures in the file header). A narrow
 * interface lets test doubles skip faking Pi's whole API and lets this file avoid `import type` on the DOM-requiring package.
 */
export interface HreaderUi {
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
}

export interface HreaderContext {
  readonly ui: HreaderUi;
  readonly hasUI: boolean;
  readonly cwd: string;
}

/** `RegisteredCommand.handler`: `args` is the whole string after the slash command, possibly empty. */
export interface HreaderCommandOptions {
  readonly description: string;
  readonly handler: (args: string, ctx: HreaderContext) => Promise<void>;
}

export interface HreaderToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface HreaderTool<TParams extends TSchema = TSchema> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParams;
  // Method syntax is deliberate: Pi's `ToolDefinition` is also a method (bivariant); a property would make
  // `HreaderTool<typeof X>` fail `HreaderTool<TSchema>` on `params` contravariance (forcing a cast in the doubles table).
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: HreaderContext,
  ): Promise<HreaderToolResult>;
}

export interface HreaderCustomMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
}

/** The part of `ExtensionAPI` this extension uses; the default export must be callable by Pi as the extension factory. */
export interface HreaderPi {
  readonly registerCommand: (name: string, options: HreaderCommandOptions) => void;
  readonly registerTool: <TParams extends TSchema>(tool: HreaderTool<TParams>) => void;
  readonly sendMessage: (
    message: HreaderCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => void;
  readonly on: (event: "session_shutdown", handler: () => void) => () => void;
}

export interface FetchReply {
  readonly ok: boolean;
  readonly status: number;
  /** Event streams come back as a `ReadableStream`; a one-shot response may be `null` (read `text()` only). */
  readonly body: ReadableStream<Uint8Array> | null;
  readonly text: () => Promise<string>;
}

export interface HreaderRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type FetchLike = (url: string, request: HreaderRequest) => Promise<FetchReply>;

export interface HreaderDeps {
  /** `~`: `daemon.json` lives under `~/.hreader/`; tests pass a temp dir. */
  readonly home: string;
  /** Reads raw bytes; UTF-8 decoding happens in `readDaemonOf` so the default implementation can be `node:fs`'s own function. */
  readonly readFile: (file: string) => Promise<Uint8Array>;
  readonly fetch: FetchLike;
  /** Reconnect wait. The default implementation must `unref()`, or Pi's print mode cannot exit. */
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The daemon's error-code copy (the full `HrErrorCode` set of `packages/core/src/hr-error.ts`; a missing entry turns a drift pin red). */
export const ERROR_TEXTS: Readonly<Record<string, string>> = {
  invalid_html: "HTML 不合法",
  no_article: "文档里没有 `<article>`",
  node_not_found: "找不到该节点（id 可能已随上一次改动变化）",
  invalid_selector: "选择器不合法",
  invalid_document: "文档不合法",
  node_not_allowed: "该节点类型不允许这样改",
  invalid_max_bytes: "字节上限参数不合法",
  invalid_input: "入参不合法",
  locked: "文档正被另一个写请求占用",
  invalid_fragment: "片段不合法",
  forbidden_content: "片段里含脚本/样式等禁止内容",
  path_outside_workspace: "路径不在 daemon 的 workspace 里",
  not_a_file: "目标不是文件",
  io_failure: "daemon 读写文件失败",
  invalid_utf8: "文件不是合法 UTF-8",
  undo_unavailable: "没有可撤销的改动",
  invalid_style: "风格定义不合法",
  unknown_style: "没有这个风格",
  invalid_theme: "视觉主题不合法",
  style_io_failure: "主题样式表读写失败",
  not_found: "目标不存在",
  invalid_request: "请求不合法",
  busy: "daemon 正忙，请稍后重试",
  too_many_clients: "订阅者过多，daemon 拒绝了新连接",
  unauthorized: "认证失败（cookie/token 不对，daemon 可能已重启）",
  forbidden_origin: "来源被拒绝",
  daemon_already_running: "已经有一个 daemon 在跑",
  invalid_payload: "请求体不合法",
  nothing_to_undo: "没有可撤销的改动",
  anchor_lost: "批注锚点已失效（那段文字被改过了）",
  file_exists: "目标文件已存在（要覆盖请显式加 --force）",
  llm_failure: "风格建议层调用失败（检查 key / 网络，或用 --no-llm 走纯统计版）",
  empty_document: "文档正文裁掉交互 UI 后为空，没有可印的内容",
  chrome_missing: "找不到本机 Chrome（可用 HREADER_CHROME 指定）",
  chrome_failed: "Chrome 起不来或渲染失败",
  render_timeout: "渲染超时（Chrome 未在期限内完成）",
  render_empty: "Chrome 没有返回可用的 PDF/PNG",
  needs_normalize: "文档缺少 data-hr-id（先跑 hr normalize <file> --write）",
  port_in_use: "端口被别的进程占用（换一个 --port，或先停掉占它的进程）",
  content_model_conflict: "片段与目标容器内容模型冲突（换容器或改 --html）",
  duplicate_id: "两个元素共用一个 data-hr-id（只命中第一个）：先跑 hr normalize <file> --write",
};

export const errorTextOf = (code: string, detail?: string): string => {
  const text = ERROR_TEXTS[code] ?? "未知错误（看 daemon 日志）";
  return code.startsWith("http_")
    ? `daemon 返回 ${code.slice("http_".length)}：${text}`
    : detail === undefined || detail === ""
      ? `[${code}] ${text}`
      : `[${code}] ${text}——${detail}`;
};

/** Upper bound for terminal echo: a huge id (4KB observed) inflates one notify into thousands of characters and smears everything else off screen. */
export const NOTIFY_MAX = 400;

/** Single-line sanitizer: control chars (ESC and newlines included) → `?`. Ids come from untrusted workspace directory names, so echoing ESC would hand the terminal to the daemon; display only — validation and `POST` use the raw value. */
export const safeTextOf = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : char;
  }).join("");

/** Truncates with a `…` suffix; the result is **at most** `max` characters. */
export const clipTextOf = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/** Echo cap for user-typed ids: keeps the candidate list visible instead of letting one long input push it off. */
const ECHO_MAX = 120;
/** The only exit into the terminal: every `ctx.ui.notify` goes through it (a message's own newlines are deliberate, so it clips rather than sanitizing whole). */
export const notifyOf = (
  ctx: HreaderContext,
  message: string,
  type: "info" | "warning" | "error",
): void => {
  ctx.ui.notify(clipTextOf(message, NOTIFY_MAX), type);
};

/** Display form of the available ids: each sanitized, then joined with `、`. */
export const idListTextOf = (ids: readonly string[]): string =>
  ids.map((id) => safeTextOf(id)).join("、");

/** Cuts one node out of the **source file bytes** fetched via `/s/:docId`: core has no readNode route, so node source can only come from here. */
export const nodeSliceOf = (html: string, nodeId: string): string | undefined => {
  const open = nodeId === "root" ? html.indexOf("<article") : findByIdOf(html, nodeId);
  if (open === undefined || open === -1) return undefined;
  const end = closeIndexOf(html, open);
  return end === undefined ? undefined : html.slice(open, end);
};

interface TagStart {
  readonly start: number;
  readonly name: string;
  readonly tagEnd: number;
  readonly selfClosing: boolean;
}
const findByIdOf = (html: string, nodeId: string): number | undefined => {
  const patterns = [`data-hr-id="${nodeId}"`, `data-hr-id='${nodeId}'`];
  for (const pattern of patterns) {
    const at = html.indexOf(pattern);
    if (at !== -1) return html.lastIndexOf("<", at);
  }
  return undefined;
};

const tagAtOf = (html: string, start: number): TagStart | undefined => {
  const head = /^<([a-zA-Z][\w-]*)/.exec(html.slice(start, start + 40));
  if (head === null) return undefined;
  const tagEnd = html.indexOf(">", start);
  if (tagEnd === -1) return undefined;
  // `slice/join` rather than `head[1] ?? ""`: under per-file 100% coverage a fallback branch must be reachable.
  return {
    start,
    name: head.slice(1, 2).join(""),
    tagEnd,
    selfClosing: html[tagEnd - 1] === "/",
  };
};

/** Counts same-tag nesting depth forward from the open tag; back at 0, the node ends right after `</tag>`. */
const closeIndexOf = (html: string, start: number): number | undefined => {
  const tag = tagAtOf(html, start);
  if (tag === undefined) return undefined;
  if (tag.selfClosing || VOID_TAGS.has(tag.name)) return tag.tagEnd + 1;
  let depth = 1;
  let cursor = tag.tagEnd + 1;
  // No `while (cursor < html.length)` exit: `closeAt + 1` can reach `length - 2` at most, so a "condition went
  // false" exit is unreachable (per-file 100% would flag it red). The only way out is `closeAt === -1`.
  for (;;) {
    const openAt = html.indexOf(`<${tag.name}`, cursor);
    const closeAt = html.indexOf(`</${tag.name}`, cursor);
    if (closeAt === -1) return undefined;
    if (openAt !== -1 && openAt < closeAt) {
      depth += 1;
      cursor = openAt + 1;
      continue;
    }
    depth -= 1;
    cursor = closeAt + 1;
    if (depth === 0) {
      // With no `>` (the source file was cut mid-tag) returning `-1 + 1 = 0` is **not** allowed:
      // `html.slice(open, 0)` would be "", which callers would read as "node source was empty".
      const end = html.indexOf(">", closeAt);
      return end === -1 ? undefined : end + 1;
    }
  }
};

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "img", "hr", "input", "meta", "link"]);

/** Reads the document source file (`/s/:docId` is token-auth, no cookie). */
const documentOf = async (
  deps: HreaderDeps,
  info: DaemonInfo,
  docId: string,
): Promise<string | undefined> => {
  try {
    const reply = await deps.fetch(readerUrlOf(info, docId), {
      method: "GET",
      headers: {},
    });
    return reply.ok ? await reply.text() : undefined;
  } catch {
    return undefined;
  }
};

export type ApiResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly text: string };

const jsonOf = async (reply: FetchReply): Promise<unknown> => {
  try {
    return JSON.parse(await reply.text());
  } catch {
    return undefined;
  }
};

const failureTextOf = (status: number, value: unknown): string => {
  // A non-JSON 2xx must not say "200: unknown error" — that misleads when a proxy/front page slips in.
  if (status < 400 && !isRecord(value)) {
    return `daemon 返回 ${String(status)} 但响应不是 JSON（看 daemon 日志）`;
  }
  const codeOf = (): string =>
    isRecord(value) && typeof value["code"] === "string" ? value["code"] : `http_${String(status)}`;
  const code = safeTextOf(codeOf());
  const messageOf = (): string | undefined =>
    isRecord(value) && typeof value["message"] === "string"
      ? safeTextOf(value["message"])
      : undefined;
  return errorTextOf(code, messageOf());
};

/** One API call: reads carry the cookie, writes additionally carry `x-hr-csrf: 1` (the `routes.ts` auth column). */
const apiOf = async (
  deps: HreaderDeps,
  info: DaemonInfo,
  endpoint: Endpoint,
  params: Readonly<Record<string, string>>,
  body?: Readonly<Record<string, unknown>>,
): Promise<ApiResult> => {
  // Whether to send the CSRF header is decided by the endpoint table's auth, not by repeating `method === "POST"` at call sites.
  const write = endpoint.auth === "cookie+csrf";
  const headers: Record<string, string> = {
    cookie: `${COOKIE_NAME}=${info.token}`,
    "content-type": "application/json",
    ...(write ? { [CSRF_HEADER]: CSRF_VALUE } : {}),
  };
  try {
    const reply = await deps.fetch(apiUrlOf(info, pathOf(endpoint, params)), {
      method: endpoint.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await jsonOf(reply);
    if (reply.ok && isRecord(value)) return { ok: true, value };
    return { ok: false, text: failureTextOf(reply.status, value) };
  } catch {
    return { ok: false, text: errorTextOf("io_failure", "连不上 daemon（可能已退出）") };
  }
};

export interface HreaderEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly id: string | undefined;
}

export interface SubscribeHandlers {
  readonly onEvent: (event: HreaderEvent) => void;
  /** `reset` frame (`event-ring.ts:83`): the ring expired, and the user must learn that events were lost. */
  readonly onStale: () => void;
  /** One read round ended (disconnect/server close); a reconnect follows. */
  readonly onDown: () => void;
  /** The frame's `data` is not a JSON object with `type`: drop it, but not silently — that is what protocol drift looks like. */
  readonly onBadFrame: (detail: string) => void;
}

export interface Subscription {
  readonly stop: () => void;
}

interface CycleContext {
  readonly deps: HreaderDeps;
  /** A daemon restart changes port/token; refreshed by `loopOf` in the down window, hence not readonly. */
  info: DaemonInfo;
  readonly handlers: SubscribeHandlers;
  readonly signal: AbortSignal;
  /** Alert categories already reported (`bad`/`down`), see `reportOnceOf`. */
  readonly reported: Set<"bad" | "down">;
  lastEventId: string | undefined;
}

/**
 * One alert per category per subscription: a hint per bad frame on a 50ms bad stream would be 20 permanent
 * lines a second. The set clears once the stream proves healthy (a business event arrives), so a post-reconnect
 * problem may report once more.
 */
const reportOnceOf = (context: CycleContext, key: "bad" | "down"): boolean => {
  if (context.reported.has(key)) return false;
  context.reported.add(key);
  return true;
};

/** Where a frame goes: `reset` → staleness notice; the four business types → handled; everything else (`ready` included) ignored. */
const dispatchOf = (context: CycleContext, envelope: SseEnvelope): void => {
  const event = eventOf(envelope);
  if (event === undefined) {
    if (reportOnceOf(context, "bad")) context.handlers.onBadFrame(envelope.data);
    return;
  }
  if (event.type === "reset") {
    context.handlers.onStale();
    return;
  }
  if (BUSINESS_EVENT_TYPES.has(event.type)) {
    context.reported.clear();
    context.handlers.onEvent(event);
  }
  // `ready`'s `id: 0` is not in the ring: using it as `Last-Event-ID` would make reconnect replay from the ring head.
  if (event.id !== undefined && event.id !== "0") context.lastEventId = event.id;
};

/** `cancel()` rejects on an aborted stream: Node 24 turns unhandled rejections into a process crash by default. */
const cancelQuietlyOf = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  reader.cancel().catch(() => undefined);
};

const readStreamOf = async (
  context: CycleContext,
  body: ReadableStream<Uint8Array>,
): Promise<void> => {
  const reader = body.getReader();
  const onAbort = (): void => {
    cancelQuietlyOf(reader);
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  const decoder = createSseDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const envelope of decoder.push(value)) dispatchOf(context, envelope);
      if (decoder.overflowed()) return;
    }
    for (const envelope of decoder.flush()) dispatchOf(context, envelope);
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    // An overflow exit via `return` must still close the body: `loopOf` reconnects 2s later, so every overflow
    // would otherwise leak a connection (one per 2s = unbounded growth). After a normal read `cancel()` is a harmless no-op.
    cancelQuietlyOf(reader);
  }
};

const headersOfEvents = (
  info: DaemonInfo,
  lastEventId: string | undefined,
): Record<string, string> => ({
  cookie: `${COOKIE_NAME}=${info.token}`,
  accept: "text/event-stream",
  ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
});

const runCycleOf = async (context: CycleContext): Promise<void> => {
  try {
    const reply = await context.deps.fetch(apiUrlOf(context.info, "/api/events"), {
      method: "GET",
      headers: headersOfEvents(context.info, context.lastEventId),
      signal: context.signal,
    });
    if (!reply.ok || reply.body === null) return;
    await readStreamOf(context, reply.body);
  } catch {
    // Disconnects are routine: hand off to the outer `onDown` + reconnect instead of throwing at Pi.
  }
};

/** Reads `aborted` through a function: `while (!signal.aborted)` would narrow later reads to `false` (TS treats a readonly property as fixed). */
const abortedOf = (signal: AbortSignal): boolean => signal.aborted;

const loopOf = async (context: CycleContext): Promise<void> => {
  while (!abortedOf(context.signal)) {
    await runCycleOf(context);
    if (abortedOf(context.signal)) return;
    if (reportOnceOf(context, "down")) context.handlers.onDown();
    await context.deps.delay(RECONNECT_MS, context.signal);
    // A daemon restart rewrites daemon.json (new port/token): reconnecting with stale info only yields endless
    // ECONNREFUSED/401. The disk read happens only in the down window — while the stream lives, runCycleOf is
    // blocked on read and never gets here.
    const fresh = await readDaemonOf(context.deps);
    if (
      fresh !== undefined &&
      (fresh.port !== context.info.port || fresh.token !== context.info.token)
    ) {
      context.info = fresh;
      // A new daemon has a different event ring: the old cursor is not "behind" but "invalid" — clear it and start over.
      context.lastEventId = undefined;
    }
  }
};

/** Subscribes to `/api/events`: reads until the stream drops, waits `RECONNECT_MS`, reconnects with `Last-Event-ID`, until `stop()`. */
export const subscribeOf = (
  deps: HreaderDeps,
  info: DaemonInfo,
  handlers: SubscribeHandlers,
): Subscription => {
  const controller = new AbortController();
  const context: CycleContext = {
    deps,
    info,
    handlers,
    signal: controller.signal,
    reported: new Set<"bad" | "down">(),
    lastEventId: undefined,
  };
  void loopOf(context);
  return {
    stop: () => {
      controller.abort();
    },
  };
};

interface HreaderSession {
  docId: string | undefined;
  /** Visual id chosen per document: `POST /api/style` takes a `docId`, the style is a **document property** the extension still remembers on switching back. */
  readonly themeOf: Map<string, string>;
  /** Monotonic `/hr-style` sequence: the latest command wins, and a slow reply uses it to tell it was superseded. */
  styleSeq: number;
  subscription: Subscription | undefined;
  readonly asked: Set<string>;
  /** Serializes the flow: two `doc.changed` in one chunk must not run concurrently (the dedupe set is not yet registered and would ask twice). */
  queue: Promise<void>;
}

const sessionOf = (): HreaderSession => ({
  docId: undefined,
  themeOf: new Map<string, string>(),
  styleSeq: 0,
  subscription: undefined,
  asked: new Set<string>(),
  queue: Promise.resolve(),
});

interface PendingAnnotation {
  readonly id: string;
  readonly nodeId: string;
  readonly note: string;
}

/** Accepts `pending_ai` and `pending` (same criterion as core); `resolved`/dismissed and every other status are excluded — the user must not be asked twice. */
const pendingOf = (value: unknown): PendingAnnotation | undefined => {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const nodeId = value["nodeId"];
  if (!isNonEmptyString(id) || !isNonEmptyString(nodeId)) return undefined;
  const status = value["status"];
  if (typeof status !== "string" || !PENDING_ANNOTATION_STATUSES.has(status)) return undefined;
  const note = value["note"];
  return { id, nodeId, note: typeof note === "string" ? note : "" };
};

const pendingListOf = (
  value: unknown,
  asked: ReadonlySet<string>,
): readonly PendingAnnotation[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const annotation = pendingOf(item);
    return annotation === undefined || asked.has(annotation.id) ? [] : [annotation];
  });
};

/** In a `doc.changed` payload the document key is `docId` (`runtime.ts:232`); `path` only appears in `doc.error`/`library.changed`. */
const docIdOfEvent = (payload: Readonly<Record<string, unknown>>): string | undefined => {
  const docId = payload["docId"];
  return typeof docId === "string" ? docId : undefined;
};

const injectionOf = (
  annotation: PendingAnnotation,
  docId: string,
  document: string | undefined,
): string => {
  const source =
    document === undefined ? "（读不到节点源码）" : nodeSliceOf(document, annotation.nodeId);
  return [
    `hReader 批注（文档 ${docId}，节点 ${annotation.nodeId}）`,
    "",
    "节点源码：",
    source ?? "（该节点已不在文档里）",
    "",
    "批注：",
    annotation.note,
    "",
    "请按批注改这一个节点；改完用 hreader_patch_node 落盘（改完记得在阅读器里解决批注）。",
  ].join("\n");
};

interface OfferContext {
  readonly pi: HreaderPi;
  readonly ctx: HreaderContext;
  readonly docId: string;
  readonly document: string | undefined;
}

const offerOf = async (context: OfferContext, annotation: PendingAnnotation): Promise<void> => {
  const text = injectionOf(annotation, context.docId, context.document);
  // With no UI (print/json mode) `confirm` is unavailable: notify only, never inject the annotation into the session uninvited.
  if (!context.ctx.hasUI) {
    // `nodeId`/`note` are untrusted fragments from the daemon: sanitize before echoing.
    notifyOf(
      context.ctx,
      `有新批注（${safeTextOf(annotation.nodeId)}）：${safeTextOf(annotation.note)}`,
      "info",
    );
    return;
  }
  const accepted = await context.ctx.ui.confirm("hReader 批注", text);
  if (!accepted) return;
  context.pi.sendMessage(
    { customType: "hreader.annotation", content: text, display: true },
    { triggerTurn: true, deliverAs: "followUp" },
  );
};

const intakeOf =
  (deps: HreaderDeps, session: HreaderSession, pi: HreaderPi) =>
  async (event: HreaderEvent, ctx: HreaderContext): Promise<void> => {
    if (event.type !== "doc.changed") return;
    const docId = docIdOfEvent(event.payload);
    if (docId === undefined || docId !== session.docId) return;
    const info = await readDaemonOf(deps);
    if (info === undefined) return;
    const listed = await apiOf(deps, info, ENDPOINTS.annotations, { docId });
    if (!listed.ok) return;
    const pending = pendingListOf(listed.value["annotations"], session.asked);
    if (pending.length === 0) return;
    const document = await documentOf(deps, info, docId);
    for (const annotation of pending) {
      // Register before asking: if another `doc.changed` arrives while `confirm` is pending, the same `anId` must not prompt twice.
      session.asked.add(annotation.id);
      await offerOf({ pi, ctx, docId, document }, annotation);
    }
  };

const summaryOf = (value: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(value, null, 2);

const toolResultOf = (
  text: string,
  details: Readonly<Record<string, unknown>> = {},
): HreaderToolResult => ({ content: [{ type: "text", text }], details });

interface ToolContext {
  readonly info: DaemonInfo;
  readonly docId: string;
}

/** Shared shell of the three tools: a missing daemon or an out-of-workspace path becomes **text**, never a bare throw.
 * There is no `try/catch` here: each of the three IO seams already folds errors into `undefined` / `ok: false`
 * internally, leaving `work` as pure non-throwing computation. Before adding IO to `work`, totalize that seam
 * first, or the tools' "never throws" promise breaks here. */
const runToolOf = async (
  deps: HreaderDeps,
  path: string,
  work: (context: ToolContext) => Promise<HreaderToolResult>,
): Promise<HreaderToolResult> => {
  const info = await readDaemonOf(deps);
  if (info === undefined) return toolResultOf(DAEMON_MISSING_HINT);
  const docId = docIdOf(info.workspace, path);
  if (!docId.ok) {
    return toolResultOf(errorTextOf("path_outside_workspace", `${path} 不在 ${info.workspace} 里`));
  }
  return work({ info, docId: docId.docId });
};

const OUTLINE_PARAMS = Type.Object({ path: Type.String() });
const READ_NODE_PARAMS = Type.Object({ path: Type.String(), nodeId: Type.String() });
const PATCH_NODE_PARAMS = Type.Object({
  path: Type.String(),
  nodeId: Type.String(),
  action: Type.Union(PATCH_ACTIONS.map((action) => Type.Literal(action))),
  htmlContent: Type.String(),
});

const outlineToolOf = (deps: HreaderDeps): HreaderTool<typeof OUTLINE_PARAMS> => ({
  name: "hreader_outline",
  label: "读文档大纲",
  description: "写稿前先看结构：返回标题层级、每节字数与未处理的批注。要挑一个节点改时先调它",
  parameters: OUTLINE_PARAMS,
  execute: async (_toolCallId, params) =>
    runToolOf(deps, params.path, async ({ info, docId }) => {
      const result = await apiOf(deps, info, ENDPOINTS.outline, { docId });
      if (!result.ok) return toolResultOf(result.text);
      return toolResultOf(summaryOf(result.value), {
        revision: result.value["revision"],
        docId,
      });
    }),
});

const readNodeToolOf = (deps: HreaderDeps): HreaderTool<typeof READ_NODE_PARAMS> => ({
  name: "hreader_read_node",
  label: "读单个节点",
  description:
    "按 `hreader_outline` 给的 nodeId 取那一块的真实 HTML 与它身上的批注。要改某段正文前先用它看清现状",
  parameters: READ_NODE_PARAMS,
  execute: async (_toolCallId, params) =>
    runToolOf(deps, params.path, async ({ info, docId }) => {
      const document = await documentOf(deps, info, docId);
      if (document === undefined) return toolResultOf(errorTextOf("io_failure", "取不到文档源码"));
      const html = nodeSliceOf(document, params.nodeId);
      if (html === undefined) return toolResultOf(errorTextOf("node_not_found", params.nodeId));
      const listed = await apiOf(deps, info, ENDPOINTS.annotations, { docId });
      // Only the pending annotations on this node: other nodes' annotations belong to other tool calls.
      const notes = listed.ok
        ? pendingListOf(listed.value["annotations"], new Set()).filter(
            (annotation) => annotation.nodeId === params.nodeId,
          )
        : [];
      return toolResultOf(
        JSON.stringify({ docId, nodeId: params.nodeId, html, annotations: notes }, null, 2),
        {
          docId,
          nodeId: params.nodeId,
          revision: listed.ok ? listed.value["revision"] : undefined,
        },
      );
    }),
});

/** `delete` sends no fragment (same fork as MCP's `patch-node.ts:35-38`); the other four actions require one. */
const patchBodyOf = (
  docId: string,
  params: { readonly nodeId: string; readonly action: string; readonly htmlContent: string },
): Readonly<Record<string, unknown>> =>
  params.action === "delete"
    ? { docId, targetId: params.nodeId, action: params.action }
    : { docId, targetId: params.nodeId, action: params.action, fragment: params.htmlContent };

const patchNodeToolOf = (deps: HreaderDeps): HreaderTool<typeof PATCH_NODE_PARAMS> => ({
  name: "hreader_patch_node",
  label: "改一个节点",
  description:
    "对某个节点做 replace/insert_before/insert_after/append/delete。要动正文时用它，别整篇重写；写盘走原子替换并留 undo 快照",
  parameters: PATCH_NODE_PARAMS,
  execute: async (_toolCallId, params) =>
    runToolOf(deps, params.path, async ({ info, docId }) => {
      const result = await apiOf(deps, info, ENDPOINTS.patch, {}, patchBodyOf(docId, params));
      if (!result.ok) return toolResultOf(result.text);
      return toolResultOf(summaryOf(result.value), {
        revision: result.value["revision"],
        changed: result.value["changed"],
      });
    }),
});

const statusHintOf = (info: DaemonInfo, session: HreaderSession): string => {
  // Only the record of the **currently bound document**: other documents' styles are irrelevant to this one.
  const themeId = session.docId === undefined ? undefined : session.themeOf.get(session.docId);
  const style = themeId === undefined ? "" : `，风格 ${safeTextOf(themeId)}`;
  return `${USAGE_HINT}\ndaemon 在跑：127.0.0.1:${String(info.port)}，workspace ${safeTextOf(info.workspace)}${style}`;
};

/** The `themes` field of `GET /api/theme`; malformed shapes and empty strings are all dropped — better to under-report than to invent an id. */
const themeIdsOf = (value: Readonly<Record<string, unknown>>): readonly string[] => {
  const listed = value["themes"];
  if (!Array.isArray(listed)) return [];
  return listed.filter((item): item is string => isNonEmptyString(item));
};

/** The context is settled at subscribe time: the subscription only starts from the "document bound" fork, so inside the handlers it cannot be undefined. */
const handlersOf = (
  deps: HreaderDeps,
  session: HreaderSession,
  pi: HreaderPi,
  ctx: HreaderContext,
): SubscribeHandlers => ({
  onEvent: (event) => {
    session.queue = session.queue
      .then(() => intakeOf(deps, session, pi)(event, ctx))
      .catch(() => {
        notifyOf(ctx, "处理 hReader 批注事件时出错（见 Pi 日志）", "warning");
      });
  },
  // An expired ring means "you were down too long": the user must hear it, not have it swallowed by "unknown type".
  onStale: () => {
    notifyOf(
      ctx,
      "事件已过期（events_expired）：环里你断线期间的事件已滚掉，请刷新阅读器",
      "warning",
    );
  },
  onDown: () => {
    notifyOf(ctx, "hReader 事件流断开，2 秒后重连", "warning");
  },
  onBadFrame: (detail) => {
    notifyOf(ctx, `收到无法解析的事件帧（疑似 core 协议漂移）：${detail.slice(0, 80)}`, "warning");
  },
});

const hreaderCommandOf =
  (deps: HreaderDeps, session: HreaderSession, pi: HreaderPi) =>
  async (args: string, ctx: HreaderContext): Promise<void> => {
    const info = await readDaemonOf(deps);
    if (info === undefined) {
      notifyOf(ctx, DAEMON_MISSING_HINT, "error");
      return;
    }
    const target = args.trim();
    if (target === "") {
      // No args prints usage + daemon status. `GET /` is cookie-auth and `/s/:docId` token-auth,
      // so with no args there is no clickable valid link — printing the root URL would be a dead one.
      notifyOf(ctx, statusHintOf(info, session), "info");
      return;
    }
    const docId = docIdOf(info.workspace, target);
    if (!docId.ok) {
      notifyOf(ctx, `${target} 不在 daemon 的 workspace（${info.workspace}）里`, "error");
      return;
    }
    session.docId = docId.docId;
    session.asked.clear();
    session.subscription?.stop();
    session.subscription = subscribeOf(deps, info, handlersOf(deps, session, pi, ctx));
    notifyOf(ctx, `阅读器：${readerUrlOf(info, docId.docId)}`, "info");
  };

const STYLE_USAGE_HINT = "用法：/hr-style <视觉 id>——不给 id 就列出 daemon 报的可选值";

/** Fetches the available visual ids; on a missing/empty list the caller has **already** been notified, so it returns `undefined` for a clean exit. */
const styleIdsOf = async (
  deps: HreaderDeps,
  info: DaemonInfo,
  ctx: HreaderContext,
): Promise<readonly string[] | undefined> => {
  const listed = await apiOf(deps, info, ENDPOINTS.themes, {});
  if (!listed.ok) {
    notifyOf(ctx, listed.text, "error");
    return undefined;
  }
  const ids = themeIdsOf(listed.value);
  if (ids.length === 0) {
    notifyOf(ctx, "daemon 没报任何可选风格（`GET /api/theme` 的 themes 为空）", "error");
    return undefined;
  }
  return ids;
};

/** Validates the id and the document binding; on failure the caller has **already** been notified, so it returns `undefined`. */
const styleTargetOf = (
  ids: readonly string[],
  requested: string,
  session: HreaderSession,
  ctx: HreaderContext,
): { readonly docId: string; readonly visualId: string } | undefined => {
  // Validate against the list first: an unlisted id never even POSTs (`applyStyle` would report `unknown_style`, but by then the lock was already taken).
  if (!ids.includes(requested)) {
    const echo = clipTextOf(safeTextOf(requested), ECHO_MAX);
    notifyOf(ctx, `没有叫 ${echo} 的风格\n可选风格：${idListTextOf(ids)}`, "error");
    return undefined;
  }
  const docId = session.docId;
  if (docId === undefined) {
    notifyOf(ctx, "先用 /hreader <文档路径> 绑定文档；/hr-style 只换当前文档的视觉", "error");
    return undefined;
  }
  return { docId, visualId: requested };
};

const styleDoneTextOf = (_changed: boolean, docId: string, requested: string): string =>
  _changed
    ? `已把 ${safeTextOf(docId)} 换成 ${safeTextOf(requested)}`
    : `${safeTextOf(requested)} 与当前视觉相同，文档没变`;

/** `/hr-style <id>`'s only semantics is **switch the visual**; ids come solely from `GET /api/theme` (the extension never scans the theme directory).
 * Take a ticket on entry and write back with it — a stale earlier reply is silently dropped: no notify, no state change ("the latest command wins"). */
const styleCommandOf =
  (deps: HreaderDeps, session: HreaderSession) =>
  async (args: string, ctx: HreaderContext): Promise<void> => {
    const token = (session.styleSeq += 1);
    const info = await readDaemonOf(deps);
    if (info === undefined) {
      notifyOf(ctx, DAEMON_MISSING_HINT, "error");
      return;
    }
    const ids = await styleIdsOf(deps, info, ctx);
    if (ids === undefined || token !== session.styleSeq) return;
    const requested = args.trim();
    if (requested === "") {
      notifyOf(ctx, `${STYLE_USAGE_HINT}\n可选风格：${idListTextOf(ids)}`, "info");
      return;
    }
    const target = styleTargetOf(ids, requested, session, ctx);
    if (target === undefined) return;
    // The body has only these two keys (`handlers.ts:191-197` reads only `docId`/`visualId`).
    const result = await apiOf(deps, info, ENDPOINTS.style, {}, target);
    // Superseded by a later `/hr-style` while the request was in flight: this reply is stale — drop it silently.
    if (token !== session.styleSeq) return;
    if (!result.ok) {
      notifyOf(ctx, result.text, "error");
      return;
    }
    session.themeOf.set(target.docId, target.visualId);
    notifyOf(
      ctx,
      styleDoneTextOf(result.value["changed"] === true, target.docId, requested),
      "info",
    );
  };

export const hreaderExtensionOf =
  (deps: HreaderDeps) =>
  (pi: HreaderPi): void => {
    const session = sessionOf();
    pi.registerCommand("hreader", {
      description: "把文档推到 hReader 阅读器并订阅它的批注事件",
      handler: hreaderCommandOf(deps, session, pi),
    });
    pi.registerCommand("hr-style", {
      description: "换当前文档的视觉（id 来自 daemon 的 `GET /api/theme`）",
      handler: styleCommandOf(deps, session),
    });
    pi.registerTool(outlineToolOf(deps));
    pi.registerTool(readNodeToolOf(deps));
    pi.registerTool(patchNodeToolOf(deps));
    // A resident SSE connection holds the event loop: it must be wound down when Pi exits the session, or the process cannot quit.
    pi.on("session_shutdown", () => {
      session.subscription?.stop();
      session.subscription = undefined;
    });
  };

/** Default reconnect wait: `unref()` is a hard requirement (whether it truly frees the process is proven by the smoke script's exit code). */
export const delayOf = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((done) => {
    if (signal.aborted) {
      done();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done();
    }, ms);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });

const liveDeps = (): HreaderDeps => ({
  home: homedir(),
  readFile,
  // The global `fetch` has a wider signature than `FetchLike` (`RequestInit`), so it is passed as-is:
  // wrapping it as `(url, request) => fetch(url, request)` would add a function no test ever reaches.
  fetch,
  delay: delayOf,
});

export default (api: HreaderPi): void => {
  hreaderExtensionOf(liveDeps())(api);
};
